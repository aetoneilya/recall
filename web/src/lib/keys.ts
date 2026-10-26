// Review shortcuts (Space, Enter, 1–4, z) listen on the window, so they must
// stand aside while something above the card has the keyboard: a field, an
// open sheet (the filter) or menu (deck switcher, card ⋯). Otherwise Enter on
// a focused chip rates the card behind it, and 1 answers an exercise.
export function shortcutsOff(e: KeyboardEvent, doc: Pick<Document, 'querySelector'> = document): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return true
  const t = e.target as Element | null
  if (t?.closest?.('input, textarea, select, [role="dialog"], [role="menu"]')) return true
  return doc.querySelector('[data-sheet], [role="menu"]') !== null
}
