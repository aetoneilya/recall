// Per-user FSRS: training data from the review logs, thresholds and cadence,
// adoption sanity checks, the real fsrs-rs binding on a synthetic history,
// and that ratings are scheduled with the user's own weights.
import { DEFAULT_WEIGHTS, review, scheduler } from '@recall/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bindingOptimizer, checkCandidate, dueForTraining, fsrsTick, reviewHistories, trainingItems, trainUser, userFsrs, type FsrsOptimizer } from '../src/fsrs.ts'
import { applyReviews } from '../src/study.ts'
import { ensureUser, getUser, updateUserSettings } from '../src/users.ts'
import { addWord, cardsOf, listen, makeCtx, rate, send, TZ, type TestCtx } from './helpers.ts'

const DAY = 86400_000

// A deterministic history: `cards` words, each forward card reviewed `reps`
// times on its due date, rated Again with ~15% probability.
let words = 0
function simulate(ctx: TestCtx, cards: number, reps: number, userId = ctx.user.id) {
  let seed = 7
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const start = new Date('2026-01-01T09:00:00Z').getTime()
  let n = 0
  for (let i = 0; i < cards; i++) {
    const w = addWord(ctx, `w${++words}`, { userId, at: new Date(start + (i % 30) * DAY) })
    let at = new Date(start + (i % 30) * DAY)
    let cardId = cardsOf(ctx, w.id, userId)[0]!.id
    for (let k = 0; k < reps; k++) {
      const rating = k === 0 ? 3 : rnd() < 0.15 ? 1 : 3
      const r = applyReviews(ctx.db, userId, [{ id: `sim-${w.id}-${k}`, cardId, rating, reviewedAt: at.toISOString() }])
      n++
      // At least a day later, so the history has long-term reviews.
      at = new Date(Math.max(Date.parse(r.cards[0]!.schedule.due), at.getTime() + DAY))
      cardId = r.cards[0]!.id
    }
  }
  return n
}

describe('training data', () => {
  it('turns each card’s logs into (rating, study days since the previous review), Anki-style', () => {
    const ctx = makeCtx()
    const w = addWord(ctx, 'frown')
    const [fwd, rev] = cardsOf(ctx, w.id)
    // Study day starts at 04:00 Moscow (01:00 UTC): 00:30 UTC belongs to the previous day.
    rate(ctx, fwd!.id, 3, new Date('2026-10-01T09:00:00Z'))
    rate(ctx, fwd!.id, 1, new Date('2026-10-01T09:10:00Z'))
    rate(ctx, fwd!.id, 3, new Date('2026-10-04T00:30:00Z'))
    rate(ctx, fwd!.id, 4, new Date('2026-10-04T09:00:00Z'))
    rate(ctx, rev!.id, 2, new Date('2026-10-02T09:00:00Z'))
    // A card whose logged history starts mid-way (an import) is skipped.
    const other = addWord(ctx, 'bone')
    const c = cardsOf(ctx, other.id)[0]!
    rate(ctx, c.id, 3, new Date('2026-10-01T09:00:00Z'))
    ctx.db.prepare(`UPDATE review_logs SET "before" = json_set("before", '$.state', 2) WHERE card_id = ?`).run(c.id)

    const { histories, reviews } = reviewHistories(ctx.db, ctx.user.id, TZ)
    expect(reviews).toBe(5)
    const sorted = histories.sort((a, b) => b.length - a.length)
    expect(sorted).toEqual([
      [{ rating: 3, deltaT: 0 }, { rating: 1, deltaT: 0 }, { rating: 3, deltaT: 2 }, { rating: 4, deltaT: 1 }],
      [{ rating: 2, deltaT: 0 }],
    ])
    // One item per review after the first, once a long-term review is in it.
    expect(trainingItems(sorted)).toEqual([sorted[0]!.slice(0, 3), sorted[0]!])
    // Other users' logs never leak in.
    expect(reviewHistories(ctx.db, ensureUser(ctx.db, ctx.cfg, 2, ctx.now()).id, TZ)).toEqual({ histories: [], reviews: 0 })
  })
})

