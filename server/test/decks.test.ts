// Decks as big containers of any card type: decks with and without
// languages, facts and rules anywhere, the per-deck queue under its review
// filter, merging decks into tags, the REST routes and the bot's counts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cleanFact } from '@recall/core'
import { dueCounts, reminderText } from '../src/bot.ts'
import { addExercises } from '../src/exercises.ts'
import { createFact, DuplicateFactError, factCard, searchFacts, updateFact } from '../src/facts.ts'
import { mergeByName } from '../src/merge-decks.ts'
import { createDeck, defaultDeck, deleteDeck, getDeck, HttpError, mergeDecks, searchWords, updateDeck } from '../src/repo.ts'
import { buildQueue, decksWithCounts, reviewOptions, reviewedOn, stats, studyDay } from '../src/study.ts'
import { addWord, callTool, cardsOf, deck, listen, makeCtx, rate, send, TZ, type TestCtx } from './helpers.ts'

const D = 86400_000

function addFact(ctx: TestCtx, deckId: string, front: string, opts: { back?: string; at?: Date; tags?: string[] } = {}) {
  return createFact(ctx.db, ctx.user.id, { deckId, fact: { front, back: opts.back ?? `${front} — answer`, tags: opts.tags }, status: 'active', createdBy: 'user', createdAt: opts.at ?? ctx.now() }, ctx.now())
}
const choose = (n: number) => ({ type: 'choose' as const, text: `Thing ${n} runs ___ noon.`, options: ['at', 'in'], answer: 'at' })
const fronts = (q: ReturnType<typeof buildQueue>) => q.items.map((i) => (i.kind === 'fact' ? i.fact.front : i.word.term))

describe('decks', () => {
  it('has optional languages; words need them, facts go anywhere', () => {
    const ctx = makeCtx()
    const prog = createDeck(ctx.db, ctx.user.id, { name: '  Programming ' }, ctx.now())
    expect(prog).toMatchObject({ name: 'Programming', targetLang: null, nativeLang: null, newPerDay: 5, reviewFilter: null })
    expect(prog).not.toHaveProperty('kind')
    expect(() => createDeck(ctx.db, ctx.user.id, { name: 'programming' }, ctx.now())).toThrow(/already exists/)
    expect(() => createDeck(ctx.db, ctx.user.id, { name: 'X', targetLang: 'de' }, ctx.now())).toThrow(/both/)
    const en = defaultDeck(ctx.db, ctx.user.id, ctx.now())
    expect(en).toMatchObject({ name: 'English', targetLang: 'en', newPerDay: 15 })
    expect(() => createDeck(ctx.db, ctx.user.id, { name: 'More English', targetLang: 'en', nativeLang: 'ru' }, ctx.now())).toThrow(/one deck per language/)
    expect(() => addWord(ctx, 'bone', { deckId: prog.id })).toThrow(/no languages/)
    // A fact in the English deck, a word next to it.
    expect(addFact(ctx, en.id, 'What is the past of begin?').fact.deckId).toBe(en.id)
    addWord(ctx, 'bone')
    expect(decksWithCounts(ctx.db, ctx.user.id, TZ, ctx.now()).map((d) => [d.name, d.counts.total])).toEqual([['English', 2], ['Programming', 0]])
    // Word settings are only for a deck with languages; the rest is for any deck.
    for (const patch of [{ typeAnswer: 'both' as const }, { reverseAfterDays: 5 }, { forwardEnabled: false }, { reverseEnabled: false }])
      expect(() => updateDeck(ctx.db, ctx.user.id, prog.id, patch)).toThrow(/only for a deck with languages/)
    expect(updateDeck(ctx.db, ctx.user.id, prog.id, { newPerDay: 3, name: 'Code' })).toMatchObject({ typeAnswer: 'off', forwardEnabled: true, newPerDay: 3, name: 'Code' })
    expect(updateDeck(ctx.db, ctx.user.id, en.id, { typeAnswer: 'both' })).toMatchObject({ typeAnswer: 'both' })
  })

  it('deletes a deck, with its cards only when asked', () => {
    const ctx = makeCtx()
    const en = deck(ctx)
    addWord(ctx, 'bone')
    const p = createDeck(ctx.db, ctx.user.id, { name: 'Programming' }, ctx.now())
    const { cardId } = addFact(ctx, p.id, 'What is a record?')
    rate(ctx, cardId, 3, ctx.now())
    expect(() => deleteDeck(ctx.db, ctx.user.id, p.id)).toThrow(/still has 1 card$/)
    expect(deleteDeck(ctx.db, ctx.user.id, p.id, { withCards: true })).toEqual({ words: 0, facts: 1 })
    expect(ctx.db.prepare('SELECT count(*) AS n FROM review_logs').get()).toEqual({ n: 0 })
    expect(deleteDeck(ctx.db, ctx.user.id, en.id, { withCards: true })).toEqual({ words: 1, facts: 0 })
    expect(getDeck(ctx.db, ctx.user.id, en.id)).toBeNull()
  })

  it('cleans facts, dedupes by question per deck and moves them with their card', () => {
    expect(cleanFact({ front: '  What is CAS? ', back: 'Compare-and-swap.\r\n', tags: [' cas ', 'cas', ''] })).toEqual({ fact: { front: 'What is CAS?', back: 'Compare-and-swap.', tags: ['cas'] } })
    const ctx = makeCtx()
    const p = createDeck(ctx.db, ctx.user.id, { name: 'Programming' }, ctx.now())
    const { fact, cardId } = addFact(ctx, p.id, 'What is a deadlock?', { tags: ['Concurrency'] })
    expect(factCard(ctx.db, ctx.user.id, fact.id)).toMatchObject({ id: cardId, wordId: null, factId: fact.id, direction: 'forward' })
    expect(() => addFact(ctx, p.id, '  what is a DEADLOCK ')).toThrow(DuplicateFactError)
    rate(ctx, cardId, 3, ctx.now())
    addFact(ctx, p.id, 'What is MVCC?', { tags: ['Databases'] })
    expect(searchFacts(ctx.db, ctx.user.id, { tag: 'Databases' }, ctx.now()).facts.map((f) => f.front)).toEqual(['What is MVCC?'])
    const en = defaultDeck(ctx.db, ctx.user.id, ctx.now())
    expect(updateFact(ctx.db, ctx.user.id, fact.id, { deckId: 'en' }, ctx.now())).toMatchObject({ deckId: en.id })
    expect(factCard(ctx.db, ctx.user.id, fact.id)!.schedule.reps).toBe(1)
  })
})

