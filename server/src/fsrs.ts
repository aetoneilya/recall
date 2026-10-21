// FSRS parameters per user: the scheduler built from the user's own weights
// and target retention, and training those weights on their review history.
//
// Training uses fsrs-rs through @open-spaced-repetition/binding (a prebuilt
// N-API addon per platform, linux-x64-gnu included; no compiler needed). It is
// imported lazily, so a missing or broken binary only turns training off.
// A card's history becomes FSRSItems the way Anki does it: its ratings in
// order with delta_t = study days since the previous review (0 for the
// first and for same-day reviews), one item per review after the first,
// keeping items with at least one long-term (delta_t > 0) review. Cards whose
// logged history doesn't start at their first review (imports) are skipped.
//
// New weights are adopted only when they are finite, the expected length, and
// fit the same data at least as well (log loss and RMSE) as both the defaults
// and the user's current weights. The previous weights are kept.
import {
  dayKey, DEFAULT_WEIGHTS, sanitizeWeights, scheduler, type DayOptions, type Rating,
} from '@recall/core'
import type { AppContext } from './context.ts'
import type { Db } from './db.ts'
import { HttpError } from './repo.ts'
import { getUser, isAllowed, listUsers, userDayOptions, type User } from './users.ts'

export const REQUEST_RETENTION = { min: 0.75, max: 0.97, default: 0.9 } as const
// Background training at most this often per user; a manual run at most once a day.
export const TRAIN_EVERY_MS = 7 * 86400_000
export const MANUAL_EVERY_MS = 86400_000

// ---------- scheduling ----------

export interface UserFsrs {
  weights: number[] | null
  requestRetention: number
}

export function userFsrs(db: Db, userId: string): UserFsrs {
  const r = db.prepare('SELECT request_retention, fsrs_weights FROM users WHERE id = ?').get(userId) as { request_retention: number; fsrs_weights: string | null } | undefined
  let weights: number[] | null = null
  try {
    weights = r?.fsrs_weights ? sanitizeWeights(JSON.parse(r.fsrs_weights) as number[]) : null
  } catch {
    weights = null
  }
  const rr = r?.request_retention
  return { weights, requestRetention: typeof rr === 'number' && rr >= REQUEST_RETENTION.min && rr <= REQUEST_RETENTION.max ? rr : REQUEST_RETENTION.default }
}

// The scheduler every server-side rating of this user goes through.
export function userScheduler(db: Db, userId: string) {
  const f = userFsrs(db, userId)
  return scheduler({ requestRetention: f.requestRetention, ...(f.weights ? { weights: f.weights } : {}) })
}

// ---------- training data ----------

export interface HistoryReview {
  rating: Rating
  // Study days since the previous review; 0 for the first one.
  deltaT: number
}

const dayNumber = (key: string) => Math.round(Date.parse(`${key}T00:00:00Z`) / 86400_000)

// Per card, its reviews in order; only cards whose logs start at their first
// review (state new before it). `reviews` counts the logs used.
export function reviewHistories(db: Db, userId: string, opts: DayOptions): { histories: HistoryReview[][]; reviews: number } {
  const rows = db.prepare(`
    SELECT l.card_id, l.rating, l.reviewed_at, json_extract(l."before", '$.state') AS before_state
    FROM review_logs l JOIN cards c ON c.id = l.card_id JOIN words w ON w.id = c.word_id
    WHERE w.user_id = ? ORDER BY l.card_id, l.reviewed_at, l.rowid`).all(userId) as { card_id: string; rating: number; reviewed_at: string; before_state: number }[]
  const histories: HistoryReview[][] = []
  let reviews = 0
  let i = 0
  while (i < rows.length) {
    const card = rows[i]!.card_id
    let j = i
    while (j < rows.length && rows[j]!.card_id === card) j++
    const logs = rows.slice(i, j)
    i = j
    if (logs[0]!.before_state !== 0 || logs.some((l) => l.rating < 1 || l.rating > 4)) continue
    let prev: number | null = null
    const h = logs.map((l) => {
      const d = dayNumber(dayKey(new Date(l.reviewed_at), opts))
      const deltaT = prev === null ? 0 : Math.max(0, d - prev)
      prev = d
      return { rating: l.rating as Rating, deltaT }
    })
    histories.push(h)
    reviews += h.length
  }
  return { histories, reviews }
}

// FSRSItems: every prefix of a history ending at its 2nd, 3rd… review that
// contains a long-term review.
export function trainingItems(histories: HistoryReview[][]): HistoryReview[][] {
  const items: HistoryReview[][] = []
  for (const h of histories) {
    for (let k = 2; k <= h.length; k++) {
      const item = h.slice(0, k)
      if (item.slice(1).some((r) => r.deltaT > 0)) items.push(item)
    }
  }
  return items
}