describe('adoption checks', () => {
  const base = { logLoss: 0.4, rmse: 0.05 }
  it('takes only finite weights of the right length that fit at least as well as every baseline', () => {
    const good = DEFAULT_WEIGHTS.map((w) => w * 1.01)
    expect(checkCandidate(good, { logLoss: 0.39, rmse: 0.04 }, [base])).toMatchObject({ ok: true })
    expect(checkCandidate(good.slice(0, 19), { logLoss: 0.3, rmse: 0.03 }, [base])).toEqual({ ok: false, reason: 'expected 21 weights, got 19' })
    expect(checkCandidate(good.map((w, i) => (i === 3 ? NaN : w)), { logLoss: 0.3, rmse: 0.03 }, [base])).toEqual({ ok: false, reason: 'weights are not all finite' })
    expect(checkCandidate(good, { logLoss: 0.41, rmse: 0.03 }, [base])).toMatchObject({ ok: false, reason: expect.stringMatching(/log loss/) })
    expect(checkCandidate(good, { logLoss: 0.39, rmse: 0.06 }, [base])).toMatchObject({ ok: false, reason: expect.stringMatching(/RMSE/) })
    expect(checkCandidate(good, { logLoss: 0.39, rmse: 0.04 }, [base, { logLoss: 0.38, rmse: 0.04 }])).toMatchObject({ ok: false })
    expect(checkCandidate(good, { logLoss: NaN, rmse: 0.04 }, [base])).toEqual({ ok: false, reason: 'evaluation failed' })
  })

  it('trains in the background only with enough reviews, at most weekly, and only when there are new ones', () => {
    const now = new Date('2026-10-21T09:00:00Z')
    const fresh = { fsrsAttemptedAt: null, fsrsReviewsUsed: null }
    expect(dueForTraining(fresh, 999, 1000, now)).toBe(false)
    expect(dueForTraining(fresh, 1000, 1000, now)).toBe(true)
    const recent = { fsrsAttemptedAt: new Date(now.getTime() - 6 * DAY).toISOString(), fsrsReviewsUsed: 1000 }
    expect(dueForTraining(recent, 2000, 1000, now)).toBe(false)
    const weekAgo = { fsrsAttemptedAt: new Date(now.getTime() - 7 * DAY).toISOString(), fsrsReviewsUsed: 1000 }
    expect(dueForTraining(weekAgo, 2000, 1000, now)).toBe(true)
    expect(dueForTraining(weekAgo, 1000, 1000, now)).toBe(false)
  })
})

// A fake fsrs-rs: hands out the given weights and metrics.
function fakeOptimizer(weights: number[][], metrics: (w: readonly number[]) => { logLoss: number; rmse: number }): FsrsOptimizer & { runs: number } {
  const o = {
    runs: 0,
    computeParameters: async () => weights[Math.min(o.runs++, weights.length - 1)]!,
    evaluate: (w: readonly number[]) => metrics(w),
  }
  return o
}

describe('training with a fake optimizer', () => {
  const W1 = DEFAULT_WEIGHTS.map((w, i) => (i < 4 ? w * 2 : w))
  const W2 = DEFAULT_WEIGHTS.map((w, i) => (i < 4 ? w * 3 : w))
  // Lower is better for weights further from the defaults.
  const metrics = (w: readonly number[]) => ({ logLoss: 0.5 - (w[0]! - DEFAULT_WEIGHTS[0]!) / 10, rmse: 0.1 - (w[0]! - DEFAULT_WEIGHTS[0]!) / 100 })

  it('needs FSRS_MIN_REVIEWS usable reviews, keeps the previous weights, and rejects bad ones', async () => {
    const ctx = makeCtx({ FSRS_MIN_REVIEWS: '20' })
    ctx.fsrsOptimizer = fakeOptimizer([W1, W2, W2.map((x, i) => (i === 0 ? Infinity : x))], metrics)
    simulate(ctx, 3, 5)
    expect(await trainUser(ctx, getUser(ctx.db, ctx.user.id)!)).toEqual({ status: 'not-enough', reviews: 15, minReviews: 20 })
    expect(getUser(ctx.db, ctx.user.id)!.fsrsAttemptedAt).toBeNull()
    simulate(ctx, 2, 5)

    const first = await trainUser(ctx, getUser(ctx.db, ctx.user.id)!)
    expect(first).toMatchObject({ status: 'adopted', reviews: 25 })
    expect(userFsrs(ctx.db, ctx.user.id).weights).toEqual(W1)
    expect(getUser(ctx.db, ctx.user.id)).toMatchObject({ fsrsTrainedAt: ctx.now().toISOString(), fsrsReviewsUsed: 25, fsrsAttemptedAt: ctx.now().toISOString() })

    await trainUser(ctx, getUser(ctx.db, ctx.user.id)!)
    const row = ctx.db.prepare('SELECT fsrs_weights, fsrs_prev_weights, fsrs_result FROM users WHERE id = ?').get(ctx.user.id) as Record<string, string>
    expect(JSON.parse(row.fsrs_weights!)).toEqual(W2)
    expect(JSON.parse(row.fsrs_prev_weights!)).toEqual(W1)

    // Non-finite weights are never adopted; the ones in use stay.
    expect(await trainUser(ctx, getUser(ctx.db, ctx.user.id)!)).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/finite/) })
    expect(userFsrs(ctx.db, ctx.user.id).weights).toEqual(W2)
    expect(JSON.parse((ctx.db.prepare('SELECT fsrs_result FROM users WHERE id = ?').get(ctx.user.id) as { fsrs_result: string }).fsrs_result)).toMatchObject({ status: 'rejected' })
  })

  it('rejects weights that fit worse than the ones in use', async () => {
    const ctx = makeCtx({ FSRS_MIN_REVIEWS: '10' })
    ctx.fsrsOptimizer = fakeOptimizer([W2, W1], metrics)
    simulate(ctx, 2, 6)
    expect(await trainUser(ctx, ctx.user)).toMatchObject({ status: 'adopted' })
    // W1 beats the defaults but not W2.
    expect(await trainUser(ctx, ctx.user)).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/log loss/) })
    expect(userFsrs(ctx.db, ctx.user.id).weights).toEqual(W2)
  })

  it('the hourly job trains due users only, weekly', async () => {
    const ctx = makeCtx({ FSRS_MIN_REVIEWS: '10', OWNER_TELEGRAM_ID: '1001', ALLOW_USER_IDS: '2002' })
    const opt = fakeOptimizer([W1], metrics)
    ctx.fsrsOptimizer = opt
    const other = ensureUser(ctx.db, ctx.cfg, 2002, ctx.now())
    simulate(ctx, 2, 6)
    simulate(ctx, 1, 3, other.id)
    await fsrsTick(ctx)
    expect(opt.runs).toBe(1)
    expect(userFsrs(ctx.db, other.id).weights).toBeNull()
    simulate(ctx, 1, 3)
    ctx.clock.t = new Date(ctx.clock.t.getTime() + 6 * DAY)
    await fsrsTick(ctx)
    expect(opt.runs).toBe(1)
    ctx.clock.t = new Date(ctx.clock.t.getTime() + DAY)
    await fsrsTick(ctx)
    expect(opt.runs).toBe(2)
  })
})

