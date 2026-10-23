import { describe, expect, it } from 'vitest'
import { lift, nextArmed, nextArmedDir, plan, releaseDir, snapMs, tilt, tiltOrigin } from './throw.ts'

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
    // Vertical: a slight lift, no extra tilt.
    expect(plan('down', { x: 0, y: 50, rotate: 0 }, 1.6, stage)).toMatchObject({ x: 0, y: 640, rotate: 0, scale: 0.985, ms: 260 })
    // From a diagonal drag the other axis keeps its offset (and tilt).
    expect(plan('right', { x: 120, y: 40, rotate: 5 }, 2, stage)).toMatchObject({ x: 415, y: 40 })
    expect(plan('down', { x: 30, y: 120, rotate: 1.8 }, 2, stage)).toMatchObject({ x: 30, y: 640, rotate: 1.8 })
    // A button: from rest at 1.6 px/ms.
    expect(plan('up', { x: 0, y: 0, rotate: 0 }, 1.6, { width: 375, height: 100 }).ms).toBeCloseTo(175)
  })
})

describe('press, peek and the next card', () => {
  it('lifts on press and carries the lift into the drag pose', async () => {
    const { dragRise, dragScale, PRESS_SCALE } = await import('./throw.ts')
    expect(dragScale(true, 0, 0)).toBe(PRESS_SCALE)
    expect(dragRise(true, 0)).toBe(-2)
    // No jump when the drag starts, the drag pose by the threshold:
    // sideways (no vertical progress) 1, straight down or up 0.985.
    expect(dragScale(true, 0.5, 0)).toBeCloseTo(1.01)
    expect(dragScale(true, 1, 0)).toBe(1)
    expect(dragScale(true, 1, 1)).toBeCloseTo(0.985)
    expect(dragScale(true, 3, 3)).toBeCloseTo(0.985)
    // A diagonal: lifted by its vertical part.
    expect(dragScale(true, 1, 0.5)).toBeCloseTo(lift(0.5))
    expect(dragRise(true, 1)).toBeCloseTo(0)
    // Not pressed (a drag continuing a snap-back): the plain drag pose.
    expect(dragScale(false, 0.5, 0.5)).toBeCloseTo(lift(0.5))
    expect(dragRise(false, 0)).toBe(0)
  })

  it('reveals a hidden card past the slop or after the hold', async () => {
    const { peekReveals } = await import('./throw.ts')
    expect(peekReveals(0, 0)).toBe(false)
    expect(peekReveals(7, 149)).toBe(false)
    expect(peekReveals(8, 0)).toBe(true)
    expect(peekReveals(0, 150)).toBe(true)
  })

  it('arms and commits only 300 ms after the answer became visible', async () => {
    const { canArm, releaseOutcome } = await import('./throw.ts')
    expect(canArm(null, 1000)).toBe(false)
    expect(canArm(1000, 1299)).toBe(false)
    expect(canArm(1000, 1300)).toBe(true)
    // A flick right after the peek springs back; the same swipe later rates.
    expect(releaseOutcome('right', 1000, 1200)).toBe('spring')
    expect(releaseOutcome('right', 1000, 1400)).toBe('commit')
    // Released near the centre: back in place, still revealed.
    expect(releaseOutcome(null, 1000, 5000)).toBe('spring')
  })

  it('eases the next card into place with the drag', async () => {
    const { nextPose } = await import('./throw.ts')
    expect(nextPose(0)).toEqual({ y: 5, scale: 0.97 })
    expect(nextPose(0.5)).toEqual({ y: 2.5, scale: 0.985 })
    expect(nextPose(2)).toEqual({ y: 0, scale: 1 })
    expect(nextPose(1, true)).toEqual({ y: 5, scale: 0.97 })
  })

  it('commits the way the pill says: armed and pulled back to 90 of 98 px still rates', () => {
    // Dragged to 120, back to 90: still armed (above 85%), the tracker says snap back.
    const armed = nextArmedDir(nextArmedDir(null, 'right', 120, 98), 'right', 90, 98)
    expect(armed).toBe('right')
    expect(releaseDir(null, armed)).toBe('right')
    expect(releaseDir('down', 'up')).toBe('up')
    // Not armed: the tracker's verdict (a flick, or nothing).
    expect(releaseDir(null, null)).toBeNull()
    expect(releaseDir('left', null)).toBe('left')
  })

  it('arms on the dominant direction; the hysteresis holds only while it stays', () => {
    expect(nextArmedDir(null, 'down', 100, 108)).toBeNull()
    expect(nextArmedDir(null, 'down', 110, 108)).toBe('down')
    expect(nextArmedDir('down', 'down', 95, 108)).toBe('down')
    // Swung over to the right at 95 of 100: a new direction arms afresh.
    expect(nextArmedDir('down', 'right', 95, 100)).toBeNull()
    expect(nextArmedDir('down', 'right', 101, 100)).toBe('right')
    expect(nextArmedDir('right', null, 0, 100)).toBeNull()
  })
})
