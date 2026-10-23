// Swipe-down to close a bottom sheet: the numbers, apart from the DOM so
// they can be tested (like lib/throw.ts).

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// Down follows the finger; up resists, logarithmically, a few px at most.
export function sheetOffset(dy: number): number {
  return dy >= 0 ? dy : -12 * Math.log1p(-dy / 12)
}

// Let go past 30% of the sheet's height, or flicked down faster than 0.5 px/ms;
// flicked back up as fast, it stays, however far down it was.
export function dismisses(dy: number, v: number, height: number): boolean {
  if (dy <= 0 || v < -0.5) return false
  return dy > height * 0.3 || v > 0.5
}

// Off the bottom with the throw's rule (start speed = the finger's), 180–300 ms.
export function dismissMs(dy: number, v: number, height: number): number {
  const d = Math.max(0, height - dy)
  return clamp((2 * d) / Math.max(v, 1.2), 180, 300)
}

// Back up: longer from further, 200–320 ms on the drawer curve.
export const springBackMs = (dy: number) => clamp(180 + Math.abs(dy) * 0.8, 200, 320)

// Whether a drag may move the sheet: from its top (the handle, the title)
// always; elsewhere only downward and with the content scrolled to the top,
// so scrolling the content up and down still scrolls it.
export function canDrag(fromTop: boolean, scrollTop: number, dy: number): boolean {
  if (fromTop) return true
  return scrollTop <= 0 && dy > 0
}
