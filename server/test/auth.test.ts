import { afterEach, describe, expect, it } from 'vitest'
import { validateInitData } from '../src/auth.ts'
import { bearer, callTool, initData, listen, makeCtx, MCP_HEADERS, send } from './helpers.ts'

const BOT = '123456:TEST-fake-bot-token'
const OWNER = 4242
const FRIEND = 111
const STATIC = 'static-token'

describe('telegram initData', () => {
  const now = new Date('2026-10-21T09:00:00Z')
  const fresh = Math.floor(now.getTime() / 1000) - 60

  it('accepts a correctly signed, fresh payload', () => {
    expect(validateInitData(initData({ id: OWNER, first_name: 'I' }, fresh, BOT), BOT, now)).toMatchObject({ id: OWNER })
  })

  it('rejects a wrong token, tampering and stale auth_date', () => {
    expect(validateInitData(initData({ id: OWNER }, fresh, 'other:token'), BOT, now)).toBeNull()
    const tampered = initData({ id: OWNER }, fresh, BOT).replace(encodeURIComponent(`"id":${OWNER}`), encodeURIComponent('"id":1'))
    expect(validateInitData(tampered, BOT, now)).toBeNull()
    expect(validateInitData(initData({ id: OWNER }, fresh - 2 * 86400, BOT), BOT, now)).toBeNull()
    expect(validateInitData('garbage', BOT, now)).toBeNull()
  })
})

