import { describe, expect, it } from 'vitest'
import { lift, nextArmed, plan, snapMs, tilt, tiltOrigin } from './throw.ts'

describe('card motion', () => {
  it('tilts 0.06°/px up to 8°, around the thumb or a point above', () => {
    expect(tilt(110, true)).toBeCloseTo(6.6)
    expect(tilt(400, true)).toBe(8)
    expect(tilt(-50, true)).toBeCloseTo(-3)
    expect(tilt(110, false)).toBeCloseTo(-6.6)
    expect(tiltOrigin(true)).toBe('50% 110%')
    expect(tiltOrigin(false)).toBe('50% -10%')
    expect(lift(0)).toBe(1)
    expect(lift(2)).toBeCloseTo(0.985)
  })

  it('snaps back longer from further, and disarms only under 85%', () => {
    expect(snapMs(0)).toBe(200)
    expect(snapMs(100)).toBe(260)
    expect(snapMs(500)).toBe(320)
    expect(nextArmed(false, 100, 100)).toBe(false)
    expect(nextArmed(false, 101, 100)).toBe(true)
    expect(nextArmed(true, 90, 100)).toBe(true)
    expect(nextArmed(true, 84, 100)).toBe(false)
  })

  it('throws off the stage in 2·D/v, clamped to 160–260 ms, keeping the tilt going', () => {
    const stage = { width: 375, height: 600 }
    // A slow release: the minimum speed, then the cap.
    const slow = plan('right', { x: 100, y: 0, rotate: 6 }, 0.2, stage)
    expect(slow).toMatchObject({ x: 415, y: 0, scale: 1, ms: 260 })
    expect(slow.rotate).toBeCloseTo(8.4)
    // A fast flick: D = 415 − 100 = 315, v = 3 → 210 ms.
    expect(plan('right', { x: 100, y: 0, rotate: 6 }, 3, stage).ms).toBeCloseTo(210)
    expect(plan('left', { x: -60, y: 0, rotate: -3 }, -10, stage)).toMatchObject({ x: -415, ms: 160 })
    // Vertical: no tilt, a slight lift.
    expect(plan('down', { x: 0, y: 50, rotate: 0 }, 1.6, stage)).toMatchObject({ x: 0, y: 640, rotate: 0, scale: 0.985, ms: 260 })
    // A button: from rest at 1.6 px/ms.
    expect(plan('up', { x: 0, y: 0, rotate: 0 }, 1.6, { width: 375, height: 100 }).ms).toBeCloseTo(175)
  })
})
