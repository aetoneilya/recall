// Swipe gestures on an element whose content may also scroll vertically.
//
// The element keeps `touch-action: pan-y`, so the browser scrolls vertically
// on its own and horizontal drags are always ours. Vertical swipes (opt-in
// with `axes: 'xy'`) compete with that scrolling, so the rule, decided once
// when the finger leaves the SLOP, is:
//
// - If the scroller's content fits, every vertical drag is a swipe.
// - If it scrolls, a vertical drag is a swipe only when it *starts* at an
//   edge and moves outward: down from the very top, or up from the very
//   bottom. Any other vertical drag scrolls natively for its whole length,
//   so scrolling into an edge never fires a rating; a fresh drag from the
//   edge does.
//
// Past the slop the gesture is either a scroll (the browser's, to the end)
// or a drag. A drag (`axes: 'xy'`) follows the finger in 2D with no axis
// lock: the direction is the dominant one of the displacement at release,
// so a drag that starts down and ends right is a right swipe. Every move of
// a drag cancels the native default, so the browser never takes it back.
//
// Touch input uses touch events (a non-passive touchmove can still claim a
// gesture before WebKit starts scrolling, which pointer events + touch-action
// can't express on iOS); mouse and pen use pointer events.

export type SwipeDir = 'left' | 'right' | 'up' | 'down'
export type Axis = 'x' | 'y'

export interface ScrollState {
  top: number
  height: number
  client: number
}

export const SLOP = 12

