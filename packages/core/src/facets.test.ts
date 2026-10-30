import { describe, expect, it } from 'vitest'
import { facetOptions, inReviewFilter, type FacetItem } from './index.ts'

const both = ['forward', 'reverse'] as const
const items: FacetItem[] = [
  { type: 'word', tags: ['Books/wuthering heights', 'claude'], pos: 'noun', cefr: 'B1', directions: [...both] },
  { type: 'word', tags: ['Books/the king'], pos: 'verb', cefr: 'B2', directions: [...both] },
  { type: 'word', tags: ['Books/the king'], pos: 'verb', cefr: 'B1', directions: ['forward'] },
  { type: 'word', tags: ['claude'], pos: 'adverb', cefr: 'C1', directions: ['forward'] },
  { type: 'rule', tags: ['Grammar/Tenses', 'Grammar/Modals'] },
  { type: 'rule', tags: ['Grammar/Modals'] },
  { type: 'fact', tags: ['Grammar/Tenses', 'claude'] },
]
const n = (xs: { value: string; n: number }[]) => Object.fromEntries(xs.map((x) => [x.value, x.n]))

describe('hybrid filter', () => {
  it('ORs the values of a single-valued facet, ANDs tags and facets', () => {
    const rule = { type: 'rule' as const, tags: ['Grammar/Tenses', 'Grammar/Modals'] }
    expect(inReviewFilter({ tags: ['Grammar/Tenses', 'Grammar/Modals'] }, rule)).toBe(true)
    expect(inReviewFilter({ tags: ['Grammar/Tenses', 'claude'] }, rule)).toBe(false)
    expect(inReviewFilter({ types: ['rule', 'fact'] }, rule)).toBe(true)
    expect(inReviewFilter({ types: ['word', 'fact'] }, rule)).toBe(false)
    const word = { type: 'word' as const, tags: ['x'], pos: 'verb' as const, cefr: 'B2' as const, direction: 'forward' as const }
    expect(inReviewFilter({ pos: ['verb', 'noun'] }, word)).toBe(true)
    expect(inReviewFilter({ cefr: ['B2', 'C1'] }, word)).toBe(true)
    expect(inReviewFilter({ cefr: ['B1', 'C1'] }, word)).toBe(false)
    expect(inReviewFilter({ directions: ['forward', 'reverse'] }, word)).toBe(true)
    // Across facets: AND.
    expect(inReviewFilter({ pos: ['verb', 'noun'], cefr: ['C1'] }, word)).toBe(false)
    expect(inReviewFilter({ pos: ['verb'], tags: ['y'] }, word)).toBe(false)
    // Word-only fields still leave other cards alone.
    expect(inReviewFilter({ pos: ['verb'], cefr: ['C2'] }, rule)).toBe(true)
  })
})