describe('the per-deck queue and its review filter', () => {
  it('appends a moved fact to its destination plan without reviving its source position', () => {
    const ctx = makeCtx()
    const en = deck(ctx, 10)
    const notes = createDeck(ctx.db, ctx.user.id, { name: 'Notes' }, ctx.now())
    const moving = addFact(ctx, en.id, 'Moving question')
    addFact(ctx, en.id, 'Staying question')
    addFact(ctx, notes.id, 'Destination question')
    buildQueue(ctx.db, ctx.user.id, TZ, ctx.now())
    updateFact(ctx.db, ctx.user.id, moving.fact.id, { deckId: notes.id }, ctx.now())
    const q = buildQueue(ctx.db, ctx.user.id, TZ, ctx.now(), { deckId: notes.id })
    expect(fronts(q)).toEqual(['Destination question', 'Moving question'])
    expect(q.counts.new).toBe(2)
    expect(fronts(buildQueue(ctx.db, ctx.user.id, TZ, ctx.now(), { deckId: en.id }))).toEqual(['Staying question'])
  })

  function setup() {
    const ctx = makeCtx()
    const en = deck(ctx, 10)
    addWord(ctx, 'to give up', { pos: 'phrasal_verb', cefr: 'B1', tags: ['phrasal'], at: new Date(ctx.now().getTime() - 9 * D) })
    addWord(ctx, 'bone', { cefr: 'A2', at: new Date(ctx.now().getTime() - 8 * D) })
    const rule = addFact(ctx, en.id, 'Prepositions of time', { tags: ['Grammar'], at: new Date(ctx.now().getTime() - 7 * D) })
    addExercises(ctx.db, ctx.user.id, rule.fact.id, [choose(1), choose(2), choose(3)], 'user', ctx.now())
    const p = createDeck(ctx.db, ctx.user.id, { name: 'Programming', newPerDay: 2 }, ctx.now())
    addFact(ctx, p.id, 'What is a deadlock?', { tags: ['Concurrency'], at: new Date(ctx.now().getTime() - 6 * D) })
    addFact(ctx, p.id, 'What is MVCC?', { tags: ['Databases'], at: new Date(ctx.now().getTime() - 5 * D) })
    addFact(ctx, p.id, 'What is a livelock?', { tags: ['Concurrency'], at: new Date(ctx.now().getTime() - 4 * D) })
    return { ctx, en, p, rule }
  }

  it('builds one deck\'s session and counts every deck', () => {
    const { ctx, en, p } = setup()
    const q = buildQueue(ctx.db, ctx.user.id, TZ, ctx.now(), { deckId: p.id })
    expect(fronts(q)).toEqual(['What is a deadlock?', 'What is MVCC?'])
    expect(q.counts).toEqual({ new: 2, learning: 0, review: 0 })
    // English: one card per word today (siblings wait), plus the rule.
    expect(q.decks).toEqual([
      { id: en.id, name: 'English', hasLanguages: true, counts: { new: 3, learning: 0, review: 0 } },
      { id: p.id, name: 'Programming', hasLanguages: false, counts: { new: 2, learning: 0, review: 0 } },
    ])
    expect(fronts(buildQueue(ctx.db, ctx.user.id, TZ, ctx.now(), { deckId: en.id }))).toEqual(['bone', 'to give up', 'Prepositions of time'])
  })

  it('applies the filter: by type, tag, part of speech, CEFR and direction; outside cards spend no budget', () => {
    const { ctx, en, p, rule } = setup()
    updateDeck(ctx.db, ctx.user.id, p.id, { reviewFilter: { tags: ['Concurrency'] } })
    // MVCC is outside, so the budget of two goes to both Concurrency facts.
    expect(fronts(buildQueue(ctx.db, ctx.user.id, TZ, ctx.now(), { deckId: p.id }))).toEqual(['What is a deadlock?', 'What is a livelock?'])
    updateDeck(ctx.db, ctx.user.id, en.id, { reviewFilter: { types: ['rule'] } })
    const q = buildQueue(ctx.db, ctx.user.id, TZ, ctx.now(), { deckId: en.id })
    expect(q.items).toMatchObject([{ kind: 'fact', fact: { id: rule.fact.id }, exercises: [{}, {}, {}] }])
    updateDeck(ctx.db, ctx.user.id, en.id, { reviewFilter: { pos: ['phrasal_verb'], directions: ['reverse'] } })
    expect(buildQueue(ctx.db, ctx.user.id, TZ, ctx.now(), { deckId: en.id }).items.map((i) => [i.kind, i.card.direction])).toEqual([['word', 'reverse'], ['fact', 'forward']])
    updateDeck(ctx.db, ctx.user.id, en.id, { reviewFilter: { types: ['word'], cefr: ['A2'] } })
    expect(fronts(buildQueue(ctx.db, ctx.user.id, TZ, ctx.now(), { deckId: en.id }))).toEqual(['bone'])
    expect(getDeck(ctx.db, ctx.user.id, en.id)!.reviewFilter).toEqual({ types: ['word'], cefr: ['A2'] })
    // Two values of one facet: either of them.
    updateDeck(ctx.db, ctx.user.id, en.id, { reviewFilter: { types: ['word'], cefr: ['A2', 'B1'] } })
    expect(fronts(buildQueue(ctx.db, ctx.user.id, TZ, ctx.now(), { deckId: en.id }))).toEqual(['bone', 'to give up'])
    updateDeck(ctx.db, ctx.user.id, en.id, { reviewFilter: { types: ['word', 'rule'], pos: ['noun'] } })
    expect(fronts(buildQueue(ctx.db, ctx.user.id, TZ, ctx.now(), { deckId: en.id }))).toEqual(['bone', 'Prepositions of time'])
    updateDeck(ctx.db, ctx.user.id, en.id, { reviewFilter: { types: ['word'], cefr: ['A2'] } })
    // The deck counts and the bot follow the filters.
    expect(buildQueue(ctx.db, ctx.user.id, TZ, ctx.now()).decks.map((d) => [d.name, d.counts.new])).toEqual([['English', 1], ['Programming', 2]])
    expect(dueCounts(ctx.db, ctx.cfg, ctx.user, ctx.now())).toEqual({ due: 3, decks: [{ name: 'English', due: 1 }, { name: 'Programming', due: 2 }] })
    // Cleared: everything again.
    expect(updateDeck(ctx.db, ctx.user.id, en.id, { reviewFilter: { types: [], tags: [] } }).reviewFilter).toBeNull()
  })

  it('previews a draft filter with the deck\'s options', () => {
    const { ctx, en } = setup()
    const o = reviewOptions(ctx.db, ctx.user.id, TZ, ctx.now(), en.id, { types: ['word'] })
    expect(o.counts).toEqual({ new: 2, learning: 0, review: 0 })
    // A type's other values stay on offer, counted without the type; tags
    // count under the whole draft, so Grammar (no word has it) is gone.
    expect(o.types).toEqual([{ value: 'word', n: 2 }, { value: 'rule', n: 1 }])
    expect(o.tags).toEqual([{ value: 'phrasal', n: 1 }])
    expect(o.pos).toEqual([{ value: 'noun', n: 1 }, { value: 'phrasal_verb', n: 1 }])
    expect(o.cefr).toEqual([{ value: 'A2', n: 1 }, { value: 'B1', n: 1 }])
    expect(o.directions.map((d) => d.value)).toEqual(['forward', 'reverse'])
    // With a noun picked, the phrasal verb is still offered; B1 (only the
    // phrasal verb's) is not.
    const noun = reviewOptions(ctx.db, ctx.user.id, TZ, ctx.now(), en.id, { types: ['word'], pos: ['noun'] })
    expect([noun.counts.new, noun.pos, noun.cefr]).toEqual([1, [{ value: 'noun', n: 1 }, { value: 'phrasal_verb', n: 1 }], [{ value: 'A2', n: 1 }]])
    // Not saved.
    expect(getDeck(ctx.db, ctx.user.id, en.id)!.reviewFilter).toBeNull()
  })

  it('counts facts in stats and reviews them in the right deck', () => {
    const { ctx, p } = setup()
    const q = buildQueue(ctx.db, ctx.user.id, TZ, ctx.now(), { deckId: p.id })
    rate(ctx, q.items[0]!.card.id, 3, ctx.now())
    expect(reviewedOn(ctx.db, ctx.user.id, studyDay(ctx.now(), TZ))).toBe(true)
    expect(stats(ctx.db, ctx.user.id, TZ, ctx.now(), { days: 7, deckId: p.id }).reviews).toBe(1)
    expect(buildQueue(ctx.db, ctx.user.id, TZ, ctx.now(), { deckId: p.id }).counts).toEqual({ new: 1, learning: 1, review: 0 })
  })

  it('says what is due per deck in the bot', () => {
    expect(reminderText({ due: 12 })).toBe('12 cards due')
    expect(reminderText({ due: 29, decks: [{ name: 'English', due: 24 }, { name: 'Programming', due: 5 }] })).toBe('English 24 · Programming 5 due')
    expect(reminderText({ due: 5, decks: [{ name: 'English', due: 5 }] })).toBe('5 cards due')
  })
})

