// "Log in with Telegram": nonce from the web → /start login_<nonce> in the
// bot → ✅ pressed under "Log in to Mnemosyne on the web?" → the web's poll
// gets a session cookie, once.
import { afterEach, describe, expect, it } from 'vitest'
import { LOGIN_TEXT } from '../src/bot.ts'
import { answerLoginRef, createLoginNonce, openLoginNonce, pollLoginNonce } from '../src/login.ts'
import { ensureUser, getUserByTelegramId } from '../src/users.ts'
import { fakeBot } from './fake-telegram.ts'
import { listen, makeCtx, send } from './helpers.ts'

const BOT = '123456:TEST-fake-bot-token'
const FRIEND = 111
const OTHER = 222
const STRANGER = 7

describe('login via the bot', () => {
  let close: (() => Promise<void>) | undefined
  afterEach(async () => {
    await close?.()
    close = undefined
  })

  async function start() {
    const ctx = makeCtx({ BOT_TOKEN: BOT, OWNER_TELEGRAM_ID: '4242', ALLOW_USER_IDS: `${FRIEND},${OTHER}` }, new Date().toISOString())
    const s = await listen(ctx)
    close = s.close
    return { ctx, url: s.url }
  }
  const newNonce = async (url: string) => {
    const r = await send(`${url}/api/login/telegram`, 'POST', {})
    return { status: r.status, body: (await r.json()) as any }
  }
  const poll = (url: string, nonce: string) => fetch(`${url}/api/login/telegram/${nonce}`)

  it('is unavailable until the bot username is known', async () => {
    const { url } = await start()
    expect((await newNonce(url)).status).toBe(503)
  })

  it('goes pending → confirmed by an allowed user → one session → gone', async () => {
    const { ctx, url } = await start()
    ctx.telegram.botUsername = 'mnemo_bot'
    const bot = fakeBot(ctx)

    const { status, body } = await newNonce(url)
    expect(status).toBe(200)
    expect(body.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(body.url).toBe(`https://t.me/mnemo_bot?start=login_${body.nonce}`)
    expect(new Date(body.expiresAt).getTime() - ctx.now().getTime()).toBe(5 * 60_000)
    // Stored hashed.
    expect(JSON.stringify(ctx.db.prepare('SELECT * FROM login_nonces').all())).not.toContain(body.nonce)

    const pending = await poll(url, body.nonce)
    expect(pending.status).toBe(202)
    expect(await pending.json()).toEqual({ status: 'pending', expiresAt: body.expiresAt })
    expect(pending.headers.get('set-cookie')).toBeNull()

    // A stranger can't open it; they get their id back.
    expect(await bot.message(STRANGER, `/start login_${body.nonce}`)).toBe(
      `This is a private bot. Your Telegram id: ${STRANGER} — send it to the owner to get access.`)
    expect((await poll(url, body.nonce)).status).toBe(202)
    expect(getUserByTelegramId(ctx.db, STRANGER)).toBeNull()

    // Opening the link only asks; nothing is confirmed yet.
    expect(await bot.message(FRIEND, `/start login_${body.nonce}`, 'Anna')).toBe('Log in to Mnemosyne on the web?')
    expect(bot.calls.some((c) => c.method === 'setChatMenuButton' && c.payload.chat_id === FRIEND)).toBe(true)
    const shown = bot.buttons()
    expect(shown.map(([label]) => label)).toEqual(['✅ Log in', '✖ Cancel'])
    const okData = shown[0]![1]
    const noData = shown[1]![1]
    // The buttons carry an opaque ref, never the nonce.
    expect(okData).toMatch(/^login:ok:[A-Za-z0-9_-]{43}$/)
    expect(noData).toMatch(/^login:no:/)
    expect(okData + noData).not.toContain(body.nonce)
    expect((await poll(url, body.nonce)).status).toBe(202)

    // Another allowed account can neither open nor press it.
    expect(await bot.message(OTHER, `/start login_${body.nonce}`)).toBe(LOGIN_TEXT.expired)
    expect(await bot.press(OTHER, okData!)).toEqual({ edited: undefined, answered: true, popup: LOGIN_TEXT.notYours })
    expect(await bot.press(STRANGER, okData!)).toMatchObject({ edited: undefined })
    expect((await poll(url, body.nonce)).status).toBe(202)

    expect(await bot.press(FRIEND, okData!)).toEqual({ edited: '✅ Logged in on the web — you can go back to the app', answered: true, popup: undefined })

    const ok = await poll(url, body.nonce)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ status: 'ok', user: { telegramId: FRIEND, name: 'Anna', isOwner: false } })
    const cookie = ok.headers.get('set-cookie')!.split(';')[0]!
    const me = await fetch(`${url}/api/me`, { headers: { cookie } })
    expect(await me.json()).toMatchObject({ authenticatedVia: 'session', user: { telegramId: FRIEND }, botUsername: 'mnemo_bot' })

    // Single use, for the poller and for the bot.
    const again = await poll(url, body.nonce)
    expect(again.status).toBe(410)
    expect(again.headers.get('set-cookie')).toBeNull()
    expect(await bot.press(FRIEND, okData!)).toMatchObject({ edited: LOGIN_TEXT.expired })
    expect(await bot.message(FRIEND, `/start login_${body.nonce}`)).toBe(LOGIN_TEXT.expired)
    expect((await poll(url, 'not-a-nonce')).status).toBe(410)
  })

  it('cancel drops the login; the web gets 410', async () => {
    const { ctx, url } = await start()
    ctx.telegram.botUsername = 'mnemo_bot'
    const bot = fakeBot(ctx)
    const { body } = await newNonce(url)
    await bot.message(FRIEND, `/start login_${body.nonce}`)
    const [ok, no] = bot.buttons()
    const okData = ok![1]
    const noData = no![1]
    expect(await bot.press(FRIEND, noData!)).toMatchObject({ edited: 'Cancelled', answered: true })
    expect((await poll(url, body.nonce)).status).toBe(410)
    expect(await bot.press(FRIEND, okData!)).toMatchObject({ edited: LOGIN_TEXT.expired })
    expect((await poll(url, body.nonce)).status).toBe(410)
  })

  it('checks expiry again at press time', async () => {
    const { ctx, url } = await start()
    ctx.telegram.botUsername = 'mnemo_bot'
    const bot = fakeBot(ctx)
    const { body } = await newNonce(url)
    await bot.message(FRIEND, `/start login_${body.nonce}`)
    const okData = bot.buttons()[0]![1]
    ctx.clock.t = new Date(ctx.clock.t.getTime() + 5 * 60_000 + 1)
    expect(await bot.press(FRIEND, okData!)).toMatchObject({ edited: LOGIN_TEXT.expired })
    expect((await poll(url, body.nonce)).status).toBe(410)
  })

  it('ignores forged button data', async () => {
    const { ctx } = await start()
    const bot = fakeBot(ctx)
    expect(await bot.press(FRIEND, `login:ok:${'A'.repeat(43)}`)).toMatchObject({ edited: LOGIN_TEXT.expired })
    // Malformed data matches no handler.
    expect(await bot.press(FRIEND, 'login:ok:short')).toEqual({ edited: undefined, answered: false, popup: undefined })
  })

  it('expires after 5 minutes', async () => {
    const { ctx, url } = await start()
    ctx.telegram.botUsername = 'mnemo_bot'
    const bot = fakeBot(ctx)
    const { body } = await newNonce(url)
    ctx.clock.t = new Date(ctx.clock.t.getTime() + 5 * 60_000 + 1)
    expect((await poll(url, body.nonce)).status).toBe(410)
    expect(await bot.message(FRIEND, `/start login_${body.nonce}`)).toBe(LOGIN_TEXT.expired)
    expect(bot.buttons()).toEqual([])
    expect((await poll(url, body.nonce)).status).toBe(410)
  })

  it('binds a nonce to the first account that opens it', async () => {
    const { ctx } = await start()
    const n = createLoginNonce(ctx.db, ctx.now())!
    const friend = ensureUser(ctx.db, ctx.cfg, FRIEND, ctx.now()).id
    const other = ensureUser(ctx.db, ctx.cfg, OTHER, ctx.now()).id
    const opened = openLoginNonce(ctx.db, n.nonce, friend, ctx.now())
    if (!('ref' in opened)) throw new Error('not opened')
    expect(openLoginNonce(ctx.db, n.nonce, other, ctx.now())).toEqual({ error: 'taken' })
    expect(openLoginNonce(ctx.db, n.nonce, friend, ctx.now())).toEqual(opened)
    expect(pollLoginNonce(ctx.db, n.nonce, ctx.now())).toEqual({ status: 'pending', expiresAt: n.expiresAt })
    expect(answerLoginRef(ctx.db, opened.ref, other, 'confirm', ctx.now())).toBe('taken')
    expect(answerLoginRef(ctx.db, opened.ref, other, 'cancel', ctx.now())).toBe('taken')
    expect(answerLoginRef(ctx.db, opened.ref, friend, 'confirm', ctx.now())).toBe('confirmed')
    expect(answerLoginRef(ctx.db, opened.ref, friend, 'confirm', ctx.now())).toBe('confirmed')
    expect(pollLoginNonce(ctx.db, n.nonce, ctx.now())).toEqual({ status: 'confirmed', userId: friend })
    expect(pollLoginNonce(ctx.db, n.nonce, ctx.now())).toEqual({ status: 'gone' })
    expect(answerLoginRef(ctx.db, opened.ref, friend, 'confirm', ctx.now())).toBe('expired')
  })

  it('rate-limits nonce creation per client', async () => {
    const { ctx, url } = await start()
    ctx.telegram.botUsername = 'mnemo_bot'
    for (let i = 0; i < 20; i++) expect((await newNonce(url)).status).toBe(200)
    expect((await newNonce(url)).status).toBe(429)
  })

  it('greets allowed users by name on /start and answers /due', async () => {
    const { ctx } = await start()
    const bot = fakeBot(ctx)
    expect(await bot.message(FRIEND, '/start', 'Anna')).toBe("Hi, Anna! Send me an English word and I'll add it to your deck — /help for more. Reminders go to this chat. 0 cards due")
    expect(getUserByTelegramId(ctx.db, FRIEND)).toMatchObject({ name: 'Anna', botStartedAt: expect.any(String) })
    const menu = bot.calls.find((c) => c.method === 'setChatMenuButton')!
    expect(menu.payload).toEqual({ chat_id: FRIEND, menu_button: { type: 'web_app', text: 'Review', web_app: { url: 'http://localhost:9' } } })
    expect(await bot.message(FRIEND, '/due')).toBe('0 cards due')
    expect(await bot.message(STRANGER, '/start')).toMatch(/Your Telegram id: 7/)
  })
})

