// Local review queue: what to show next and how a rating changes the queue.
// Pure functions over immutable state so undo is just "restore the previous
// state" and the logic is testable without a DOM.
import { nextDayStart, review, type CardState, type DayOptions, type QueueItem, type Rating } from '@recall/core'
import type { Scheduler } from './fsrs.ts'

export interface QueueState {
  // Cards shown in server order (reviews and new cards, already interleaved).
  main: QueueItem[]
  // Time-gated cards (learning/relearning, or anything due again later
  // today), sorted by due. Shown once due, or early when nothing else is left.
  learning: QueueItem[]
  // wordId → the card of that word reviewed today. Its other direction is
  // buried until tomorrow; the card itself may come back while learning.
  buried: Record<string, string>
}

// Learning cards due within this window are shown when nothing else is left,
// so a session doesn't stall on a 1-minute step. Covers the default 1m/10m
// FSRS learning steps.
export const LEARN_AHEAD_MS = 20 * 60_000

export const emptyQueue = (): QueueState => ({ main: [], learning: [], buried: {} })

const due = (it: QueueItem) => new Date(it.card.schedule.due).getTime()
const isLearning = (s: CardState) => s.state === 1 || s.state === 3

function insertByDue(list: QueueItem[], item: QueueItem): QueueItem[] {
  const t = due(item)
  const i = list.findIndex((x) => due(x) > t)
  return i < 0 ? [...list, item] : [...list.slice(0, i), item, ...list.slice(i)]
}

function later(a: string | null, b: string | null): boolean {
  if (!a) return false
  if (!b) return true
  return new Date(a).getTime() > new Date(b).getTime()
}

// Builds the queue from server items. `local` holds card states rated on this
// device today; when newer than what the server sent (a rating not yet
// uploaded), they win, and a card no longer due today drops out. `keep`
// filters items out on the spot, e.g. a direction just turned off.
export function buildQueue(
  items: QueueItem[],
  buried: Record<string, string>,
  local: Record<string, CardState>,
  now: Date,
  day: DayOptions,
  keep: (item: QueueItem) => boolean = () => true,
): QueueState {
  const dayEnd = nextDayStart(now, day).getTime()
  const seen = new Set<string>()
  const words = new Set<string>()
  const q: QueueState = { main: [], learning: [], buried: { ...buried } }
  for (const raw of items) {
    if (seen.has(raw.card.id) || raw.card.suspended || !keep(raw)) continue
    seen.add(raw.card.id)
    let item = raw
    const l = local[raw.card.id]
    if (l && later(l.lastReview, raw.card.schedule.lastReview)) item = { ...raw, card: { ...raw.card, schedule: l } }
    if (due(item) >= dayEnd) continue
    const mine = buried[raw.word.id]
    // Learning cards are mid-flight and never buried (same rule as the
    // server); review and new cards wait for tomorrow when a sibling was
    // reviewed today or is earlier in this queue.
    if (!isLearning(item.card.schedule)) {
      if (mine && mine !== raw.card.id) continue
      if (words.has(raw.word.id)) continue
    }
    words.add(raw.word.id)
    if (isLearning(item.card.schedule) || mine) q.learning = insertByDue(q.learning, item)
    else q.main.push(item)
  }
  return q
}

export function nextItem(q: QueueState, now: Date, learnAheadMs = LEARN_AHEAD_MS): QueueItem | null {
  const t = now.getTime()
  const l = q.learning[0]
  if (l && due(l) <= t) return l
  if (q.main.length) return q.main[0]
  if (l && due(l) <= t + learnAheadMs) return l
  return null
}

export interface Rated {
  queue: QueueState
  after: CardState
  item: QueueItem
}

export function applyRating(q: QueueState, item: QueueItem, rating: Rating, now: Date, day: DayOptions, f?: Scheduler): Rated {
  const after = review(item.card.schedule, rating, now, f)
  const wordId = item.word.id
  // Drops the card itself and its review/new sibling; a learning sibling stays.
  const keep = (x: QueueItem) => x.word.id !== wordId || (x.card.id !== item.card.id && isLearning(x.card.schedule))
  const updated: QueueItem = { ...item, card: { ...item.card, schedule: after } }
  let learning = q.learning.filter(keep)
  if (new Date(after.due).getTime() < nextDayStart(now, day).getTime()) learning = insertByDue(learning, updated)
  return {
    queue: { main: q.main.filter(keep), learning, buried: { ...q.buried, [wordId]: item.card.id } },
    after,
    item: updated,
  }
}

export function counts(q: QueueState) {
  let n = 0
  let r = 0
  for (const it of q.main) {
    if (it.card.schedule.state === 0) n++
    else if (isLearning(it.card.schedule)) continue
    else r++
  }
  const learning = q.learning.length + q.main.filter((it) => isLearning(it.card.schedule)).length
  return { new: n, learning, review: r }
}

export function remaining(q: QueueState): number {
  return q.main.length + q.learning.length
}

// Time-gated cards that aren't showable yet: "3 more due in 14 min".
export function waiting(q: QueueState, now: Date, learnAheadMs = LEARN_AHEAD_MS): { count: number; next: Date | null } {
  if (q.main.length) return { count: 0, next: null }
  const t = now.getTime() + learnAheadMs
  const rest = q.learning.filter((x) => due(x) > t)
  return { count: rest.length, next: rest.length ? new Date(due(rest[0])) : null }
}

// Every item of the queue, for persisting it.
export function allItems(q: QueueState): QueueItem[] {
  return [...q.learning, ...q.main]
}