describe('merging decks', () => {
  it('moves words and facts with their history, tagged with the source, skips duplicates and deletes the emptied source', () => {
    const ctx = makeCtx()
    const prog = createDeck(ctx.db, ctx.user.id, { name: 'Programming' }, ctx.now())
    const conc = createDeck(ctx.db, ctx.user.id, { name: 'Concurrency' }, ctx.now())
    const dl = addFact(ctx, conc.id, 'What is a deadlock?', { tags: ['revolut'] })
    rate(ctx, dl.cardId, 3, ctx.now())
    addExercises(ctx.db, ctx.user.id, dl.fact.id, [choose(1)], 'user', ctx.now())
    addFact(ctx, conc.id, 'What is a livelock?', { tags: ['Concurrency'], at: new Date(ctx.now().getTime() + 1000) })
    const r = mergeDecks(ctx.db, ctx.user.id, conc.id, prog.id, { tag: true }, ctx.now())
    expect(r).toEqual({ from: { id: conc.id, name: 'Concurrency', deleted: true }, into: { id: prog.id, name: 'Programming' }, moved: { words: 0, facts: 2 }, skipped: [] })
    expect(getDeck(ctx.db, ctx.user.id, conc.id)).toBeNull()
    expect(searchFacts(ctx.db, ctx.user.id, { deck: prog.id }, ctx.now()).facts.map((f) => [f.front, f.tags])).toEqual([
      ['What is a deadlock?', ['revolut', 'Concurrency']], ['What is a livelock?', ['Concurrency']],
    ])
    expect(factCard(ctx.db, ctx.user.id, dl.fact.id)).toMatchObject({ id: dl.cardId, schedule: { reps: 1 } })
    expect(ctx.db.prepare('SELECT count(*) AS n FROM review_logs').get()).toEqual({ n: 1 })
    expect(ctx.db.prepare('SELECT count(*) AS n FROM fact_exercises WHERE fact_id = ?').get(dl.fact.id)).toEqual({ n: 1 })

    // A duplicate stays behind (and so does its deck); without tag, tags are untouched.
    const db2 = createDeck(ctx.db, ctx.user.id, { name: 'Databases' }, ctx.now())
    const dup = addFact(ctx, db2.id, 'what is a DEADLOCK')
    addFact(ctx, db2.id, 'What is MVCC?')
    const r2 = mergeDecks(ctx.db, ctx.user.id, db2.id, prog.id, { tag: false }, ctx.now())
    expect(r2).toMatchObject({ from: { deleted: false }, moved: { facts: 1 }, skipped: [{ kind: 'fact', id: dup.fact.id, text: 'what is a DEADLOCK' }] })
    expect(searchFacts(ctx.db, ctx.user.id, { q: 'MVCC' }, ctx.now()).facts[0]).toMatchObject({ deckId: prog.id, tags: [] })
    expect(() => mergeDecks(ctx.db, ctx.user.id, prog.id, prog.id, {}, ctx.now())).toThrow(/itself/)
  })

  it('moves words only between decks with the same languages', () => {
    const ctx = makeCtx()
    const en = deck(ctx)
    const w = addWord(ctx, 'bone')
    rate(ctx, cardsOf(ctx, w.id)[0]!.id, 3, ctx.now())
    const prog = createDeck(ctx.db, ctx.user.id, { name: 'Programming' }, ctx.now())
    expect(() => mergeDecks(ctx.db, ctx.user.id, en.id, prog.id, {}, ctx.now())).toThrow(/languages differ/)
    // Facts-only decks merge into a language deck fine.
    const grammar = createDeck(ctx.db, ctx.user.id, { name: 'Grammar' }, ctx.now())
    addFact(ctx, grammar.id, 'since vs for')
    expect(mergeDecks(ctx.db, ctx.user.id, grammar.id, en.id, {}, ctx.now())).toMatchObject({ moved: { facts: 1 }, from: { deleted: true } })
    expect(searchWords(ctx.db, ctx.user.id, {}, ctx.now()).words[0]!.cards.forward).toMatchObject({ reps: 1 })
  })

  it('merges by name from the CLI, creating the target on request, dry runs writing nothing', () => {
    const ctx = makeCtx()
    for (const name of ['Revolut — Java Core', 'Revolut — Databases']) addFact(ctx, createDeck(ctx.db, ctx.user.id, { name }, ctx.now()).id, `Q about ${name}?`)
    expect(() => mergeByName(ctx.db, ctx.user.id, 'Programming', ['Revolut — Java Core'])).toThrow(/--create-into/)
    const dry = mergeByName(ctx.db, ctx.user.id, 'Programming', ['Revolut — Java Core', 'Revolut — Databases', 'Nope'], { create: true, dryRun: true })
    expect(dry).toMatchObject({ into: { name: 'Programming', created: true }, missing: ['Nope'], merged: [{ moved: { facts: 1 } }, { moved: { facts: 1 } }] })
    expect(decksWithCounts(ctx.db, ctx.user.id, TZ, ctx.now()).map((d) => d.name).sort()).toEqual(['Revolut — Databases', 'Revolut — Java Core'])
    mergeByName(ctx.db, ctx.user.id, 'Programming', ['Revolut — Java Core', 'Revolut — Databases'], { create: true })
    const decks = decksWithCounts(ctx.db, ctx.user.id, TZ, ctx.now())
    expect(decks.map((d) => [d.name, d.counts.total, d.tags])).toEqual([['Programming', 2, [{ tag: 'Revolut — Databases', n: 1 }, { tag: 'Revolut — Java Core', n: 1 }]]])
  })
})

