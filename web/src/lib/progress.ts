import type { ActivityDay } from './types.ts'

// Activity is ordered by study day and includes empty days through today.
export function studySummary(days: ActivityDay[]) {
  const week = days.slice(-7).reduce(
    (s, d) => ({ reviews: s.reviews + d.reviews, again: s.again + d.again, timeMs: s.timeMs + d.timeMs }),
    { reviews: 0, again: 0, timeMs: 0 },
  )
  return {
    ...week,
    todayReviews: days.at(-1)?.reviews ?? 0,
    recalled: week.reviews ? (week.reviews - week.again) / week.reviews : null,
  }
}
