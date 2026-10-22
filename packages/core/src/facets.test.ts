import { describe, expect, it } from 'vitest'
import { facetOptions, inReviewFilter, type FacetItem } from './index.ts'

const both = ['forward', 'reverse'] as const
const items: FacetItem[] = [
  { type: 'word', tags: ['Books/wuthering heights', 'claude'], pos: 'noun', cefr: 'B1', directions: [...both] },
  { type: 'word', tags: ['Books/the king'], pos: 'verb', cefr: 'B2', directions: [...both] },
  { type: 'word', tags: ['Books/the king'], pos: 'verb', cefr: 'B1', directions: ['forward'] },
  { type: 'rule', tags: ['Grammar/Tenses', 'Grammar/Modals'] },
  { type: 'rule', tags: ['Grammar/Modals'] },
  { type: 'fact', tags: ['Grammar/Tenses', 'claude'] },
]
const n = (xs: { value: string; n: number }[]) => Object.fromEntries(xs.map((x) => [x.value, x.n]))

describe('drill-down filter', () => {
  it('ANDs every selected value, within a facet too', () => {
    const rule = { type: 'rule' as const, tags: ['Grammar/Tenses', 'Grammar/Modals'] }
    expect(inReviewFilter({ tags: ['Grammar/Tenses', 'Grammar/Modals'] }, rule)).toBe(true)
    expect(inReviewFilter({ tags: ['Grammar/Tenses', 'claude'] }, rule)).toBe(false)
    expect(inReviewFilter({ types: ['rule', 'fact'] }, rule)).toBe(false)
    const word = { type: 'word' as const, tags: [], pos: 'verb' as const, direction: 'forward' as const }
    expect(inReviewFilter({ pos: ['verb', 'noun'] }, word)).toBe(false)
    expect(inReviewFilter({ directions: ['forward', 'reverse'] }, word)).toBe(false)
    // Word-only fields still leave other cards alone.
    expect(inReviewFilter({ pos: ['verb'] }, rule)).toBe(true)
  })
})

describe('facet options', () => {
  it('counts everything without a filter: tags with their ancestors, directions per word card', () => {
    const c = facetOptions(items, null)
    expect(c.types).toEqual([{ value: 'word', n: 3 }, { value: 'rule', n: 2 }, { value: 'fact', n: 1 }])
    // The parent counts each card once, though one carries two Grammar tags.
    expect(n(c.tags)).toEqual({ Grammar: 3, 'Grammar/Modals': 2, 'Grammar/Tenses': 2, Books: 3, 'Books/the king': 2, 'Books/wuthering heights': 1, claude: 2 })
    expect(c.pos).toEqual([{ value: 'verb', n: 2 }, { value: 'noun', n: 1 }])
    expect(c.directions).toEqual([{ value: 'forward', n: 3 }, { value: 'reverse', n: 2 }])
  })

  it('offers only what narrows to something: with pos = verb, no noun', () => {
    const c = facetOptions(items, { pos: ['verb'] })
    expect(c.pos).toEqual([{ value: 'verb', n: 2 }])
    expect(n(c.cefr)).toEqual({ B1: 1, B2: 1 })
    // Facts pass a word-only field, so the tag counts keep them.
    expect(n(c.tags)).toEqual({ Books: 2, 'Books/the king': 2, Grammar: 3, 'Grammar/Modals': 2, 'Grammar/Tenses': 2, claude: 1 })
    expect(n(c.types)).toEqual({ word: 2, rule: 2, fact: 1 })
  })

  it('two tags AND; a parent tag counts its subtree; types without words hide the word facets', () => {
    const c = facetOptions(items, { tags: ['Grammar/Tenses', 'Grammar/Modals'] })
    expect(n(c.types)).toEqual({ rule: 1 })
    expect(n(c.tags)).toEqual({ Grammar: 1, 'Grammar/Modals': 1, 'Grammar/Tenses': 1 })
    const p = facetOptions(items, { tags: ['Grammar'] })
    expect(n(p.types)).toEqual({ rule: 2, fact: 1 })
    expect(n(p.tags)).toEqual({ Grammar: 3, 'Grammar/Modals': 2, 'Grammar/Tenses': 2, claude: 1 })
    expect(p.pos).toEqual([])
    const r = facetOptions(items, { types: ['rule'] })
    expect(n(r.tags)).toEqual({ Grammar: 2, 'Grammar/Modals': 2, 'Grammar/Tenses': 1 })
    expect([r.pos, r.cefr, r.directions]).toEqual([[], [], []])
  })

  it('keeps a selected option at 0; removing a selection widens the options again', () => {
    const c = facetOptions(items, { types: ['fact'], tags: ['Grammar/Modals', 'Gone'] })
    expect(c.types).toEqual([{ value: 'fact', n: 0 }])
    expect(c.tags).toEqual([{ value: 'Gone', n: 0 }, { value: 'Grammar/Modals', n: 0 }])
    const d = facetOptions(items, { directions: ['reverse'] })
    expect(d.directions).toEqual([{ value: 'reverse', n: 2 }])
    expect(n(facetOptions(items, { pos: ['verb', 'noun'] }).pos)).toEqual({ verb: 0, noun: 0 })
    expect(facetOptions(items, {})).toEqual(facetOptions(items, null))
    expect(facetOptions(items, { tags: ['Grammar/Tenses'] }).tags.length).toBeLessThan(facetOptions(items, null).tags.length)
  })
})
