import { describe, expect, it } from 'vitest'
import { createTracker, defaultThreshold, dirOf, dominantAxis, pastSlop, release, SLOP, verticalAllowed, type ScrollState } from './swipe.ts'

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

// Drives a tracker along a path of points, 16 ms apart, and lets go at the last.
function path(points: [number, number][], opts: { axes?: 'x' | 'xy'; threshold?: number } = {}) {
  const t = createTracker({ axes: opts.axes ?? 'xy', threshold: () => opts.threshold ?? 100 })
  t.start(0, 0, 0, null)
  const moves = points.map(([x, y], i) => t.move(x, y, (i + 1) * 16))
  const [x, y] = points.at(-1)!
  return { moves, end: t.end(x, y) }
}

describe('slop and dominant axis', () => {
  it('stays undecided inside the slop', () => {
    expect(pastSlop(SLOP - 1, 0)).toBe(false)
    expect(pastSlop(5, -8)).toBe(false)
    expect(pastSlop(0, -SLOP)).toBe(true)
  })
  it('names the dominant axis and its direction; a tie goes sideways', () => {
    expect(dominantAxis(14, 6)).toBe('x')
    expect(dominantAxis(-6, 14)).toBe('y')
    expect(dominantAxis(13, -13)).toBe('x')
    expect([dirOf(30, 10), dirOf(-30, 10), dirOf(10, 30), dirOf(10, -30)]).toEqual(['right', 'left', 'down', 'up'])
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
    expect(release(120, 0, 0, 0, 100)).toBe('right')
    expect(release(-120, 0, 0, 0, 100)).toBe('left')
    expect(release(0, 120, 0, 0, 100)).toBe('down')
    expect(release(0, -120, 0, 0, 100)).toBe('up')
  })
  it('decides by the dominant direction of the final displacement', () => {
    // Good (right), Again (down), Easy (up) from diagonal end points.
    expect(release(130, 60, 0, 0, 100)).toBe('right')
    expect(release(40, 140, 0, 0, 100)).toBe('down')
    expect(release(-90, -150, 0, 0, 100)).toBe('up')
    // Near-equal: the larger one wins, whichever it is.
    expect(release(121, 120, 0, 0, 100)).toBe('right')
    expect(release(-120, 121, 0, 0, 100)).toBe('down')
    // Each axis against its own threshold.
    expect(release(0, 95, 0, 0, (a) => (a === 'y' ? 90 : 110))).toBe('down')
    expect(release(105, 20, 0, 0, (a) => (a === 'y' ? 90 : 110))).toBeNull()
  })
  it('snaps back under the threshold unless flicked along the dominant axis', () => {
    expect(release(80, 0, 0.1, 0, 100)).toBeNull()
    expect(release(0, -60, 0, -0.9, 100)).toBe('up')
    expect(release(30, 0, 2, 0, 100)).toBeNull()
    expect(release(60, 0, -0.9, 0, 100)).toBeNull()
    // A short fast flick, a little off-axis: its dominant axis decides.
    expect(release(50, -20, 1.2, -0.4, 100)).toBe('right')
    expect(release(-15, -48, -0.2, -1.1, 100)).toBe('up')
    // Fast across the dominant axis is no flick along it.
    expect(release(30, 50, 1.5, 0.1, 100)).toBeNull()
  })
})

describe('createTracker', () => {
  it('commits all four directions with axes xy', () => {
    expect(drag({ axes: 'xy', to: [150, 0] }).end.dir).toBe('right')
    expect(drag({ axes: 'xy', to: [-150, 0] }).end.dir).toBe('left')
    expect(drag({ axes: 'xy', to: [0, 150] }).end.dir).toBe('down')
    expect(drag({ axes: 'xy', to: [0, -150] }).end.dir).toBe('up')
  })

  it('follows the finger in 2D: a diagonal drag keeps both offsets', () => {
    const r = drag({ axes: 'xy', to: [150, 90] })
    expect(r.last).toMatchObject({ state: 'drag', axis: 'x', dx: 150, dy: 90, prevent: true })
    expect(r.end.dir).toBe('right')
  })

  it('has no axis lock: after a downward start, sideways moves still count', () => {
    const r = path([[0, 6], [2, 14], [3, 20], [30, 24], [80, 28], [140, 30]])
    expect(r.moves[2]).toMatchObject({ state: 'drag', axis: 'y', dx: 3, dy: 20 })
    expect(r.moves.slice(3).map((m) => m.dx)).toEqual([30, 80, 140])
    expect(r.moves.at(-1)!.axis).toBe('x')
    // Every move of the drag stays ours, whichever way it heads.
    expect(r.moves.slice(2).every((m) => m.prevent)).toBe(true)
    // Starts down, ends right: Good.
    expect(r.end.dir).toBe('right')
  })

  it('decides at release: starts right and ends down = Again; up-left, mostly up = Easy', () => {
    expect(path([[14, 0], [30, 4], [40, 40], [45, 90], [50, 150]]).end.dir).toBe('down')
    expect(path([[-4, -14], [-30, -50], [-60, -110], [-80, -150]]).end.dir).toBe('up')
    // The release speed is along the final dominant axis.
    const r = path([[14, 0], [30, 4], [40, 40], [45, 90], [50, 150]])
    expect(r.end.v).toBeGreaterThan(2)
  })

  it('takes no flick from a drag held still before the release', () => {
    const t = createTracker({ axes: 'x', threshold: () => 100 })
    t.start(0, 0, 0, null)
    for (let i = 1; i <= 6; i++) t.move(i * 10, 0, i * 8)
    // Released at once: a flick.
    expect(t.end(60, 0, 52).dir).toBe('right')
    t.start(0, 0, 0, null)
    for (let i = 1; i <= 6; i++) t.move(i * 10, 0, i * 8)
    // Held for 2 s first: short of the threshold, so back.
    expect(t.end(60, 0, 2048)).toMatchObject({ dir: null, v: 0 })
  })

  it('follows the finger when it changes course', () => {
    const t = createTracker({ axes: 'xy', threshold: () => 100 })
    t.start(0, 0, 0, null)
    t.move(0, 20, 16)
    expect(t.move(160, 30, 32)).toMatchObject({ axis: 'x', dx: 160, dy: 30 })
    expect(t.end(160, 30).dir).toBe('right')
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
    // Sideways, the vertical part isn't the gesture's: never down, never moved.
    const d = drag({ axes: 'x', to: [60, 150] })
    expect(d.last.state).toBe('scroll')
    const s = path([[14, 0], [40, 60], [120, 150]], { axes: 'x' })
    expect(s.moves.at(-1)).toMatchObject({ dx: 120, dy: 0, axis: 'x' })
    expect(s.end.dir).toBe('right')
  })

  it('keeps scrolling once the slop says scroll, wherever the finger goes', () => {
    // Mid-scroll content, a vertical start: native scrolling to the end.
    const t = createTracker({ axes: 'xy', threshold: () => 100 })
    t.start(0, 0, 0, middle)
    t.move(1, 14, 16)
    expect(t.move(160, 25, 32)).toMatchObject({ state: 'scroll', prevent: false })
    expect(t.end(160, 25)).toMatchObject({ dir: null, wasDrag: false })
  })
})

describe('defaultThreshold', () => {
  it('scales with the card and caps at 110px', () => {
    expect(defaultThreshold('x', 360, 600)).toBeCloseTo(100.8)
    expect(defaultThreshold('y', 360, 500)).toBe(90)
    expect(defaultThreshold('x', 800, 900)).toBe(110)
  })
})
