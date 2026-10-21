// Topic decks of Q&A facts: decks, facts, the mixed review queue, in-review
// switches, the REST routes and what stays about words only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cleanFact } from '@recall/core'
import { createFact, DuplicateFactError, factCard, searchFacts, updateFact } from '../src/facts.ts'
import { createTopicDeck, defaultDeck, deleteDeck, getDeck, HttpError, updateDeck } from '../src/repo.ts'
import { buildQueue, decksWithCounts, reviewedOn, stats, studyDay } from '../src/study.ts'
import { dueCounts } from '../src/bot.ts'
import { addWord, callTool, cardsOf, deck, listen, makeCtx, rate, send, TZ, type TestCtx } from './helpers.ts'

const D = 86400_000

function addFact(ctx: TestCtx, deckId: string, front: string, back = `${front} — answer`, at = ctx.now()) {
  return createFact(ctx.db, ctx.user.id, { deckId, fact: { front, back }, status: 'active', createdBy: 'user', createdAt: at }, ctx.now())
}

describe('topic decks and facts', () => {
  it('creates topic decks without languages, never as the default deck', () => {
    const ctx = makeCtx()
    const java = createTopicDeck(ctx.db, ctx.user.id, { name: '  Java   Core ' }, ctx.now())
    expect(java).toMatchObject({ kind: 'topic', name: 'Java Core', targetLang: null, nativeLang: null, inReview: true, newPerDay: 15 })
    expect(() => createTopicDeck(ctx.db, ctx.user.id, { name: 'java core' }, ctx.now())).toThrow(/already exists/)
    // A topic deck first does not become the place words go.
    const en = defaultDeck(ctx.db, ctx.user.id, ctx.now())
    expect(en).toMatchObject({ kind: 'language', targetLang: 'en' })
    expect(() => addWord(ctx, 'bone', { deckId: java.id })).toThrow(/topic deck/)
    expect(() => addFact(ctx, en.id, 'What is a monad?')).toThrow(/language deck/)
    // Directions and typed answers don't apply to facts.
    expect(() => updateDeck(ctx.db, ctx.user.id, java.id, { typeAnswer: 'both' })).toThrow(/does not apply/)
    expect(updateDeck(ctx.db, ctx.user.id, java.id, { inReview: false, newPerDay: 3, name: 'Java' })).toMatchObject({ inReview: false, newPerDay: 3, name: 'Java' })
    // Only an empty topic deck can be deleted.
    addFact(ctx, java.id, 'What is the JMM?')
    expect(() => deleteDeck(ctx.db, ctx.user.id, java.id)).toThrow(/still has facts/)
    expect(() => deleteDeck(ctx.db, ctx.user.id, en.id)).toThrow(/only topic decks/)
    const empty = createTopicDeck(ctx.db, ctx.user.id, { name: 'Empty' }, ctx.now())
    deleteDeck(ctx.db, ctx.user.id, empty.id)
    expect(getDeck(ctx.db, ctx.user.id, empty.id)).toBeNull()
  })

  it('cleans facts, dedupes by question and keeps the card on edits', () => {
    expect(cleanFact({ front: '  What is CAS? ', back: 'Compare-and-swap.\r\n\r\n```java\nx.compareAndSet(a, b);  \n```\n\n', tags: [' cas ', 'cas', ''] }))
      .toEqual({ fact: { front: 'What is CAS?', back: 'Compare-and-swap.\n\n```java\nx.compareAndSet(a, b);\n```', tags: ['cas'] } })
    expect(cleanFact({ front: 'Q', back: '  ' })).toEqual({ error: 'back is empty' })

    const ctx = makeCtx()
    const t = createTopicDeck(ctx.db, ctx.user.id, { name: 'Concurrency' }, ctx.now())
    const { fact, cardId } = addFact(ctx, t.id, 'What is a deadlock?')
    expect(fact).toMatchObject({ deckId: t.id, front: 'What is a deadlock?', status: 'active', createdBy: 'user', tags: [] })
    expect(factCard(ctx.db, ctx.user.id, fact.id)).toMatchObject({ id: cardId, wordId: null, factId: fact.id, direction: 'forward', schedule: { state: 0 } })
    expect(() => addFact(ctx, t.id, '  what is a DEADLOCK ')).toThrow(DuplicateFactError)
    rate(ctx, cardId, 3, ctx.now())
    const edited = updateFact(ctx.db, ctx.user.id, fact.id, { back: 'Threads wait for each other **forever**.', tags: ['locks'] }, ctx.now())
    expect(edited).toMatchObject({ front: 'What is a deadlock?', back: 'Threads wait for each other **forever**.', tags: ['locks'] })
    expect(factCard(ctx.db, ctx.user.id, fact.id)!.schedule.reps).toBe(1)
    const other = addFact(ctx, t.id, 'What is a livelock?', 'x', new Date(ctx.now().getTime() + 1000)).fact
    expect(() => updateFact(ctx.db, ctx.user.id, other.id, { front: 'What is a deadlock' }, ctx.now())).toThrow(DuplicateFactError)
    expect(searchFacts(ctx.db, ctx.user.id, { deck: 'Concurrency', q: 'forever' }, ctx.now()).facts.map((f) => f.id)).toEqual([fact.id])
    expect(searchFacts(ctx.db, ctx.user.id, {}, ctx.now())).toMatchObject({ total: 2, facts: [{ deckName: 'Concurrency', card: { state: 'learning' } }, { card: { state: 'new' } }] })
  })

  it('mixes facts into the session, per deck newPerDay, and leaves decks out of review', () => {
    const ctx = makeCtx()
    const en = deck(ctx, 2)
    const t = createTopicDeck(ctx.db, ctx.user.id, { name: 'Databases', newPerDay: 1 }, ctx.now())
    for (let i = 1; i <= 3; i++) addWord(ctx, `w${i}`, { at: new Date(ctx.now().getTime() - (10 - i) * D) })
    const f1 = addFact(ctx, t.id, 'What is MVCC?', 'x', new Date(ctx.now().getTime() - 8.5 * D))
    addFact(ctx, t.id, 'What is a phantom read?', 'x', new Date(ctx.now().getTime() - 5 * D))
    let q = buildQueue(ctx.db, ctx.user.id, TZ, ctx.now())
    // Created-order across both decks, each deck's own budget.
    expect(q.items.map((i) => i.kind === 'fact' ? i.fact.front : i.word.term)).toEqual(['w1', 'What is MVCC?', 'w2'])
    expect(q.items[1]).toMatchObject({ kind: 'fact', deckName: 'Databases', card: { factId: f1.fact.id, wordId: null } })
    expect(q.counts).toEqual({ new: 3, learning: 0, review: 0 })
    expect(q.decks).toEqual([
      { id: en.id, name: 'English', kind: 'language', inReview: true, counts: { new: 2, learning: 0, review: 0 } },
      { id: t.id, name: 'Databases', kind: 'topic', inReview: true, counts: { new: 1, learning: 0, review: 0 } },
    ])

    // Rating a fact counts against its deck's budget; the next fact waits for tomorrow.
    rate(ctx, f1.cardId, 3, ctx.now())
    q = buildQueue(ctx.db, ctx.user.id, TZ, ctx.now())
    expect(q.decks[1]!.counts).toEqual({ new: 0, learning: 1, review: 0 })
    expect(reviewedOn(ctx.db, ctx.user.id, studyDay(ctx.now(), TZ))).toBe(true)

    // Out of review: not queued, still counted for its chip; ?deck= still shows it.
    updateDeck(ctx.db, ctx.user.id, t.id, { inReview: false })
    q = buildQueue(ctx.db, ctx.user.id, TZ, ctx.now())
    expect(q.items.every((i) => i.kind === 'word')).toBe(true)
    expect(q.counts).toEqual({ new: 2, learning: 0, review: 0 })
    expect(q.decks[1]).toMatchObject({ inReview: false, counts: { new: 0, learning: 1, review: 0 } })
    expect(buildQueue(ctx.db, ctx.user.id, TZ, ctx.now(), { deckId: t.id }).items.map((i) => i.kind)).toEqual(['fact'])
    expect(dueCounts(ctx.db, ctx.cfg, ctx.user, ctx.now()).due).toBe(2)
    updateDeck(ctx.db, ctx.user.id, t.id, { inReview: true })
    expect(dueCounts(ctx.db, ctx.cfg, ctx.user, ctx.now()).due).toBe(3)
  })

  it('counts facts in deck counts and stats, words only in per-direction retention', () => {
    const ctx = makeCtx()
    deck(ctx, 5)
    const w = addWord(ctx, 'bone')
    const t = createTopicDeck(ctx.db, ctx.user.id, { name: 'Java Core' }, ctx.now())
    const { cardId } = addFact(ctx, t.id, 'What does volatile guarantee?')
    addFact(ctx, t.id, 'What is a ConcurrentHashMap?')
    rate(ctx, cardId, 3, new Date(ctx.now().getTime() - 3 * D))
    rate(ctx, cardsOf(ctx, w.id)[0]!.id, 3, new Date(ctx.now().getTime() - 3 * D))
    const decks = decksWithCounts(ctx.db, ctx.user.id, TZ, ctx.now())
    expect(decks.find((d) => d.id === t.id)!.counts).toMatchObject({ total: 2, active: 2, inbox: 0, new: 1, newTotal: 1 })
    expect(decks.find((d) => d.kind === 'language')!.counts).toMatchObject({ total: 1, active: 1 })
    const s = stats(ctx.db, ctx.user.id, TZ, ctx.now(), { days: 7 })
    expect(s.reviews).toBe(2)
    expect(s.cardsByState.learning + s.cardsByState.review).toBe(2)
    expect(stats(ctx.db, ctx.user.id, TZ, ctx.now(), { days: 7, deckId: t.id }).reviews).toBe(1)
  })
})

