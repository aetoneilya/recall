<script lang="ts">
  import type { Snippet } from 'svelte'
  import { cubicOut, quintOut } from 'svelte/easing'
  import { fade, fly } from 'svelte/transition'
  import { canDrag, dismisses, dismissMs, sheetOffset, springBackMs } from '../lib/sheetDrag.ts'

  // A bottom sheet over a dimmed screen. It closes only from its own
  // buttons: what it shows (a one-time secret) shouldn't vanish on a stray tap.
  // `onclose`: Escape and a swipe down close it too — down from the handle or
  // the title, or anywhere once its content is scrolled to the top.
  let { title, children, label, onclose }: { title: string; children: Snippet; label?: string; onclose?: () => void } = $props()

  const still = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

  let sheet: HTMLDivElement | undefined = $state()
  let scrim: HTMLDivElement | undefined = $state()
  // The finger: where it started, whether it moves the sheet.
  let drag: { y0: number; x0: number; lastY: number; lastT: number; v: number; fromTop: boolean; on: boolean; h: number } | null = null
  // Closed by a swipe: it is already off screen, so no outro.
  let swiped = false

  function start(x: number, y: number, t: number, target: EventTarget | null) {
    if (!onclose || !sheet) return
    const el = target as Element | null
    if (el?.closest?.('input, textarea, select, .table-wrap, pre')) return
    const top = sheet.getBoundingClientRect().top
    drag = { x0: x, y0: y, lastY: y, lastT: t, v: 0, fromTop: y - top < 56, on: false, h: sheet.offsetHeight }
  }

  function move(x: number, y: number, t: number): boolean {
    if (!drag || !sheet) return false
    const dy = y - drag.y0
    if (!drag.on) {
      if (Math.abs(dy) < 6 || Math.abs(x - drag.x0) > Math.abs(dy)) return false
      if (!canDrag(drag.fromTop, sheet.scrollTop, dy)) {
        drag = null
        return false
      }
      drag.on = true
      sheet.style.transition = 'none'
    }
    const dt = t - drag.lastT
    if (dt > 0) drag.v = 0.7 * ((y - drag.lastY) / dt) + 0.3 * drag.v
    drag.lastY = y
    drag.lastT = t
    const off = sheetOffset(dy)
    sheet.style.transform = `translate3d(0, ${off}px, 0)`
    if (scrim) scrim.style.opacity = String(1 - Math.max(0, off) / drag.h)
    return true
  }

  function end(y: number) {
    const d = drag
    drag = null
    if (!d?.on || !sheet) return
    const dy = y - d.y0
    if (dismisses(dy, d.v, d.h)) {
      swiped = true
      const ms = still ? 0 : dismissMs(dy, d.v, d.h)
      sheet.style.transition = `transform ${ms}ms cubic-bezier(0.3, 0.6, 0.5, 1)`
      sheet.style.transform = `translate3d(0, ${d.h + 24}px, 0)`
      if (scrim) {
        scrim.style.transition = `opacity ${ms}ms ease`
        scrim.style.opacity = '0'
      }
      setTimeout(() => onclose?.(), ms)
    } else {
      sheet.style.transition = still ? 'none' : `transform ${springBackMs(dy)}ms var(--ease-drawer)`
      sheet.style.transform = ''
      if (scrim) {
        scrim.style.transition = 'opacity 120ms ease'
        scrim.style.opacity = ''
      }
    }
  }

  // Touch: a non-passive touchmove claims the drag before WebKit scrolls.
  function gesture(node: HTMLElement) {
    const ts = (e: TouchEvent) => e.touches.length === 1 && start(e.touches[0]!.clientX, e.touches[0]!.clientY, e.timeStamp, e.target)
    const tm = (e: TouchEvent) => {
      const t = e.touches[0]
      if (t && move(t.clientX, t.clientY, e.timeStamp) && e.cancelable) e.preventDefault()
    }
    const te = (e: TouchEvent) => end(e.changedTouches[0]?.clientY ?? 0)
    const pd = (e: PointerEvent) => e.pointerType !== 'touch' && e.button === 0 && start(e.clientX, e.clientY, e.timeStamp, e.target)
    const pm = (e: PointerEvent) => e.pointerType !== 'touch' && move(e.clientX, e.clientY, e.timeStamp)
    const pu = (e: PointerEvent) => e.pointerType !== 'touch' && end(e.clientY)
    node.addEventListener('touchstart', ts, { passive: true })
    node.addEventListener('touchmove', tm, { passive: false })
    node.addEventListener('touchend', te)
    node.addEventListener('touchcancel', te)
    node.addEventListener('pointerdown', pd)
    window.addEventListener('pointermove', pm)
    window.addEventListener('pointerup', pu)
    return {
      destroy() {
        node.removeEventListener('touchstart', ts)
        node.removeEventListener('touchmove', tm)
        node.removeEventListener('touchend', te)
        node.removeEventListener('touchcancel', te)
        node.removeEventListener('pointerdown', pd)
        window.removeEventListener('pointermove', pm)
        window.removeEventListener('pointerup', pu)
      },
    }
  }

  // The outro, unless a swipe already took it off screen.
  function leave(node: Element) {
    return swiped ? { duration: 0 } : fly(node, { y: still ? 0 : 40, duration: 200, easing: cubicOut })
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape' && onclose) {
      e.preventDefault()
      e.stopPropagation()
      onclose()
    }
  }}
/>

<div class="scrim" data-sheet bind:this={scrim} transition:fade={{ duration: 200 }}></div>
<div class="sheet" role="dialog" aria-modal="true" aria-label={label ?? title} bind:this={sheet} use:gesture in:fly={{ y: still ? 0 : 80, opacity: 0, duration: 320, easing: quintOut }} out:leave>
  <div class="grabber" aria-hidden="true"></div>
  <h2>{title}</h2>
  {@render children()}
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: rgba(0, 0, 0, 0.32);
  }
  .sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 41;
    max-width: 560px;
    max-height: calc(100% - var(--sat) - 24px);
    margin: 0 auto;
    overflow-y: auto;
    overscroll-behavior: contain;
    background: var(--bg);
    border-radius: var(--radius) var(--radius) 0 0;
    /* The hairline keeps the edge visible over the scrim in dark mode. */
    box-shadow: var(--shadow-lift), inset 0 0.5px 0 var(--hairline);
    padding: 8px calc(16px + var(--sar)) calc(var(--sab) + 16px) calc(16px + var(--sal));
  }
  .grabber {
    width: 36px;
    height: 5px;
    border-radius: 3px;
    background: var(--hairline);
    margin: 0 auto 14px;
  }
  h2 {
    margin: 0 0 6px;
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }
</style>
