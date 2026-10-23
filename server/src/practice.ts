// Practice: extra rounds outside the schedule. Nothing here writes — the
// client shows the cards and keeps the outcome to itself (or sends nothing),
// so FSRS state, logs and the day's budget stay as they are.
import { retrievability, type DayOptions, type FactQueueItem, type QueueItem } from '@recall/core'
import type { Db } from './db.ts'
import { exerciseSets, MIN_POOL, SERVABLE } from './exercises.ts'
import { mustGetFact, toFact, type FactRow } from './facts.ts'
import { HttpError, toCard, toState, type CardRow } from './repo.ts'
import { inFilter, QUEUE_SELECT, queueItems, studyDay, type QueueRow } from './study.ts'

export const PRACTICE_LIMIT = { default: 20, max: 50 }
// Items for one rule ("Practice this" in the handbook).
export const RULE_SETS = 3

// A deck's weak cards: first the ones rated Again today, most recent first;
// then the rest of the cards reviewed at least once, most lapses first, then
// lowest retrievability now. Under the deck's review filter, active,
// unsuspended, enabled directions only; one card per word or fact.
export function practiceDeck(db: Db, userId: string, deckId: string, opts: DayOptions, now: Date, { limit = PRACTICE_LIMIT.default, grading = false } = {}): QueueItem[] {
  const n = Math.min(Math.max(Math.floor(limit), 1), PRACTICE_LIMIT.max)
  const day = studyDay(now, opts)
  const rows = inFilter()(db.prepare(`${QUEUE_SELECT} AND c.state > 0 AND c.deck_id = ?`).all(userId, deckId) as unknown as QueueRow[])
  const again = new Map((db.prepare(`
    SELECT l.card_id, max(l.reviewed_at) AS at FROM review_logs l JOIN study_cards c ON c.id = l.card_id
    WHERE c.user_id = ? AND c.deck_id = ? AND l.rating = 1 AND l.reviewed_at >= ? AND l.reviewed_at < ? GROUP BY l.card_id`)
    .all(userId, deckId, day.start.toISOString(), day.end.toISOString()) as { card_id: string; at: string }[]).map((r) => [r.card_id, r.at]))
  const r = new Map(rows.map((x) => [x.id, retrievability(toState(x), now)]))
  const sorted = [...rows].sort((a, b) => {
    const aa = again.get(a.id)
    const ba = again.get(b.id)
    if (aa || ba) return !aa ? 1 : !ba ? -1 : ba.localeCompare(aa)
    return b.lapses - a.lapses || r.get(a.id)! - r.get(b.id)! || a.id.localeCompare(b.id)
  })
  const seen = new Set<string>()
  const page: QueueRow[] = []
  for (const x of sorted) {
    if (page.length >= n) break
    if (seen.has(x.item_id)) continue
    seen.add(x.item_id)
    page.push(x)
  }
  return queueItems(db, page, grading, day.key)
}

// One rule, a few rounds: up to RULE_SETS items, each with its own set of
// exercises (as disjoint as the active pool allows). A fact without a pool
// to review from gives none.
export function practiceRule(db: Db, userId: string, factId: string, { grading = false } = {}): FactQueueItem[] {
  mustGetFact(db, userId, factId)
  const row = db.prepare(`SELECT f.*, d.name AS deck_name, (SELECT count(*) FROM fact_exercises e WHERE e.fact_id = f.id AND ${SERVABLE}) AS pool
    FROM facts f JOIN decks d ON d.id = f.deck_id WHERE f.id = ? AND f.user_id = ?`).get(factId, userId) as unknown as FactRow & { deck_name: string; pool: number }
  const card = db.prepare('SELECT * FROM cards WHERE fact_id = ?').get(factId) as CardRow | undefined
  if (!card) throw new HttpError(404, `fact ${factId} has no card`)
  if (row.pool < MIN_POOL) return []
  const fact = toFact(row)
  return exerciseSets(db, factId, RULE_SETS, grading).map((exercises) => ({ kind: 'fact', card: toCard(card), fact, deckName: row.deck_name, exercises }))
}