// ---------- optimizer ----------

export interface Metrics {
  logLoss: number
  rmse: number
}

// What training needs from fsrs-rs; tests can pass a fake.
export interface FsrsOptimizer {
  computeParameters(items: HistoryReview[][]): Promise<number[]>
  evaluate(weights: readonly number[], items: HistoryReview[][]): Metrics
}

let loaded: Promise<FsrsOptimizer | null> | null = null

// The fsrs-rs binding, or null (logged once) when it can't be loaded on this platform.
export function bindingOptimizer(): Promise<FsrsOptimizer | null> {
  loaded ??= import('@open-spaced-repetition/binding').then(
    (b) => {
      const toItems = (items: HistoryReview[][]) => items.map((it) => new b.FSRSBindingItem(it.map((r) => new b.FSRSBindingReview(r.rating, r.deltaT))))
      return {
        // No `timeout`: in 0.5.0 it makes the call never resolve.
        computeParameters: (items) => b.computeParameters(toItems(items), { enableShortTerm: true, numRelearningSteps: 1 }),
        evaluate: (weights, items) => {
          const e = new b.FSRSBinding([...weights]).evaluate(toItems(items))
          return { logLoss: e.logLoss, rmse: e.rmseBins }
        },
      } satisfies FsrsOptimizer
    },
    (e) => {
      console.warn(`FSRS training is off: cannot load @open-spaced-repetition/binding: ${(e as Error).message}`)
      return null
    },
  )
  return loaded
}

function optimizerOf(ctx: AppContext): Promise<FsrsOptimizer | null> {
  if (ctx.fsrsOptimizer !== undefined) return Promise.resolve(ctx.fsrsOptimizer)
  return bindingOptimizer()
}

// ---------- training ----------

export type TrainResult =
  | { status: 'adopted'; weights: number[]; reviews: number; metrics: Metrics; baseline: Metrics }
  | { status: 'rejected'; reason: string; reviews: number; metrics?: Metrics; baseline?: Metrics }
  | { status: 'not-enough'; reviews: number; minReviews: number }
  | { status: 'unavailable' }

// Adopt only finite weights of the expected length that fit no worse than
// every baseline (defaults, current) on the same items.
export function checkCandidate(raw: readonly number[], metrics: Metrics | null, baselines: Metrics[]): { ok: true; weights: number[] } | { ok: false; reason: string } {
  const weights = sanitizeWeights(raw)
  if (!weights) return { ok: false, reason: raw.length !== DEFAULT_WEIGHTS.length ? `expected ${DEFAULT_WEIGHTS.length} weights, got ${raw.length}` : 'weights are not all finite' }
  if (!metrics || !Number.isFinite(metrics.logLoss) || !Number.isFinite(metrics.rmse)) return { ok: false, reason: 'evaluation failed' }
  const eps = 1e-9
  for (const b of baselines) {
    if (metrics.logLoss > b.logLoss + eps) return { ok: false, reason: `log loss ${metrics.logLoss.toFixed(4)} is worse than ${b.logLoss.toFixed(4)}` }
    if (metrics.rmse > b.rmse + eps) return { ok: false, reason: `RMSE ${metrics.rmse.toFixed(4)} is worse than ${b.rmse.toFixed(4)}` }
  }
  return { ok: true, weights }
}

const running = new Set<string>()

