import { describe, expect, it } from 'vitest'
import { createFact, factCard } from '../src/facts.ts'
import { cardSummary, getDeck, setWordSuspended, updateDeck } from '../src/repo.ts'
import { buildQueue, decksWithCounts, reviewedOn, stats, studyDay, wordLogs } from '../src/study.ts'
import { addWord, cardsOf, deck, makeCtx, otherDeck, rate, TZ, wordOf } from './helpers.ts'

describe('study day', () => {
  it('spans 04:00 to 04:00 Moscow time', () => {
    const d = studyDay(new Date('2026-10-21T22:30:00Z'), TZ) // 01:30 MSK on the 22nd
    expect(d.key).toBe('2026-10-21')
    expect(d.start.toISOString()).toBe('2026-10-21T01:00:00.000Z')
    expect(d.end.toISOString()).toBe('2026-10-22T01:00:00.000Z')
  })
})

describe('reviewedOn', () => {
  it('tells whether the user reviewed anything in a study day', () => {
    const ctx = makeCtx()
    const w = addWord(ctx, 'frown')
    const today = studyDay(ctx.now(), TZ)
    expect(reviewedOn(ctx.db, ctx.user.id, today)).toBe(false)
    rate(ctx, cardsOf(ctx, w.id)[0]!.id, 3, ctx.now())
    expect(reviewedOn(ctx.db, ctx.user.id, today)).toBe(true)
    expect(reviewedOn(ctx.db, 'us_other', today)).toBe(false)
    expect(reviewedOn(ctx.db, ctx.user.id, studyDay(new Date('2026-10-22T09:00:00Z'), TZ))).toBe(false)
  })
})

