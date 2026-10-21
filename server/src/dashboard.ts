// GET /api/dashboard: one deck's progress — word and card counts, known-word
// growth, activity and streak, retention per direction, frequency coverage
// and the vocabulary-size estimate.
import { dayKey, retrievability, type CardState, type DayOptions, type Deck, type Direction } from '@recall/core'
import type { Db } from './db.ts'
import { termTokens, type Lexicon } from './lexicon.ts'
import { toState, type CardRow } from './repo.ts'
import { KNOWN_R, studyDay } from './study.ts'
import { vocabularySummary, type VocabularySummary } from './vocab.ts'

// Mastered: every enabled direction's card at least this stable.
export const MASTERED_DAYS = 21
export const COVERAGE_BANDS: [number, number][] = [[1, 1000], [1001, 2000], [2001, 5000], [5001, 10000], [10001, 20000], [20001, 30000]]

export interface DirectionCounts {
  enabled: boolean
  new: number
  learning: number
  // Review state with R ≥ 0.9 now.
  known: number
  // Review state but R < 0.9 now (due or overdue).
  fading: number
  suspended: number
}

export interface Dashboard {
  deck: Deck
  counts: {
    words: { total: number; active: number; inbox: number; rejected: number }
    directions: Record<Direction, DirectionCounts>
    // Active words known in any enabled direction.
    known: number
    mastered: number
  }
  growth: { date: string; known: number }[]
  activity: {
    days: { day: string; reviews: number; again: number; timeMs: number }[]
    streak: { current: number; longest: number; studiedToday: boolean }
    totals: { reviews: number; timeMs: number }
  }
  retention: Record<Direction, { rate: number | null; reviews: number }>
  coverage: { from: number; to: number; words: number; known: number }[]
  vocabulary: VocabularySummary
}

interface Row extends CardRow {
  status: string
  term: string
  freq_rank: number | null
}

const known = (s: CardState, at: Date) => s.state === 2 && retrievability(s, at) >= KNOWN_R

export function dashboard(db: Db, userId: string, deck: Deck, lex: Lexicon, opts: DayOptions, now: Date): Dashboard {
  const enabled: Record<Direction, boolean> = { forward: deck.forwardEnabled, reverse: deck.reverseEnabled }
  const words = db.prepare('SELECT status, count(*) AS n FROM words WHERE user_id = ? AND deck_id = ? GROUP BY status').all(userId, deck.id) as { status: string; n: number }[]
  const byStatus = Object.fromEntries(words.map((w) => [w.status, w.n])) as Record<string, number>
  const cards = db.prepare(`
    SELECT c.*, w.status, w.term, w.freq_rank FROM cards c JOIN words w ON w.id = c.word_id
    WHERE w.user_id = ? AND w.deck_id = ? AND w.status = 'active'`).all(userId, deck.id) as unknown as Row[]

  const directions = {
    forward: { enabled: enabled.forward, new: 0, learning: 0, known: 0, fading: 0, suspended: 0 },
    reverse: { enabled: enabled.reverse, new: 0, learning: 0, known: 0, fading: 0, suspended: 0 },
  } satisfies Record<Direction, DirectionCounts>
  const knownWords = new Set<string>()
  const stable = new Map<string, boolean>()
  for (const c of cards) {
    const dir = c.direction as Direction
    const d = directions[dir]
    const s = toState(c)
    if (c.suspended) d.suspended++
    else if (s.state === 0) d.new++
    else if (s.state === 1 || s.state === 3) d.learning++
    else if (known(s, now)) d.known++
    else d.fading++
    if (!enabled[dir]) continue
    if (!c.suspended && known(s, now)) knownWords.add(c.word_id)
    const ok = s.state === 2 && s.stability >= MASTERED_DAYS
    stable.set(c.word_id, (stable.get(c.word_id) ?? true) && ok)
  }
  const mastered = [...stable.values()].filter(Boolean).length

  return {
    deck,
    counts: {
      words: { total: words.reduce((s, w) => s + w.n, 0), active: byStatus.active ?? 0, inbox: byStatus.inbox ?? 0, rejected: byStatus.rejected ?? 0 },
      directions,
      known: knownWords.size,
      mastered,
    },
    growth: growth(db, cards.filter((c) => enabled[c.direction as Direction] && !c.suspended), now),
    activity: activity(db, userId, deck.id, opts, now),
    retention: retention(db, userId, deck.id, now),
    coverage: coverage(cards.filter((c) => enabled[c.direction as Direction]), now),
    vocabulary: vocabularySummary(db, userId, lex, now, deck.id),
  }
}

