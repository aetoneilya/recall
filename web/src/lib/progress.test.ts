import { describe, expect, it } from 'vitest'
import { studySummary } from './progress.ts'

describe('studySummary', () => {
  it('includes today and the previous six study days, including empty days', () => {
    const days = Array.from({ length: 8 }, (_, i) => ({ day: `2026-10-${24 + i}`, reviews: 0, again: 0, timeMs: 0 }))
    days[0] = { ...days[0], reviews: 100, again: 100, timeMs: 600_000 }
    days[1] = { ...days[1], reviews: 9, again: 1, timeMs: 90_000 }
    days[7] = { ...days[7], reviews: 1, again: 1, timeMs: 10_000 }
    expect(studySummary(days)).toEqual({ reviews: 10, again: 2, timeMs: 100_000, todayReviews: 1, recalled: 0.8 })
  })

  it('does not present a success rate before any reviews', () => {
    expect(studySummary([])).toEqual({ reviews: 0, again: 0, timeMs: 0, todayReviews: 0, recalled: null })
  })

  it('keeps an empty today instead of taking the last active day', () => {
    expect(studySummary([
      { day: '2026-10-30', reviews: 4, again: 0, timeMs: 1000 },
      { day: '2026-10-31', reviews: 0, again: 0, timeMs: 0 },
    ])).toMatchObject({ reviews: 4, todayReviews: 0, recalled: 1 })
  })
})
