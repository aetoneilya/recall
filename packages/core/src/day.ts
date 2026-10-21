// A study day starts at `startHour` local time in `timeZone` (4 a.m. by
// default, like Anki), so reviewing past midnight still counts as "today".
// Server and client use this to agree on the new-cards-per-day budget.

export interface DayOptions {
  timeZone: string
  startHour: number
}

// "2026-10-21" for the study day containing `at`.
export function dayKey(at: Date, { timeZone, startHour }: DayOptions): string {
  const shifted = new Date(at.getTime() - startHour * 3600_000)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(shifted)
}

// The instant the study day after the one containing `at` begins; cards due
// before it count as due today.
export function nextDayStart(at: Date, opts: DayOptions): Date {
  const today = dayKey(at, opts)
  // Step forward in hours until the key changes — DST-safe and cheap.
  let t = new Date(Math.floor(at.getTime() / 3600_000) * 3600_000)
  while (dayKey(t, opts) === today) t = new Date(t.getTime() + 3600_000)
  return t
}