describe('facet options', () => {
  it('keeps a disabled tag available to turn back on while other facets reflect its exclusion', () => {
    const options = facetOptions(items, { tagSelection: { values: { Grammar: false } } })
    expect(options.tags.find((t) => t.value === 'Grammar')?.n).toBe(3)
    expect(options.types).toEqual([{ value: 'word', n: 4 }])
  })
  it('counts everything without a filter: tags with their ancestors, directions per word card', () => {
    const c = facetOptions(items, null)
    expect(c.types).toEqual([{ value: 'word', n: 4 }, { value: 'rule', n: 2 }, { value: 'fact', n: 1 }])
    // The parent counts each card once, though one carries two Grammar tags.
    expect(n(c.tags)).toEqual({ Grammar: 3, 'Grammar/Modals': 2, 'Grammar/Tenses': 2, Books: 3, 'Books/the king': 2, 'Books/wuthering heights': 1, claude: 3 })
    expect(c.pos).toEqual([{ value: 'verb', n: 2 }, { value: 'adverb', n: 1 }, { value: 'noun', n: 1 }])
    expect(c.directions).toEqual([{ value: 'forward', n: 4 }, { value: 'reverse', n: 2 }])
  })

  it('keeps a facet\'s other values on offer, counted under the other facets: with verb, noun stays', () => {
    const c = facetOptions(items, { pos: ['verb'], tags: ['Books'] })
    // The owner's example: "noun" is still offered, with its count under the
    // tag; "adverb" is hidden, since no adverb has it.
    expect(c.pos).toEqual([{ value: 'verb', n: 2 }, { value: 'noun', n: 1 }])
    // The other facets count under the whole selection.
    expect(n(c.cefr)).toEqual({ B1: 1, B2: 1 })
    expect(n(c.types)).toEqual({ word: 2 })
    expect(n(c.tags)).toEqual({ Books: 2, 'Books/the king': 2 })
    // Without the tag every part of speech is there; facts pass a word-only
    // field, so the tag and type counts keep them.
    const v = facetOptions(items, { pos: ['verb'] })
    expect(n(v.pos)).toEqual({ verb: 2, adverb: 1, noun: 1 })
    expect(n(v.tags)).toEqual({ Books: 2, 'Books/the king': 2, Grammar: 3, 'Grammar/Modals': 2, 'Grammar/Tenses': 2, claude: 1 })
    expect(n(v.types)).toEqual({ word: 2, rule: 2, fact: 1 })
  })

  it('two levels = either of them', () => {
    const c = facetOptions(items, { cefr: ['B2', 'C1'] })
    expect(n(c.cefr)).toEqual({ B1: 2, B2: 1, C1: 1 })
    expect(n(c.pos)).toEqual({ verb: 1, adverb: 1 })
    expect(c.directions).toEqual([{ value: 'forward', n: 2 }, { value: 'reverse', n: 1 }])
    expect(n(c.types)).toEqual({ word: 2, rule: 2, fact: 1 })
    // Two types: either; the word facets go only when no type is a word.
    expect(n(facetOptions(items, { types: ['word', 'rule'] }).types)).toEqual({ word: 4, rule: 2, fact: 1 })
    expect(facetOptions(items, { types: ['word', 'rule'] }).pos).toHaveLength(3)
    expect(facetOptions(items, { types: ['rule', 'fact'] }).pos).toEqual([])
  })

  it('two tags AND; a parent tag counts its subtree; tags that would give nothing are hidden', () => {
    const c = facetOptions(items, { tags: ['Grammar/Tenses', 'Grammar/Modals'] })
    expect(n(c.types)).toEqual({ rule: 1 })
    expect(n(c.tags)).toEqual({ Grammar: 1, 'Grammar/Modals': 1, 'Grammar/Tenses': 1 })
    expect(c.pos).toEqual([])
    const p = facetOptions(items, { tags: ['Grammar'] })
    expect(n(p.types)).toEqual({ rule: 2, fact: 1 })
    expect(n(p.tags)).toEqual({ Grammar: 3, 'Grammar/Modals': 2, 'Grammar/Tenses': 2, claude: 1 })
    const r = facetOptions(items, { types: ['rule'] })
    expect(n(r.types)).toEqual({ word: 4, rule: 2, fact: 1 })
    expect(n(r.tags)).toEqual({ Grammar: 2, 'Grammar/Modals': 2, 'Grammar/Tenses': 1 })
    expect([r.pos, r.cefr, r.directions]).toEqual([[], [], []])
  })

  it('keeps a selected option at 0; removing a selection widens the options again', () => {
    const c = facetOptions(items, { types: ['fact'], tags: ['Grammar/Modals', 'Gone'] })
    expect(c.types).toEqual([{ value: 'fact', n: 0 }])
    expect(c.tags).toEqual([{ value: 'Gone', n: 0 }, { value: 'Grammar/Modals', n: 0 }])
    expect(facetOptions(items, { pos: ['verb'], tags: ['claude'] }).pos).toEqual([{ value: 'adverb', n: 1 }, { value: 'noun', n: 1 }, { value: 'verb', n: 0 }])
    expect(facetOptions(items, { directions: ['reverse'] }).directions).toEqual([{ value: 'forward', n: 4 }, { value: 'reverse', n: 2 }])
    expect(facetOptions(items, {})).toEqual(facetOptions(items, null))
    expect(facetOptions(items, { tags: ['Grammar/Tenses'] }).tags.length).toBeLessThan(facetOptions(items, null).tags.length)
  })
})