// Trains one user's weights now (no cadence checks; see fsrsTick and the route).
export async function trainUser(ctx: AppContext, user: User): Promise<TrainResult> {
  const { db, cfg } = ctx
  if (running.has(user.id)) throw new HttpError(409, 'FSRS training is already running')
  running.add(user.id)
  try {
    const { histories, reviews } = reviewHistories(db, user.id, userDayOptions(cfg, user))
    if (reviews < cfg.fsrsMinReviews) return { status: 'not-enough', reviews, minReviews: cfg.fsrsMinReviews }
    const opt = await optimizerOf(ctx)
    if (!opt) return { status: 'unavailable' }
    const startedAt = ctx.now()
    db.prepare('UPDATE users SET fsrs_attempted_at = ? WHERE id = ?').run(startedAt.toISOString(), user.id)
    const items = trainingItems(histories)
    let result: TrainResult
    try {
      const raw = await opt.computeParameters(items)
      const current = userFsrs(db, user.id).weights
      const safe = sanitizeWeights(raw)
      const metrics = safe ? opt.evaluate(safe, items) : null
      const baseline = opt.evaluate(DEFAULT_WEIGHTS, items)
      const baselines = [baseline, ...(current ? [opt.evaluate(current, items)] : [])]
      const check = checkCandidate(raw, metrics, baselines)
      result = check.ok
        ? { status: 'adopted', weights: check.weights, reviews, metrics: metrics!, baseline }
        : { status: 'rejected', reason: check.reason, reviews, ...(metrics ? { metrics } : {}), baseline }
    } catch (e) {
      result = { status: 'rejected', reason: `training failed: ${(e as Error).message}`, reviews }
    }
    const at = ctx.now().toISOString()
    const summary = { at, ...result, ...(result.status === 'adopted' ? { weights: undefined } : {}) }
    if (result.status === 'adopted') {
      db.prepare(`UPDATE users SET fsrs_prev_weights = fsrs_weights, fsrs_weights = ?, fsrs_trained_at = ?, fsrs_reviews_used = ?, fsrs_result = ? WHERE id = ?`)
        .run(JSON.stringify(result.weights), at, reviews, JSON.stringify(summary), user.id)
    } else {
      db.prepare('UPDATE users SET fsrs_result = ? WHERE id = ?').run(JSON.stringify(summary), user.id)
    }
    console.log(`fsrs user=${user.id} reviews=${reviews} items=${items.length} ${result.status}${'reason' in result ? `: ${result.reason}` : ''}` +
      ('metrics' in result && result.metrics ? ` logLoss=${result.metrics.logLoss.toFixed(4)} rmse=${result.metrics.rmse.toFixed(4)}` : '') +
      ('baseline' in result && result.baseline ? ` (defaults ${result.baseline.logLoss.toFixed(4)} / ${result.baseline.rmse.toFixed(4)})` : ''))
    return result
  } finally {
    running.delete(user.id)
  }
}

// Usable reviews since the last attempt, cheaply: all of the user's logs.
function reviewCount(db: Db, userId: string): number {
  return (db.prepare('SELECT count(*) AS n FROM review_logs l JOIN cards c ON c.id = l.card_id JOIN words w ON w.id = c.word_id WHERE w.user_id = ?').get(userId) as { n: number }).n
}

// Should the background job train this user now: enough reviews, nothing
// attempted in the last week, and new reviews since the weights in use.
export function dueForTraining(user: Pick<User, 'fsrsAttemptedAt' | 'fsrsReviewsUsed'>, totalReviews: number, minReviews: number, now: Date): boolean {
  if (totalReviews < minReviews) return false
  if (user.fsrsAttemptedAt && now.getTime() - Date.parse(user.fsrsAttemptedAt) < TRAIN_EVERY_MS) return false
  return user.fsrsReviewsUsed === null || totalReviews > user.fsrsReviewsUsed
}

// The hourly pass: trains every allowed user who is due, one at a time.
export async function fsrsTick(ctx: AppContext): Promise<void> {
  for (const user of listUsers(ctx.db)) {
    if (!isAllowed(ctx.cfg, user.telegramId)) continue
    if (!dueForTraining(user, reviewCount(ctx.db, user.id), ctx.cfg.fsrsMinReviews, ctx.now())) continue
    try {
      await trainUser(ctx, user)
    } catch (e) {
      console.error(`fsrs training for user ${user.id}:`, e)
    }
  }
}

export function startFsrsJob(ctx: AppContext): () => void {
  const run = () => fsrsTick(ctx).catch((e) => console.error('fsrs:', e))
  const first = setTimeout(run, 60_000)
  const timer = setInterval(run, 3600_000)
  first.unref()
  timer.unref()
  return () => {
    clearTimeout(first)
    clearInterval(timer)
  }
}

// POST /api/fsrs/optimize: the user's own run, at most once a day.
export async function optimizeNow(ctx: AppContext, userId: string): Promise<TrainResult> {
  const user = getUser(ctx.db, userId)!
  if (user.fsrsAttemptedAt) {
    const wait = Date.parse(user.fsrsAttemptedAt) + MANUAL_EVERY_MS - ctx.now().getTime()
    if (wait > 0) throw new HttpError(429, 'FSRS training ran recently, try again later', { retryAfterSeconds: Math.ceil(wait / 1000) })
  }
  const r = await trainUser(ctx, user)
  if (r.status === 'not-enough') throw new HttpError(422, `not enough reviews to train FSRS (${r.reviews} of ${r.minReviews})`, { reviews: r.reviews, minReviews: r.minReviews })
  if (r.status === 'unavailable') throw new HttpError(503, 'FSRS training is not available on this server')
  return r
}

// GET /api/me's `fsrs`.
export function fsrsInfo(ctx: AppContext, user: User) {
  const f = userFsrs(ctx.db, user.id)
  return {
    weights: f.weights,
    requestRetention: f.requestRetention,
    trainedAt: user.fsrsTrainedAt,
    reviewsUsed: user.fsrsReviewsUsed,
    minReviews: ctx.cfg.fsrsMinReviews,
  }
}
