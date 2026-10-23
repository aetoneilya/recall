import { describe, expect, it, vi } from 'vitest'
import { AuthError, createApi, HttpError, NetworkError, NotAllowedError } from './api.ts'

function recorder(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = []
  const f = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return respond(String(url), init ?? {})
  }) as unknown as typeof fetch
  return { f, calls }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const headers = (init: RequestInit) => init.headers as Record<string, string>

describe('api client', () => {
  it('sends Telegram init data on every request when present', async () => {
    const { f, calls } = recorder(() => json({ items: [], counts: { new: 0, learning: 0, review: 0 } }))
    const api = createApi({ fetch: f, initData: () => 'query_id=1&user=%7B%7D&hash=abc' })
    await api.queue()
    await api.postReviews([])
    expect(calls).toHaveLength(2)
    for (const c of calls) expect(headers(c.init)['X-Telegram-Init-Data']).toBe('query_id=1&user=%7B%7D&hash=abc')
  })

  it('omits the header outside Telegram and relies on the session cookie', async () => {
    const { f, calls } = recorder(() => json({}))
    const api = createApi({ fetch: f, initData: () => undefined })
    await api.me()
    expect(headers(calls[0].init)['X-Telegram-Init-Data']).toBeUndefined()
    expect(calls[0].init.credentials).toBe('same-origin')
  })

  it('turns 401 into AuthError and reports it once per request', async () => {
    const onUnauthorized = vi.fn()
    const { f } = recorder(() => json({ error: 'unauthorized' }, 401))
    const api = createApi({ fetch: f, onUnauthorized })
    await expect(api.queue()).rejects.toBeInstanceOf(AuthError)
    expect(onUnauthorized).toHaveBeenCalledOnce()
  })

  it("turns 'not allowed' into NotAllowedError carrying the Telegram id", async () => {
    const onUnauthorized = vi.fn()
    const { f } = recorder(() => json({ error: 'not allowed', telegramId: 987654321 }, 401))
    const api = createApi({ fetch: f, onUnauthorized, initData: () => 'user=x&hash=y' })
    const err = await api.me().catch((e) => e)
    expect(err).toBeInstanceOf(NotAllowedError)
    expect(err).toBeInstanceOf(AuthError)
    expect(err.telegramId).toBe(987654321)
    expect(onUnauthorized).toHaveBeenCalledWith(err)

    // A plain 401, or one without a usable id, stays a bare AuthError.
    for (const body of [{ error: 'unauthorized' }, { error: 'not allowed' }, null]) {
      const r = recorder(() => (body ? json(body, 401) : new Response('', { status: 401 })))
      const e = await createApi({ fetch: r.f }).me().catch((x) => x)
      expect(e).toBeInstanceOf(AuthError)
      expect(e).not.toBeInstanceOf(NotAllowedError)
    }
  })

  it('maps the bot-login poll: 202 pending, 200 ok, 410 expired', async () => {
    const answers = [
      json({ status: 'pending', expiresAt: '2026-10-21T10:05:00Z' }, 202),
      json({ status: 'ok', user: { id: 'us_1', telegramId: 1, name: 'A', isOwner: true } }),
      json({ status: 'expired', error: 'login link expired' }, 410),
    ]
    const { f, calls } = recorder(() => answers.shift()!)
    const api = createApi({ fetch: f })
    expect(await api.pollLogin('a/b')).toEqual({ status: 'pending', expiresAt: '2026-10-21T10:05:00Z' })
    expect(calls[0].url).toBe('/api/login/telegram/a%2Fb')
    expect(await api.pollLogin('n')).toMatchObject({ status: 'ok', user: { telegramId: 1 } })
    expect(await api.pollLogin('n')).toEqual({ status: 'expired' })
  })

  it('posts JSON bodies and the login password', async () => {
    const { f, calls } = recorder(() => json({ ok: true }))
    const api = createApi({ fetch: f })
    await api.login('hunter2')
    expect(calls[0].url).toBe('/api/login')
    expect(calls[0].init.method).toBe('POST')
    expect(headers(calls[0].init)['Content-Type']).toBe('application/json')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ password: 'hunter2' })
  })

  it('uploads reviews with keepalive so a backgrounded page still delivers them', async () => {
    const { f, calls } = recorder(() => json({ applied: 1, skipped: 0, cards: [] }))
    const api = createApi({ fetch: f })
    await api.postReviews([{ id: 'u1', cardId: 'cd_1', rating: 3, reviewedAt: '2026-10-21T10:00:00Z' }])
    expect(calls[0].init.keepalive).toBe(true)
  })

  it('distinguishes network failures from HTTP errors', async () => {
    const onNetwork = vi.fn()
    const down = createApi({ fetch: (async () => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch, onNetwork })
    await expect(down.me()).rejects.toBeInstanceOf(NetworkError)
    expect(onNetwork).toHaveBeenLastCalledWith(false)

    const existing = { id: 'wd_1', term: 'to frown', pos: 'verb' }
    const { f } = recorder(() => json({ error: '"to frown" (verb) is already in this deck', existing }, 409))
    const api = createApi({ fetch: f, onNetwork })
    const err = await api.createWord({ term: 'frown', pos: 'verb', translations: ['хмуриться'] }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(409)
    expect((err as HttpError).message).toBe('"to frown" (verb) is already in this deck')
    // The duplicate comes along, so the app can offer to merge into it.
    expect((err as HttpError).data.existing).toEqual(existing)
    expect(onNetwork).toHaveBeenLastCalledWith(true)
  })

  it('a connection that drops while the body streams in is offline too, not a raw TypeError', async () => {
    const onNetwork = vi.fn()
    const broken = { status: 200, ok: true, text: () => Promise.reject(new TypeError('network error')) } as unknown as Response
    const api = createApi({ fetch: (async () => broken) as typeof fetch, onNetwork })
    await expect(api.me()).rejects.toBeInstanceOf(NetworkError)
    expect(onNetwork).toHaveBeenLastCalledWith(false)
  })

  it('defaults deck fields an older server leaves out', async () => {
    const { f } = recorder(() => json({ decks: [{ id: 'dk_1', name: 'English', counts: { total: 3, due: 1, new: 2 } }] }))
    const [d] = await createApi({ fetch: f }).decks()
    expect(d.typeAnswer).toBe('off')
    expect(d.forwardEnabled).toBe(true)
    expect(d.reverseAfterDays).toBeNull()
    expect(d.counts).toEqual({ total: 3, active: 0, dropped: 0, known: 0, learning: 0, due: 1, new: 2, newTotal: 0 })
    const { f: g } = recorder(() => json({ decks: [{ id: 'dk_1', typeAnswer: 'both', reverseEnabled: false, reverseAfterDays: 7 }] }))
    expect(await createApi({ fetch: g }).decks()).toMatchObject([{ typeAnswer: 'both', reverseEnabled: false, reverseAfterDays: 7 }])
  })

  it('builds the words query without empty params', async () => {
    const { f, calls } = recorder(() => json({ words: [{ id: 'wd_1' }], total: 7 }))
    const page = await createApi({ fetch: f }).words({ q: '', status: 'rejected', sort: 'alpha', limit: 500, offset: 0 })
    expect(calls[0].url).toBe('/api/words?status=rejected&sort=alpha&limit=500&offset=0')
    expect(page).toEqual({ words: [{ id: 'wd_1' }], total: 7 })
  })

  it('sends the autofill hint only when given', async () => {
    const { f, calls } = recorder(() => json({ draft: {}, alternatives: [], freqRank: null, duplicate: null }))
    const api = createApi({ fetch: f })
    await api.autofill('bank')
    await api.autofill('bank', 'river')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ term: 'bank' })
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ term: 'bank', hint: 'river' })
  })
})