describe('deck and fact routes', () => {
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

  it('creates, filters, merges and deletes decks; CRUDs facts in any deck', async () => {
    expect((await api('GET', '/decks')).body.decks).toMatchObject([{ name: 'English', targetLang: 'en', reviewFilter: null, tags: [] }])
    expect((await api('POST', '/decks', {})).status).toBe(400)
    expect((await api('POST', '/decks', { kind: 'topic', name: 'X' })).status).toBe(400)
    const created = await api('POST', '/decks', { name: 'Programming' })
    expect(created).toMatchObject({ status: 201, body: { deck: { name: 'Programming', newPerDay: 5, targetLang: null } } })
    const id = created.body.deck.id
    expect((await api('PATCH', `/decks/${id}`, { inReview: false })).status).toBe(400)
    expect((await api('PATCH', `/decks/${id}`, { reviewFilter: { tags: ['Concurrency'], colour: 'red' } })).status).toBe(400)
    expect((await api('PATCH', `/decks/${id}`, { reviewFilter: { tags: ['Concurrency'] } })).body.deck.reviewFilter).toEqual({ tags: ['Concurrency'] })

    const f = await api('POST', '/facts', { deckId: 'Programming', front: 'What is the JMM?', back: 'Happens-before.', tags: ['Java Core'] })
    expect(f).toMatchObject({ status: 201, body: { fact: { deckName: 'Programming', tags: ['Java Core'] } } })
    await api('POST', '/facts', { deckId: id, front: 'What is a deadlock?', back: 'A cycle of waits.', tags: ['Concurrency'] })
    expect((await api('POST', '/facts', { deckId: 'en', front: 'Q?', back: 'A' })).status).toBe(201)
    expect((await api('POST', '/words', { deckId: id, term: 'bone', pos: 'noun', translations: ['кость'] })).status).toBe(400)
    expect((await api('GET', '/facts?tag=Concurrency')).body).toMatchObject({ total: 1, facts: [{ front: 'What is a deadlock?' }] })

    const q = await api('GET', `/queue?deck=${id}`)
    expect(q.body.items.map((i: any) => i.fact.front)).toEqual(['What is a deadlock?'])
    expect(q.body.decks.map((d: any) => [d.name, d.counts.new])).toEqual([['English', 1], ['Programming', 1]])
    const opt = await api('GET', `/decks/${id}/review-options?filter=${encodeURIComponent(JSON.stringify({ tags: ['Java Core'] }))}`)
    expect(opt.body).toMatchObject({ counts: { new: 1 }, types: [{ value: 'fact', n: 1 }], tags: [{ value: 'Java Core', n: 1 }] })
    expect((await api('GET', `/decks/${id}/review-options?filter=nope`)).status).toBe(400)

    // MCP: decks, a fact with deck + tags, search by tag.
    const decks = await callTool(url, 'static-mcp-token', 'list_decks')
    expect(decks.map((d: any) => [d.name, d.targetLang, d.tags.map((t: any) => t.tag)])).toEqual([['English', 'en', []], ['Programming', null, ['Concurrency', 'Java Core']]])
    expect(await callTool(url, 'static-mcp-token', 'create_deck', { name: 'Reading' })).toMatchObject({ name: 'Reading', targetLang: null })
    expect(await callTool(url, 'static-mcp-token', 'create_topic', { name: 'Old name' })).toMatchObject({ name: 'Old name' })
    const added = await callTool(url, 'static-mcp-token', 'add_facts', { deck: 'Programming', tags: ['Kafka'], facts: [{ front: 'What is a partition?', back: 'An ordered log.', tags: ['basics'] }] })
    expect(added.created).toHaveLength(1)
    expect((await callTool(url, 'static-mcp-token', 'search_facts', { tag: 'Kafka' })).facts).toMatchObject([{ front: 'What is a partition?', tags: ['claude', 'Kafka', 'basics'], status: 'active' }])
    expect((await callTool(url, 'static-mcp-token', 'add_words', { deck: 'Programming', words: [{ term: 'bone', pos: 'noun', translations: ['кость'] }] })).error).toMatch(/no languages/)

    // Merge and delete.
    expect((await api('POST', '/decks/dk_nope/merge', { into: 'Programming' })).status).toBe(404)
    const reading = (await api('GET', '/decks')).body.decks.find((d: any) => d.name === 'Reading')
    expect((await api('POST', `/decks/${reading.id}/merge`, { into: 'Programming' })).body).toMatchObject({ from: { deleted: true }, moved: { words: 0, facts: 0 } })
    expect((await api('DELETE', `/decks/${id}`)).body).toMatchObject({ facts: 3 })
    expect((await api('DELETE', `/decks/${id}?cards=delete`)).body).toEqual({ ok: true, words: 0, facts: 3 })
  })

  it('never shows one user another user\'s facts', () => {
    const other = makeCtx()
    const t = createDeck(other.db, other.user.id, { name: 'Secret' }, other.now())
    const { fact } = createFact(other.db, other.user.id, { deckId: t.id, fact: { front: 'Q', back: 'A' }, status: 'active', createdBy: 'user' }, other.now())
    expect(() => updateFact(other.db, 'us_nobody', fact.id, { back: 'B' }, other.now())).toThrow(HttpError)
    expect(factCard(other.db, 'us_nobody', fact.id)).toBeNull()
    expect(buildQueue(other.db, 'us_nobody', TZ, other.now()).items).toEqual([])
  })
})
