import { describe, expect, it } from 'vitest'
import { shouldApply, type Context } from './update.ts'

const ctx = (c: Partial<Context> = {}): Context => ({ parts: [], card: false, revealed: false, unsaved: false, pendingUndo: false, ...c })

describe('shouldApply', () => {
  it('applies when a list tab opens', () => {
    for (const parts of [['words'], ['progress'], ['settings']]) expect(shouldApply('route', ctx({ parts }))).toBe(true)
  })

  it('never interrupts a form, an editor or the test', () => {
    for (const parts of [['add'], ['word', 'wd_1'], ['fact', 'ft_1'], ['test']]) {
      expect(shouldApply('route', ctx({ parts }))).toBe(false)
      expect(shouldApply('resume', ctx({ parts }))).toBe(false)
    }
  })

  it('waits for the review session to end', () => {
    expect(shouldApply('route', ctx({ card: true }))).toBe(false)
    expect(shouldApply('summary', ctx({ card: true }))).toBe(false)
    expect(shouldApply('summary', ctx())).toBe(true)
    expect(shouldApply('route', ctx())).toBe(true)
  })

  it('on resume, reloads a review only before the answer shows', () => {
    expect(shouldApply('resume', ctx({ card: true }))).toBe(true)
    expect(shouldApply('resume', ctx({ card: true, revealed: true }))).toBe(false)
  })

  it('keeps unsaved input and changes held for Undo', () => {
    expect(shouldApply('route', ctx({ parts: ['settings'], unsaved: true }))).toBe(false)
    expect(shouldApply('summary', ctx({ pendingUndo: true }))).toBe(false)
  })

  it('the summary moment only counts on the review screen', () => {
    expect(shouldApply('summary', ctx({ parts: ['add'] }))).toBe(false)
  })
})