describe('training with fsrs-rs', () => {
  it('loads the native binding and adopts weights trained on ≥ 1000 synthetic reviews', async () => {
    const opt = await bindingOptimizer()
    expect(opt).not.toBeNull()
    const ctx = makeCtx()
    expect(simulate(ctx, 160, 7)).toBe(1120)
    const r = await trainUser(ctx, ctx.user)
    expect(r.status).toBe('adopted')
    if (r.status !== 'adopted') return
    expect(r.weights).toHaveLength(21)
    expect(r.weights.every(Number.isFinite)).toBe(true)
    expect(r.metrics.logLoss).toBeLessThanOrEqual(r.baseline.logLoss)
    expect(r.metrics.rmse).toBeLessThanOrEqual(r.baseline.rmse)
    expect(userFsrs(ctx.db, ctx.user.id).weights).toEqual(r.weights)
  }, 60_000)
})

describe('scheduling with the user’s parameters', () => {
  it('applyReviews uses the user’s weights and target retention; other users keep the defaults', () => {
    const ctx = makeCtx({ OWNER_TELEGRAM_ID: '1001', ALLOW_USER_IDS: '2002' })
    const other = ensureUser(ctx.db, ctx.cfg, 2002, ctx.now())
    const W = DEFAULT_WEIGHTS.map((w, i) => (i === 2 ? 5.5 : w))
    ctx.db.prepare('UPDATE users SET fsrs_weights = ? WHERE id = ?').run(JSON.stringify(W), ctx.user.id)
    const at = new Date('2026-10-21T09:00:00Z')
    const mine = cardsOf(ctx, addWord(ctx, 'frown').id)[0]!
    const theirs = cardsOf(ctx, addWord(ctx, 'frown', { userId: other.id }).id, other.id)[0]!
    // A new card rated Good starts at stability w[2].
    expect(rate(ctx, mine.id, 3, at).cards[0]!.schedule.stability).toBeCloseTo(5.5)
    expect(applyReviews(ctx.db, other.id, [{ id: 'o1', cardId: theirs.id, rating: 3, reviewedAt: at.toISOString() }]).cards[0]!.schedule.stability).toBeCloseTo(DEFAULT_WEIGHTS[2]!)

    // A lower target retention means longer intervals.
    const later = new Date(at.getTime() + 10 * DAY)
    const before = cardsOf(ctx, addWord(ctx, 'bone').id)[0]!
    rate(ctx, before.id, 3, at)
    rate(ctx, before.id, 3, new Date(at.getTime() + 10 * 60_000))
    const state = cardsOf(ctx, before.wordId)[0]!.schedule
    const at90 = review(state, 3, later, scheduler({ weights: W, requestRetention: 0.9 }))
    updateUserSettings(ctx.db, ctx.user.id, { requestRetention: 0.8 })
    const r = rate(ctx, before.id, 3, later).cards[0]!.schedule
    expect(r.scheduledDays).toBeGreaterThan(at90.scheduledDays)
    expect(userFsrs(ctx.db, other.id)).toEqual({ weights: null, requestRetention: 0.9 })
  })
})