describe('queue', () => {
  it('caps new cards per deck per study day, counting cards introduced today', () => {
    const ctx = makeCtx()
    const en = deck(ctx, 2)
    const de = otherDeck(ctx, 'de', 1)
    const words = [1, 2, 3, 4, 5].map((i) => addWord(ctx, `a${i}`, { at: new Date(Date.UTC(2026, 9, 1, 0, i)) }))
    addWord(ctx, 'b1', { deckId: de.id })
    addWord(ctx, 'b2', { deckId: de.id })

    let q = buildQueue(ctx.db, ctx.user.id, TZ, ctx.now())
    expect(q.counts).toEqual({ new: 3, learning: 0, review: 0 })
    // One card per word per day: forward cards of a1 and a2.
    expect(q.items.filter((i) => wordOf(i).deckId === en.id).map((i) => [wordOf(i).term, i.card.direction])).toEqual([['a1', 'forward'], ['a2', 'forward']])
    expect(q.items[0]!.deckName).toBe('English')

    // Introducing a1 uses one of English's two slots; it comes back as a learning card.
    rate(ctx, cardsOf(ctx, words[0]!.id)[0]!.id, 1, ctx.now())
    q = buildQueue(ctx.db, ctx.user.id, TZ, ctx.now())
    expect(q.counts).toEqual({ new: 2, learning: 1, review: 0 })
    expect(wordOf(q.items[0]!).term).toBe('a1')
    expect(q.items.filter((i) => i.card.schedule.state === 0 && wordOf(i).deckId === en.id).map((i) => wordOf(i).term)).toEqual(['a2'])

    // Next study day: the budget resets (a1's reverse card stays buried by its forward card, still learning).
    ctx.clock.t = new Date('2026-10-22T09:00:00Z')
    q = buildQueue(ctx.db, ctx.user.id, TZ, ctx.now())
    expect(q.items.filter((i) => i.card.schedule.state === 0 && wordOf(i).deckId === en.id).map((i) => wordOf(i).term)).toEqual(['a2', 'a3'])
  })

  it("brings yesterday's learning cards first the next day, counted as learning", () => {
    const ctx = makeCtx()
    deck(ctx, 2)
    addWord(ctx, 'a', { at: new Date('2026-10-01T00:00:00Z') })
    const b = addWord(ctx, 'b', { at: new Date('2026-10-02T00:00:00Z') })
    rate(ctx, cardsOf(ctx, b.id)[0]!.id, 1, ctx.now())
    // b's 1-minute step was due yesterday; a is still new.
    ctx.clock.t = new Date('2026-10-22T09:00:00Z')
    const q = buildQueue(ctx.db, ctx.user.id, TZ, ctx.now())
    expect(q.items.map((i) => [wordOf(i).term, i.card.schedule.state])).toEqual([['b', 1], ['a', 0]])
    expect(q.counts).toEqual({ new: 1, learning: 1, review: 0 })
  })

  it('buries siblings across directions: one card per word per day', () => {
    const ctx = makeCtx()
    const word = addWord(ctx, 'to frown', { pos: 'verb', translations: ['хмуриться'] })
    const [fwd, rev] = cardsOf(ctx, word.id)
    expect([fwd!.direction, rev!.direction]).toEqual(['forward', 'reverse'])

    let q = buildQueue(ctx.db, ctx.user.id, TZ, ctx.now())
    expect(q.items.map((i) => i.card.id)).toEqual([fwd!.id])

    rate(ctx, fwd!.id, 1, ctx.now())
    q = buildQueue(ctx.db, ctx.user.id, TZ, ctx.now())
    // forward continues its learning steps; reverse stays buried today.
    expect(q.items.map((i) => i.card.id)).toEqual([fwd!.id])

    rate(ctx, fwd!.id, 4, new Date(ctx.now().getTime() + 60_000))
    expect(buildQueue(ctx.db, ctx.user.id, TZ, ctx.now()).items).toEqual([])

    // Next day, with forward not due, reverse is introduced.
    ctx.db.prepare("UPDATE cards SET due = '2026-12-01T00:00:00.000Z' WHERE id = ?").run(fwd!.id)
    ctx.clock.t = new Date('2026-10-22T09:00:00Z')
    q = buildQueue(ctx.db, ctx.user.id, TZ, ctx.now())
    expect(q.items.map((i) => i.card.id)).toEqual([rev!.id])
  })

  it('orders learning, then the day\'s shuffle of reviews, with a new card after every 4 reviews', () => {
    const ctx = makeCtx()
    const set = ctx.db.prepare("UPDATE cards SET state = ?, due = ?, stability = 5, difficulty = 5, reps = 3, last_review = ? WHERE word_id = ? AND direction = 'forward'")
    // Reverse cards stay new; their words are already taken today by the forward card.
    for (const h of [8, 3, 6, 1, 7, 2, 5, 4]) set.run(2, new Date(Date.UTC(2026, 9, 20, h)).toISOString(), '2026-10-10T00:00:00.000Z', addWord(ctx, `review ${h}`).id)
    set.run(1, '2026-10-21T09:30:00.000Z', '2026-10-21T08:00:00.000Z', addWord(ctx, 'learning').id)
    set.run(2, '2026-10-25T09:00:00.000Z', '2026-10-10T00:00:00.000Z', addWord(ctx, 'not due').id)
    addWord(ctx, 'new 1', { at: new Date('2026-10-01T00:00:00Z') })
    addWord(ctx, 'new 2', { at: new Date('2026-10-02T00:00:00Z') })
    setWordSuspended(ctx.db, ctx.user.id, addWord(ctx, 'suspended').id, true)
    addWord(ctx, 'dropped', { status: 'rejected' })

    const q = buildQueue(ctx.db, ctx.user.id, TZ, ctx.now())
    const terms = q.items.map((i) => wordOf(i).term)
    expect(terms[0]).toBe('learning')
    expect([terms[5], terms[10], terms[11]]).toEqual(['new 1', 'new 2', 'not due'])
    const reviews = terms.filter((t) => t.startsWith('review '))
    expect([...reviews].sort()).toEqual(['review 1', 'review 2', 'review 3', 'review 4', 'review 5', 'review 6', 'review 7', 'review 8'])
    expect(reviews).not.toEqual([...reviews].sort())
    // "not due" has a new reverse card, introduced as the third new card.
    expect(q.counts).toEqual({ new: 3, learning: 1, review: 8 })
    expect(buildQueue(ctx.db, ctx.user.id, TZ, ctx.now(), { limit: 3 }).items).toHaveLength(3)

    // The same order all day; rating one keeps the rest in place.
    expect(buildQueue(ctx.db, ctx.user.id, TZ, ctx.now()).items.map((i) => wordOf(i).term)).toEqual(terms)
    const first = q.items.find((i) => wordOf(i).term === reviews[0])!
    rate(ctx, first.card.id, 3, ctx.now())
    const after = buildQueue(ctx.db, ctx.user.id, TZ, ctx.now()).items.map((i) => wordOf(i).term).filter((t) => t.startsWith('review '))
    expect(after).toEqual(reviews.slice(1))
  })

  it('takes new cards in turn from each source, each in the order added', () => {
    const ctx = makeCtx()
    updateDeck(ctx.db, ctx.user.id, deck(ctx, 4).id, { reverseEnabled: false })
    let day = 1
    const add = (term: string, tags: string[]) => addWord(ctx, term, { tags, at: new Date(Date.UTC(2026, 8, day++)) })
    for (const t of ['book 1', 'book 2', 'book 3', 'book 4']) add(t, ['Books/the king'])
    add('leon 1', ['Leon/words'])
    add('book 5', ['Books/wuthering heights'])
    add('leon 2', ['Leon/idioms'])
    add('plain', [])

    const q = buildQueue(ctx.db, ctx.user.id, TZ, ctx.now())
    expect(q.items.map((i) => wordOf(i).term)).toEqual(['book 1', 'leon 1', 'plain', 'book 2'])
  })
})