describe('http auth', () => {
  let close: (() => Promise<void>) | undefined
  afterEach(async () => {
    await close?.()
    close = undefined
  })

  async function start(env: Record<string, string> = {}) {
    const ctx = makeCtx({
      OWNER_PASSWORD: 'hunter2', MCP_TOKEN: STATIC, BOT_TOKEN: BOT, OWNER_TELEGRAM_ID: String(OWNER), ALLOW_USER_IDS: ` ${FRIEND}, 222 `, ...env,
    }, new Date().toISOString())
    const s = await listen(ctx)
    close = s.close
    return { url: s.url, ctx }
  }
  const tg = (id: number, name?: string) => ({ 'x-telegram-init-data': initData({ id, first_name: name }, Math.floor(Date.now() / 1000), BOT) })

  it('logs the owner in with the password and keeps a session cookie', async () => {
    const { url } = await start()
    expect((await fetch(`${url}/api/me`)).status).toBe(401)
    expect((await fetch(`${url}/api/health`)).status).toBe(200)

    expect((await send(`${url}/api/login`, 'POST', { password: 'nope' })).status).toBe(401)
    const ok = await send(`${url}/api/login`, 'POST', { password: 'hunter2' })
    expect(ok.status).toBe(200)
    const cookie = ok.headers.get('set-cookie')!
    expect(cookie).toMatch(/recall_session=.+; Path=\/; HttpOnly; SameSite=Lax/)
    const session = cookie.split(';')[0]!

    const me = await fetch(`${url}/api/me`, { headers: { cookie: session } })
    expect(await me.json()).toMatchObject({
      user: { telegramId: OWNER, isOwner: true }, authenticatedVia: 'session', timeZone: 'Europe/Moscow', dayStartHour: 4, reminderTime: '09:00', eveningReminderTime: null,
    })

    await fetch(`${url}/api/logout`, { method: 'POST', headers: { cookie: session } })
    expect((await fetch(`${url}/api/me`, { headers: { cookie: session } })).status).toBe(401)
  })

  it('rate-limits repeated wrong passwords', async () => {
    const { url } = await start()
    const attempt = (password: string) => send(`${url}/api/login`, 'POST', { password })
    for (let i = 0; i < 10; i++) expect((await attempt('x')).status).toBe(401)
    expect((await attempt('hunter2')).status).toBe(429)
  })

  it('accepts Telegram initData for the owner and ALLOW_USER_IDS, creating the user on first sight', async () => {
    const { url, ctx } = await start()
    const owner = await fetch(`${url}/api/me`, { headers: tg(OWNER) })
    expect(await owner.json()).toMatchObject({ authenticatedVia: 'telegram', user: { telegramId: OWNER, isOwner: true } })
    expect(ctx.db.prepare('SELECT count(*) AS n FROM users WHERE telegram_id = ?').get(FRIEND)).toEqual({ n: 0 })
    const friend = await fetch(`${url}/api/me`, { headers: tg(FRIEND, 'Anna') })
    expect(await friend.json()).toMatchObject({ authenticatedVia: 'telegram', user: { telegramId: FRIEND, name: 'Anna', isOwner: false } })
    expect(ctx.db.prepare('SELECT name FROM users WHERE telegram_id = ?').get(FRIEND)).toEqual({ name: 'Anna' })

    const stranger = await fetch(`${url}/api/me`, { headers: tg(7) })
    expect(stranger.status).toBe(401)
    expect(await stranger.json()).toEqual({ error: 'not allowed', telegramId: 7 })
    expect(ctx.db.prepare('SELECT count(*) AS n FROM users WHERE telegram_id = 7').get()).toEqual({ n: 0 })
  })

  it('drops a user removed from ALLOW_USER_IDS everywhere, sessions and tokens included', async () => {
    const { url, ctx } = await start()
    const created = await send(`${url}/api/tokens`, 'POST', { name: 'cli' }, tg(FRIEND))
    const { secret } = (await created.json()) as { secret: string }
    expect((await fetch(`${url}/api/me`, { headers: { authorization: bearer(secret) } })).status).toBe(200)
    ctx.cfg.allowUserIds = [222]
    expect((await fetch(`${url}/api/me`, { headers: { authorization: bearer(secret) } })).status).toBe(401)
    expect((await fetch(`${url}/api/me`, { headers: tg(FRIEND) })).status).toBe(401)
    expect(await callTool(url, secret, 'list_decks')).toEqual({ status: 401 })
  })

  it('maps the static MCP_TOKEN to the owner on /api and /mcp, and nothing else', async () => {
    const { url } = await start()
    const me = await fetch(`${url}/api/me`, { headers: { authorization: bearer(STATIC) } })
    expect(await me.json()).toMatchObject({ authenticatedVia: 'bearer', user: { telegramId: OWNER, isOwner: true } })
    expect((await fetch(`${url}/api/me`, { headers: { authorization: bearer('nope') } })).status).toBe(401)

    const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
    const anon = await fetch(`${url}/mcp`, { method: 'POST', headers: MCP_HEADERS, body: JSON.stringify(rpc) })
    expect(anon.status).toBe(401)
    expect(anon.headers.get('www-authenticate')).toMatch(/resource_metadata=".*\/\.well-known\/oauth-protected-resource\/mcp"/)
    const wrong = await fetch(`${url}/mcp`, { method: 'POST', headers: { ...MCP_HEADERS, authorization: bearer('wrong') }, body: JSON.stringify(rpc) })
    expect(wrong.status).toBe(401)
    const ok = await fetch(`${url}/mcp`, { method: 'POST', headers: { ...MCP_HEADERS, authorization: bearer(STATIC) }, body: JSON.stringify(rpc) })
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { result: { tools: { name: string }[] } }
    expect(body.result.tools.map((t) => t.name)).toContain('add_words')

    // What MCP_TOKEN adds lands in the owner's collection.
    await callTool(url, STATIC, 'add_words', { words: [{ term: 'owner word', pos: 'noun', translations: ['слово'] }] })
    const words = (await (await fetch(`${url}/api/words?tag=claude`, { headers: tg(OWNER) })).json()) as any
    expect(words.words.map((w: { term: string }) => w.term)).toEqual(['owner word'])
    const friendWords = (await (await fetch(`${url}/api/words`, { headers: tg(FRIEND) })).json()) as any
    expect(friendWords).toEqual({ words: [], total: 0 })
  })

  it('updates the user settings with validation', async () => {
    const { url } = await start({ EVENING_REMINDER_TIME: '20:00' })
    const h = tg(FRIEND)
    expect(await (await fetch(`${url}/api/me`, { headers: h })).json()).toMatchObject({ eveningReminderTime: '20:00' })
    const patched = await send(`${url}/api/me`, 'PATCH', { timeZone: 'Asia/Tokyo', reminderTime: '07:30', eveningReminderTime: null }, h)
    expect(patched.status).toBe(200)
    expect(await patched.json()).toMatchObject({ timeZone: 'Asia/Tokyo', reminderTime: '07:30', eveningReminderTime: null, user: { telegramId: FRIEND } })
    for (const bad of [{ timeZone: 'Mars/Olympus' }, { reminderTime: '25:00' }, { eveningReminderTime: '9am' }, { dayStartHour: 3 }]) {
      expect((await send(`${url}/api/me`, 'PATCH', bad, h)).status).toBe(400)
    }
    // Other users keep their own settings.
    expect(await (await fetch(`${url}/api/me`, { headers: tg(OWNER) })).json()).toMatchObject({ timeZone: 'Europe/Moscow', reminderTime: '09:00' })
  })
})

