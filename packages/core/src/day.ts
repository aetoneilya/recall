// A study day starts at `startHour` local time in `timeZone` (4 a.m. by
// default, like Anki), so reviewing past midnight still counts as "today".
// Server and client use this to agree on the new-cards-per-day budget.

export interface DayOptions {
  timeZone: string
  startHour: number
}

const formats = new Map<string, Intl.DateTimeFormat>()
const format = (timeZone: string) => {
  let f = formats.get(timeZone)
  if (!f) formats.set(timeZone, (f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })))
  return f
}

// "2026-10-21" for the study day containing `at`.
export function dayKey(at: Date, { timeZone, startHour }: DayOptions): string {
  return format(timeZone).format(new Date(at.getTime() - startHour * 3600_000))
}

const H = 3600_000
// Every zone's offset is a whole number of quarter hours (India +5:30, Nepal +5:45).
const Q = 15 * 60_000

// The instant the study day after the one containing `at` begins; cards due
// before it count as due today. Steps in hours, then quarters: DST-safe and cheap.
export function nextDayStart(at: Date, opts: DayOptions): Date {
  const today = dayKey(at, opts)
  let t = Math.floor(at.getTime() / Q) * Q
  while (dayKey(new Date(t + H), opts) === today) t += H
  while (dayKey(new Date(t), opts) === today) t += Q
  return new Date(t)
}

// The instant the study day containing `at` began.
export function dayStart(at: Date, opts: DayOptions): Date {
  const today = dayKey(at, opts)
  let t = Math.floor(at.getTime() / Q) * Q
  while (dayKey(new Date(t - H), opts) === today) t -= H
  while (dayKey(new Date(t - Q), opts) === today) t -= Q
  return new Date(t)
}
