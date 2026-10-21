// Everything that depends on the study day: the queue, applying ratings,
// per-deck counts, stats and leeches. All scoped to one user; `opts` carries
// that user's time zone. Disabled directions are invisible here: their
// cards are not queued, counted or forecast (they keep their state).
// Words' and facts' cards are read alike through the study_cards view
// (db.ts v6): `c.item_id` is the word or fact, `c.deck_id`/`c.user_id` its own.
import {
  dayKey, nextDayStart, retrievability, review,
  type Card, type CardState, type DayOptions, type DeckKind, type Direction, type QueueItem, type Rating, type ReviewInput, type ReviewLog,
} from '@recall/core'
import { tx, type Db } from './db.ts'
import { exercisesForQueue, recordAttempts, revertAttempts } from './exercises.ts'
import { toFact, type FactRow } from './facts.ts'
import { userScheduler } from './fsrs.ts'
import {
  ENABLED_DIRECTION, HttpError, listDecks, STATE_COLUMNS, stateValues, toCard, toState, toWord,
  type CardRow, type DeckInfo, type WordRow,
} from './repo.ts'

export interface StudyDay {
  key: string
  start: Date
  end: Date
}

export function studyDay(now: Date, opts: DayOptions): StudyDay {
  const key = dayKey(now, opts)
  const end = nextDayStart(now, opts)
  // Walk back in whole hours, mirroring core.nextDayStart.
  let start = new Date(Math.floor(now.getTime() / 3600_000) * 3600_000)
  while (dayKey(new Date(start.getTime() - 3600_000), opts) === key) start = new Date(start.getTime() - 3600_000)
  if (dayKey(start, opts) !== key) start = new Date(start.getTime() + 3600_000)
  return { key, start, end }
}

// A new reverse card waits until the word's forward card is stable enough
// (deck.reverseAfterDays), unless the gate is off or forward is disabled.
const REVERSE_GATE = `(c.direction = 'forward' OR d.reverse_after_days IS NULL OR d.forward_enabled = 0 OR EXISTS (
  SELECT 1 FROM cards f WHERE f.word_id = c.word_id AND f.direction = 'forward' AND f.state > 0 AND f.stability >= d.reverse_after_days))`

interface QueueRow extends CardRow {
  kind: 'word' | 'fact'
  item_id: string
  deck_id: string
  deck_name: string
  new_per_day: number
  in_review: number
}

// Studied cards of active words and facts in every deck; the session keeps
// those of decks in review.
const QUEUE_SELECT = `
  SELECT c.*, d.name AS deck_name, d.new_per_day, d.in_review
  FROM study_cards c JOIN decks d ON d.id = c.deck_id
  WHERE c.user_id = ? AND c.item_status = 'active' AND c.suspended = 0 AND ${ENABLED_DIRECTION}`

export interface QueueCounts {
  new: number
  learning: number
  review: number
}

export interface QueueOptions {
  limit?: number
  // One deck, whether in review or not; default every deck in review.
  deckId?: string
  // One new card after every `newEvery` reviews.
  newEvery?: number
}

// Today's counts of one deck, in review or not (the review screen's chips).
export interface QueueDeck {
  id: string
  name: string
  kind: DeckKind
  inReview: boolean
  counts: QueueCounts
}

// Cards per deck introduced today (first review log falls in the study day).
function introducedToday(db: Db, userId: string, day: StudyDay): Map<string, number> {
  const rows = db.prepare(`
    SELECT f.deck_id AS deck_id, count(*) AS n FROM (
      SELECT c.deck_id AS deck_id, min(l.reviewed_at) AS first
      FROM review_logs l JOIN study_cards c ON c.id = l.card_id
      WHERE c.user_id = ? GROUP BY l.card_id
    ) f WHERE f.first >= ? AND f.first < ? GROUP BY f.deck_id`).all(userId, day.start.toISOString(), day.end.toISOString()) as { deck_id: string; n: number }[]
  return new Map(rows.map((r) => [r.deck_id, r.n]))
}