describe('topic deck and fact routes', () => {
  let ctx: TestCtx
  let url: string
  let close: () => Promise<void>
  const api = async (method: string, p: string, body?: unknown) => {
    const r = body === undefined && method === 'GET' ? await fetch(`${url}/api${p}`) : await send(`${url}/api${p}`, method, body ?? {})
    return { status: r.status, body: (await r.json()) as any }
  }

  beforeAll(async () => {
    ctx = makeCtx({ DEV: '1', OWNER_TELEGRAM_ID: '1001', MCP_TOKEN: 'static-mcp-token' })
    const s = await listen(ctx)
    url = s.url
    close = s.close
  })
  afterAll(async () => close())

  it('creates, toggles and deletes topic decks; CRUDs facts; reviews them by card id', async () => {
    // The English deck comes first, on first use.
    expect((await api('GET', '/decks')).body.decks).toMatchObject([{ kind: 'language', name: 'English', inReview: true }])
    expect((await api('POST', '/decks', { kind: 'topic' })).status).toBe(400)
    expect((await api('POST', '/decks', { kind: 'topic', name: 'Java Core', targetLang: 'en' })).status).toBe(400)
    const created = await api('POST', '/decks', { kind: 'topic', name: 'Java Core', newPerDay: 5 })
    expect(created).toMatchObject({ status: 201, body: { deck: { kind: 'topic', name: 'Java Core', newPerDay: 5, inReview: true, targetLang: null } } })
    const id = created.body.deck.id
    expect((await api('POST', '/decks', { kind: 'topic', name: 'java core' })).status).toBe(409)
    expect((await api('PATCH', `/decks/${id}`, { reverseEnabled: false })).status).toBe(400)
    expect((await api('PATCH', `/decks/${id}`, { inReview: false })).body.deck).toMatchObject({ inReview: false })

    const f = await api('POST', '/facts', { deckId: 'Java Core', front: 'What is the JMM?', back: 'The **Java Memory Model**: happens-before.', tags: ['jmm'] })
    expect(f).toMatchObject({ status: 201, body: { fact: { front: 'What is the JMM?', deckName: 'Java Core', status: 'active', createdBy: 'user', card: { state: 'new', direction: 'forward' } } } })
    const factId = f.body.fact.id
    const cardId = f.body.fact.card.id
    expect((await api('POST', '/facts', { deckId: id, front: 'what is the jmm', back: 'x' })).body).toMatchObject({ existing: { id: factId } })
    expect((await api('POST', '/facts', { deckId: 'en', front: 'Q', back: 'A' })).status).toBe(400)
    expect((await api('POST', '/facts', { deckId: id, front: 'Q', back: '' })).status).toBe(400)
    expect((await api('POST', '/words', { deckId: id, term: 'bone', pos: 'noun', translations: ['кость'] })).status).toBe(400)

    // The queue lists every deck for the chips; the topic is off, so no facts yet.
    let q = await api('GET', '/queue')
    expect(q.body.items).toEqual([])
    expect(q.body.decks.map((d: any) => [d.name, d.kind, d.inReview, d.counts.new])).toEqual([['English', 'language', true, 0], ['Java Core', 'topic', false, 1]])
    await api('PATCH', `/decks/${id}`, { inReview: true })
    q = await api('GET', '/queue')
    expect(q.body.items).toMatchObject([{ kind: 'fact', fact: { id: factId }, deckName: 'Java Core', card: { id: cardId } }])

    expect(await api('POST', '/reviews', [{ id: 'rv-fact-1', cardId, rating: 3, reviewedAt: ctx.now().toISOString() }])).toMatchObject({ body: { applied: 1, cards: [{ id: cardId, factId }] } })
    const got = await api('GET', `/facts/${factId}`)
    expect(got.body).toMatchObject({ fact: { card: { state: 'learning' } }, logs: [{ id: 'rv-fact-1', cardId }] })
    expect((await api('POST', '/reviews/undo', { id: 'rv-fact-1' })).body).toMatchObject({ card: { id: cardId, schedule: { state: 0 } } })
    expect((await api('POST', `/cards/${cardId}/suspend`)).body).toMatchObject({ card: { suspended: true, summary: { enabled: true } } })
    await api('POST', `/cards/${cardId}/unsuspend`)

    const patched = await api('PATCH', `/facts/${factId}`, { back: 'Happens-before, visibility, ordering.', tags: [] })
    expect(patched.body.fact).toMatchObject({ back: 'Happens-before, visibility, ordering.', tags: [] })
    expect((await api('PATCH', `/facts/${factId}`, { deckId: 'x' })).status).toBe(400)
    expect((await api('GET', '/facts?deck=Java%20Core&q=visibility')).body).toMatchObject({ total: 1, facts: [{ id: factId }] })
    // Words stay words: the list, the dashboard and autofill are about the language deck.
    expect((await api('GET', '/words')).body.total).toBe(0)
    expect((await api('GET', `/dashboard?deck=${id}`)).status).toBe(400)

    // MCP reports the kind and the switch.
    const decks = await callTool(url, 'static-mcp-token', 'list_decks')
    expect(decks.map((d: any) => [d.name, d.kind, d.inReview, d.targetLang])).toEqual([['English', 'language', true, 'en'], ['Java Core', 'topic', true, null]])

    expect((await api('DELETE', `/decks/${id}`)).status).toBe(409)
    expect((await api('DELETE', `/facts/${factId}`)).body).toEqual({ ok: true })
    expect((await api('GET', `/facts/${factId}`)).status).toBe(404)
    expect((await api('DELETE', `/decks/${id}`)).body).toEqual({ ok: true })
    expect((await api('GET', '/decks')).body.decks.map((d: any) => d.name)).toEqual(['English'])
  })

  it('never shows one user another user\'s facts', () => {
    const other = makeCtx()
    const t = createTopicDeck(other.db, other.user.id, { name: 'Secret' }, other.now())
    const { fact, cardId } = createFact(other.db, other.user.id, { deckId: t.id, fact: { front: 'Q', back: 'A' }, status: 'active', createdBy: 'user' }, other.now())
    expect(() => updateFact(other.db, 'us_nobody', fact.id, { back: 'B' }, other.now())).toThrow(HttpError)
    expect(factCard(other.db, 'us_nobody', fact.id)).toBeNull()
    expect(buildQueue(other.db, 'us_nobody', TZ, other.now()).items).toEqual([])
    expect(cardId).toMatch(/^cd_/)
  })
})
