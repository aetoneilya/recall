// Local review queue: what to show next and how a rating changes the queue.
// Pure functions over immutable state so undo is just "restore the previous
// state" and the logic is testable without a DOM.
import { dayStart, isLearningState, itemOf, nextDayStart, planToday, review, todaySlot, type CardFacts, type CardState, type DayOptions, type Fact, type QueueItem, type Rating, type TodayCard, type Word } from '@recall/core'
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

// Learning cards due within this window may be shown early when nothing else
// is left, so a session doesn't stall on a 1-minute step — but only once the
// minimum gap holds for them. Covers the default 1m/10m FSRS learning steps.
export const LEARN_AHEAD_MS = 20 * 60_000

// The minimum gap: a card rated is not shown again until GAP_CARDS other
// cards have been rated since, or GAP_MS have passed (the user left and came
// back), whichever comes first. A repeat after a card or two is close to
// useless (Pyc & Rawson 2009, Kornell 2009): better to end the session and
// let the card come back later.
export const GAP_CARDS = 10
export const GAP_MS = 5 * 60_000
// How much rating history the session keeps for the gap: a card that fell
// out of it has GAP_CARDS ratings after it.
export const RECENT_MAX = GAP_CARDS + 1

// One rating in the session's recent history, oldest first.
export interface Shown {
  cardId: string
  at: number
}

export const emptyQueue = (): QueueState => ({ main: [], learning: [], buried: {} })

const due = (it: QueueItem) => new Date(it.card.schedule.due).getTime()
const isLearning = (s: CardState) => isLearningState(s.state)

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

const bounds = (now: Date, day: DayOptions) => ({ start: dayStart(now, day).getTime(), end: nextDayStart(now, day).getTime() })
const todayView = (it: QueueItem): TodayCard => ({ id: it.card.id, itemId: itemOf(it).id, state: it.card.schedule.state, due: it.card.schedule.due, lastReview: it.card.schedule.lastReview })

// Builds the queue from server items. `local` holds card states rated on this
// device today; when newer than what the server sent (a rating not yet
// uploaded), they win, and a card no longer due today drops out. `keep`
// filters items out on the spot, e.g. a direction just turned off. Burying
// and what waits are core.planToday's, the server's own rules; `buried` adds
// this device's ratings the server may not have yet.
export function buildQueue(
  items: QueueItem[],
  buried: Record<string, string>,
  local: Record<string, CardState>,
  now: Date,
  day: DayOptions,
  keep: (item: QueueItem) => boolean = () => true,
): QueueState {
  const seen = new Set<string>()
  const list: QueueItem[] = []
  for (const raw of items) {
    if (seen.has(raw.card.id) || raw.card.suspended || !keep(raw)) continue
    seen.add(raw.card.id)
    const l = local[raw.card.id]
    list.push(l && later(l.lastReview, raw.card.schedule.lastReview) ? { ...raw, card: { ...raw.card, schedule: l } } : raw)
  }
  const q: QueueState = { main: [], learning: [], buried: { ...buried } }
  const mine = (itemId: string, cardId: string) => !!buried[itemId] && buried[itemId] !== cardId
  const view = (it: QueueItem) => ({ ...todayView(it), reviewedToday: buried[itemOf(it).id] === it.card.id })
  for (const p of planToday(list, view, mine, bounds(now, day))) {
    if (p.slot === 'later') q.learning = insertByDue(q.learning, p.card)
    else q.main.push(p.card)
  }
  return q
}

// Whether a card may be shown again: not rated lately, or GAP_CARDS other
// cards rated since, or GAP_MS passed since its rating.
export function rested(cardId: string, recent: readonly Shown[], now: number): boolean {
  const i = recent.findLastIndex((s) => s.cardId === cardId)
  if (i < 0) return true
  return recent.length - 1 - i >= GAP_CARDS || now - recent[i]!.at >= GAP_MS
}

