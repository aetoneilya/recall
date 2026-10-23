import { describe, expect, it } from 'vitest'
import { planToday, todayCount, todaySlot, type TodayCard } from './index.ts'

// Study day 2026-10-21 04:00 → 2026-10-22 04:00 MSK; "now" is 13:00 MSK.
const day = { start: Date.parse('2026-10-21T01:00:00Z'), end: Date.parse('2026-10-22T01:00:00Z') }
const at = (h: number) => new Date(Date.parse('2026-10-21T10:00:00Z') + h * 3600_000).toISOString()
const card = (id: string, itemId: string, state: TodayCard['state'], due: string, lastReview: string | null = null): TodayCard => ({ id, itemId, state, due, lastReview })

describe('todaySlot', () => {
  it('shows a new card now whatever its due, even one far in the future', () => {
    expect(todaySlot(card('a', 'w', 0, at(-48)), false, day)).toBe('now')
    expect(todaySlot(card('a', 'w', 0, at(6)), false, day)).toBe('now')
    expect(todaySlot(card('a', 'w', 0, at(72)), false, day)).toBe('now')
  })

  it('buries new and review cards by a sibling, never learning cards', () => {
    expect(todaySlot(card('a', 'w', 0, at(0)), true, day)).toBe('out')
    expect(todaySlot(card('a', 'w', 2, at(-1)), true, day)).toBe('out')
    expect(todaySlot(card('a', 'w', 1, at(0.1)), true, day)).toBe('later')
    expect(todaySlot(card('a', 'w', 3, at(0.1)), true, day)).toBe('later')
  })

  it('keeps reviews and learning cards due before the day ends', () => {
    expect(todaySlot(card('a', 'w', 2, at(-30)), false, day)).toBe('now')
    expect(todaySlot(card('a', 'w', 2, at(14.9)), false, day)).toBe('now')
    expect(todaySlot(card('a', 'w', 2, at(15)), false, day)).toBe('out')
    expect(todaySlot(card('a', 'w', 1, at(15)), false, day)).toBe('out')
  })

  it('makes a card reviewed today wait for its due', () => {
    expect(todaySlot(card('a', 'w', 2, at(5), at(-1)), false, day)).toBe('later')
    expect(todaySlot({ ...card('a', 'w', 2, at(5), at(-24)), reviewedToday: true }, false, day)).toBe('later')
    // Reviewed yesterday, due today: an ordinary review.
    expect(todaySlot(card('a', 'w', 2, at(5), at(-24)), false, day)).toBe('now')
  })
})

describe('planToday', () => {
  const never = () => false

  it('lets the first card of an item in and buries its later review/new siblings', () => {
    const cards = [card('l1', 'A', 1, at(0.1)), card('l2', 'A', 3, at(0.2)), card('r1', 'A', 2, at(-1)), card('n1', 'B', 0, at(-5)), card('n2', 'B', 0, at(-5))]
    expect(planToday(cards, (c) => c, never, day).map((p) => [p.card.id, p.slot])).toEqual([['l1', 'later'], ['l2', 'later'], ['n1', 'now']])
  })

  it('buries a card whose sibling was reviewed today, not one reviewed itself', () => {
    // Today's reviews: a0 (its own) and b0 (the sibling of the new card b1).
    const today: Record<string, string> = { A: 'a0', B: 'b0' }
    const reviewed = (item: string, id: string) => !!today[item] && today[item] !== id
    const out = planToday([card('a0', 'A', 2, at(4), at(-2)), card('b1', 'B', 0, at(0))], (c) => c, reviewed, day)
    expect(out.map((p) => [p.card.id, p.slot])).toEqual([['a0', 'later']])
  })

  it('spends the budget only on new cards that go in', () => {
    let left = 2
    const asked: string[] = []
    const admit = (c: TodayCard) => (asked.push(c.id), left-- > 0)
    const cards = [card('r', 'A', 2, at(-1)), card('a1', 'A', 0, at(0)), card('b0', 'B', 0, at(0)), card('b1', 'B', 0, at(0)), card('c0', 'C', 0, at(0)), card('d0', 'D', 0, at(0))]
    expect(planToday(cards, (c) => c, never, day, admit).map((p) => p.card.id)).toEqual(['r', 'b0', 'c0'])
    // a1 and b1 were buried before the budget was asked.
    expect(asked).toEqual(['b0', 'c0', 'd0'])
  })

  it('a refused new card buries nothing', () => {
    let first = true
    const admit = () => (first ? ((first = false), false) : true)
    const out = planToday([card('a0', 'A', 0, at(0)), card('a1', 'A', 0, at(0))], (c) => c, never, day, admit)
    expect(out.map((p) => p.card.id)).toEqual(['a1'])
  })
})

describe('todayCount', () => {
  it('counts waiting cards as learning', () => {
    expect(todayCount('now', 0)).toBe('new')
    expect(todayCount('now', 2)).toBe('review')
    expect(todayCount('later', 2)).toBe('learning')
    expect(todayCount('later', 1)).toBe('learning')
  })
})
