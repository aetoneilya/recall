import { describe, expect, it } from 'vitest'
import { createTracker, defaultThreshold, lockAxis, release, SLOP, verticalAllowed, type ScrollState } from './swipe.ts'

const fits: ScrollState = { top: 0, height: 400, client: 500 }
const atTop: ScrollState = { top: 0, height: 1200, client: 500 }
const middle: ScrollState = { top: 300, height: 1200, client: 500 }
const atBottom: ScrollState = { top: 700, height: 1200, client: 500 }

// Drives a tracker through a straight drag in `steps` moves of 16 ms.
function drag(opts: { axes: 'x' | 'xy'; scroll?: ScrollState | null; to: [number, number]; steps?: number; threshold?: number }) {
  const t = createTracker({ axes: opts.axes, threshold: () => opts.threshold ?? 100 })
  const steps = opts.steps ?? 10
  t.start(0, 0, 0, opts.scroll ?? null)
  const moves = []
  for (let i = 1; i <= steps; i++) moves.push(t.move((opts.to[0] * i) / steps, (opts.to[1] * i) / steps, i * 16))
  return { moves, last: moves.at(-1)!, end: t.end(opts.to[0], opts.to[1]) }
}

describe('lockAxis', () => {
  it('stays undecided inside the slop', () => {
    expect(lockAxis(SLOP - 1, 0)).toBeNull()
    expect(lockAxis(5, -8)).toBeNull()
  })
  it('picks the dominant direction once past it', () => {
    expect(lockAxis(14, 6)).toBe('x')
    expect(lockAxis(-6, 14)).toBe('y')
    expect(lockAxis(13, -13)).toBe('x')
  })
})

describe('verticalAllowed', () => {
  it('is always true when the content fits', () => {
    expect(verticalAllowed(20, fits)).toBe(true)
    expect(verticalAllowed(-20, fits)).toBe(true)
    expect(verticalAllowed(20, null)).toBe(true)
  })
  it('only lets a drag leave through the edge it starts at', () => {
    expect(verticalAllowed(20, atTop)).toBe(true)
    expect(verticalAllowed(-20, atTop)).toBe(false)
    expect(verticalAllowed(-20, atBottom)).toBe(true)
    expect(verticalAllowed(20, atBottom)).toBe(false)
    expect(verticalAllowed(20, middle)).toBe(false)
    expect(verticalAllowed(-20, middle)).toBe(false)
  })
})

describe('release', () => {
  it('maps each axis and sign to a direction', () => {
    expect(release('x', 120, 0, 0, 0, 100)).toBe('right')
    expect(release('x', -120, 0, 0, 0, 100)).toBe('left')
    expect(release('y', 0, 120, 0, 0, 100)).toBe('down')
    expect(release('y', 0, -120, 0, 0, 100)).toBe('up')
  })
  it('snaps back under the threshold unless flicked', () => {
    expect(release('x', 80, 0, 0.1, 0, 100)).toBeNull()
    expect(release('y', 0, -60, 0, -0.9, 100)).toBe('up')
    expect(release('x', 30, 0, 2, 0, 100)).toBeNull()
    expect(release('x', 60, 0, -0.9, 0, 100)).toBeNull()
  })
})

describe('createTracker', () => {
  it('commits all four directions with axes xy', () => {
    expect(drag({ axes: 'xy', to: [150, 0] }).end.dir).toBe('right')
    expect(drag({ axes: 'xy', to: [-150, 0] }).end.dir).toBe('left')
    expect(drag({ axes: 'xy', to: [0, 150] }).end.dir).toBe('down')
    expect(drag({ axes: 'xy', to: [0, -150] }).end.dir).toBe('up')
  })

  it('locks the axis: a diagonal drag only moves along the dominant one', () => {
    const r = drag({ axes: 'xy', to: [150, 90] })
    expect(r.last.axis).toBe('x')
    expect(r.last.dy).toBe(0)
    expect(r.end.dir).toBe('right')
  })

  it('keeps the first locked axis even if the finger changes course', () => {
    const t = createTracker({ axes: 'xy', threshold: () => 100 })
    t.start(0, 0, 0, null)
    t.move(0, 20, 16)
    t.move(160, 30, 32)
    const end = t.end(160, 30)
    expect(end.dir).toBeNull()
  })

  it('reports nothing and claims sideways motion while inside the slop', () => {
    const t = createTracker({ axes: 'xy', threshold: () => 100 })
    t.start(0, 0, 0, middle)
    expect(t.move(6, 1, 16)).toMatchObject({ state: 'pending', dx: 0, prevent: true })
    t.start(0, 0, 0, middle)
    expect(t.move(1, 6, 16)).toMatchObject({ state: 'pending', prevent: false })
  })

  it('lets scrollable content scroll instead of swiping vertically', () => {
    const r = drag({ axes: 'xy', scroll: middle, to: [0, 200] })
    expect(r.last).toMatchObject({ state: 'scroll', prevent: false })
    expect(r.end).toMatchObject({ dir: null, wasDrag: false })
  })

  it('swipes vertically from the edge the drag starts at', () => {
    expect(drag({ axes: 'xy', scroll: atTop, to: [0, 150] }).end.dir).toBe('down')
    expect(drag({ axes: 'xy', scroll: atTop, to: [0, -150] }).end.dir).toBeNull()
    expect(drag({ axes: 'xy', scroll: atBottom, to: [0, -150] }).end.dir).toBe('up')
    expect(drag({ axes: 'xy', scroll: atBottom, to: [0, 150] }).end.dir).toBeNull()
  })

  it('still swipes sideways on scrollable content', () => {
    expect(drag({ axes: 'xy', scroll: middle, to: [-150, 10] }).end.dir).toBe('left')
  })

  it('ignores vertical drags with axes x', () => {
    const r = drag({ axes: 'x', to: [0, 150] })
    expect(r.last.state).toBe('scroll')
    expect(r.end.dir).toBeNull()
    expect(drag({ axes: 'x', to: [150, 0] }).end.dir).toBe('right')
  })
})

describe('defaultThreshold', () => {
  it('scales with the card and caps at 110px', () => {
    expect(defaultThreshold('x', 360, 600)).toBeCloseTo(100.8)
    expect(defaultThreshold('y', 360, 500)).toBe(90)
    expect(defaultThreshold('x', 800, 900)).toBe(110)
  })
})
