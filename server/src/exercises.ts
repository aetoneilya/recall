// Grammar exercises: a pool of items per fact (fact_exercises, db.ts v7).
// A fact with at least MIN_POOL active items reviews through PER_REVIEW of
// them, picked when the queue is built; how each went comes back with the
// review (ReviewInput.exercises) and is kept per log (exercise_attempts).
// Ownership is the fact's: every function takes the acting user's id.
import {
  cleanExercise, exerciseKey, EXERCISE_TYPES, isTapType,
  type Author, type ExerciseAttempt, type ExerciseInput, type ExerciseItem, type ExerciseType,
} from '@recall/core'
import { newId, tx, type Db } from './db.ts'
import { mustGetFact } from './facts.ts'
import { HttpError } from './repo.ts'

export const MIN_POOL = 3
export const PER_REVIEW = 3
// At most this many items of one type in a review, when the pool allows.
const SAME_TYPE = 2

export type ExerciseStatus = 'active' | 'flagged'

export interface ExerciseRow {
  id: string
  fact_id: string
  type: string
  prompt: string
  answer: string
  accepted: string
  options: string
  wrong: string | null
  explain: string | null
  status: string
  needs_review: number
  created_by: string
  dedupe_key: string
  import_ref: string | null
  created_at: string
  shown_count: number
  last_shown_at: string | null
  correct_count: number
  wrong_count: number
}

// An item with its status and how it has gone.
export interface ExerciseInfo extends ExerciseItem {
  factId: string
  status: ExerciseStatus
  // "I was right" was used on it: worth a look.
  needsReview: boolean
  createdBy: Author
  createdAt: string
  shownCount: number
  lastShownAt: string | null
  correctCount: number
  wrongCount: number
}

export const toItem = (r: ExerciseRow): ExerciseItem => ({
  id: r.id, type: r.type as ExerciseType, prompt: r.prompt, answer: r.answer, accepted: JSON.parse(r.accepted) as string[], explain: r.explain,
  ...(isTapType(r.type as ExerciseType) ? { options: JSON.parse(r.options ?? '[]') as string[], wrong: r.wrong } : {}),
})

export const toExercise = (r: ExerciseRow): ExerciseInfo => ({
  ...toItem(r),
  factId: r.fact_id,
  status: r.status as ExerciseStatus,
  needsReview: r.needs_review === 1,
  createdBy: r.created_by as Author,
  createdAt: r.created_at,
  shownCount: r.shown_count,
  lastShownAt: r.last_shown_at,
  correctCount: r.correct_count,
  wrongCount: r.wrong_count,
})

// The fact's whole pool, in the order it was written.
export function listExercises(db: Db, userId: string, factId: string): ExerciseInfo[] {
  mustGetFact(db, userId, factId)
  return (db.prepare('SELECT * FROM fact_exercises WHERE fact_id = ? ORDER BY rowid').all(factId) as unknown as ExerciseRow[]).map(toExercise)
}

function mustOwn(db: Db, userId: string, id: string): ExerciseRow {
  const r = db.prepare('SELECT e.* FROM fact_exercises e JOIN facts f ON f.id = e.fact_id WHERE e.id = ? AND f.user_id = ?').get(id, userId) as ExerciseRow | undefined
  if (!r) throw new HttpError(404, `exercise ${id} not found`)
  return r
}

export interface AddExercisesResult {
  created: { index: number; id: string }[]
  // Same prompt (normalised) as an item the pool has, whatever its status.
  duplicates: { index: number; existingId: string; existingStatus: ExerciseStatus }[]
  errors: { index: number; error: string }[]
}

