// The server's queue as the review screen plays it: server buildQueue → the
// web's buildQueue → nextItem. Whatever the server counts and spends the
// new-card budget on, the session shows.
import { describe, expect, it } from 'vitest'
import type { QueueItem, Rating } from '@recall/core'
import { applyRating, buildQueue as clientQueue, counts, nextItem, type QueueState, type Shown } from '../../web/src/lib/queue.ts'
import { updateDeck } from '../src/repo.ts'
import { addExtraNew, buildQueue, decksWithCounts, studyDay } from '../src/study.ts'
import { addWord, cardsOf, deck, makeCtx, rate, TZ, wordOf, type TestCtx } from './helpers.ts'

// Plays the session to its end the way the store does (ratings recorded in
// `buried` and the gap history); returns the cards shown, "term:direction".
function play(ctx: TestCtx, items: QueueItem[], buried: Record<string, string>, rating: Rating = 4): string[] {
  let q: QueueState = clientQueue(items, buried, {}, ctx.now(), TZ)
  const recent: Shown[] = []
  const shown: string[] = []
  for (let cur = nextItem(q, ctx.now(), recent); cur; cur = nextItem(q, ctx.now(), recent)) {
    shown.push(`${wordOf(cur).term}:${cur.card.direction}`)
    q = applyRating(q, cur, rating, ctx.now(), TZ).queue
    recent.push({ cardId: cur.card.id, at: ctx.now().getTime() })
  }
  return shown
}

const later = (ctx: TestCtx, ms: number) => (ctx.clock.t = new Date(ctx.now().getTime() + ms))

describe('+5 new after a session', () => {
  it('brings five cards the session shows, not the reverse siblings of words reviewed today', () => {
    const ctx = makeCtx()
    const d = deck(ctx, 4)
    const words = Array.from({ length: 12 }, (_, i) => addWord(ctx, `w${i}`, { at: new Date(Date.UTC(2026, 9, 1, 0, i)) }))
    // Today's session: the forward cards of w0..w2 introduced and graduated.
    const buried: Record<string, string> = {}
    for (const w of words.slice(0, 3)) {
      const fwd = cardsOf(ctx, w.id)[0]!
      rate(ctx, fwd.id, 3, ctx.now())
      rate(ctx, fwd.id, 4, later(ctx, 60_000))
      buried[w.id] = fwd.id
    }
    // An older word: its forward card reviewed today and due again tonight;
    // its reverse card is new.
    const old = addWord(ctx, 'w-old', { at: new Date('2026-09-01T00:00:00Z') })
    const [oldFwd] = cardsOf(ctx, old.id)
    rate(ctx, oldFwd!.id, 4, ctx.now())
    ctx.db.prepare('UPDATE cards SET due = ? WHERE id = ?').run(new Date(ctx.now().getTime() + 5 * 3600_000).toISOString(), oldFwd!.id)
    buried[old.id] = oldFwd!.id
    later(ctx, 60_000)

    // The day's 4 are used (w-old's forward was new too): nothing new until +5.
    expect(buildQueue(ctx.db, ctx.user.id, TZ, ctx.now(), { deckId: d.id }).counts).toEqual({ new: 0, learning: 1, review: 0 })
    addExtraNew(ctx.db, ctx.user.id, d.id, studyDay(ctx.now(), TZ).key, 5)
    const q = buildQueue(ctx.db, ctx.user.id, TZ, ctx.now(), { deckId: d.id })
    expect(q.counts).toEqual({ new: 5, learning: 1, review: 0 })
    expect(q.decks.find((x) => x.id === d.id)!.counts).toEqual(q.counts)
    expect(decksWithCounts(ctx.db, ctx.user.id, TZ, ctx.now()).find((x) => x.id === d.id)!.counts.new).toBe(5)
    // The client counts the same and shows exactly those five.
    expect(counts(clientQueue(q.items, buried, {}, ctx.now(), TZ))).toEqual(q.counts)
    expect(play(ctx, q.items, buried)).toEqual(['w3:forward', 'w4:forward', 'w5:forward', 'w6:forward', 'w7:forward'])
  })

  it('spends nothing on a disabled direction or a card outside the filter, and shows a new card with a future due', () => {
    const ctx = makeCtx()
    const d = deck(ctx, 0)
    const a = addWord(ctx, 'alpha', { at: new Date('2026-10-01T00:00:00Z'), tags: ['x'] })
    addWord(ctx, 'bravo', { at: new Date('2026-10-02T00:00:00Z') })
    const c = addWord(ctx, 'charlie', { at: new Date('2026-10-03T00:00:00Z'), tags: ['x'] })
    addWord(ctx, 'delta', { at: new Date('2026-10-04T00:00:00Z'), tags: ['x'] })
    // charlie's new cards carry a due days ahead: new cards show whatever their due.
    ctx.db.prepare("UPDATE cards SET due = '2026-10-30T00:00:00.000Z' WHERE word_id = ?").run(c.id)
    updateDeck(ctx.db, ctx.user.id, d.id, { forwardEnabled: false, reviewFilter: { tags: ['x'] } }, studyDay(ctx.now(), TZ).key)
    addExtraNew(ctx.db, ctx.user.id, d.id, studyDay(ctx.now(), TZ).key, 2)
    const q = buildQueue(ctx.db, ctx.user.id, TZ, ctx.now(), { deckId: d.id })
    expect(q.items.map((i) => `${wordOf(i).term}:${i.card.direction}`)).toEqual(['alpha:reverse', 'charlie:reverse'])
    expect(q.counts.new).toBe(2)
    expect(play(ctx, q.items, {})).toEqual(['alpha:reverse', 'charlie:reverse'])
    void a
  })
})

describe('counts match what the session shows', () => {
  it('counts a card reviewed today and due again later today as learning, on both sides', () => {
    const ctx = makeCtx()
    const d = deck(ctx, 0)
    const w = addWord(ctx, 'frown')
    const [fwd] = cardsOf(ctx, w.id)
    rate(ctx, fwd!.id, 4, ctx.now())
    ctx.db.prepare('UPDATE cards SET due = ? WHERE id = ?').run(new Date(ctx.now().getTime() + 6 * 3600_000).toISOString(), fwd!.id)
    const q = buildQueue(ctx.db, ctx.user.id, TZ, ctx.now(), { deckId: d.id })
    expect(q.counts).toEqual({ new: 0, learning: 1, review: 0 })
    expect(q.decks.find((x) => x.id === d.id)!.counts).toEqual({ new: 0, learning: 1, review: 0 })
    const cq = clientQueue(q.items, {}, {}, ctx.now(), TZ)
    expect(counts(cq)).toEqual(q.counts)
    // Not showable now: the session waits for it.
    expect(nextItem(cq, ctx.now())).toBeNull()
  })
})
