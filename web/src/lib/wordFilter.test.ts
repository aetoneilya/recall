import { describe, expect, it } from 'vitest'
import { dirState, matches } from './wordFilter.ts'
import type { CardSummary, WordItem } from './types.ts'

const card = (p: Partial<CardSummary> = {}): CardSummary => ({
  id: 'c', direction: 'forward', enabled: true, suspended: false, state: 'review', due: '2026-10-25T00:00:00Z',
  stability: 10, difficulty: 5, reps: 3, lapses: 0, lastReview: null, retrievability: 0.95, ...p,
})

const word = (term: string, p: Partial<WordItem> = {}): WordItem => ({
  id: term, deckId: 'dk', deckName: 'English', term, pos: 'noun', translations: ['перевод'], ipa: null, examples: [], note: null,
  tags: [], freqRank: null, cefr: null, status: 'active', createdBy: 'user', createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z', cards: { forward: card(), reverse: card({ direction: 'reverse', state: 'new', retrievability: null }) }, ...p,
})

describe('dirState', () => {
  it('names the learner-facing state of a card', () => {
    expect(dirState(card())).toBe('known')
    expect(dirState(card({ retrievability: 0.7 }))).toBe('fading')
    expect(dirState(card({ state: 'relearning' }))).toBe('learning')
    expect(dirState(card({ state: 'new' }))).toBe('new')
    expect(dirState(card({ suspended: true }))).toBe('suspended')
    expect(dirState(card({ enabled: false }))).toBe('off')
    expect(dirState(null)).toBeNull()
  })
})

describe('matches', () => {
  const words = [
    word('to frown', { translations: ['хмуриться'] }),
    word('moor', { translations: ['вересковая пустошь'], examples: [{ text: 'The wind howled across the moor.', translation: null }] }),
    word('ёлка', { translations: ['fir'] }),
  ]

  it('searches term, translations and examples, folding case and ё', () => {
    expect(matches(words[1]!, 'HOWLED moor')).toBe(true)
    expect(matches(words[0]!, 'хмур')).toBe(true)
    expect(matches(words[2]!, 'елка')).toBe(true)
    expect(matches(words[0]!, 'frown xyz')).toBe(false)
  })
})