describe('direction settings', () => {
  it('hides a disabled direction from queue, counts and stats, keeping its history, and restores it', () => {
    const ctx = makeCtx()
    const d = deck(ctx)
    const w = addWord(ctx, 'frown')
    const [fwd, rev] = cardsOf(ctx, w.id)
    // Put the reverse card into review with a history.
    rate(ctx, rev!.id, 3, new Date('2026-10-01T09:00:00Z'))
    ctx.db.prepare("UPDATE cards SET due = '2026-10-20T09:00:00.000Z' WHERE id = ?").run(rev!.id)
    const revBefore = cardsOf(ctx, w.id)[1]!

    let q = buildQueue(ctx.db, ctx.user.id, TZ, ctx.now())
    expect(q.items.map((i) => i.card.direction)).toEqual(['reverse'])
    expect(decksWithCounts(ctx.db, ctx.user.id, TZ, ctx.now())[0]!.counts).toMatchObject({ due: 1, newTotal: 1 })

    updateDeck(ctx.db, ctx.user.id, d.id, { reverseEnabled: false })
    q = buildQueue(ctx.db, ctx.user.id, TZ, ctx.now())
    expect(q.items.map((i) => i.card.id)).toEqual([fwd!.id])
    expect(q.counts).toEqual({ new: 1, learning: 0, review: 0 })
    expect(decksWithCounts(ctx.db, ctx.user.id, TZ, ctx.now())[0]!.counts).toMatchObject({ due: 0, new: 1, newTotal: 1 })
    const st = stats(ctx.db, ctx.user.id, TZ, ctx.now())
    expect(st.forecast[0]!.due).toBe(0)
    expect(st.cardsByState).toMatchObject({ new: 1, review: 0 })
    // The card and its history are untouched.
    expect(cardsOf(ctx, w.id)[1]).toEqual(revBefore)
    expect(wordLogs(ctx.db, ctx.user.id, w.id)).toHaveLength(1)

    updateDeck(ctx.db, ctx.user.id, d.id, { reverseEnabled: true })
    expect(buildQueue(ctx.db, ctx.user.id, TZ, ctx.now()).items.map((i) => i.card.id)).toEqual([rev!.id])
    expect(() => updateDeck(ctx.db, ctx.user.id, d.id, { forwardEnabled: false, reverseEnabled: false })).toThrow(/at least one direction/)
    expect(getDeck(ctx.db, ctx.user.id, d.id)).toMatchObject({ forwardEnabled: true, reverseEnabled: true })
  })

  it('introduces reverse cards only once the forward card is stable enough (reverseAfterDays)', () => {
    const ctx = makeCtx()
    const d = deck(ctx)
    updateDeck(ctx.db, ctx.user.id, d.id, { reverseAfterDays: 10 })
    const w = addWord(ctx, 'frown')
    const [fwd, rev] = cardsOf(ctx, w.id)
    ctx.db.prepare("UPDATE cards SET state = 2, stability = 4, due = '2026-11-01T00:00:00.000Z', last_review = '2026-10-15T00:00:00.000Z' WHERE id = ?").run(fwd!.id)
    expect(buildQueue(ctx.db, ctx.user.id, TZ, ctx.now()).items).toEqual([])
    expect(decksWithCounts(ctx.db, ctx.user.id, TZ, ctx.now())[0]!.counts).toMatchObject({ new: 0, newTotal: 1 })

    ctx.db.prepare('UPDATE cards SET stability = 12 WHERE id = ?').run(fwd!.id)
    expect(buildQueue(ctx.db, ctx.user.id, TZ, ctx.now()).items.map((i) => i.card.id)).toEqual([rev!.id])

    // With forward turned off, the gate no longer applies.
    ctx.db.prepare('UPDATE cards SET stability = 1 WHERE id = ?').run(fwd!.id)
    updateDeck(ctx.db, ctx.user.id, d.id, { forwardEnabled: false })
    expect(buildQueue(ctx.db, ctx.user.id, TZ, ctx.now()).items.map((i) => i.card.id)).toEqual([rev!.id])
    expect(() => updateDeck(ctx.db, ctx.user.id, d.id, { reverseAfterDays: 0 })).toThrow(/reverseAfterDays/)
    expect(() => updateDeck(ctx.db, ctx.user.id, d.id, { reverseAfterDays: 1.5 })).toThrow(/reverseAfterDays/)
  })

  it('lets a reverse card through the gate when its forward card is suspended', () => {
    const ctx = makeCtx()
    const d = deck(ctx)
    updateDeck(ctx.db, ctx.user.id, d.id, { reverseAfterDays: 10 })
    const w = addWord(ctx, 'frown')
    const [fwd, rev] = cardsOf(ctx, w.id)
    expect(buildQueue(ctx.db, ctx.user.id, TZ, ctx.now()).items.map((i) => i.card.id)).toEqual([fwd!.id])
    // Forward suspended while new: it will never get stable, so reverse is what's studied.
    ctx.db.prepare('UPDATE cards SET suspended = 1 WHERE id = ?').run(fwd!.id)
    expect(buildQueue(ctx.db, ctx.user.id, TZ, ctx.now()).items.map((i) => i.card.id)).toEqual([rev!.id])
  })

  it('applies directions to word cards only: facts and rules stay in the session', () => {
    const ctx = makeCtx()
    const d = deck(ctx)
    addWord(ctx, 'frown')
    const { fact } = createFact(ctx.db, ctx.user.id, { deckId: d.id, fact: { front: 'Why?', back: 'Because.' }, status: 'active', createdBy: 'user', createdAt: ctx.now() }, ctx.now())
    updateDeck(ctx.db, ctx.user.id, d.id, { forwardEnabled: false })
    const q = buildQueue(ctx.db, ctx.user.id, TZ, ctx.now())
    expect(q.items.map((i) => `${i.kind} ${i.card.direction}`).sort()).toEqual(['fact forward', 'word reverse'])
    expect(decksWithCounts(ctx.db, ctx.user.id, TZ, ctx.now())[0]!.counts).toMatchObject({ new: 2, newTotal: 2 })
    expect(stats(ctx.db, ctx.user.id, TZ, ctx.now()).cardsByState).toMatchObject({ new: 2 })
    expect(cardSummary(factCard(ctx.db, ctx.user.id, fact.id)!, getDeck(ctx.db, ctx.user.id, d.id)!, ctx.now()).enabled).toBe(true)
  })
})