// word or fact id → ids of its cards reviewed today.
function reviewedToday(db: Db, userId: string, day: StudyDay): Map<string, Set<string>> {
  const rows = db.prepare(`
    SELECT DISTINCT c.item_id AS item_id, c.id AS card_id
    FROM review_logs l JOIN study_cards c ON c.id = l.card_id
    WHERE c.user_id = ? AND l.reviewed_at >= ? AND l.reviewed_at < ?`).all(userId, day.start.toISOString(), day.end.toISOString()) as { item_id: string; card_id: string }[]
  const out = new Map<string, Set<string>>()
  for (const r of rows) {
    let s = out.get(r.item_id)
    if (!s) out.set(r.item_id, (s = new Set()))
    s.add(r.card_id)
  }
  return out
}

// Did the user review anything in this study day (the bot's evening nudge).
export function reviewedOn(db: Db, userId: string, day: StudyDay): boolean {
  return !!db.prepare(`
    SELECT 1 FROM review_logs l JOIN study_cards c ON c.id = l.card_id
    WHERE c.user_id = ? AND l.reviewed_at >= ? AND l.reviewed_at < ? LIMIT 1`).get(userId, day.start.toISOString(), day.end.toISOString())
}

// Today's cards of every deck. Each deck's rows are what it would put in
// the session on its own: the new-card budget is per deck and burying is
// per word or fact, so a deck's share doesn't depend on the others.
function selectQueue(db: Db, userId: string, opts: DayOptions, now: Date, deckId?: string) {
  const day = studyDay(now, opts)
  const end = day.end.toISOString()
  const deckFilter = deckId ? ' AND c.deck_id = ?' : ''
  const deckArgs = deckId ? [deckId] : []

  const learning = db.prepare(`${QUEUE_SELECT} AND c.state IN (1, 3) AND c.due < ?${deckFilter} ORDER BY c.due, c.id`).all(userId, end, ...deckArgs) as unknown as QueueRow[]
  const reviews = db.prepare(`${QUEUE_SELECT} AND c.state = 2 AND c.due < ?${deckFilter} ORDER BY c.due, c.id`).all(userId, end, ...deckArgs) as unknown as QueueRow[]
  const fresh = db.prepare(`${QUEUE_SELECT} AND c.state = 0 AND ${REVERSE_GATE}${deckFilter} ORDER BY c.item_created_at, c.item_id, c.direction`).all(userId, ...deckArgs) as unknown as QueueRow[]

  const touched = reviewedToday(db, userId, day)
  const queued = new Set<string>()
  // Sibling burying: one card per word per day. A card's own earlier review
  // today (learning steps) does not bury it.
  const buried = (r: QueueRow) => {
    if (queued.has(r.item_id)) return true
    const seen = touched.get(r.item_id)
    return !!seen && [...seen].some((id) => id !== r.id)
  }

  // Learning cards are mid-flight, so they are never buried.
  const learningOut = learning.filter((r) => {
    queued.add(r.item_id)
    return true
  })
  const reviewOut = reviews.filter((r) => {
    if (buried(r)) return false
    queued.add(r.item_id)
    return true
  })
  const introduced = introducedToday(db, userId, day)
  const budget = new Map<string, number>()
  const newOut = fresh.filter((r) => {
    const left = budget.get(r.deck_id) ?? Math.max(0, r.new_per_day - (introduced.get(r.deck_id) ?? 0))
    if (left <= 0 || buried(r)) return false
    budget.set(r.deck_id, left - 1)
    queued.add(r.item_id)
    return true
  })
  return { learning: learningOut, reviews: reviewOut, fresh: newOut }
}