// The card to show: a learning card that is due, then the main queue, then
// (nothing else left) a learning card due within the learn-ahead window.
// Every pick keeps the minimum gap (`rested`), so a card is never pulled
// early before the gap holds for it.
export function nextItem(q: QueueState, now: Date, recent: readonly Shown[] = [], learnAheadMs = LEARN_AHEAD_MS): QueueItem | null {
  const t = now.getTime()
  const ok = (it: QueueItem) => rested(it.card.id, recent, t)
  return q.learning.find((it) => due(it) <= t && ok(it)) ?? q.main.find(ok) ?? q.learning.find((it) => due(it) <= t + learnAheadMs && ok(it)) ?? null
}

// Nothing showable now: the card that comes next and when it becomes
// showable (by the rules of nextItem, with nothing rated meanwhile — so only
// GAP_MS can rest it); null when nothing is left today.
export function upcoming(q: QueueState, now: Date, recent: readonly Shown[] = [], learnAheadMs = LEARN_AHEAD_MS): { item: QueueItem; at: Date } | null {
  const t = now.getTime()
  const restedAt = (it: QueueItem) => {
    if (rested(it.card.id, recent, t)) return t
    return recent.findLast((s) => s.cardId === it.card.id)!.at + GAP_MS
  }
  const when = (it: QueueItem, inMain: boolean) => Math.max(restedAt(it), inMain ? t : due(it) - learnAheadMs)
  let best: { item: QueueItem; at: number } | null = null
  for (const [list, inMain] of [[q.main, true], [q.learning, false]] as const) {
    for (const it of list) {
      const at = when(it, inMain)
      if (!best || at < best.at) best = { item: it, at }
    }
  }
  return best && { item: best.item, at: new Date(Math.max(t, best.at)) }
}

// The card nextItem would show once `current` is rated now, so the stack can
// show it underneath: the same rules, gap and learn-ahead included. The
// rating's outcome doesn't matter: the card just rated is never picked
// straight away (the gap), so it can be left out.
export function peekNext(q: QueueState, current: QueueItem, now: Date, recent: readonly Shown[] = [], learnAheadMs = LEARN_AHEAD_MS): QueueItem | null {
  const id = itemOf(current).id
  // What a rating leaves: the card and its review/new siblings go; a learning sibling stays.
  const keep = (x: QueueItem) => itemOf(x).id !== id || (x.card.id !== current.card.id && isLearning(x.card.schedule))
  const after: QueueState = { ...q, main: q.main.filter(keep), learning: q.learning.filter(keep) }
  return nextItem(after, now, [...recent, { cardId: current.card.id, at: now.getTime() }], learnAheadMs)
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
  // Back later today (a learning step) unless core.todaySlot puts it out.
  if (todaySlot(todayView(updated), false, bounds(now, day)) !== 'out') learning = insertByDue(learning, updated)
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
    else r++
  }
  // Waiting cards (learning steps, or due again later today) count as learning, as on the server.
  return { new: n, learning: q.learning.length, review: r }
}

// What's left today per deck id, counted like counts().
export function deckCounts(q: QueueState): Record<string, Counts> {
  const out: Record<string, Counts> = {}
  const of = (it: QueueItem) => (out[itemOf(it).deckId] ??= { new: 0, learning: 0, review: 0 })
  for (const it of q.learning) of(it).learning++
  for (const it of q.main) of(it)[it.card.schedule.state === 0 ? 'new' : 'review']++
  return out
}

export function remaining(q: QueueState): number {
  return q.main.length + q.learning.length
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

// What the review filter looks at, for a queue item (a fact served with
// exercises is a rule).
export function itemFacts(it: QueueItem): CardFacts {
  if (it.kind === 'fact') return { type: it.exercises?.length ? 'rule' : 'fact', tags: it.fact.tags }
  return { type: 'word', tags: it.word.tags, pos: it.word.pos, cefr: it.word.cefr, direction: it.card.direction }
}

// Items with these cards' schedules put in.
export function withSchedules(list: QueueItem[], schedules: Record<string, CardState>): QueueItem[] {
  return list.map((it) => {
    const s = schedules[it.card.id]
    return s ? { ...it, card: { ...it.card, schedule: s } } : it
  })
}


// A practice run's next order: a card got right is done; Again puts it back
// three cards later (at the end, in a short run).
export function practiceStep<T>(queue: T[], ok: boolean): T[] {
  const [head, ...rest] = queue
  if (head === undefined || ok) return rest
  return [...rest.slice(0, 3), head, ...rest.slice(3)]
}
