import { describe, expect, it } from 'vitest'
import { canDrag, dismisses, dismissMs, sheetOffset, springBackMs } from './sheetDrag.ts'

describe('sheet swipe-down', () => {
  it('follows down 1:1 and resists up', () => {
    expect(sheetOffset(80)).toBe(80)
    expect(sheetOffset(0)).toBe(0)
    expect(sheetOffset(-12)).toBeCloseTo(-8.3, 1)
    expect(sheetOffset(-200)).toBeGreaterThan(-40)
  })

  it('dismisses past 30% or on a downward flick, never upward', () => {
    expect(dismisses(130, 0.1, 400)).toBe(true)
    expect(dismisses(110, 0.1, 400)).toBe(false)
    expect(dismisses(40, 0.6, 400)).toBe(true)
    expect(dismisses(-40, 2, 400)).toBe(false)
    expect(dismisses(0, 2, 400)).toBe(false)
  })

  it('times the close like a throw and the spring back like a snap', () => {
    // 2·(400 − 100) / 1.2 = 500 → 300; a fast flick: 2·300 / 4 = 150 → 180.
    expect(dismissMs(100, 0.2, 400)).toBe(300)
    expect(dismissMs(100, 4, 400)).toBe(180)
    expect(dismissMs(100, 2.4, 400)).toBe(250)
    expect(springBackMs(0)).toBe(200)
    expect(springBackMs(100)).toBe(260)
    expect(springBackMs(-500)).toBe(320)
  })

  it('drags from the top always, from the content only down at the top', () => {
    expect(canDrag(true, 120, -10)).toBe(true)
    expect(canDrag(false, 0, 10)).toBe(true)
    expect(canDrag(false, 0, -10)).toBe(false)
    expect(canDrag(false, 40, 10)).toBe(false)
  })
})