// Today's session: due and new cards of every deck in review (or of one
// deck), words and facts mixed; plus every deck's counts.
export function buildQueue(db: Db, userId: string, opts: DayOptions, now: Date, q: QueueOptions = {}): { items: QueueItem[]; counts: QueueCounts; decks: QueueDeck[] } {
  const all = selectQueue(db, userId, opts, now, q.deckId)
  const perDeck = new Map<string, QueueCounts>()
  const tally = (rows: QueueRow[], k: keyof QueueCounts) => {
    for (const r of rows) {
      let c = perDeck.get(r.deck_id)
      if (!c) perDeck.set(r.deck_id, (c = { new: 0, learning: 0, review: 0 }))
      c[k]++
    }
  }
  tally(all.learning, 'learning')
  tally(all.reviews, 'review')
  tally(all.fresh, 'new')
  const decks = listDecks(db, userId)
    .filter((d) => !q.deckId || d.id === q.deckId)
    .map((d) => ({ id: d.id, name: d.name, kind: d.kind, inReview: d.inReview, counts: perDeck.get(d.id) ?? { new: 0, learning: 0, review: 0 } }))
  const studied = (r: QueueRow) => !!q.deckId || r.in_review === 1
  const learning = all.learning.filter(studied)
  const reviews = all.reviews.filter(studied)
  const fresh = all.fresh.filter(studied)
  const every = q.newEvery ?? 4
  const ordered: QueueRow[] = [...learning]
  let ni = 0
  reviews.forEach((r, i) => {
    ordered.push(r)
    if ((i + 1) % every === 0 && ni < fresh.length) ordered.push(fresh[ni++]!)
  })
  while (ni < fresh.length) ordered.push(fresh[ni++]!)

  const limit = Math.min(Math.max(q.limit ?? 200, 1), 2000)
  const page = ordered.slice(0, limit)
  const words = new Map<string, WordRow>()
  const facts = new Map<string, FactRow>()
  for (const [table, map] of [['words', words], ['facts', facts]] as const) {
    const ids = [...new Set(page.filter((r) => (r.kind === 'fact') === (table === 'facts')).map((r) => r.item_id))]
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      for (const row of db.prepare(`SELECT * FROM ${table} WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as unknown as (WordRow & FactRow)[]) map.set(row.id, row)
    }
  }
  // Rules with an exercise pool: this review's items, picked now.
  const exercises = exercisesForQueue(db, [...facts.keys()])
  return {
    items: page.map((r): QueueItem => r.kind === 'fact'
      ? { kind: 'fact', card: toCard(r), fact: toFact(facts.get(r.item_id)!), deckName: r.deck_name, ...(exercises.has(r.item_id) ? { exercises: exercises.get(r.item_id)! } : {}) }
      : { kind: 'word', card: toCard(r), word: toWord(words.get(r.item_id)!), deckName: r.deck_name }),
    counts: { new: fresh.length, learning: learning.length, review: reviews.length },
    decks,
  }
}

export function inboxCount(db: Db, userId: string): number {
  return (db.prepare("SELECT count(*) AS n FROM words WHERE user_id = ? AND status = 'inbox'").get(userId) as { n: number }).n
}

// ---------- reviews ----------

export interface ApplyResult {
  applied: number
  skipped: number
  cards: Card[]
}

interface LogRow {
  id: string
  card_id: string
  rating: number
  reviewed_at: string
  duration_ms: number | null
  before: string
  after: string
}

function toLog(r: LogRow): ReviewLog {
  const log: ReviewLog = {
    id: r.id,
    cardId: r.card_id,
    rating: r.rating as Rating,
    reviewedAt: r.reviewed_at,
    before: JSON.parse(r.before) as CardState,
    after: JSON.parse(r.after) as CardState,
  }
  if (r.duration_ms !== null) log.durationMs = r.duration_ms
  return log
}

// Uploads from the offline outbox may repeat or arrive out of order: apply
// in reviewedAt order and skip ids we already have (and unknown cards, which
// includes other users' cards). Scheduled with the user's own FSRS weights
// and target retention.
export function applyReviews(db: Db, userId: string, inputs: ReviewInput[]): ApplyResult {
  const sorted = [...inputs].sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt) || a.id.localeCompare(b.id))
  let applied = 0
  let skipped = 0
  const touched = new Map<string, Card>()
  const f = userScheduler(db, userId)
  tx(db, () => {
    const exists = db.prepare('SELECT 1 FROM review_logs WHERE id = ?')
    const getCard = db.prepare('SELECT * FROM study_cards WHERE id = ? AND user_id = ?')
    const update = db.prepare(`UPDATE cards SET ${STATE_COLUMNS} WHERE id = ?`)
    const insert = db.prepare('INSERT INTO review_logs(id, card_id, rating, reviewed_at, duration_ms, "before", "after") VALUES (?, ?, ?, ?, ?, ?, ?)')
    for (const r of sorted) {
      const row = getCard.get(r.cardId, userId) as CardRow | undefined
      if (exists.get(r.id) || !row) {
        skipped++
        continue
      }
      const at = new Date(r.reviewedAt)
      const before = toCard(row).schedule
      const after = review(before, r.rating, at, f)
      update.run(...stateValues(after), r.cardId)
      insert.run(r.id, r.cardId, r.rating, at.toISOString(), r.durationMs ?? null, JSON.stringify(before), JSON.stringify(after))
      if (r.exercises?.length && row.fact_id) recordAttempts(db, r.id, row.fact_id, r.exercises, at.toISOString())
      touched.set(r.cardId, toCard(getCard.get(r.cardId, userId) as unknown as CardRow))
      applied++
    }
  })
  return { applied, skipped, cards: [...touched.values()] }
}

export function undoReview(db: Db, userId: string, logId: string): Card {
  return tx(db, () => {
    const log = db.prepare(`
      SELECT l.* FROM review_logs l JOIN study_cards c ON c.id = l.card_id
      WHERE l.id = ? AND c.user_id = ?`).get(logId, userId) as LogRow | undefined
    if (!log) throw new HttpError(404, 'review not found')
    const latest = db.prepare('SELECT id FROM review_logs WHERE card_id = ? ORDER BY reviewed_at DESC, rowid DESC LIMIT 1').get(log.card_id) as { id: string }
    if (latest.id !== logId) throw new HttpError(409, 'only the latest review of a card can be undone')
    const before = JSON.parse(log.before) as CardState
    db.prepare(`UPDATE cards SET ${STATE_COLUMNS} WHERE id = ?`).run(...stateValues(before), log.card_id)
    revertAttempts(db, logId)
    db.prepare('DELETE FROM review_logs WHERE id = ?').run(logId)
    return toCard(db.prepare('SELECT * FROM cards WHERE id = ?').get(log.card_id) as unknown as CardRow)
  })
}

// Newest first.
export function factLogs(db: Db, userId: string, factId: string, limit = 20): ReviewLog[] {
  const rows = db.prepare(`
    SELECT l.* FROM review_logs l JOIN cards c ON c.id = l.card_id JOIN facts f ON f.id = c.fact_id
    WHERE c.fact_id = ? AND f.user_id = ?
    ORDER BY l.reviewed_at DESC, l.rowid DESC LIMIT ?`).all(factId, userId, limit) as unknown as LogRow[]
  return rows.map(toLog)
}

// Newest first.
export function wordLogs(db: Db, userId: string, wordId: string, limit = 20): ReviewLog[] {
  const rows = db.prepare(`
    SELECT l.* FROM review_logs l JOIN cards c ON c.id = l.card_id JOIN words w ON w.id = c.word_id
    WHERE c.word_id = ? AND w.user_id = ?
    ORDER BY l.reviewed_at DESC, l.rowid DESC LIMIT ?`).all(wordId, userId, limit) as unknown as LogRow[]
  return rows.map(toLog)
}

// ---------- known words ----------

// A card is "known" when it is in review state and its recall probability
// is at least this now; a word is known when any of its enabled cards is.
export const KNOWN_R = 0.9

export interface ReviewCardRow extends CardRow {
  deck_id: string
  term: string
  freq_rank: number | null
  pos: string
}

// Review-state, unsuspended cards of active words in enabled directions.
export function reviewCards(db: Db, userId: string, deckId?: string): ReviewCardRow[] {
  return db.prepare(`
    SELECT c.*, w.deck_id, w.term, w.freq_rank, w.pos FROM cards c JOIN words w ON w.id = c.word_id JOIN decks d ON d.id = w.deck_id
    WHERE w.user_id = ? AND w.status = 'active' AND c.state = 2 AND c.suspended = 0 AND ${ENABLED_DIRECTION}${deckId ? ' AND w.deck_id = ?' : ''}`)
    .all(userId, ...(deckId ? [deckId] : [])) as unknown as ReviewCardRow[]
}

export function isKnown(c: CardRow, at: Date): boolean {
  return c.state === 2 && retrievability(toState(c), at) >= KNOWN_R
}

// ---------- decks with counts ----------

export interface DeckCounts {
  // Words (facts in a topic deck), by status.
  total: number
  active: number
  inbox: number
  // Active words (facts) with at least one known card (review state, R ≥ 0.9 now).
  known: number
  // Cards in enabled directions: in learning/relearning, due today
  // (learning + review), new available today (daily budget and reverse gate applied).
  learning: number
  due: number
  new: number
  // Unseen cards in enabled directions, ignoring the daily budget and the gate.
  newTotal: number
}

export function decksWithCounts(db: Db, userId: string, opts: DayOptions, now: Date): (DeckInfo & { counts: DeckCounts })[] {
  const day = studyDay(now, opts)
  const words = db.prepare(`
    SELECT deck_id, count(*) AS total, sum(status = 'active') AS active, sum(status = 'inbox') AS inbox
    FROM words WHERE user_id = ? GROUP BY deck_id
    UNION ALL
    SELECT deck_id, count(*), sum(status = 'active'), sum(status = 'inbox')
    FROM facts WHERE user_id = ? GROUP BY deck_id`).all(userId, userId) as { deck_id: string; total: number; active: number; inbox: number }[]
  const cards = db.prepare(`
    SELECT c.deck_id,
      sum(c.state IN (1, 3)) AS learning,
      sum(c.state > 0 AND c.due < ?) AS due,
      sum(c.state = 0) AS new_total
    FROM study_cards c JOIN decks d ON d.id = c.deck_id
    WHERE c.user_id = ? AND c.item_status = 'active' AND c.suspended = 0 AND ${ENABLED_DIRECTION} GROUP BY c.deck_id`)
    .all(day.end.toISOString(), userId) as { deck_id: string; learning: number; due: number; new_total: number }[]
  const known = new Map<string, Set<string>>()
  const reviewed = db.prepare(`
    SELECT c.* FROM study_cards c JOIN decks d ON d.id = c.deck_id
    WHERE c.user_id = ? AND c.item_status = 'active' AND c.state = 2 AND c.suspended = 0 AND ${ENABLED_DIRECTION}`).all(userId) as unknown as (CardRow & { deck_id: string; item_id: string })[]
  for (const c of reviewed) {
    if (!isKnown(c, now)) continue
    let s = known.get(c.deck_id)
    if (!s) known.set(c.deck_id, (s = new Set()))
    s.add(c.item_id)
  }
  const fresh = new Map<string, number>()
  for (const r of selectQueue(db, userId, opts, now).fresh) fresh.set(r.deck_id, (fresh.get(r.deck_id) ?? 0) + 1)
  const w = new Map(words.map((r) => [r.deck_id, r]))
  const c = new Map(cards.map((r) => [r.deck_id, r]))
  return listDecks(db, userId).map((d) => ({
    ...d,
    counts: {
      total: w.get(d.id)?.total ?? 0,
      active: w.get(d.id)?.active ?? 0,
      inbox: w.get(d.id)?.inbox ?? 0,
      known: known.get(d.id)?.size ?? 0,
      learning: c.get(d.id)?.learning ?? 0,
      due: c.get(d.id)?.due ?? 0,
      new: fresh.get(d.id) ?? 0,
      newTotal: c.get(d.id)?.new_total ?? 0,
    },
  }))
}

// ---------- stats ----------

export interface Stats {
  days: { day: string; reviews: number; again: number }[]
  // Share of non-Again ratings on review-state cards, overall and per direction.
  retention: number | null
  retentionByDirection: Record<Direction, number | null>
  reviews: number
  forecast: { day: string; due: number }[]
  cardsByState: { new: number; learning: number; review: number; relearning: number; suspended: number }
}

export function stats(db: Db, userId: string, opts: DayOptions, now: Date, { days = 30, deckId }: { days?: number; deckId?: string } = {}): Stats {
  days = Math.min(Math.max(Math.floor(days), 1), 365)
  const day = studyDay(now, opts)
  const keys: string[] = []
  for (let i = days - 1; i >= 0; i--) keys.push(dayKey(new Date(day.start.getTime() - i * 86400_000 + 12 * 3600_000), opts))
  const since = studyDay(new Date(day.start.getTime() - (days - 1) * 86400_000 + 12 * 3600_000), opts).start
  // Words and facts alike; per-direction retention is about words.
  const scope = ` JOIN decks d ON d.id = c.deck_id AND c.user_id = ?${deckId ? ' AND c.deck_id = ?' : ''}`
  const scopeArgs = deckId ? [userId, deckId] : [userId]

  const logs = db.prepare(`
    SELECT l.reviewed_at, l.rating, c.direction, c.kind, json_extract(l."before", '$.state') AS before_state
    FROM review_logs l JOIN study_cards c ON c.id = l.card_id${scope} WHERE l.reviewed_at >= ?`).all(...scopeArgs, since.toISOString()) as { reviewed_at: string; rating: number; direction: Direction; kind: string; before_state: number }[]
  const perDay = new Map(keys.map((k) => [k, { day: k, reviews: 0, again: 0 }]))
  const ret: Record<'all' | Direction, [number, number]> = { all: [0, 0], forward: [0, 0], reverse: [0, 0] }
  for (const l of logs) {
    const d = perDay.get(dayKey(new Date(l.reviewed_at), opts))
    if (d) {
      d.reviews++
      if (l.rating === 1) d.again++
    }
    if (l.before_state === 2) {
      for (const k of l.kind === 'word' ? (['all', l.direction] as const) : (['all'] as const)) {
        ret[k][1]++
        if (l.rating > 1) ret[k][0]++
      }
    }
  }
  const rate = ([ok, n]: [number, number]) => (n ? ok / n : null)

  const forecastKeys: string[] = []
  for (let i = 0; i < 14; i++) forecastKeys.push(dayKey(new Date(day.start.getTime() + i * 86400_000 + 12 * 3600_000), opts))
  const forecast = new Map(forecastKeys.map((k) => [k, 0]))
  // What will come up: without a deck, the decks in review.
  const dueRows = db.prepare(`
    SELECT c.due FROM study_cards c${scope}
    WHERE c.item_status = 'active' AND c.suspended = 0 AND c.state > 0 AND ${ENABLED_DIRECTION}${deckId ? '' : ' AND d.in_review = 1'}`).all(...scopeArgs) as { due: string }[]
  for (const { due } of dueRows) {
    // Overdue cards count towards today.
    const k = new Date(due) < day.end ? day.key : dayKey(new Date(due), opts)
    if (forecast.has(k)) forecast.set(k, forecast.get(k)! + 1)
  }

  const states = db.prepare(`
    SELECT c.state, c.suspended, count(*) AS n FROM study_cards c${scope}
    WHERE c.item_status = 'active' AND ${ENABLED_DIRECTION} GROUP BY c.state, c.suspended`).all(...scopeArgs) as { state: number; suspended: number; n: number }[]
  const cardsByState = { new: 0, learning: 0, review: 0, relearning: 0, suspended: 0 }
  const names = ['new', 'learning', 'review', 'relearning'] as const
  for (const s of states) {
    if (s.suspended) cardsByState.suspended += s.n
    else cardsByState[names[s.state]!] += s.n
  }

  return {
    days: [...perDay.values()],
    reviews: logs.length,
    retention: rate(ret.all),
    retentionByDirection: { forward: rate(ret.forward), reverse: rate(ret.reverse) },
    forecast: forecastKeys.map((k) => ({ day: k, due: forecast.get(k)! })),
    cardsByState,
  }
}

// ---------- leeches ----------

export interface Leech {
  wordId: string
  deckName: string
  term: string
  pos: string
  translations: string[]
  cards: { id: string; direction: Direction; lapses: number; reps: number; suspended: boolean; lastRatings: Rating[] }[]
  maxLapses: number
}

export function leeches(db: Db, userId: string, { deckId, direction, minLapses = 4, limit = 20 }: { deckId?: string; direction?: Direction; minLapses?: number; limit?: number }): Leech[] {
  const rows = db.prepare(`
    SELECT c.*, w.term, w.pos, w.translations, d.name AS deck_name
    FROM cards c JOIN words w ON w.id = c.word_id JOIN decks d ON d.id = w.deck_id
    WHERE w.user_id = ? AND w.status = 'active' AND c.lapses >= ?${deckId ? ' AND w.deck_id = ?' : ''}${direction ? ' AND c.direction = ?' : ''}
    ORDER BY c.lapses DESC, c.id`).all(userId, minLapses, ...(deckId ? [deckId] : []), ...(direction ? [direction] : [])) as unknown as (CardRow & { term: string; pos: string; translations: string; deck_name: string })[]
  const ratings = db.prepare('SELECT rating FROM review_logs WHERE card_id = ? ORDER BY reviewed_at DESC LIMIT 10')
  const byWord = new Map<string, Leech>()
  for (const r of rows) {
    const wordId = r.word_id!
    let l = byWord.get(wordId)
    if (!l) {
      if (byWord.size >= limit) continue
      l = { wordId, deckName: r.deck_name, term: r.term, pos: r.pos, translations: JSON.parse(r.translations), cards: [], maxLapses: r.lapses }
      byWord.set(wordId, l)
    }
    const last = (ratings.all(r.id) as { rating: number }[]).map((x) => x.rating as Rating).reverse()
    l.cards.push({ id: r.id, direction: r.direction as Direction, lapses: r.lapses, reps: r.reps, suspended: r.suspended === 1, lastRatings: last })
  }
  return [...byWord.values()]
}