// Validates (core.cleanExercise) and dedupes by prompt, against the pool and
// earlier items of the batch. Items are created a millisecond apart, in order.
export function addExercises(
  db: Db,
  userId: string,
  factId: string,
  items: (ExerciseInput & { importRef?: string })[],
  createdBy: Author,
  now: Date,
): AddExercisesResult {
  return tx(db, () => {
    mustGetFact(db, userId, factId)
    const out: AddExercisesResult = { created: [], duplicates: [], errors: [] }
    const find = db.prepare('SELECT id, status FROM fact_exercises WHERE fact_id = ? AND dedupe_key = ?')
    const insert = db.prepare(`INSERT INTO fact_exercises(id, fact_id, type, prompt, answer, accepted, options, wrong, explain, created_by, dedupe_key, import_ref, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    items.forEach((input, index) => {
      const r = cleanExercise(input)
      if ('error' in r) {
        out.errors.push({ index, error: r.error })
        return
      }
      const key = exerciseKey(r.item.prompt, r.item.type)
      const dup = find.get(factId, key) as { id: string; status: ExerciseStatus } | undefined
      if (dup) {
        out.duplicates.push({ index, existingId: dup.id, existingStatus: dup.status })
        return
      }
      const id = newId('ex')
      const it = r.item
      insert.run(id, factId, it.type, it.prompt, it.answer, JSON.stringify(it.accepted), JSON.stringify(it.options), it.wrong, it.explain, createdBy, key, input.importRef ?? null,
        new Date(now.getTime() + index).toISOString())
      out.created.push({ index, id })
    })
    return out
  })
}

export type ExercisePatch = Partial<ExerciseInput> & { status?: ExerciseStatus; needsReview?: boolean }

export function updateExercise(db: Db, userId: string, id: string, patch: ExercisePatch): ExerciseInfo {
  return tx(db, () => {
    const cur = toExercise(mustOwn(db, userId, id))
    const r = cleanExercise({
      type: patch.type ?? cur.type,
      prompt: patch.prompt ?? patch.text ?? cur.prompt,
      answer: patch.answer ?? cur.answer,
      accepted: patch.accepted ?? cur.accepted,
      explain: patch.explain !== undefined ? patch.explain : cur.explain,
      options: patch.options ?? cur.options ?? [],
      wrong: patch.wrong !== undefined ? patch.wrong : cur.wrong ?? null,
    })
    if ('error' in r) throw new HttpError(400, r.error)
    const status = patch.status ?? cur.status
    if (status !== 'active' && status !== 'flagged') throw new HttpError(400, 'status must be active or flagged')
    const key = exerciseKey(r.item.prompt, r.item.type)
    const dup = db.prepare('SELECT id FROM fact_exercises WHERE fact_id = ? AND dedupe_key = ? AND id <> ?').get(cur.factId, key, id)
    if (dup) throw new HttpError(409, 'the pool already has this prompt')
    db.prepare('UPDATE fact_exercises SET type = ?, prompt = ?, answer = ?, accepted = ?, options = ?, wrong = ?, explain = ?, status = ?, needs_review = ?, dedupe_key = ? WHERE id = ?').run(
      r.item.type, r.item.prompt, r.item.answer, JSON.stringify(r.item.accepted), JSON.stringify(r.item.options), r.item.wrong, r.item.explain, status,
      (patch.needsReview ?? cur.needsReview) ? 1 : 0, key, id,
    )
    return toExercise(db.prepare('SELECT * FROM fact_exercises WHERE id = ?').get(id) as unknown as ExerciseRow)
  })
}

export function deleteExercise(db: Db, userId: string, id: string) {
  mustOwn(db, userId, id)
  db.prepare('DELETE FROM fact_exercises WHERE id = ?').run(id)
}

export interface PoolCounts {
  active: number
  flagged: number
  needsReview: number
  // Active and never shown: what the top-up keeps stocked.
  fresh: number
}

// Pool counts per fact, for the facts given (or all of the user's).
export function poolCounts(db: Db, factIds: string[]): Map<string, PoolCounts> {
  const out = new Map<string, PoolCounts>()
  for (let i = 0; i < factIds.length; i += 500) {
    const chunk = factIds.slice(i, i + 500)
    const rows = db.prepare(`SELECT fact_id, sum(status = 'active') AS active, sum(status = 'flagged') AS flagged,
        sum(needs_review = 1) AS needs_review, sum(status = 'active' AND shown_count = 0) AS fresh
      FROM fact_exercises WHERE fact_id IN (${chunk.map(() => '?').join(',')}) GROUP BY fact_id`).all(...chunk) as { fact_id: string; active: number; flagged: number; needs_review: number; fresh: number }[]
    for (const r of rows) out.set(r.fact_id, { active: r.active, flagged: r.flagged, needsReview: r.needs_review, fresh: r.fresh })
  }
  return out
}

// PER_REVIEW items from a pool: least recently shown first (never shown
// before anything), random among equals, at most SAME_TYPE of one type
// unless the pool has nothing else.
export function pickExercises<T extends { type: string; last_shown_at: string | null }>(pool: T[], n = PER_REVIEW, rand: () => number = Math.random): T[] {
  const order = pool
    .map((x) => ({ x, r: rand() }))
    .sort((a, b) => (a.x.last_shown_at ?? '').localeCompare(b.x.last_shown_at ?? '') || a.r - b.r)
    .map((o) => o.x)
  const out: T[] = []
  const per = new Map<string, number>()
  for (const x of order) {
    if (out.length >= n) break
    if ((per.get(x.type) ?? 0) >= SAME_TYPE) continue
    out.push(x)
    per.set(x.type, (per.get(x.type) ?? 0) + 1)
  }
  for (const x of order) {
    if (out.length >= n) break
    if (!out.includes(x)) out.push(x)
  }
  return out
}

// The items a review draws from: with MIN_POOL active tap items (choose,
// spot), only those — the typed legacy types are never served again; else
// the whole active pool, tap items first.
export function servablePool<T extends { type: string; last_shown_at: string | null }>(pool: T[]): T[] {
  const tap = pool.filter((x) => isTapType(x.type as ExerciseType))
  if (tap.length >= MIN_POOL) return tap
  return pool
}

// This review's items for every fact given that has a pool to review from.
export function exercisesForQueue(db: Db, factIds: string[], rand: () => number = Math.random): Map<string, ExerciseItem[]> {
  const out = new Map<string, ExerciseItem[]>()
  for (let i = 0; i < factIds.length; i += 500) {
    const chunk = factIds.slice(i, i + 500)
    const rows = db.prepare(`SELECT * FROM fact_exercises WHERE status = 'active' AND fact_id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as unknown as ExerciseRow[]
    const byFact = new Map<string, ExerciseRow[]>()
    for (const r of rows) byFact.set(r.fact_id, [...(byFact.get(r.fact_id) ?? []), r])
    for (const [factId, all] of byFact) {
      if (all.length < MIN_POOL) continue
      const pool = servablePool(all)
      const tap = pool.filter((x) => isTapType(x.type as ExerciseType))
      // A pool still short of tap items: those come first, typed ones fill up.
      const picked = tap.length && tap.length < pool.length
        ? [...pickExercises(tap, PER_REVIEW, rand), ...pickExercises(pool.filter((x) => !tap.includes(x)), PER_REVIEW - Math.min(tap.length, PER_REVIEW), rand)]
        : pickExercises(pool, PER_REVIEW, rand)
      out.set(factId, picked.map(toItem))
    }
  }
  return out
}

// A review of an exercise fact: keeps each item's attempt and updates its
// counters (shown, right / wrong — a bad item counts as neither). "I was
// right" marks the item for a look; "bad item" takes it out of the pool.
// Items of another fact, and repeats, are ignored.
export function recordAttempts(db: Db, logId: string, factId: string, attempts: ExerciseAttempt[], at: string) {
  const own = db.prepare('SELECT 1 FROM fact_exercises WHERE id = ? AND fact_id = ?')
  const insert = db.prepare('INSERT OR IGNORE INTO exercise_attempts(review_log_id, exercise_id, given, correct, overridden, bad, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const update = db.prepare(`UPDATE fact_exercises SET shown_count = shown_count + 1,
      last_shown_at = CASE WHEN last_shown_at IS NULL OR last_shown_at < ? THEN ? ELSE last_shown_at END,
      correct_count = correct_count + ?, wrong_count = wrong_count + ?,
      needs_review = CASE WHEN ? THEN 1 ELSE needs_review END,
      status = CASE WHEN ? THEN 'flagged' ELSE status END
    WHERE id = ?`)
  for (const a of attempts) {
    if (!own.get(a.id, factId)) continue
    const r = insert.run(logId, a.id, a.given.slice(0, 500), a.correct ? 1 : 0, a.overridden ? 1 : 0, a.bad ? 1 : 0, at)
    if (!r.changes) continue
    const graded = !a.bad
    update.run(at, at, graded && a.correct ? 1 : 0, graded && !a.correct ? 1 : 0, a.overridden ? 1 : 0, a.bad ? 1 : 0, a.id)
  }
}

// Undoing a review takes its attempts back out of the counters (flags set by
// it stay: the learner meant them). The attempts go with the log.
export function revertAttempts(db: Db, logId: string) {
  const rows = db.prepare('SELECT exercise_id, correct, bad FROM exercise_attempts WHERE review_log_id = ?').all(logId) as { exercise_id: string; correct: number; bad: number }[]
  db.prepare('DELETE FROM exercise_attempts WHERE review_log_id = ?').run(logId)
  const update = db.prepare(`UPDATE fact_exercises SET shown_count = max(0, shown_count - 1),
      correct_count = max(0, correct_count - ?), wrong_count = max(0, wrong_count - ?),
      last_shown_at = (SELECT max(at) FROM exercise_attempts WHERE exercise_id = fact_exercises.id)
    WHERE id = ?`)
  for (const r of rows) update.run(!r.bad && r.correct ? 1 : 0, !r.bad && !r.correct ? 1 : 0, r.exercise_id)
}

export const EXERCISE_STATUSES: readonly ExerciseStatus[] = ['active', 'flagged']
export { EXERCISE_TYPES }
