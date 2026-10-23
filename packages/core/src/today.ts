// Today's queue rules, in one place for the server (what it sends, counts
// and spends the new-card budget on) and the web app (what it shows). When
// both place cards with the same function, a count can't promise a card the
// review screen won't show.
import type { FsrsState } from './types.ts'

// now: showable at once. later: waits for its due time today (a learning
// step, or a card reviewed today and due again later today). out: not today.
export type TodaySlot = 'now' | 'later' | 'out'

export interface TodayCard {
  id: string
  // The word or fact behind the card: what siblings share.
  itemId: string
  state: FsrsState
  due: string
  lastReview: string | null
  // Known to be reviewed today though `lastReview` doesn't say so yet (rated
  // on this device, upload pending).
  reviewedToday?: boolean
}

// The study day as instants (ms): [start, end).
export interface TodayBounds {
  start: number
  end: number
}

export const isLearningState = (s: FsrsState): boolean => s === 1 || s === 3

// Where one card goes today. `siblingSeen`: another card of its word or fact
// was reviewed today or is earlier in this queue.
export function todaySlot(c: TodayCard, siblingSeen: boolean, day: TodayBounds): TodaySlot {
  const learning = isLearningState(c.state)
  // One card per word per day; learning cards are mid-flight and never buried.
  if (!learning && siblingSeen) return 'out'
  // A new card has no schedule yet: its due (the creation time) never hides it.
  if (c.state === 0) return 'now'
  if (Date.parse(c.due) >= day.end) return 'out'
  if (learning || c.reviewedToday || (c.lastReview !== null && Date.parse(c.lastReview) >= day.start)) return 'later'
  return 'now'
}

// Places cards given in queue order (learning first, then reviews, then new
// cards). A card buries the later review/new cards of its word or fact.
// `reviewed(itemId, cardId)`: another card of that item was reviewed today.
// `admitNew` is asked about each new card that would go in (the day's
// budget); false leaves it out without burying anything.
export function planToday<T>(
  cards: readonly T[],
  view: (t: T) => TodayCard,
  reviewed: (itemId: string, cardId: string) => boolean,
  day: TodayBounds,
  admitNew: (t: T) => boolean = () => true,
): { card: T; slot: 'now' | 'later' }[] {
  const queued = new Set<string>()
  const out: { card: T; slot: 'now' | 'later' }[] = []
  for (const t of cards) {
    const c = view(t)
    const slot = todaySlot(c, queued.has(c.itemId) || reviewed(c.itemId, c.id), day)
    if (slot === 'out' || (c.state === 0 && !admitNew(t))) continue
    queued.add(c.itemId)
    out.push({ card: t, slot })
  }
  return out
}

// Which count a placed card is in: waiting cards count as learning.
export function todayCount(slot: 'now' | 'later', state: FsrsState): 'new' | 'learning' | 'review' {
  if (slot === 'later' || isLearningState(state)) return 'learning'
  return state === 0 ? 'new' : 'review'
}