// The axis the displacement mostly lies along; a tie goes sideways.
export const dominantAxis = (dx: number, dy: number): Axis => (Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y')

// Whether the finger has left the slop (and the gesture is decided).
export const pastSlop = (dx: number, dy: number, slop = SLOP) => Math.max(Math.abs(dx), Math.abs(dy)) >= slop

// Whether a vertical drag heading `dy` may be a swipe instead of a scroll.
export function verticalAllowed(dy: number, s: ScrollState | null): boolean {
  if (!s || s.height <= s.client + 1) return true
  if (dy > 0) return s.top <= 0
  if (dy < 0) return s.top + s.client >= s.height - 1
  return false
}

// A finger held still before letting go isn't flicking any more: the speed
// measured on the last move counts only if that move was this recent.
export const FLICK_WINDOW_MS = 80

// The release speed: the last measured one, or 0 after a pause.
export function liveVelocity(v: number, lastMoveT: number, releaseT: number): number {
  return releaseT - lastMoveT > FLICK_WINDOW_MS ? 0 : v
}

// The direction a displacement points to along its dominant axis.
export function dirOf(dx: number, dy: number): SwipeDir {
  if (dominantAxis(dx, dy) === 'x') return dx > 0 ? 'right' : 'left'
  return dy > 0 ? 'down' : 'up'
}

// The committed direction on release, from where the finger ended up: the
// dominant axis of the whole displacement, past that axis's threshold or
// flicked along it (fast that way, at least 40px out). The path there
// doesn't matter.
export function release(dx: number, dy: number, vx: number, vy: number, threshold: number | ((axis: Axis) => number)): SwipeDir | null {
  const axis = dominantAxis(dx, dy)
  const d = axis === 'x' ? dx : dy
  const v = axis === 'x' ? vx : vy
  const limit = typeof threshold === 'number' ? threshold : threshold(axis)
  const fast = Math.abs(v) > 0.55 && Math.abs(d) > 40 && Math.sign(v) === Math.sign(d)
  if (Math.abs(d) <= limit && !fast) return null
  return dirOf(dx, dy)
}

export interface MoveResult {
  state: 'pending' | 'drag' | 'scroll'
  // While dragging: the dominant axis right now (it may change).
  axis: Axis | null
  // The drag's displacement, both axes (dy is 0 with axes 'x').
  dx: number
  dy: number
  // Whether the native default (scrolling) should be cancelled.
  prevent: boolean
}

// Gesture state machine, independent of the DOM.
export function createTracker(opts: { axes: 'x' | 'xy'; threshold: (axis: Axis) => number }) {
  let x0 = 0
  let y0 = 0
  let lastX = 0
  let lastY = 0
  let lastT = 0
  let vx = 0
  let vy = 0
  let scroll: ScrollState | null = null
  let state: MoveResult['state'] = 'pending'
  // Vertical motion is part of the gesture only with axes 'xy'.
  const vertical = (dy: number) => (opts.axes === 'xy' ? dy : 0)

  return {
    start(x: number, y: number, t: number, s: ScrollState | null) {
      x0 = lastX = x
      y0 = lastY = y
      lastT = t
      vx = vy = 0
      scroll = s
      state = 'pending'
    },
    move(x: number, y: number, t: number): MoveResult {
      const dx = x - x0
      const dy = y - y0
      if (state === 'pending') {
        const sideways = dominantAxis(dx, dy) === 'x'
        if (!pastSlop(dx, dy)) {
          // Claim early what will be ours anyway, before the browser
          // commits to scrolling: sideways motion, or vertical motion
          // that couldn't scroll.
          const mine = sideways ? dx !== 0 : opts.axes === 'xy' && verticalAllowed(dy, scroll)
          return { state, axis: null, dx: 0, dy: 0, prevent: mine }
        }
        // Decided once: the scroll rule looks at how the gesture starts;
        // a drag is then free in 2D until the finger lifts.
        state = sideways || (opts.axes === 'xy' && verticalAllowed(dy, scroll)) ? 'drag' : 'scroll'
      }
      if (state !== 'drag') return { state, axis: null, dx: 0, dy: 0, prevent: false }
      const dt = t - lastT
      if (dt > 0) {
        vx = 0.7 * ((x - lastX) / dt) + 0.3 * vx
        vy = 0.7 * ((y - lastY) / dt) + 0.3 * vy
      }
      lastX = x
      lastY = y
      lastT = t
      return { state, axis: dominantAxis(dx, vertical(dy)), dx, dy: vertical(dy), prevent: true }
    },
    // `v`: the release velocity along the final displacement's dominant
    // axis, px/ms; `t`: the release time (without it, the last move's speed
    // is taken as is).
    end(x: number, y: number, t = lastT): { dir: SwipeDir | null; wasDrag: boolean; v: number } {
      const wasDrag = state === 'drag'
      const dx = x - x0
      const dy = vertical(y - y0)
      const ux = liveVelocity(vx, lastT, t)
      const uy = liveVelocity(vy, lastT, t)
      const dir = wasDrag ? release(dx, dy, ux, uy, opts.threshold) : null
      const v = !wasDrag ? 0 : dominantAxis(dx, dy) === 'x' ? ux : uy
      state = 'pending'
      return { dir, wasDrag, v }
    },
  }
}

export interface SwipeOptions {
  enabled?: () => boolean
  // 'x' (default): left/right only. 'xy': also up/down.
  axes?: 'x' | 'xy'
  // The scrolling element inside the node whose scroll wins over vertical
  // swipes (see the rule above). Defaults to treating content as fitting.
  scroller?: () => HTMLElement | null | undefined
  // A gesture may start here: where it was grabbed, as fractions of the node (0..1).
  onstart?: (fx: number, fy: number) => void
  // A drag's displacement (dy 0 with axes 'x') and its dominant axis now.
  onmove?: (dx: number, dy: number, axis: Axis) => void
  // Every move from the press, inside the slop too (peek's slop).
  onraw?: (dx: number, dy: number) => void
  // The press ended, dragged or not (before onend for a drag).
  onrelease?: (wasDrag: boolean) => void
  // Called on release with the committed direction (or null to snap back)
  // and the release velocity along the dominant axis, px/ms.
  onend?: (dir: SwipeDir | null, dx: number, dy: number, v: number) => void
  threshold?: number
}

// Commit distance: a quarter of the width sideways, a sixth of the height
// vertically, never more than 110px.
export function defaultThreshold(axis: Axis | null, width: number, height: number): number {
  return axis === 'y' ? Math.min(110, height * 0.18) : Math.min(110, width * 0.28)
}

const IGNORE = 'pre, .table-wrap, input, textarea, select, a, button'

export function swipe(node: HTMLElement, initial: SwipeOptions) {
  let opts = initial
  const threshold = (axis: Axis) => opts.threshold ?? defaultThreshold(axis, node.clientWidth, node.clientHeight)
  const tracker = createTracker({ axes: opts.axes ?? 'x', threshold })
  // The active pointer or touch, or null.
  let active: number | null = null
  let kind: 'pointer' | 'touch' = 'pointer'
  let dx = 0
  let dy = 0
  let x0 = 0
  let y0 = 0
  // The gesture is a drag: its moves are ours (touchmove cancelled).
  let claimed = false

  const scrollState = (): ScrollState | null => {
    const el = opts.scroller?.()
    return el ? { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight } : null
  }

  const begin = (target: EventTarget | null, x: number, y: number, t: number) => {
    if (opts.enabled && !opts.enabled()) return false
    // Code blocks and tables scroll sideways themselves.
    if ((target as Element | null)?.closest?.(IGNORE)) return false
    dx = dy = 0
    x0 = x
    y0 = y
    claimed = false
    tracker.start(x, y, t, scrollState())
    if (opts.onstart) {
      const r = node.getBoundingClientRect()
      opts.onstart(r.width ? (x - r.left) / r.width : 0.5, r.height ? (y - r.top) / r.height : 0.5)
    }
    return true
  }

  const step = (x: number, y: number, t: number) => {
    opts.onraw?.(x - x0, y - y0)
    const r = tracker.move(x, y, t)
    claimed = r.state === 'drag'
    if (r.state === 'drag') {
      dx = r.dx
      dy = r.dy
      opts.onmove?.(r.dx, r.dy, r.axis!)
    }
    return r
  }

  const finish = (x: number, y: number, t: number, cancelled: boolean) => {
    active = null
    claimed = false
    const { dir, wasDrag, v } = tracker.end(x, y, t)
    opts.onrelease?.(wasDrag)
    if (!wasDrag) return
    // Swallow the click that follows a drag so it doesn't count as a tap.
    node.addEventListener('click', stopOnce, { capture: true, once: true })
    setTimeout(() => node.removeEventListener('click', stopOnce, { capture: true }), 50)
    opts.onend?.(cancelled ? null : dir, dx, dy, v)
  }

  const stopOnce = (e: Event) => {
    e.stopPropagation()
    e.preventDefault()
  }

  // Mouse and pen.
  const pdown = (e: PointerEvent) => {
    if (e.pointerType === 'touch' || active !== null || e.button !== 0) return
    if (!begin(e.target, e.clientX, e.clientY, e.timeStamp)) return
    active = e.pointerId
    kind = 'pointer'
  }
  const pmove = (e: PointerEvent) => {
    if (kind !== 'pointer' || e.pointerId !== active) return
    const r = step(e.clientX, e.clientY, e.timeStamp)
    if (r.state === 'drag' && !node.hasPointerCapture(e.pointerId)) {
      try {
        node.setPointerCapture(e.pointerId)
      } catch {
        // Synthetic or already-released pointer; the drag still works.
      }
    }
  }
  const pup = (e: PointerEvent) => {
    if (kind !== 'pointer' || e.pointerId !== active) return
    finish(e.clientX, e.clientY, e.timeStamp, e.type === 'pointercancel')
  }

  // Touch.
  const find = (list: TouchList) => {
    for (let i = 0; i < list.length; i++) if (list[i].identifier === active) return list[i]
    return null
  }
  const tstart = (e: TouchEvent) => {
    if (active !== null) {
      // A second finger: end the gesture cleanly rather than jump to it.
      if (kind === 'touch') finish(0, 0, e.timeStamp, true)
      return
    }
    if (e.touches.length > 1) return
    const t = e.changedTouches[0]
    if (!begin(e.target, t.clientX, t.clientY, e.timeStamp)) return
    active = t.identifier
    kind = 'touch'
  }
  const tmove = (e: TouchEvent) => {
    if (active === null) return
    // A pen drag (pointer events) also sends touches on iOS: keep the
    // browser from panning under it.
    if (kind === 'pointer') {
      if (claimed && e.cancelable) e.preventDefault()
      return
    }
    const t = find(e.changedTouches)
    if (!t) return
    const r = step(t.clientX, t.clientY, e.timeStamp)
    if (r.prevent && e.cancelable) e.preventDefault()
  }
  const tend = (e: TouchEvent) => {
    if (kind !== 'touch' || active === null) return
    const t = find(e.changedTouches)
    if (!t) return
    finish(t.clientX, t.clientY, e.timeStamp, e.type === 'touchcancel')
  }
  const blur = () => {
    if (active !== null) finish(0, 0, performance.now(), true)
  }

  node.addEventListener('pointerdown', pdown)
  node.addEventListener('pointermove', pmove)
  node.addEventListener('pointerup', pup)
  node.addEventListener('pointercancel', pup)
  node.addEventListener('lostpointercapture', pup)
  node.addEventListener('touchstart', tstart, { passive: true })
  node.addEventListener('touchmove', tmove, { passive: false })
  node.addEventListener('touchend', tend)
  node.addEventListener('touchcancel', tend)
  window.addEventListener('blur', blur)

  return {
    update(next: SwipeOptions) {
      opts = next
    },
    destroy() {
      node.removeEventListener('pointerdown', pdown)
      node.removeEventListener('pointermove', pmove)
      node.removeEventListener('pointerup', pup)
      node.removeEventListener('pointercancel', pup)
      node.removeEventListener('lostpointercapture', pup)
      node.removeEventListener('touchstart', tstart)
      node.removeEventListener('touchmove', tmove)
      node.removeEventListener('touchend', tend)
      node.removeEventListener('touchcancel', tend)
      window.removeEventListener('blur', blur)
    },
  }
}