describe('settings and FSRS over HTTP', () => {
  let ctx: TestCtx
  let url: string
  let close: () => Promise<void>
  const api = async (method: string, p: string, body?: unknown) => {
    const r = method === 'GET' ? await fetch(`${url}/api${p}`) : await send(`${url}/api${p}`, method, body ?? {})
    return { status: r.status, body: (await r.json()) as any }
  }
  beforeAll(async () => {
    ctx = makeCtx({ DEV: '1', OWNER_TELEGRAM_ID: '1001', FSRS_MIN_REVIEWS: '10' })
    const s = await listen(ctx)
    url = s.url
    close = s.close
  })
  afterAll(async () => close())

  it('GET /api/me shows the weekly report switch and FSRS; PATCH changes them', async () => {
    const me = await api('GET', '/me')
    expect(me.body).toMatchObject({ weeklyReport: true, weeklyReportDay: 0, weeklyReportTime: '19:00',
      fsrs: { weights: null, requestRetention: 0.9, trainedAt: null, reviewsUsed: null, minReviews: 10 } })
    expect((await api('PATCH', '/me', { weeklyReport: false, requestRetention: 0.85 })).body).toMatchObject({ weeklyReport: false, fsrs: { requestRetention: 0.85 } })
    for (const bad of [{ requestRetention: 0.7 }, { requestRetention: 0.98 }, { weeklyReport: 'yes' }, { weeklyReportDay: 7 }, { weeklyReportTime: '25:00' }]) {
      expect((await api('PATCH', '/me', bad)).status).toBe(400)
    }
    expect((await api('PATCH', '/me', { weeklyReport: true, weeklyReportDay: 6, weeklyReportTime: '10:30' })).body).toMatchObject({ weeklyReport: true, weeklyReportDay: 6, weeklyReportTime: '10:30' })
  })

  it('POST /api/fsrs/optimize: 422 without enough reviews, trains, then 429 for a day', async () => {
    const W = DEFAULT_WEIGHTS.map((w, i) => (i === 0 ? w * 2 : w))
    ctx.fsrsOptimizer = fakeOptimizer([W], (w) => ({ logLoss: w[0] === W[0] ? 0.3 : 0.4, rmse: w[0] === W[0] ? 0.03 : 0.04 }))
    const few = await api('POST', '/fsrs/optimize')
    expect(few).toMatchObject({ status: 422, body: { reviews: 0, minReviews: 10 } })
    simulate(ctx, 2, 6)
    const ok = await api('POST', '/fsrs/optimize')
    expect(ok).toMatchObject({ status: 200, body: { adopted: true, reviews: 12, metrics: { logLoss: 0.3 }, baseline: { logLoss: 0.4 }, fsrs: { weights: W, reviewsUsed: 12, trainedAt: ctx.now().toISOString() } } })
    expect((await api('GET', '/me')).body.fsrs.weights).toEqual(W)
    expect((await api('POST', '/fsrs/optimize')).status).toBe(429)
    ctx.fsrsOptimizer = null
    ctx.clock.t = new Date(ctx.clock.t.getTime() + DAY + 1)
    expect((await api('POST', '/fsrs/optimize')).status).toBe(503)
  })

  it('decks carry typeAnswer, validated on PATCH', async () => {
    const [d] = (await api('GET', '/decks')).body.decks
    expect(d.typeAnswer).toBe('off')
    expect((await api('PATCH', `/decks/${d.id}`, { typeAnswer: 'reverse' })).body.deck).toMatchObject({ typeAnswer: 'reverse' })
    expect((await api('GET', '/decks')).body.decks[0].typeAnswer).toBe('reverse')
    expect((await api('PATCH', `/decks/${d.id}`, { typeAnswer: 'sometimes' })).status).toBe(400)
    expect((await api('PATCH', `/decks/${d.id}`, { typeAnswer: null })).status).toBe(400)
    expect((await api('PATCH', `/decks/${d.id}`, { typeAnswer: 'both' })).body.deck.typeAnswer).toBe('both')
  })
})
