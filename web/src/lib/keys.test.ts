import { describe, expect, it } from 'vitest'
import { shortcutsOff } from './keys.ts'

// A minimal stand-in for an element: `closest` matches when any selector in
// the list names one of its roles/tags.
const el = (matches: string[]) => ({ closest: (sel: string) => (matches.some((m) => sel.includes(m)) ? {} : null) })
const key = (target: unknown, mods: Partial<KeyboardEvent> = {}) => ({ key: '1', target, metaKey: false, ctrlKey: false, altKey: false, ...mods }) as unknown as KeyboardEvent
const doc = (open: boolean) => ({ querySelector: () => (open ? ({} as Element) : null) })

describe('shortcutsOff', () => {
  it('lets shortcuts through on the plain review screen', () => {
    expect(shortcutsOff(key(el([])), doc(false))).toBe(false)
  })
  it('stands aside while a sheet or menu is open, wherever focus is', () => {
    expect(shortcutsOff(key(el([])), doc(true))).toBe(true)
  })
  it('stands aside for fields, dialogs and menus', () => {
    expect(shortcutsOff(key(el(['input'])), doc(false))).toBe(true)
    expect(shortcutsOff(key(el(['[role="dialog"]'])), doc(false))).toBe(true)
    expect(shortcutsOff(key(el(['[role="menu"]'])), doc(false))).toBe(true)
  })
  it('leaves browser shortcuts alone', () => {
    expect(shortcutsOff(key(el([]), { metaKey: true }), doc(false))).toBe(true)
  })
})
