import { describe, expect, it } from 'vitest'
import { dirState, emptyFilter, filterWords, matches } from './wordFilter.ts'
import type { CardSummary, WordItem } from './types.ts'

const card = (p: Partial<CardSummary> = {}): CardSummary => ({
  id: 'c', direction: 'forward', enabled: true, suspended: false, state: 'review', due: '2026-10-25T00:00:00Z',
  stability: 10, difficulty: 5, reps: 3, lapses: 0, lastReview: null, retrievability: 0.95, ...p,
})

const word = (term: string, p: Partial<WordItem> = {}): WordItem => ({
  id: term, deckId: 'dk', deckName: 'English', term, pos: 'noun', translations: ['перевод'], ipa: null, examples: [], note: null,
  source: null, tags: [], freqRank: null, cefr: null, status: 'active', createdBy: 'user', createdAt: '2026-10-01T00:00:00Z',
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

describe('filterWords', () => {
  const words = [
    word('to frown', { translations: ['хмуриться'], createdAt: '2026-10-03T00:00:00Z', freqRank: 9000, pos: 'verb' }),
    word('moor', { translations: ['вересковая пустошь'], examples: [{ text: 'The wind howled across the moor.', translation: null }], freqRank: 7000, cefr: 'C1' }),
    word('ёлка', { translations: ['fir'], status: 'inbox', createdAt: '2026-10-02T00:00:00Z' }),
    word('bleak', { status: 'rejected', cards: { forward: card({ lapses: 4 }), reverse: null } }),
  ]
  const terms = (xs: WordItem[]) => xs.map((w) => w.term)

  it('searches term, translations and examples, folding case and ё', () => {
    expect(matches(words[1], 'HOWLED moor')).toBe(true)
    expect(matches(words[0], 'хмур')).toBe(true)
    expect(matches(words[2], 'елка')).toBe(true)
    expect(matches(words[0], 'frown xyz')).toBe(false)
  })

  it('hides rejected words unless asked, and filters by status, pos, CEFR and state', () => {
    expect(terms(filterWords(words, emptyFilter()))).toEqual(['to frown', 'ёлка', 'moor'])
    expect(terms(filterWords(words, { ...emptyFilter(), status: 'all' }))).toHaveLength(4)
    expect(terms(filterWords(words, { ...emptyFilter(), status: 'inbox' }))).toEqual(['ёлка'])
    expect(terms(filterWords(words, { ...emptyFilter(), pos: 'verb' }))).toEqual(['to frown'])
    expect(terms(filterWords(words, { ...emptyFilter(), cefr: 'C1' }))).toEqual(['moor'])
    expect(terms(filterWords(words, { ...emptyFilter(), state: 'new' }))).toEqual(['to frown', 'ёлка', 'moor'])
  })

  it('sorts alphabetically ignoring "to", by frequency with unranked last, and by difficulty', () => {
    expect(terms(filterWords(words, { ...emptyFilter(), sort: 'alpha' }))).toEqual(['to frown', 'moor', 'ёлка'])
    expect(terms(filterWords(words, { ...emptyFilter(), sort: 'freq' }))).toEqual(['moor', 'to frown', 'ёлка'])
    expect(terms(filterWords(words, { ...emptyFilter(), status: 'all', sort: 'difficulty' }))[0]).toBe('bleak')
  })
})