// Known words at the end of each of the last 26 weeks, reconstructed from
// the review logs: a card's state at t is the `after` of its last review
// before t (cards without logs: their current state from lastReview on), and
// it counts as known at t if that state is review with R(t) ≥ 0.9.
function growth(db: Db, cards: Row[], now: Date, weeks = 26): { date: string; known: number }[] {
  const logs = db.prepare(`SELECT card_id, reviewed_at, "after" FROM review_logs WHERE card_id IN (SELECT value FROM json_each(?)) ORDER BY reviewed_at`)
    .all(JSON.stringify(cards.map((c) => c.id))) as { card_id: string; reviewed_at: string; after: string }[]
  const timeline = new Map<string, { t: number; s: CardState }[]>()
  for (const l of logs) timeline.set(l.card_id, [...(timeline.get(l.card_id) ?? []), { t: Date.parse(l.reviewed_at), s: JSON.parse(l.after) as CardState }])
  for (const c of cards) {
    if (!timeline.has(c.id) && c.state > 0 && c.last_review) timeline.set(c.id, [{ t: Date.parse(c.last_review), s: toState(c) }])
  }
  const points: { date: string; known: number }[] = []
  for (let i = weeks - 1; i >= 0; i--) {
    const at = new Date(now.getTime() - i * 7 * 86400_000)
    const t = at.getTime()
    const set = new Set<string>()
    for (const c of cards) {
      const events = timeline.get(c.id)
      if (!events) continue
      let last: CardState | null = null
      for (const e of events) {
        if (e.t > t) break
        last = e.s
      }
      if (last && known(last, at)) set.add(c.word_id)
    }
    points.push({ date: at.toISOString().slice(0, 10), known: set.size })
  }
  return points
}

function activity(db: Db, userId: string, deckId: string, opts: DayOptions, now: Date, days = 90): Dashboard['activity'] {
  const logs = db.prepare(`
    SELECT l.reviewed_at, l.rating, l.duration_ms FROM review_logs l JOIN cards c ON c.id = l.card_id JOIN words w ON w.id = c.word_id
    WHERE w.user_id = ? AND w.deck_id = ?`).all(userId, deckId) as { reviewed_at: string; rating: number; duration_ms: number | null }[]
  const today = studyDay(now, opts)
  const keys: string[] = []
  for (let i = days - 1; i >= 0; i--) keys.push(dayKey(new Date(today.start.getTime() - i * 86400_000 + 12 * 3600_000), opts))
  const perDay = new Map(keys.map((k) => [k, { day: k, reviews: 0, again: 0, timeMs: 0 }]))
  const studied = new Set<string>()
  for (const l of logs) {
    const k = dayKey(new Date(l.reviewed_at), opts)
    studied.add(k)
    const d = perDay.get(k)
    if (!d) continue
    d.reviews++
    if (l.rating === 1) d.again++
    d.timeMs += l.duration_ms ?? 0
  }
  // Day keys going back from today, one study day at a time (DST-safe).
  const back = (k: string) => dayKey(new Date(Date.parse(`${k}T12:00:00Z`) - 86400_000), { timeZone: 'UTC', startHour: 0 })
  const studiedToday = studied.has(today.key)
  let current = 0
  for (let k = studiedToday ? today.key : back(today.key); studied.has(k); k = back(k)) current++
  let longest = 0
  let run = 0
  let prev: string | null = null
  for (const k of [...studied].sort()) {
    run = prev !== null && back(k) === prev ? run + 1 : 1
    longest = Math.max(longest, run)
    prev = k
  }
  const list = [...perDay.values()]
  return {
    days: list,
    streak: { current, longest, studiedToday },
    totals: { reviews: list.reduce((s, d) => s + d.reviews, 0), timeMs: list.reduce((s, d) => s + d.timeMs, 0) },
  }
}

// Share of non-Again ratings on review-state cards over the last 30 days.
function retention(db: Db, userId: string, deckId: string, now: Date): Dashboard['retention'] {
  const since = new Date(now.getTime() - 30 * 86400_000).toISOString()
  const rows = db.prepare(`
    SELECT c.direction, count(*) AS n, sum(l.rating > 1) AS ok FROM review_logs l JOIN cards c ON c.id = l.card_id JOIN words w ON w.id = c.word_id
    WHERE w.user_id = ? AND w.deck_id = ? AND l.reviewed_at >= ? AND json_extract(l."before", '$.state') = 2 GROUP BY c.direction`)
    .all(userId, deckId, since) as { direction: Direction; n: number; ok: number }[]
  const out: Dashboard['retention'] = { forward: { rate: null, reviews: 0 }, reverse: { rate: null, reviews: 0 } }
  for (const r of rows) out[r.direction] = { rate: r.n ? r.ok / r.n : null, reviews: r.n }
  return out
}

// Single-word terms (distinct lemmas) per frequency band: in the app, and known.
function coverage(cards: Row[], now: Date): Dashboard['coverage'] {
  const inApp = new Map<number, boolean>()
  for (const c of cards) {
    if (c.freq_rank === null || termTokens(c.term).length !== 1) continue
    const k = !c.suspended && known(toState(c), now)
    inApp.set(c.freq_rank, (inApp.get(c.freq_rank) ?? false) || k)
  }
  return COVERAGE_BANDS.map(([from, to]) => {
    let words = 0
    let k = 0
    for (const [rank, isKnown] of inApp) {
      if (rank < from || rank > to) continue
      words++
      if (isKnown) k++
    }
    return { from, to, words, known: k }
  })
}