describe('personal API tokens', () => {
  let close: (() => Promise<void>) | undefined
  afterEach(async () => {
    await close?.()
    close = undefined
  })

  it('creates, lists without secrets, authenticates and revokes', async () => {
    const ctx = makeCtx({ BOT_TOKEN: BOT, OWNER_TELEGRAM_ID: String(OWNER), ALLOW_USER_IDS: String(FRIEND) }, new Date().toISOString())
    const s = await listen(ctx)
    close = s.close
    const url = s.url
    const h = { 'x-telegram-init-data': initData({ id: FRIEND }, Math.floor(Date.now() / 1000), BOT) }

    const created = await send(`${url}/api/tokens`, 'POST', { name: '  Claude Code  ' }, h)
    expect(created.status).toBe(201)
    const body = (await created.json()) as { token: { id: string; name: string; createdAt: string; lastUsedAt: null }; secret: string }
    expect(body.secret).toMatch(/^mn_[A-Za-z0-9_-]{43}$/)
    expect(body.token).toMatchObject({ id: expect.stringMatching(/^tk_/), name: 'Claude Code', lastUsedAt: null })
    expect((await send(`${url}/api/tokens`, 'POST', { name: ' ' }, h)).status).toBe(400)

    // Works on /api and /mcp as that user.
    const me = await fetch(`${url}/api/me`, { headers: { authorization: bearer(body.secret) } })
    expect(await me.json()).toMatchObject({ authenticatedVia: 'bearer', user: { telegramId: FRIEND } })
    expect(await callTool(url, body.secret, 'list_decks')).toMatchObject([{ name: 'English', counts: { total: 0 } }])

    const list = (await (await fetch(`${url}/api/tokens`, { headers: h })).json()) as any
    expect(list.tokens).toEqual([{ id: body.token.id, name: 'Claude Code', createdAt: body.token.createdAt, lastUsedAt: expect.any(String) }])
    expect(JSON.stringify(list)).not.toContain(body.secret.slice(3, 20))
    expect(JSON.stringify(ctx.db.prepare('SELECT * FROM api_tokens').all())).not.toContain(body.secret.slice(3))

    // A bearer can't manage tokens, and nobody else's tokens are visible or deletable.
    expect((await fetch(`${url}/api/tokens`, { headers: { authorization: bearer(body.secret) } })).status).toBe(403)
    const ownerH = { 'x-telegram-init-data': initData({ id: OWNER }, Math.floor(Date.now() / 1000), BOT) }
    expect(((await (await fetch(`${url}/api/tokens`, { headers: ownerH })).json()) as any).tokens).toEqual([])
    expect((await fetch(`${url}/api/tokens/${body.token.id}`, { method: 'DELETE', headers: ownerH })).status).toBe(404)

    expect((await fetch(`${url}/api/tokens/${body.token.id}`, { method: 'DELETE', headers: h })).status).toBe(200)
    expect((await fetch(`${url}/api/me`, { headers: { authorization: bearer(body.secret) } })).status).toBe(401)
    expect(await callTool(url, body.secret, 'list_decks')).toEqual({ status: 401 })
    expect(((await (await fetch(`${url}/api/tokens`, { headers: h })).json()) as any).tokens).toEqual([])
  })
})
