import { describe, expect, it } from 'vitest'
import { applyReviews, undoReview, wordLogs } from '../src/study.ts'
import { addWord, cardsOf, makeCtx } from './helpers.ts'

describe('reviews', () => {
  it('is idempotent on review ids and applies in reviewedAt order', () => {
    const ctx = makeCtx()
    const note = addWord(ctx, 'q')
    const card = cardsOf(ctx, note.id)[0]!
    const batch = [
      { id: 'b', cardId: card.id, rating: 3 as const, reviewedAt: '2026-10-21T09:20:00.000Z' },
      { id: 'a', cardId: card.id, rating: 1 as const, reviewedAt: '2026-10-21T09:00:00.000Z' },
    ]
    const first = applyReviews(ctx.db, ctx.user.id, batch)
    expect(first).toMatchObject({ applied: 2, skipped: 0 })
    expect(first.cards).toHaveLength(1)
    expect(first.cards[0]!.schedule.reps).toBe(2)

    const logs = wordLogs(ctx.db, ctx.user.id, note.id).reverse()
    expect(logs.map((l) => l.id)).toEqual(['a', 'b'])
    expect(logs[0]!.before.state).toBe(0)
    expect(logs[1]!.before).toEqual(logs[0]!.after)
    expect(cardsOf(ctx, note.id)[0]!.schedule).toEqual(logs[1]!.after)

    // Retried upload: nothing changes.
    const again = applyReviews(ctx.db, ctx.user.id, [...batch, { id: 'x', cardId: 'cd_missing', rating: 3, reviewedAt: '2026-10-21T09:30:00.000Z' }])
    expect(again).toMatchObject({ applied: 0, skipped: 3, cards: [] })
    expect(cardsOf(ctx, note.id)[0]!.schedule.reps).toBe(2)
  })

  it('undoes only the latest review of a card', () => {
    const ctx = makeCtx()
    const note = addWord(ctx, 'q')
    const card = cardsOf(ctx, note.id)[0]!
    applyReviews(ctx.db, ctx.user.id, [
      { id: 'one', cardId: card.id, rating: 3, reviewedAt: '2026-10-21T09:00:00.000Z' },
      { id: 'two', cardId: card.id, rating: 4, reviewedAt: '2026-10-21T09:10:00.000Z' },
    ])
    expect(() => undoReview(ctx.db, ctx.user.id, 'one')).toThrow(/latest/)
    const afterOne = wordLogs(ctx.db, ctx.user.id, note.id).find((l) => l.id === 'one')!.after
    expect(undoReview(ctx.db, ctx.user.id, 'two').schedule).toEqual(afterOne)
    expect(undoReview(ctx.db, ctx.user.id, 'one').schedule).toEqual(card.schedule)
    expect(wordLogs(ctx.db, ctx.user.id, note.id)).toEqual([])
    expect(() => undoReview(ctx.db, ctx.user.id, 'one')).toThrow(/not found/)
  })

  it('sorts reviewedAt as instants, whatever the offset', () => {
    const ctx = makeCtx()
    const note = addWord(ctx, 'q')
    const card = cardsOf(ctx, note.id)[0]!
    // 11:30+03:00 is 08:30Z: before 09:00Z, though its string sorts after.
    applyReviews(ctx.db, ctx.user.id, [
      { id: 'z', cardId: card.id, rating: 3, reviewedAt: '2026-10-21T09:00:00.000Z' },
      { id: 'plus3', cardId: card.id, rating: 1, reviewedAt: '2026-10-21T11:30:00+03:00' },
    ])
    expect(wordLogs(ctx.db, ctx.user.id, note.id).reverse().map((l) => [l.id, l.reviewedAt])).toEqual([['plus3', '2026-10-21T08:30:00.000Z'], ['z', '2026-10-21T09:00:00.000Z']])
  })

  it('slots a late upload of an older rating into the history (two devices)', () => {
    const ctx = makeCtx()
    const note = addWord(ctx, 'q')
    const card = cardsOf(ctx, note.id)[0]!
    const a = { id: 'a', cardId: card.id, rating: 1 as const, reviewedAt: '2026-10-21T09:00:00.000Z' }
    const b = { id: 'b', cardId: card.id, rating: 3 as const, reviewedAt: '2026-10-21T09:20:00.000Z' }
    // In order, on a twin.
    const twin = makeCtx()
    const tw = addWord(twin, 'q')
    const twCard = cardsOf(twin, tw.id)[0]!
    applyReviews(twin.db, twin.user.id, [{ ...a, cardId: twCard.id }, { ...b, cardId: twCard.id }])
    // Device B uploads first, then device A's older rating arrives.
    applyReviews(ctx.db, ctx.user.id, [b])
    applyReviews(ctx.db, ctx.user.id, [a])
    const strip = (l: { id: string; before: unknown; after: unknown }) => [l.id, l.before, l.after]
    expect(wordLogs(ctx.db, ctx.user.id, note.id).map(strip)).toEqual(wordLogs(twin.db, twin.user.id, tw.id).map(strip))
    expect(cardsOf(ctx, note.id)[0]!.schedule).toEqual(cardsOf(twin, tw.id)[0]!.schedule)
    // Undo walks back through both, leaving the card as it was.
    expect(() => undoReview(ctx.db, ctx.user.id, 'a')).toThrow(/latest/)
    undoReview(ctx.db, ctx.user.id, 'b')
    expect(undoReview(ctx.db, ctx.user.id, 'a').schedule).toEqual(card.schedule)
  })
})
