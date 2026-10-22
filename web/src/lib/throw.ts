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
