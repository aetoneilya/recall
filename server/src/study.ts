// Everything that depends on the study day: the queue, applying ratings,
// per-deck counts, stats and leeches. All scoped to one user; `opts` carries
// that user's time zone. Disabled directions are invisible here: their
// cards are not queued, counted or forecast (they keep their state).
// Words' and facts' cards are read alike through the study_cards view
// (db.ts v6): `c.item_id` is the word or fact, `c.deck_id`/`c.user_id` its own.
import {
  cleanReviewFilter, dayKey, dayStart, DIRECTIONS, facetOptions, inReviewFilter, nextDayStart, planToday, retrievability, review,
  type Card, type CardFacts, type CardState, type CardType, type Cefr, type DayOptions, type Direction, type FsrsState, type PartOfSpeech, type QueueItem, type Rating,
  type FacetItem, type ReviewFilter, type ReviewInput, type ReviewLog,
} from '@recall/core'
import { tx, type Db } from './db.ts'
import { exercisesForQueue, MIN_POOL, recordAttempts, reviewSeed, revertAttempts, SERVABLE } from './exercises.ts'
import { toFact, type FactRow } from './facts.ts'
import { userScheduler } from './fsrs.ts'
import {
  ENABLED_DIRECTION, getDeck, hasLanguages, HttpError, listDecks, STATE_COLUMNS, stateValues, toCard, toState, toWord,
  type CardRow, type DeckInfo, type WordRow,
} from './repo.ts'

export interface StudyDay {
  key: string
  start: Date
  end: Date
}

export function studyDay(now: Date, opts: DayOptions): StudyDay {
  const key = dayKey(now, opts)
  return { key, start: dayStart(now, opts), end: nextDayStart(now, opts) }
}

// A new reverse card waits until the word's forward card is stable enough
// (deck.reverseAfterDays), unless the gate is off, forward is disabled or the
// forward card is suspended (it would never get stable: reverse is all
// that's studied of the word).
const REVERSE_GATE = `(c.direction = 'forward' OR d.reverse_after_days IS NULL OR d.forward_enabled = 0 OR EXISTS (
  SELECT 1 FROM cards f WHERE f.word_id = c.word_id AND f.direction = 'forward' AND (f.suspended = 1 OR (f.state > 0 AND f.stability >= d.reverse_after_days))))`

export interface QueueRow extends CardRow {
  kind: 'word' | 'fact'
  item_id: string
  deck_id: string
  deck_name: string
  new_per_day: number
  review_filter: string | null
  item_tags: string
  item_pos: string | null
  item_cefr: string | null
  // Active exercises of a fact that any server can serve (not write): a
  // rule with MIN_POOL or more.
  pool: number
}

// Studied cards of active words and facts in every deck, with what the
// review filter looks at.
export const QUEUE_SELECT = `
  SELECT c.*, d.name AS deck_name, d.new_per_day, d.review_filter,
    coalesce(w.tags, f.tags, '[]') AS item_tags, w.pos AS item_pos, w.cefr AS item_cefr,
    (SELECT count(*) FROM fact_exercises e WHERE e.fact_id = c.fact_id AND ${SERVABLE}) AS pool
  FROM study_cards c JOIN decks d ON d.id = c.deck_id
  LEFT JOIN words w ON w.id = c.word_id LEFT JOIN facts f ON f.id = c.fact_id
  WHERE c.user_id = ? AND c.item_status = 'active' AND c.suspended = 0 AND ${ENABLED_DIRECTION}`

export const cardType = (r: { kind: string; pool: number }): CardType => (r.kind === 'word' ? 'word' : r.pool >= MIN_POOL ? 'rule' : 'fact')

export const rowFacts = (r: QueueRow): CardFacts => ({
  type: cardType(r),
  tags: JSON.parse(r.item_tags) as string[],
  pos: r.item_pos as PartOfSpeech | null,
  cefr: r.item_cefr as Cefr | null,
  direction: r.direction as Direction,
})

export interface QueueCounts {
  new: number
  learning: number
  review: number
}

export interface QueueOptions {
  limit?: number
  // One deck's session; default every deck's.
  deckId?: string
  // One new card after every `newEvery` reviews.
  newEvery?: number
  // Write items can be graded here (Claude configured): rules may get one.
  grading?: boolean
}

// Today's counts of one deck under its review filter (the deck switcher).
export interface QueueDeck {
  id: string
  name: string
  hasLanguages: boolean
  counts: QueueCounts
}

