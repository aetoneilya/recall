// Keeps the app inside the visible viewport while the on-screen keyboard is
// open. iOS overlays the keyboard instead of resizing the page (and may pan
// it), so the shell follows visualViewport: --vv-h / --vv-top size and
// place #app, and <html data-keyboard> lets screens drop the tab bar so
// what's needed (a typed answer, the rating bar) sits right above the keys.
export function initViewport(): void {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null
  if (!vv) return
  const root = document.documentElement
  let frame = 0
  const update = () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      const keyboard = window.innerHeight - vv.height > 120
      root.style.setProperty('--vv-h', `${Math.round(vv.height)}px`)
      root.style.setProperty('--vv-top', `${Math.round(vv.offsetTop)}px`)
      if (keyboard) root.dataset.keyboard = ''
      else delete root.dataset.keyboard
      // The page itself never scrolls; undo iOS's pan towards the field.
      if (window.scrollY) window.scrollTo(0, 0)
    })
  }
  vv.addEventListener('resize', update)
  vv.addEventListener('scroll', update)
  update()
}
