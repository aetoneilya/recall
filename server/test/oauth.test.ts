// claude.ai connector flow: codes and tokens act as the user who approved.
import { createHash, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSession, SESSION_COOKIE } from '../src/auth.ts'
import { addWords } from '../src/repo.ts'
import { ensureUser, type User } from '../src/users.ts'
import { bearer, callTool, listen, makeCtx, type TestCtx } from './helpers.ts'

const OWNER = 4242
const A = 111
const B = 222

describe('OAuth for claude.ai', () => {
  let ctx: TestCtx
  let url: string
  let close: () => Promise<void>
  let clientId: string
  let userA: User
  let userB: User
  const redirect = 'http://localhost/callback'
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const params = () => ({ client_id: clientId, redirect_uri: redirect, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'st8' })
  const cookieFor = (u: User) => `${SESSION_COOKIE}=${createSession(ctx.db, u.id, ctx.now()).token}`
  const form = (body: Record<string, string>, cookie?: string) =>
    fetch(`${url}/authorize`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
      body: new URLSearchParams({ ...params(), ...body }),
    })
  const token = async (body: Record<string, string>) => {
    const r = await fetch(`${url}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, ...body }) })
    return { status: r.status, body: (await r.json()) as any }
  }
  const codeFrom = (r: Response) => {
    expect(r.status).toBe(302)
    const loc = new URL(r.headers.get('location')!)
    expect(loc.searchParams.get('state')).toBe('st8')
    return loc.searchParams.get('code')!
  }
  const exchange = async (code: string) => token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect })

  beforeAll(async () => {
    ctx = makeCtx({ OWNER_TELEGRAM_ID: String(OWNER), ALLOW_USER_IDS: `${A},${B}`, OWNER_PASSWORD: 'hunter2' }, new Date().toISOString())
    ctx.telegram.botUsername = 'mnemo_bot'
    const s = await listen(ctx)
    url = s.url
    close = s.close
    userA = ensureUser(ctx.db, ctx.cfg, A, ctx.now(), 'Anna')
    userB = ensureUser(ctx.db, ctx.cfg, B, ctx.now(), 'Boris')
    addWords(ctx.db, userA.id, { createdBy: 'user', words: [{ term: 'anna word', pos: 'noun', translations: ['а'] }] }, ctx.now())
    addWords(ctx.db, userB.id, { createdBy: 'user', words: [{ term: 'boris word', pos: 'noun', translations: ['б'] }] }, ctx.now())
    const reg = await fetch(`${url}/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [redirect], client_name: 'Claude', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
    })
    clientId = ((await reg.json()) as { client_id: string }).client_id
  })
  afterAll(async () => close())

  it('shows the consent page for the signed-in user, or Telegram + password without a session', async () => {
    const q = new URLSearchParams(params())
    const signedIn = await (await fetch(`${url}/authorize?${q}`, { headers: { cookie: cookieFor(userB) } })).text()
    expect(signedIn).toContain('Allow Claude to manage your cards, Boris?')
    expect(signedIn).not.toContain('Confirm in Telegram')
    const anon = await fetch(`${url}/authorize?${q}`)
    const html = await anon.text()
    expect(html).toContain('Confirm in Telegram')
    expect(html).toContain('@mnemo_bot')
    expect(html).toContain('name="password"')
    const csp = anon.headers.get('content-security-policy')!
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1]!
    expect(html).toContain(`<script nonce="${nonce}">`)
  })

  it('issues tokens that act as the approving user only, through refresh too', async () => {
    const tokB = await exchange(codeFrom(await form({ decision: 'approve' }, cookieFor(userB))))
    expect(tokB.status).toBe(200)
    const tokA = await exchange(codeFrom(await form({ decision: 'approve' }, cookieFor(userA))))

    const decks = async (t: string) => (await callTool(url, t, 'search_words', {})).words.map((w: { term: string }) => w.term)
    expect(await decks(tokB.body.access_token)).toEqual(['boris word'])
    expect(await decks(tokA.body.access_token)).toEqual(['anna word'])
    const me = await fetch(`${url}/api/me`, { headers: { authorization: bearer(tokB.body.access_token) } })
    expect(await me.json()).toMatchObject({ user: { telegramId: B } })

    // B's token writes into B's collection.
    ctx.clock.t = new Date(ctx.clock.t.getTime() + 1000)
    await callTool(url, tokB.body.access_token, 'add_words', { words: [{ term: 'from claude', pos: 'noun', translations: ['x'] }] })
    expect(await decks(tokA.body.access_token)).toEqual(['anna word'])
    expect(await decks(tokB.body.access_token)).toEqual(['from claude', 'boris word'])

    const refreshed = await token({ grant_type: 'refresh_token', refresh_token: tokB.body.refresh_token })
    expect(refreshed.status).toBe(200)
    expect(await decks(refreshed.body.access_token)).toEqual(['from claude', 'boris word'])
    // Rotation: the old refresh token is spent.
    expect((await token({ grant_type: 'refresh_token', refresh_token: tokB.body.refresh_token })).status).toBe(400)
  })

  it('approves as the owner with the password fallback, and refuses approve without a session', async () => {
    expect((await form({ decision: 'approve' })).status).toBe(401)
    expect((await form({ decision: 'password', password: 'wrong' })).status).toBe(401)
    const tok = await exchange(codeFrom(await form({ decision: 'password', password: 'hunter2' })))
    const me = await fetch(`${url}/api/me`, { headers: { authorization: bearer(tok.body.access_token) } })
    expect(await me.json()).toMatchObject({ user: { telegramId: OWNER, isOwner: true } })
    expect(await callTool(url, tok.body.access_token, 'list_decks')).toMatchObject([{ name: 'English', counts: { total: 0 } }])

    const denied = await form({ decision: 'deny' }, cookieFor(userA))
    expect(new URL(denied.headers.get('location')!).searchParams.get('error')).toBe('access_denied')
  })
})