// Extra new cards per deck for one study day ("+5 today"), on top of newPerDay.
export function extraNewOn(db: Db, userId: string, day: string): Map<string, number> {
  const rows = db.prepare('SELECT x.deck_id, x.n FROM deck_extra_new x JOIN decks d ON d.id = x.deck_id WHERE d.user_id = ? AND x.day = ?').all(userId, day) as { deck_id: string; n: number }[]
  return new Map(rows.map((r) => [r.deck_id, r.n]))
}

// Adds n to a deck's extra allowance for the study day; taps accumulate.
export function addExtraNew(db: Db, userId: string, deckId: string, day: string, n: number) {
  if (!db.prepare('SELECT 1 FROM decks WHERE id = ? AND user_id = ?').get(deckId, userId)) throw new HttpError(404, 'deck not found')
  db.prepare(`INSERT INTO deck_extra_new(deck_id, day, n) VALUES (?, ?, ?)
    ON CONFLICT(deck_id, day) DO UPDATE SET n = n + excluded.n`).run(deckId, day, n)
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

// Rows that pass their deck's review filter (`filters` overrides a deck's;
// it caches the parsed ones too).
export function inFilter(filters: Map<string, ReviewFilter | null> = new Map()) {
  const filterOf = (r: QueueRow): ReviewFilter | null => {
    if (filters.has(r.deck_id)) return filters.get(r.deck_id)!
    let f: ReviewFilter | null = null
    try {
      f = r.review_filter ? cleanReviewFilter(JSON.parse(r.review_filter) as ReviewFilter) : null
    } catch {
      f = null
    }
    filters.set(r.deck_id, f)
    return f
  }
  return (rows: QueueRow[]) => rows.filter((r) => inReviewFilter(filterOf(r), rowFacts(r)))
}

// Today's cards of every deck (or one), each deck's under its review filter
// (`filters` overrides it, for a preview). Each deck's rows are what it
// would put in the session on its own: the new-card budget is per deck and
// burying is per word or fact, so a deck's share doesn't depend on the
// others. Cards outside the filter don't use the new-card budget.
function selectQueue(db: Db, userId: string, opts: DayOptions, now: Date, deckId?: string, filters: Map<string, ReviewFilter | null> = new Map()) {
  const day = studyDay(now, opts)
  const end = day.end.toISOString()
  const deckFilter = deckId ? ' AND c.deck_id = ?' : ''
  const deckArgs = deckId ? [deckId] : []

  const wanted = inFilter(filters)
  const learning = wanted(db.prepare(`${QUEUE_SELECT} AND c.state IN (1, 3) AND c.due < ?${deckFilter} ORDER BY c.due, c.id`).all(userId, end, ...deckArgs) as unknown as QueueRow[])
  const reviews = wanted(db.prepare(`${QUEUE_SELECT} AND c.state = 2 AND c.due < ?${deckFilter} ORDER BY c.due, c.id`).all(userId, end, ...deckArgs) as unknown as QueueRow[])
  const fresh = wanted(db.prepare(`${QUEUE_SELECT} AND c.state = 0 AND ${REVERSE_GATE}${deckFilter} ORDER BY c.item_created_at, c.item_id, c.direction`).all(userId, ...deckArgs) as unknown as QueueRow[])

  const touched = reviewedToday(db, userId, day)
  const introduced = introducedToday(db, userId, day)
  const extra = extraNewOn(db, userId, day.key)
  const budget = new Map<string, number>()
  // The budget is asked only about new cards the session will show: buried
  // ones (core.planToday) never use it.
  const admit = (r: QueueRow) => {
    const left = budget.get(r.deck_id) ?? Math.max(0, r.new_per_day + (extra.get(r.deck_id) ?? 0) - (introduced.get(r.deck_id) ?? 0))
    budget.set(r.deck_id, left - 1)
    return left > 0
  }
  const placed = planToday(
    [...learning, ...reviews, ...fresh],
    (r) => ({ id: r.id, itemId: r.item_id, state: r.state as FsrsState, due: r.due, lastReview: r.last_review }),
    (itemId, cardId) => [...(touched.get(itemId) ?? [])].some((id) => id !== cardId),
    { start: day.start.getTime(), end: day.end.getTime() },
    admit,
  )
  // learning: everything that waits for its time today (counted as learning).
  const out = { learning: [] as QueueRow[], reviews: [] as QueueRow[], fresh: [] as QueueRow[] }
  for (const p of placed) out[p.slot === 'later' ? 'learning' : p.card.state === 0 ? 'fresh' : 'reviews'].push(p.card)
  return out
}

// Today's session: due and new cards of one deck (or of every deck), under
// its review filter, words, facts and rules mixed; plus every deck's counts.
export function buildQueue(db: Db, userId: string, opts: DayOptions, now: Date, q: QueueOptions = {}): { items: QueueItem[]; counts: QueueCounts; decks: QueueDeck[] } {
  const all = selectQueue(db, userId, opts, now)
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
  const decks = listDecks(db, userId, studyDay(now, opts).key)
    .map((d) => ({ id: d.id, name: d.name, hasLanguages: hasLanguages(d), counts: perDeck.get(d.id) ?? { new: 0, learning: 0, review: 0 } }))
  const studied = (r: QueueRow) => !q.deckId || r.deck_id === q.deckId
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
  return {
    items: queueItems(db, ordered.slice(0, limit), q.grading ?? false, studyDay(now, opts).key),
    counts: { new: fresh.length, learning: learning.length, review: reviews.length },
    decks,
  }
}

// Queue rows as the review screen gets them, with their words and facts, and
// for rules this review's exercise items (picked now, the same all `day`
// until the card is rated).
export function queueItems(db: Db, page: QueueRow[], grading: boolean, day: string): QueueItem[] {
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
  const seeds = new Map(page.filter((r) => r.kind === 'fact').map((r) => [r.item_id, reviewSeed(r.id, day, r.reps)]))
  const exercises = exercisesForQueue(db, seeds, grading)
  return page.map((r): QueueItem => r.kind === 'fact'
    ? { kind: 'fact', card: toCard(r), fact: toFact(facts.get(r.item_id)!), deckName: r.deck_name, ...(exercises.has(r.item_id) ? { exercises: exercises.get(r.item_id)! } : {}) }
    : { kind: 'word', card: toCard(r), word: toWord(words.get(r.item_id)!), deckName: r.deck_name })
}

export interface ReviewOptions {
  // Today's cards under the filter given.
  counts: QueueCounts
  // What the deck has to filter by, with how many active items each.
  types: { value: CardType; n: number }[]
  tags: { value: string; n: number }[]
  pos: { value: PartOfSpeech; n: number }[]
  cefr: { value: Cefr; n: number }[]
  directions: { value: Direction; n: number }[]
}

// The review filter sheet: today's count under a draft filter (not saved)
// and the deck's options, drill-down (core.facetOptions): an option counted
// as the draft plus that option, active words and facts, a word once per
// enabled direction for `directions`.
export function reviewOptions(db: Db, userId: string, opts: DayOptions, now: Date, deckId: string, filter: ReviewFilter | null): ReviewOptions {
  const deck = getDeck(db, userId, deckId)
  if (!deck) throw new HttpError(404, 'deck not found')
  const draft = cleanReviewFilter(filter)
  const q = selectQueue(db, userId, opts, now, deckId, new Map([[deckId, draft]]))
  const words = db.prepare("SELECT pos, cefr, tags FROM words WHERE user_id = ? AND deck_id = ? AND status = 'active'").all(userId, deckId) as { pos: string; cefr: string | null; tags: string }[]
  const facts = db.prepare(`SELECT f.tags, (SELECT count(*) FROM fact_exercises e WHERE e.fact_id = f.id AND ${SERVABLE}) AS pool
    FROM facts f WHERE f.user_id = ? AND f.deck_id = ? AND f.status = 'active'`).all(userId, deckId) as { tags: string; pool: number }[]
  const directions = DIRECTIONS.filter((d) => (d === 'forward' ? deck.forwardEnabled : deck.reverseEnabled))
  const items: FacetItem[] = [
    ...words.map((w) => ({ type: 'word' as const, tags: JSON.parse(w.tags) as string[], pos: w.pos as PartOfSpeech, cefr: w.cefr as Cefr | null, directions })),
    ...facts.map((f) => ({ type: cardType({ kind: 'fact', pool: f.pool }), tags: JSON.parse(f.tags) as string[] })),
  ]
  return { counts: { new: q.fresh.length, learning: q.learning.length, review: q.reviews.length }, ...facetOptions(items, draft) }
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
// in reviewedAt order (as instants, whatever the offset) and skip ids we
// already have (and unknown cards, which includes other users' cards).
// Scheduled with the user's own FSRS weights and target retention.
// A rating older than ones the card already has (another device uploaded
// first) goes into its place in the history: the later ratings are replayed
// on top of it, so the card and every log's before/after read as if they had
// come in order, and undo of the latest one stays exact.
export function applyReviews(db: Db, userId: string, inputs: ReviewInput[]): ApplyResult {
  const sorted = [...inputs].sort((a, b) => Date.parse(a.reviewedAt) - Date.parse(b.reviewedAt) || a.id.localeCompare(b.id))
  let applied = 0
  let skipped = 0
  const touched = new Map<string, Card>()
  const f = userScheduler(db, userId)
  tx(db, () => {
    const exists = db.prepare('SELECT 1 FROM review_logs WHERE id = ?')
    const getCard = db.prepare('SELECT * FROM study_cards WHERE id = ? AND user_id = ?')
    const update = db.prepare(`UPDATE cards SET ${STATE_COLUMNS} WHERE id = ?`)
    const insert = db.prepare('INSERT INTO review_logs(id, card_id, rating, reviewed_at, duration_ms, "before", "after") VALUES (?, ?, ?, ?, ?, ?, ?)')
    const laterLogs = db.prepare('SELECT id, rating, reviewed_at, "before" FROM review_logs WHERE card_id = ? AND reviewed_at > ? ORDER BY reviewed_at, rowid')
    const rewrite = db.prepare('UPDATE review_logs SET "before" = ?, "after" = ? WHERE id = ?')
    for (const r of sorted) {
      const row = getCard.get(r.cardId, userId) as CardRow | undefined
      if (exists.get(r.id) || !row) {
        skipped++
        continue
      }
      const at = new Date(r.reviewedAt)
      const later = laterLogs.all(r.cardId, at.toISOString()) as { id: string; rating: Rating; reviewed_at: string; before: string }[]
      // The state as it was at `at`: before the first later rating, if any.
      const before = later.length ? (JSON.parse(later[0]!.before) as CardState) : toCard(row).schedule
      const after = review(before, r.rating, at, f)
      let state = after
      for (const l of later) {
        const next = review(state, l.rating, new Date(l.reviewed_at), f)
        rewrite.run(JSON.stringify(state), JSON.stringify(next), l.id)
        state = next
      }
      update.run(...stateValues(state), r.cardId)
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
  // Words and facts, by status.
  total: number
  active: number
  dropped: number
  // Active words and facts with at least one known card (review state, R ≥ 0.9 now).
  known: number
  // Cards in enabled directions: in learning/relearning, due today
  // (learning + review), new available today (daily budget and reverse gate applied).
  learning: number
  due: number
  new: number
  // Unseen cards in enabled directions, ignoring the daily budget and the gate.
  newTotal: number
}

// Tags in use per deck (on active words and facts), most used first.
function deckTags(db: Db, userId: string): Map<string, { tag: string; n: number }[]> {
  const rows = db.prepare(`
    SELECT deck_id, j.value AS tag, count(*) AS n FROM (
      SELECT deck_id, tags FROM words WHERE user_id = ? AND status <> 'rejected'
      UNION ALL SELECT deck_id, tags FROM facts WHERE user_id = ? AND status <> 'rejected'
    ) x, json_each(x.tags) j GROUP BY deck_id, j.value ORDER BY n DESC, j.value`).all(userId, userId) as { deck_id: string; tag: string; n: number }[]
  const out = new Map<string, { tag: string; n: number }[]>()
  for (const r of rows) out.set(r.deck_id, [...(out.get(r.deck_id) ?? []), { tag: r.tag, n: r.n }])
  return out
}

export function decksWithCounts(db: Db, userId: string, opts: DayOptions, now: Date): (DeckInfo & { counts: DeckCounts; tags: { tag: string; n: number }[] })[] {
  const day = studyDay(now, opts)
  const words = db.prepare(`
    SELECT deck_id, count(*) AS total, sum(status = 'active') AS active, sum(status = 'rejected') AS dropped
    FROM words WHERE user_id = ? GROUP BY deck_id
    UNION ALL
    SELECT deck_id, count(*), sum(status = 'active'), sum(status = 'rejected')
    FROM facts WHERE user_id = ? GROUP BY deck_id`).all(userId, userId) as { deck_id: string; total: number; active: number; dropped: number }[]
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
  // A deck can hold words and facts: one row of each, summed.
  const w = new Map<string, { total: number; active: number; dropped: number }>()
  for (const r of words) {
    const cur = w.get(r.deck_id) ?? { total: 0, active: 0, dropped: 0 }
    w.set(r.deck_id, { total: cur.total + r.total, active: cur.active + r.active, dropped: cur.dropped + r.dropped })
  }
  const c = new Map(cards.map((r) => [r.deck_id, r]))
  const tags = deckTags(db, userId)
  return listDecks(db, userId, day.key).map((d) => ({
    ...d,
    tags: tags.get(d.id) ?? [],
    counts: {
      total: w.get(d.id)?.total ?? 0,
      active: w.get(d.id)?.active ?? 0,
      dropped: w.get(d.id)?.dropped ?? 0,
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
  // What will come up.
  const dueRows = db.prepare(`
    SELECT c.due FROM study_cards c${scope}
    WHERE c.item_status = 'active' AND c.suspended = 0 AND c.state > 0 AND ${ENABLED_DIRECTION}`).all(...scopeArgs) as { due: string }[]
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
