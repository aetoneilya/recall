import { clipParameters, createEmptyCard, default_relearning_steps, default_w, fsrs, type Card as FsrsCard, type Grade } from 'ts-fsrs'
import type { CardState, FsrsState, Rating } from './types.ts'

export interface SchedulerOptions {
  requestRetention?: number
  maximumIntervalDays?: number
  // FSRS weights; omit for the defaults.
  weights?: number[]
}

export function scheduler(opts: SchedulerOptions = {}) {
  return fsrs({
    request_retention: opts.requestRetention ?? 0.9,
    maximum_interval: opts.maximumIntervalDays ?? 36500,
    enable_fuzz: true,
    ...(opts.weights ? { w: opts.weights } : {}),
  })
}

// The default FSRS-6 weights (what `scheduler()` uses without `weights`).
export const DEFAULT_WEIGHTS: readonly number[] = default_w

// Trained weights made safe to use: null unless there are exactly as many as
// the defaults and all are finite; otherwise clipped to FSRS's valid ranges
// for the scheduler's (default) relearning steps and short-term mode.
export function sanitizeWeights(w: readonly number[]): number[] | null {
  if (w.length !== default_w.length || !w.every((x) => typeof x === 'number' && Number.isFinite(x))) return null
  return clipParameters([...w], default_relearning_steps.length, true)
}

export function newCardState(now: Date): CardState {
  return fromFsrs(createEmptyCard(now))
}

// Applies one rating. Server and client run the same code, so the interval
// shown on a button is the one that ends up stored.
export function review(
  state: CardState,
  rating: Rating,
  at: Date,
  f = scheduler(),
): CardState {
  return fromFsrs(f.next(toFsrs(state), at, rating as Grade).card)
}

// Next due date for every rating — for the labels under the buttons.
export function preview(state: CardState, at: Date, f = scheduler()): Record<Rating, Date> {
  const p = f.repeat(toFsrs(state), at)
  return { 1: p[1].card.due, 2: p[2].card.due, 3: p[3].card.due, 4: p[4].card.due }
}

export function retrievability(state: CardState, at: Date, f = scheduler()): number {
  if (state.state === 0) return 0
  return f.get_retrievability(toFsrs(state), at, false)
}

// "10m", "3h", "4d", "2mo", "1.5y" — compact interval for button labels.
export function formatInterval(from: Date, to: Date): string {
  const min = Math.max(1, Math.round((to.getTime() - from.getTime()) / 60000))
  if (min < 60) return `${min}m`
  const h = min / 60
  if (h < 24) return `${Math.round(h)}h`
  const d = h / 24
  if (d < 30) return `${Math.round(d)}d`
  if (d < 365) return `${Math.round(d / 30)}mo`
  return `${+(d / 365).toFixed(1)}y`
}

export function toFsrs(s: CardState): FsrsCard {
  return {
    due: new Date(s.due),
    stability: s.stability,
    difficulty: s.difficulty,
    elapsed_days: s.elapsedDays,
    scheduled_days: s.scheduledDays,
    learning_steps: s.learningSteps,
    reps: s.reps,
    lapses: s.lapses,
    state: s.state,
    last_review: s.lastReview ? new Date(s.lastReview) : undefined,
  }
}

export function fromFsrs(c: FsrsCard): CardState {
  return {
    due: c.due.toISOString(),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsedDays: c.elapsed_days,
    scheduledDays: c.scheduled_days,
    learningSteps: c.learning_steps,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state as FsrsState,
    lastReview: c.last_review ? c.last_review.toISOString() : null,
  }
}
