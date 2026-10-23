// Getting in from the bot: a stranger asks, the owner allows or denies;
// allowed accounts pass every auth path like ALLOW_USER_IDS ones, and a
// revoked one is cut everywhere. /users is the owner's list.
import { afterEach, describe, expect, it } from 'vitest'
import { DENY_COOLDOWN_MS, listAllowed } from '../src/access.ts'
import { ACCESS_TEXT, usersView } from '../src/bot-access.ts'
import { LOGIN_TEXT, OWNER_COMMANDS, reminderTick } from '../src/bot.ts'
import { createSession, sha256 } from '../src/auth.ts'
import { createApiToken } from '../src/tokens.ts'
import { getUserByTelegramId, isAllowed } from '../src/users.ts'
import { fakeBot } from './fake-telegram.ts'
import { addWord, bearer, callTool, initData, listen, makeCtx, send } from './helpers.ts'

const BOT = '123456:TEST-fake-bot-token'
const OWNER = 4242
const FRIEND = 111
const ANNA = 5005
const BORIS = 6006

describe('access by request', () => {
  let close: (() => Promise<void>) | undefined
  afterEach(async () => {
    await close?.()
    close = undefined
  })

  async function start(env: Record<string, string> = {}) {
    const ctx = makeCtx({ BOT_TOKEN: BOT, OWNER_TELEGRAM_ID: String(OWNER), ALLOW_USER_IDS: String(FRIEND), ...env }, new Date().toISOString())
    const s = await listen(ctx)
    close = s.close
    const tg = fakeBot(ctx)
    tg.profile(ANNA, { name: 'Anna', username: 'anna_k' })
    return { ctx, url: s.url, tg }
  }
  const tgHeader = (id: number) => ({ 'x-telegram-init-data': initData({ id, first_name: 'Anna' }, Math.floor(Date.now() / 1000), BOT) })
  // The messages that asked the owner about an account (edited once answered).
  const pings = (tg: ReturnType<typeof fakeBot>) => {
    const sent = tg.calls.filter((c) => c.method === 'sendMessage' && c.payload.chat_id === OWNER && c.payload.text.startsWith('🙋 Access request'))
    return sent.map((c) => tg.sentTo(OWNER).find((m) => m.buttons.flat().some(([, d]) => d === c.payload.reply_markup.inline_keyboard[0][0].callback_data))!)
  }
  const sentTexts = (tg: ReturnType<typeof fakeBot>, chat: number) => tg.calls.filter((c) => c.method === 'sendMessage' && c.payload.chat_id === chat).map((c) => c.payload.text)
  // A stranger: /start, then the button under the answer.
  async function ask(tg: ReturnType<typeof fakeBot>, id: number) {
    await tg.message(id, '/start')
    const intro = tg.sentTo(id).at(-1)!
    return tg.press(id, tg.data(ACCESS_TEXT.button, intro.id), intro.id)
  }

  it('request → the owner is asked → Allow → the account gets in everywhere', async () => {
    const { ctx, url, tg } = await start()
    expect((await fetch(`${url}/api/me`, { headers: tgHeader(ANNA) })).status).toBe(401)

    expect(await tg.message(ANNA, '/start')).toBe(ACCESS_TEXT.intro)
    expect(tg.buttons()).toEqual([[ACCESS_TEXT.button, `access:req:${ANNA}`]])
    // No user row for a stranger.
    expect(getUserByTelegramId(ctx.db, ANNA)).toBeNull()

    const intro = tg.sentTo(ANNA).at(-1)!.id
    expect(await tg.press(ANNA, `access:req:${ANNA}`, intro)).toMatchObject({ edited: ACCESS_TEXT.sent, answered: true })
    const [ping] = pings(tg)
    expect(ping!.text).toBe(`🙋 Access request\nAnna @anna_k · ${ANNA}`)
    expect(ping!.buttons.flat()).toEqual([['✅ Allow', `access:allow:${ANNA}`], ['✖ Deny', `access:deny:${ANNA}`]])
    for (const [, data] of ping!.buttons.flat()) expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64)

    expect(await tg.press(OWNER, `access:allow:${ANNA}`, ping!.id)).toMatchObject({ edited: `✅ Allowed: Anna @anna_k · ${ANNA}` })
    const welcome = tg.sentTo(ANNA).at(-1)!
    expect(welcome.text).toBe(ACCESS_TEXT.allowed)
    expect(welcome.buttons).toEqual([[[ACCESS_TEXT.open, 'http://localhost:9']]])
    expect(isAllowed(ctx.db, ctx.cfg, ANNA)).toBe(true)
    // Started the bot: reminders may go to their chat.
    expect(getUserByTelegramId(ctx.db, ANNA)).toMatchObject({ name: 'Anna', onboarded: false })
    expect(getUserByTelegramId(ctx.db, ANNA)!.botStartedAt).not.toBeNull()
    // A second press changes nothing.
    expect(await tg.press(OWNER, `access:deny:${ANNA}`, ping!.id)).toMatchObject({ edited: undefined, popup: ACCESS_TEXT.already })

    // Mini App, a session, a personal token and MCP all let them in.
    const me = await fetch(`${url}/api/me`, { headers: tgHeader(ANNA) })
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ user: { telegramId: ANNA, isOwner: false }, onboarded: false, coachSeen: false })
    const user = getUserByTelegramId(ctx.db, ANNA)!
    const { token } = createSession(ctx.db, user.id, ctx.now())
    expect((await fetch(`${url}/api/me`, { headers: { cookie: `recall_session=${token}` } })).status).toBe(200)
    const { secret } = createApiToken(ctx.db, user.id, 'cli', ctx.now())
    expect((await fetch(`${url}/api/me`, { headers: { authorization: bearer(secret) } })).status).toBe(200)
    expect(await callTool(url, secret, 'list_decks')).toHaveLength(1)
    // An OAuth access token (claude.ai) too.
    ctx.db.prepare("INSERT INTO oauth_tokens(token_hash, kind, user_id, client_id, scopes, resource, expires_at) VALUES (?, 'access', ?, 'c1', '', NULL, ?)")
      .run(sha256('oauth-access'), user.id, new Date(Date.now() + 3600_000).toISOString())
    expect((await fetch(`${url}/api/me`, { headers: { authorization: bearer('oauth-access') } })).status).toBe(200)
    // The bot answers them as anyone allowed, and logs them in on the web.
    expect(await tg.message(ANNA, '/due')).toBe('0 cards due')
    ctx.telegram.botUsername = 'mnemo_bot'
    const { nonce } = (await (await send(`${url}/api/login/telegram`, 'POST', {})).json()) as { nonce: string }
    expect(await tg.message(ANNA, `/start login_${nonce}`)).toBe(LOGIN_TEXT.ask)
    await tg.press(ANNA, tg.data('✅ Log in'))
    const poll = await fetch(`${url}/api/login/telegram/${nonce}`)
    expect(await poll.json()).toMatchObject({ status: 'ok', user: { telegramId: ANNA } })
  })

  it('a repeat while pending does not ask the owner again', async () => {
    const { tg } = await start()
    await ask(tg, ANNA)
    expect(pings(tg)).toHaveLength(1)
    // Asked again: /start says so, and an old button too.
    expect(await tg.message(ANNA, '/start')).toBe(ACCESS_TEXT.pending)
    expect(tg.buttons()).toEqual([])
    expect(await tg.press(ANNA, `access:req:${ANNA}`)).toMatchObject({ edited: ACCESS_TEXT.pending })
    expect(await tg.message(ANNA, 'hello')).toBe(ACCESS_TEXT.pending)
    expect(pings(tg)).toHaveLength(1)
    // Someone else's button does nothing.
    tg.profile(BORIS, { name: 'Boris' })
    expect(await tg.press(BORIS, `access:req:${ANNA}`)).toEqual({ edited: undefined, answered: true, popup: undefined })
    expect(pings(tg)).toHaveLength(1)
  })

  it('Deny is polite, holds off new requests for a week, then lets them ask again', async () => {
    const { ctx, url, tg } = await start()
    await ask(tg, ANNA)
    const ping = pings(tg)[0]!
    expect(await tg.press(OWNER, `access:deny:${ANNA}`, ping.id)).toMatchObject({ edited: `✖ Denied: Anna @anna_k · ${ANNA}` })
    expect(tg.sentTo(ANNA).at(-1)!.text).toBe(ACCESS_TEXT.denied)
    expect(isAllowed(ctx.db, ctx.cfg, ANNA)).toBe(false)
    expect((await fetch(`${url}/api/me`, { headers: tgHeader(ANNA) })).status).toBe(401)

    expect(await tg.message(ANNA, '/start')).toBe(ACCESS_TEXT.cooldown)
    expect(await tg.press(ANNA, `access:req:${ANNA}`)).toMatchObject({ edited: ACCESS_TEXT.cooldown })
    expect(pings(tg)).toHaveLength(1)

    ctx.clock.t = new Date(ctx.now().getTime() + DENY_COOLDOWN_MS + 60_000)
    expect(await ask(tg, ANNA)).toMatchObject({ edited: ACCESS_TEXT.sent })
    expect(pings(tg)).toHaveLength(2)
  })

  it('only the owner can Allow, Deny or Revoke', async () => {
    const { ctx, tg } = await start()
    await ask(tg, ANNA)
    const ping = pings(tg)[0]!
    // An allowed friend and a stranger press Allow: nothing happens.
    expect(await tg.press(FRIEND, `access:allow:${ANNA}`, ping.id, OWNER)).toEqual({ edited: undefined, answered: true, popup: undefined })
    tg.profile(BORIS, { name: 'Boris' })
    expect(await tg.press(BORIS, `access:allow:${ANNA}`, ping.id, OWNER)).toEqual({ edited: undefined, answered: true, popup: undefined })
    expect(isAllowed(ctx.db, ctx.cfg, ANNA)).toBe(false)
    expect(sentTexts(tg, ANNA)).toEqual([ACCESS_TEXT.intro])
    // The request still waits for the owner.
    expect(await tg.press(OWNER, `access:allow:${ANNA}`, ping.id)).toMatchObject({ edited: `✅ Allowed: Anna @anna_k · ${ANNA}` })
    expect(await tg.press(FRIEND, `users:revoke:${ANNA}`, ping.id)).toEqual({ edited: undefined, answered: true, popup: undefined })
    expect(isAllowed(ctx.db, ctx.cfg, ANNA)).toBe(true)
    // /users is the owner's only.
    expect(await tg.message(FRIEND, '/users')).toBe('Unknown command. /help shows what I can do.')
  })

  it('/users lists config and bot accounts; Revoke cuts every way in', async () => {
    const { ctx, url, tg } = await start()
    tg.profile(FRIEND, { name: 'Fedor' })
    await tg.message(FRIEND, '/start')
    expect(await tg.message(OWNER, '/users')).toBe(`👥 Who has access besides you (1):\n• Fedor · ${FRIEND} — from the config (ALLOW_USER_IDS), not revocable here`)
    expect(tg.buttons()).toEqual([])

    await ask(tg, ANNA)
    await tg.press(OWNER, `access:allow:${ANNA}`, pings(tg)[0]!.id)
    const user = getUserByTelegramId(ctx.db, ANNA)!
    const { token } = createSession(ctx.db, user.id, ctx.now())
    const { secret } = createApiToken(ctx.db, user.id, 'cli', ctx.now())
    ctx.db.prepare("INSERT INTO oauth_tokens(token_hash, kind, user_id, client_id, scopes, resource, expires_at) VALUES (?, 'access', ?, 'c1', '', NULL, ?)")
      .run(sha256('oauth-access'), user.id, new Date(Date.now() + 3600_000).toISOString())
    addWord(ctx, 'frown', { userId: user.id })

    await tg.message(OWNER, '/users')
    const list = tg.sentTo(OWNER).at(-1)!
    expect(list.text).toBe([
      '👥 Who has access besides you (2):',
      `• Fedor · ${FRIEND} — from the config (ALLOW_USER_IDS), not revocable here`,
      `• Anna @anna_k · ${ANNA} — let in from the bot`,
    ].join('\n'))
    // The owner's own id is never in the list.
    expect(list.text).not.toContain(String(OWNER))
    expect(list.buttons).toEqual([[['✖ Revoke Anna', `users:revoke:${ANNA}`]]])

    expect(await tg.press(OWNER, `users:revoke:${ANNA}`, list.id)).toMatchObject({
      edited: `✖ Revoked: Anna @anna_k · ${ANNA}\n👥 Who has access besides you (1):\n• Fedor · ${FRIEND} — from the config (ALLOW_USER_IDS), not revocable here`,
    })
    expect(isAllowed(ctx.db, ctx.cfg, ANNA)).toBe(false)
    expect((await fetch(`${url}/api/me`, { headers: tgHeader(ANNA) })).status).toBe(401)
    expect((await fetch(`${url}/api/me`, { headers: { cookie: `recall_session=${token}` } })).status).toBe(401)
    expect((await fetch(`${url}/api/me`, { headers: { authorization: bearer(secret) } })).status).toBe(401)
    expect(await callTool(url, secret, 'list_decks')).toEqual({ status: 401 })
    expect((await fetch(`${url}/api/me`, { headers: { authorization: bearer('oauth-access') } })).status).toBe(401)
    // Their credentials are gone: letting them in again later brings none back.
    expect(ctx.db.prepare('SELECT (SELECT count(*) FROM sessions WHERE user_id = ?) + (SELECT count(*) FROM api_tokens WHERE user_id = ?) + (SELECT count(*) FROM oauth_tokens WHERE user_id = ?) AS n').get(user.id, user.id, user.id)).toEqual({ n: 0 })
    // The bot treats them as a stranger again, and reminders skip them.
    expect(await tg.message(ANNA, '/due')).toBe(ACCESS_TEXT.intro)
    const sent: number[] = []
    ctx.db.prepare("UPDATE users SET morning_sent_day = NULL, reminder_time = '00:00'").run()
    await reminderTick(ctx, async (chat) => void sent.push(chat))
    expect(sent).not.toContain(ANNA)
    // Their collection stays.
    expect(ctx.db.prepare('SELECT count(*) AS n FROM words WHERE user_id = ?').get(user.id)).toEqual({ n: 1 })
  })

  it('an owner who cannot be reached: the request is not kept', async () => {
    const { ctx, tg } = await start()
    tg.bot.api.config.use(async (prev, method, payload: any, signal) => {
      if (method === 'sendMessage' && payload.chat_id === OWNER) throw new Error('Forbidden: bot was blocked by the user')
      return prev(method, payload, signal)
    })
    expect(await ask(tg, ANNA)).toMatchObject({ edited: ACCESS_TEXT.unreachable })
    expect(ctx.db.prepare('SELECT count(*) AS n FROM access_requests').get()).toEqual({ n: 0 })
  })

  it('without an owner there is no one to ask', async () => {
    const ctx = makeCtx({ BOT_TOKEN: BOT }, new Date().toISOString())
    const tg = fakeBot(ctx)
    expect(await tg.message(ANNA, '/start')).toBe(ACCESS_TEXT.closed)
    expect(tg.buttons()).toEqual([])
  })

  it('registers /users for the owner\'s chat on their /start', async () => {
    const { tg } = await start()
    await tg.message(OWNER, '/start')
    const call = tg.calls.find((c) => c.method === 'setMyCommands')
    expect(call?.payload).toMatchObject({ commands: OWNER_COMMANDS, scope: { type: 'chat', chat_id: OWNER } })
    expect(OWNER_COMMANDS.map((c) => c.command)).toContain('users')
  })
})

describe('the allowlist', () => {
  it('lists config ids (without the owner) before the bot\'s, each once', () => {
    const ctx = makeCtx({ OWNER_TELEGRAM_ID: String(OWNER), ALLOW_USER_IDS: `${FRIEND},${OWNER}` })
    ctx.db.prepare("INSERT INTO allowed_users(telegram_id, name, username, added_at) VALUES (?, 'Anna', NULL, '2026-10-01'), (?, 'Fedor', NULL, '2026-10-02')").run(ANNA, FRIEND)
    expect(listAllowed(ctx.db, ctx.cfg)).toEqual([
      { telegramId: FRIEND, name: '', username: null, via: 'config' },
      { telegramId: ANNA, name: 'Anna', username: null, via: 'bot' },
    ])
    expect(usersView([]).text).toMatch(/^No one else has access yet/)
  })
})
