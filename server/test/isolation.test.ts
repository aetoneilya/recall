// Two allowed users on one server: neither can see or touch the other's
// collection through REST or MCP. Someone else's ids behave as unknown ids.
import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { callTool, initData, listen, makeCtx, send, type TestCtx } from './helpers.ts'

const BOT = '123456:TEST-fake-bot-token'
const A = 111
const B = 222

describe('data isolation between users', () => {
  let ctx: TestCtx
  let url: string
  let close: () => Promise<void>
  const head = (id: number) => ({ 'x-telegram-init-data': initData({ id, first_name: `u${id}` }, Math.floor(Date.now() / 1000), BOT) })
  const as = (id: number) => ({
    get: async (p: string) => {
      const r = await fetch(`${url}/api${p}`, { headers: head(id) })
      return { status: r.status, body: (await r.json()) as any }
    },
    call: async (method: string, p: string, body: unknown = {}) => {
      const r = await send(`${url}/api${p}`, method, body, head(id))
      return { status: r.status, body: (await r.json()) as any }
    },
  })
  const a = as(A)
  const b = as(B)
  let tokenA: string
  let tokenB: string
  // A's collection.
  let deckA: string
  let activeA: string
  let inboxA: string
  let cardA: string
  let logA: string
  let testA: string

  beforeAll(async () => {
    const autofill = {
      beta: { messages: { create: async (_: MessageCreateParamsNonStreaming) => ({ stop_reason: 'end_turn', model: 'm', usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'text', text: JSON.stringify({ draft: { term: 'secret word', pos: 'noun', translations: ['секрет'], ipa: null, examples: [], note: null, cefr: null }, alternatives: [] }) }] }) as never } },
    }
    ctx = makeCtx({ BOT_TOKEN: BOT, OWNER_TELEGRAM_ID: '4242', ALLOW_USER_IDS: `${A},${B}` }, new Date().toISOString(), autofill)
    const s = await listen(ctx)
    url = s.url
    close = s.close
    tokenA = (await a.call('POST', '/tokens', { name: 'a' })).body.secret
    tokenB = (await b.call('POST', '/tokens', { name: 'b' })).body.secret

    deckA = (await a.get('/decks')).body.decks[0].id
    const created = await a.call('POST', '/words', { term: 'secret word', pos: 'noun', translations: ['секрет'], tags: ['private'] })
    expect(created.status).toBe(201)
    activeA = created.body.word.id
    cardA = created.body.word.cards.forward.id
    const proposed = await callTool(url, tokenA, 'add_words', { words: [{ term: 'proposal', pos: 'noun', translations: ['предложение'] }] })
    inboxA = proposed.created[0].id
    expect(proposed.created[0].status).toBe('inbox')
    logA = 'log-a-1'
    const reviewed = await a.call('POST', '/reviews', [{ id: logA, cardId: cardA, rating: 1, reviewedAt: new Date().toISOString() }])
    expect(reviewed.body).toMatchObject({ applied: 1 })
    testA = (await a.call('POST', '/vocab-test', {})).body.testId
  })
  afterAll(async () => close())

  it('REST: B reads nothing of A', async () => {
    const decksB = (await b.get('/decks')).body.decks
    expect(decksB).toHaveLength(1)
    expect(decksB[0].id).not.toBe(deckA)
    expect(decksB[0].counts).toMatchObject({ total: 0, inbox: 0 })
    expect((await b.get('/words?q=secret')).body).toEqual({ words: [], total: 0 })
    expect((await b.get('/words')).body.total).toBe(0)
    expect((await b.get(`/words?deck=${deckA}`)).body.total).toBe(0)
    expect((await b.get('/words?status=inbox')).body.total).toBe(0)
    expect((await b.get('/inbox')).body).toEqual({ words: [], facts: [] })
    expect((await b.get(`/inbox?deck=${deckA}`)).status).toBe(404)
    const q = (await b.get('/queue')).body
    expect(q).toMatchObject({ items: [], counts: { new: 0, learning: 0, review: 0 }, inbox: 0 })
    expect((await b.get(`/queue?deck=${deckA}`)).body.items).toEqual([])
    const st = (await b.get('/stats')).body
    expect(st.reviews).toBe(0)
    expect((await b.get(`/stats?deck=${deckA}`)).body.reviews).toBe(0)
    const dash = (await b.get('/dashboard')).body
    expect(dash.counts.words.total).toBe(0)
    expect(dash.activity.totals.reviews).toBe(0)
    expect((await b.get(`/dashboard?deck=${deckA}`)).status).toBe(404)
    expect((await b.get('/vocab-tests')).body).toEqual({ tests: [] })

    const missing = await b.get(`/words/${activeA}`)
    expect(missing).toEqual({ status: 404, body: { error: `word ${activeA} not found` } })
    // Same answer as for an id that never existed.
    expect((await b.get('/words/wd_doesnotexist')).status).toBe(404)
  })

  it('REST: B modifies nothing of A', async () => {
    expect((await b.call('PATCH', `/words/${activeA}`, { term: 'pwned' })).status).toBe(404)
    expect((await b.call('DELETE', `/words/${activeA}`)).status).toBe(404)
    expect((await b.call('POST', `/words/${inboxA}/approve`)).status).toBe(404)
    expect((await b.call('POST', `/words/${inboxA}/reject`)).status).toBe(404)
    expect((await b.call('POST', `/words/${activeA}/suspend`)).status).toBe(404)
    expect((await b.call('POST', '/inbox/approve-all', {})).body).toEqual({ approved: 0 })
    expect((await b.call('POST', '/inbox/approve-all', { deckId: deckA })).body).toEqual({ approved: 0 })
    expect((await b.call('POST', `/cards/${cardA}/suspend`)).status).toBe(404)
    expect((await b.call('PATCH', `/decks/${deckA}`, { name: 'pwned', newPerDay: 0, reverseEnabled: false })).status).toBe(404)
    // Can't add into A's deck or autofill against it; dedupe is per user.
    expect((await b.call('POST', '/words', { deckId: deckA, term: 'f', pos: 'noun', translations: ['b'] })).status).toBe(404)
    expect((await b.call('POST', '/words/autofill', { deckId: deckA, term: 'secret word' })).status).toBe(404)
    const fill = await b.call('POST', '/words/autofill', { term: 'secret word' })
    expect(fill.body.duplicate).toBeNull()
    const mine = await b.call('POST', '/words', { term: 'secret word', pos: 'noun', translations: ['мой'] })
    expect(mine.status).toBe(201)
    // A's vocabulary test is not B's.
    expect((await b.call('POST', `/vocab-test/${testA}/answers`, { answers: [] })).status).toBe(404)

    // Reviews of A's card are skipped; undoing A's log is a 404.
    const rev = await b.call('POST', '/reviews', [{ id: 'log-b-1', cardId: cardA, rating: 4, reviewedAt: new Date().toISOString() }])
    expect(rev.body).toEqual({ applied: 0, skipped: 1, cards: [] })
    expect((await b.call('POST', '/reviews/undo', { id: logA })).status).toBe(404)

    // A's collection is untouched.
    const word = await a.get(`/words/${activeA}`)
    expect(word.body.word).toMatchObject({ term: 'secret word', translations: ['секрет'], cards: { forward: { id: cardA, suspended: false, reps: 1 } } })
    expect(word.body.logs.map((l: { id: string }) => l.id)).toEqual([logA])
    expect((await a.get('/inbox')).body.words.map((n: { id: string }) => n.id)).toEqual([inboxA])
    expect((await a.get('/decks')).body.decks).toMatchObject([{ id: deckA, name: 'English', newPerDay: 15, reverseEnabled: true, counts: { total: 2, inbox: 1 } }])
    expect((await a.get('/vocab-tests')).body.tests.map((t: { id: string }) => t.id)).toEqual([testA])
    // A can still undo their own review.
    expect((await a.call('POST', '/reviews/undo', { id: logA })).status).toBe(200)
    await a.call('POST', '/reviews', [{ id: logA, cardId: cardA, rating: 1, reviewedAt: new Date().toISOString() }])
  })

  it('MCP: B reads and modifies nothing of A', async () => {
    // Give A a leech.
    ctx.db.prepare('UPDATE cards SET lapses = 5 WHERE id = ?').run(cardA)
    const decks = await callTool(url, tokenB, 'list_decks')
    expect(decks.map((d: { name: string }) => d.name)).toEqual(['English'])
    expect(decks[0].id).not.toBe(deckA)
    expect((await callTool(url, tokenB, 'search_words', { query: 'proposal' }))).toEqual({ total: 0, words: [] })
    expect((await callTool(url, tokenB, 'search_words', { status: 'inbox' })).total).toBe(0)
    expect(await callTool(url, tokenB, 'get_word', { id: activeA })).toEqual({ error: `word ${activeA} not found` })
    expect((await callTool(url, tokenB, 'update_word', { id: activeA, term: 'pwned' })).error).toMatch(/not found/)
    for (const action of ['delete', 'approve', 'reject', 'suspend', 'unsuspend']) {
      const r = await callTool(url, tokenB, 'set_word_status', { ids: [inboxA, activeA], action })
      expect(r.results.map((x: { ok: boolean }) => x.ok)).toEqual([false, false])
    }
    expect((await callTool(url, tokenB, 'review_stats', {})).reviews).toBe(0)
    expect((await callTool(url, tokenB, 'review_stats', { deck: deckA })).error).toMatch(/no deck/)
    expect(await callTool(url, tokenB, 'get_leeches', { minLapses: 1 })).toEqual([])
    expect((await callTool(url, tokenA, 'get_leeches', { minLapses: 1 })).map((l: { wordId: string }) => l.wordId)).toEqual([activeA])
    expect((await callTool(url, tokenB, 'add_words', { deck: deckA, words: [{ term: 'x', pos: 'noun', translations: ['y'] }] })).error).toMatch(/no deck/)
    const profileB = await callTool(url, tokenB, 'vocabulary_profile', {})
    expect(profileB.words).toMatchObject({ total: 1, inbox: 0 })
    expect(profileB.weakest).toEqual([])

    // Dedupe is per user: B may propose what A already has.
    const added = await callTool(url, tokenB, 'add_words', { words: [{ term: 'proposal', pos: 'noun', translations: ['b'] }] })
    expect(added.duplicates).toEqual([])
    expect(added.created).toHaveLength(1)

    // A sees exactly their own words, unchanged.
    const aWords = await callTool(url, tokenA, 'search_words', {})
    expect(aWords.total).toBe(2)
    expect(aWords.words.map((n: { id: string; status: string }) => [n.id, n.status]).sort()).toEqual([[activeA, 'active'], [inboxA, 'inbox']].sort())
    const aWord = await callTool(url, tokenA, 'get_word', { id: activeA })
    expect(aWord).toMatchObject({ term: 'secret word', cards: { forward: { suspended: false } }, faces: { reverse: { front: { translations: ['секрет'] } } } })
  })
})
