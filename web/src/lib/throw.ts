// Card motion numbers (web/DESIGN.md "Motion"): the drag's rotation, the
// snap-back, and a throw whose start speed matches the finger's.
import type { SwipeDir } from './swipe.ts'

export const THROW_EASE = 'cubic-bezier(0.3, 0.6, 0.5, 1)'
// Button commits throw as if released at this speed.
export const BUTTON_SPEED = 1.6
const MIN_SPEED = 1.2
const MAX_ROT = 8

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// Sideways tilt: 0.06°/px up to 8°. Grabbed in the lower half the card
// pivots around the thumb below it (clockwise to the right); in the upper
// half around a point above it (the other way).
export function tilt(dx: number, grabbedLow: boolean): number {
  const r = clamp(dx * 0.06, -MAX_ROT, MAX_ROT)
  return grabbedLow ? r : -r
}

export const tiltOrigin = (grabbedLow: boolean) => (grabbedLow ? '50% 110%' : '50% -10%')

// Vertical drags lift the card a little instead: 1 → 0.985 over the threshold.
export const lift = (pull: number) => 1 - 0.015 * clamp(pull, 0, 1)

// Released short of the threshold: settles back, longer from further away.
export const snapMs = (d: number) => clamp(180 + Math.abs(d) * 0.8, 200, 320)

// Once armed, a swipe disarms only back under 85% of the threshold, so the
// haptic doesn't chatter at the boundary.
export function nextArmed(armed: boolean, d: number, threshold: number): boolean {
  return armed ? Math.abs(d) >= threshold * 0.85 : Math.abs(d) > threshold
}

export interface Throw {
  // Where the card ends, off the stage, and how long it takes to get there.
  x: number
  y: number
  rotate: number
  scale: number
  ms: number
}

// From the card's current offset (and tilt) to off the stage plus 40px, in
// T = 2·D / v so that the curve's initial slope (2) gives the finger's speed.
export function plan(dir: SwipeDir, at: { x: number; y: number; rotate: number }, v: number, stage: { width: number; height: number }): Throw {
  const horizontal = dir === 'left' || dir === 'right'
  const sign = dir === 'right' || dir === 'down' ? 1 : -1
  const target = sign * ((horizontal ? stage.width : stage.height) + 40)
  const from = horizontal ? at.x : at.y
  const d = Math.max(0, Math.abs(target - from))
  const speed = Math.max(Math.abs(v), MIN_SPEED)
  const ms = clamp((2 * d) / speed, 160, 260)
  return horizontal
    ? { x: target, y: 0, rotate: clamp(at.rotate * 1.4, -MAX_ROT * 1.4, MAX_ROT * 1.4), scale: 1, ms }
    : { x: 0, y: target, rotate: 0, scale: 0.985, ms }
}

export const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

// ---------- press, peek and the next card ----------

// Pressed and held, the card lifts: scale 1.02, 2px up (120ms in, 160ms back).
export const PRESS_SCALE = 1.02
export const PRESS_Y = -2

// The drag's scale, starting from the press lift and easing into the drag
// pose by the threshold (1 sideways, `lift` vertically), so picking the card
// up and dragging it is one motion. `pull` is the drag's progress, 0..1.
export function dragScale(pressed: boolean, axis: 'x' | 'y' | null, pull: number): number {
  const p = clamp(pull, 0, 1)
  const to = axis === 'y' ? lift(p) : 1
  return pressed ? PRESS_SCALE + (to - PRESS_SCALE) * p : to
}

// The press's 2px rise, carried into the drag and gone by the threshold.
export const dragRise = (pressed: boolean, pull: number) => (pressed ? PRESS_Y * (1 - clamp(pull, 0, 1)) : 0)

// Peek and throw: on a card not revealed yet, a drag past PEEK_SLOP px or a
// hold of PEEK_HOLD_MS reveals it under the finger. Nothing arms or rates
// until the answer has been visible PEEK_SAFE_MS, so a flick can't rate blind.
export const PEEK_SLOP = 8
export const PEEK_HOLD_MS = 150
export const PEEK_SAFE_MS = 300

// Whether a press on a hidden card reveals it now: moved `dist` px, held `heldMs`.
export const peekReveals = (dist: number, heldMs: number) => dist >= PEEK_SLOP || heldMs >= PEEK_HOLD_MS

// Whether a swipe may arm (haptic, pill, commit): the answer visible long enough.
export const canArm = (revealedAt: number | null, now: number) => revealedAt !== null && now - revealedAt >= PEEK_SAFE_MS

// On release: a direction past the threshold rates once arming is allowed;
// anything else springs back, staying revealed.
export function releaseOutcome(dir: SwipeDir | null, revealedAt: number | null, now: number): 'commit' | 'spring' {
  return dir && canArm(revealedAt, now) ? 'commit' : 'spring'
}

// The next card under the top one: 5px down at 97%, rising to its place as
// the drag reaches the threshold (`pull` 0..1); reduced motion keeps it still.
export function nextPose(pull: number, reduced = false): { y: number; scale: number } {
  const p = reduced ? 0 : clamp(pull, 0, 1)
  return { y: 5 * (1 - p), scale: 0.97 + 0.03 * p }
}
