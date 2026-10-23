import { describe, expect, it } from 'vitest'
import { deckContents, deckTotal, emptyLibraryFilter, libraryFacets, libraryRows, type LibraryFilter } from './library.ts'
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
    expect(ids({ type: 'word', pos: 'phrasal_verb' })).toEqual(['word:w1'])
    expect(ids({ type: 'word', cefr: 'B1' })).toEqual(['word:w1'])
    // Word-only fields never exclude the other cards.
    expect(ids({ pos: 'phrasal_verb' })).toEqual(['fact:f5', 'rule:f4', 'word:w1'])
  })

  it('the header total follows the status picked, so Dropped is never "1 of" the active count', () => {
    expect(deckTotal(words, facts, 'dk_en', '')).toBe(4)
    expect(deckTotal(words, facts, 'dk_en', 'rejected')).toBe(1)
    expect(deckTotal(words, facts, 'dk_en', 'all')).toBe(5)
  })

  it('counts what a deck has for the chips', () => {
    expect(deckContents(words, facts, 'dk_en')).toEqual({ types: { word: 2, fact: 1, rule: 1 }, tags: [{ tag: 'phrasal', n: 2 }, { tag: 'Grammar/Prepositions', n: 1 }] })
  })
})

describe('facets like the review filter', () => {
  const w = (id: string, p: Partial<WordItem>) => word(id, id, p)
  const words = [
    w('a', { pos: 'verb', cefr: 'B1', tags: ['Books/Wuthering Heights', 'claude'] }),
    w('b', { pos: 'verb', cefr: 'B2', tags: ['Books/Dracula'], cards: { forward: card({ state: 'review', retrievability: 0.95 }), reverse: card() } }),
    w('c', { pos: 'noun', cefr: 'B2', tags: ['Books/Dracula', 'Books/Wuthering Heights'] }),
    w('d', { pos: 'adverb', cefr: 'C1', tags: ['claude'] }),
  ]
  const facts = [fact('f1', 'What is a deadlock?', { tags: ['Books/Dracula'] })]
  const facets = (f: Partial<LibraryFilter>) => libraryFacets(words, facts, 'dk_en', { ...emptyLibraryFilter(), ...f })
  const rows = (f: Partial<LibraryFilter>) => libraryRows(words, facts, 'dk_en', { ...emptyLibraryFilter(), ...f }).map((r) => r.id)

  it('keeps the rest of a picked facet on offer, counted under the other picks', () => {
    // The owner's example: with "verb" picked, "noun" is still offered with
    // its count under the tag; "adverb" is hidden, no adverb has the tag.
    expect(facets({ type: 'word', pos: 'verb', tags: ['Books'] }).pos).toEqual([{ value: 'verb', n: 2 }, { value: 'noun', n: 1 }])
    expect(facets({ type: 'word', pos: 'verb' }).pos).toEqual([{ value: 'verb', n: 2 }, { value: 'adverb', n: 1 }, { value: 'noun', n: 1 }])
    // The other facets count under the whole selection.
    expect(facets({ type: 'word', pos: 'verb' }).cefr).toEqual([{ value: 'B1', n: 1 }, { value: 'B2', n: 1 }])
    // The type chips: each counted under the other picks.
    expect(facets({ type: 'rule', tags: ['Books/Dracula'] }).types).toEqual({ word: 2, fact: 1, rule: 0 })
    expect(facets({ cefr: 'B2' }).cefr).toEqual([{ value: 'B2', n: 2 }, { value: 'B1', n: 1 }, { value: 'C1', n: 1 }])
    // State is single-valued too: the other states stay, under the other picks.
    expect(facets({ state: 'known' }).states).toEqual([{ value: 'new', n: 5 }, { value: 'known', n: 1 }])
    expect(rows({ state: 'known' })).toEqual(['b'])
  })

  it('ANDs tags: two tags = cards with both; a parent counts each card once; tags at 0 are hidden', () => {
    expect(rows({ tags: ['Books/Dracula', 'Books/Wuthering Heights'] })).toEqual(['c'])
    expect(facets({}).tags.find((t) => t.value === 'Books')).toEqual({ value: 'Books', n: 4 })
    expect(facets({ type: 'word', tags: ['Books/Dracula'] }).tags).toEqual([
      { value: 'Books', n: 2 }, { value: 'Books/Dracula', n: 2 }, { value: 'Books/Wuthering Heights', n: 1 },
    ])
  })

  it('keeps a picked option at 0', () => {
    const f = facets({ type: 'word', pos: 'verb', tags: ['claude', 'Books/Dracula'] })
    expect(f.pos).toEqual([{ value: 'verb', n: 0 }])
    expect(f.tags).toEqual([{ value: 'Books/Dracula', n: 0 }, { value: 'claude', n: 0 }])
    expect(facets({ state: 'suspended' }).states.find((s) => s.value === 'suspended')).toEqual({ value: 'suspended', n: 0 })
  })
})
