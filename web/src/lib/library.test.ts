import { describe, expect, it } from 'vitest'
import { deckContents, emptyLibraryFilter, libraryFacets, libraryRows, type LibraryFilter } from './library.ts'
import type { CardSummary, FactItem, WordItem } from './types.ts'

const card = (p: Partial<CardSummary> = {}): CardSummary => ({
  id: 'cd', direction: 'forward', enabled: true, suspended: false, state: 'new', due: '', stability: 0, difficulty: 0, reps: 0, lapses: 0, lastReview: null, retrievability: null, ...p,
})
const word = (id: string, term: string, p: Partial<WordItem> = {}): WordItem => ({
  id, deckId: 'dk_en', deckName: 'English', term, pos: 'noun', translations: ['x'], ipa: null, examples: [], note: null, tags: [], freqRank: null, cefr: null,
  status: 'active', createdBy: 'user', createdAt: `2026-10-0${id.slice(-1)}T00:00:00Z`, updatedAt: '', cards: { forward: card(), reverse: card() }, ...p,
})
const fact = (id: string, front: string, p: Partial<FactItem> = {}): FactItem => ({
  id, deckId: 'dk_en', deckName: 'English', front, back: 'a', tags: [], status: 'active', createdBy: 'user', createdAt: `2026-10-0${id.slice(-1)}T00:00:00Z`, updatedAt: '', card: card(), ...p,
})

describe('the Cards list', () => {
  const words = [word('w1', 'to give up', { pos: 'phrasal_verb', tags: ['phrasal'], cefr: 'B1' }), word('w2', 'bone', { cards: { forward: card({ lapses: 3 }), reverse: null } }), word('w3', 'moor', { deckId: 'dk_other' })]
  const facts = [fact('f4', 'Prepositions of time', { tags: ['Grammar/Prepositions'], exercises: { active: 6, flagged: 0, needsReview: 0 } }), fact('f5', 'What is a deadlock?', { tags: ['phrasal'] }), fact('f6', 'Rejected one', { status: 'rejected' })]
  const ids = (f = {}) => libraryRows(words, facts, 'dk_en', { ...emptyLibraryFilter(), ...f }).map((r) => `${r.kind}:${r.id}`)

  it('mixes a deck\'s words, questions and rules, newest first', () => {
    expect(ids()).toEqual(['fact:f5', 'rule:f4', 'word:w2', 'word:w1'])
    expect(ids({ sort: 'alpha' })).toEqual(['word:w2', 'word:w1', 'rule:f4', 'fact:f5'])
    expect(ids({ sort: 'difficulty' })[0]).toBe('word:w2')
    expect(ids({ status: 'all' })).toContain('fact:f6')
  })

  it('filters by type, tag, search and word-only fields', () => {
    expect(ids({ type: 'rule' })).toEqual(['rule:f4'])
    expect(ids({ type: 'word' })).toEqual(['word:w2', 'word:w1'])
    expect(ids({ tags: ['phrasal'] })).toEqual(['fact:f5', 'word:w1'])
    // A parent tag takes what's under it.
    expect(ids({ tags: ['Grammar'] })).toEqual(['rule:f4'])
    expect(ids({ tags: ['Gram'] })).toEqual([])
    expect(ids({ q: 'deadlock' })).toEqual(['fact:f5'])
    expect(ids({ pos: 'phrasal_verb' })).toEqual(['word:w1'])
    expect(ids({ cefr: 'B1' })).toEqual(['word:w1'])
  })

  it('counts what a deck has for the chips', () => {
    expect(deckContents(words, facts, 'dk_en')).toEqual({ types: { word: 2, fact: 1, rule: 1 }, tags: [{ tag: 'phrasal', n: 2 }, { tag: 'Grammar/Prepositions', n: 1 }] })
  })
})

describe('drill-down facets', () => {
  const w = (id: string, p: Partial<WordItem>) => word(id, id, p)
  const words = [
    w('a', { pos: 'verb', cefr: 'B1', tags: ['Books/Wuthering Heights', 'claude'] }),
    w('b', { pos: 'verb', cefr: 'B2', tags: ['Books/Dracula'] }),
    w('c', { pos: 'noun', cefr: 'B2', tags: ['Books/Dracula', 'Books/Wuthering Heights'] }),
  ]
  const facets = (f: Partial<LibraryFilter>) => libraryFacets(libraryRows(words, [], 'dk_en', { ...emptyLibraryFilter(), ...f }))

  it('counts options among the cards already shown, so every choice narrows', () => {
    // The owner's example: with "verb" picked, "noun" isn't offered — no card is both.
    expect(facets({ pos: 'verb' }).pos).toEqual([{ value: 'verb', n: 2 }])
    expect(facets({}).pos).toEqual([{ value: 'verb', n: 2 }, { value: 'noun', n: 1 }])
    // Two tags: cards with both.
    expect(libraryRows(words, [], 'dk_en', { ...emptyLibraryFilter(), tags: ['Books/Dracula', 'Books/Wuthering Heights'] }).map((r) => r.id)).toEqual(['c'])
    // A parent counts each card once, however many of its children it has.
    expect(facets({}).tags.find((t) => t.value === 'Books')).toEqual({ value: 'Books', n: 3 })
    expect(facets({ tags: ['Books/Dracula'] }).tags).toEqual([
      { value: 'Books', n: 2 }, { value: 'Books/Dracula', n: 2 }, { value: 'Books/Wuthering Heights', n: 1 },
    ])
    expect(facets({ cefr: 'B2' }).cefr).toEqual([{ value: 'B2', n: 2 }])
  })
})
