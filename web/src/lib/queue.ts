// Local review queue: what to show next and how a rating changes the queue.
// Pure functions over immutable state so undo is just "restore the previous
// state" and the logic is testable without a DOM.
import { itemOf, nextDayStart, review, type CardState, type DayOptions, type Fact, type QueueItem, type Rating, type Word } from '@recall/core'
import type { Scheduler } from './fsrs.ts'

export interface QueueState {
  // Cards shown in server order (reviews and new cards, already interleaved).
  main: QueueItem[]
  // Time-gated cards (learning/relearning, or anything due again later
  // today), sorted by due. Shown once due, or early when nothing else is left.
  learning: QueueItem[]
  // word (or fact) id → the card of it reviewed today. A word's other
  // direction is buried until tomorrow; the card itself may come back while
  // learning.
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
    const owner = itemOf(raw).id
    const mine = buried[owner]
    // Learning cards are mid-flight and never buried (same rule as the
    // server); review and new cards wait for tomorrow when a sibling was
    // reviewed today or is earlier in this queue.
    if (!isLearning(item.card.schedule)) {
      if (mine && mine !== raw.card.id) continue
      if (words.has(owner)) continue
    }
    words.add(owner)
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
  const wordId = itemOf(item).id
  // Drops the card itself and its review/new sibling; a learning sibling stays.
  const keep = (x: QueueItem) => itemOf(x).id !== wordId || (x.card.id !== item.card.id && isLearning(x.card.schedule))
  const updated: QueueItem = { ...item, card: { ...item.card, schedule: after } }
  let learning = q.learning.filter(keep)
  if (new Date(after.due).getTime() < nextDayStart(now, day).getTime()) learning = insertByDue(learning, updated)
  return {
    queue: { main: q.main.filter(keep), learning, buried: { ...q.buried, [wordId]: item.card.id } },
    after,
    item: updated,
  }
}

export interface Counts {
  new: number
  learning: number
  review: number
}

export function counts(q: QueueState): Counts {
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

// What's left today per deck id, counted like counts().
export function deckCounts(q: QueueState): Record<string, Counts> {
  const out: Record<string, Counts> = {}
  const of = (it: QueueItem) => (out[itemOf(it).deckId] ??= { new: 0, learning: 0, review: 0 })
  for (const it of q.learning) of(it).learning++
  for (const it of q.main) {
    const s = it.card.schedule
    of(it)[s.state === 0 ? 'new' : isLearning(s) ? 'learning' : 'review']++
  }
  return out
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

// A word was edited elsewhere (e.g. "Edit" from the revealed card): its
// items show the new fields at once. A word that left the active set, or a
// card now suspended, drops out.
export function patchWord(list: QueueItem[], word: Word, suspended: ReadonlySet<string> = new Set()): QueueItem[] {
  const gone = word.status !== 'active'
  return list.flatMap((it) => {
    if (it.kind === 'fact' || it.word.id !== word.id) return [it]
    if (gone || suspended.has(it.card.id)) return []
    return [{ ...it, word }]
  })
}

// The same for a fact edited from its card.
export function patchFact(list: QueueItem[], fact: Fact, suspended = false): QueueItem[] {
  const gone = fact.status !== 'active' || suspended
  return list.flatMap((it) => {
    if (it.kind !== 'fact' || it.fact.id !== fact.id) return [it]
    return gone ? [] : [{ ...it, fact }]
  })
}

// A word or fact deleted here: none of its cards stay queued.
export function dropWord(list: QueueItem[], id: string): QueueItem[] {
  return list.filter((it) => itemOf(it).id !== id)
}

// The card on screen keeps the exercises it is being answered with, though a
// refresh brings a newly picked set for it.
export function keepExercises(cur: QueueItem, fresh: QueueItem): QueueItem {
  return cur.kind === 'fact' && fresh.kind === 'fact' && cur.exercises ? { ...fresh, exercises: cur.exercises } : fresh
}

// Items with these cards' schedules put in.
export function withSchedules(list: QueueItem[], schedules: Record<string, CardState>): QueueItem[] {
  return list.map((it) => {
    const s = schedules[it.card.id]
    return s ? { ...it, card: { ...it.card, schedule: s } } : it
  })
}

