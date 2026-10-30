import { describe, expect, it } from 'vitest'
import { allIn, cefrLabel, filterChips, filterSummary, toggleIn } from './reviewFilter.ts'

describe('review filter labels', () => {
  it('summarises a filter on one line', () => {
    expect(filterSummary(null)).toBe('')
    expect(filterSummary({ pos: ['phrasal_verb', 'idiom'], cefr: ['B2', 'C1', 'C2'] })).toBe('Phrasal verbs, idioms · B2+')
    expect(filterSummary({ types: ['rule'], tags: ['Grammar'] })).toBe('Grammar · Grammar')
    expect(filterSummary({ types: ['word', 'fact'], directions: ['reverse'] }, ['en', 'ru'])).toBe('Words, Q&A · RU → EN')
    expect(filterSummary({ directions: ['forward', 'reverse'] })).toBe('')
  })

  it('reads a run of levels up to C2 as a range, lists the rest in order', () => {
    expect(cefrLabel(['C2', 'B2', 'C1'])).toBe('B2+')
    expect(cefrLabel(['C1', 'B1'])).toBe('B1, C1')
    expect(cefrLabel(['A2', 'B2'])).toBe('A2, B2')
    expect(cefrLabel(['B1', 'B2'])).toBe('B1, B2')
    expect(cefrLabel(['C2'])).toBe('C2')
  })

  it('toggles values in and drops empty lists', () => {
    const f = toggleIn(null, 'tags', 'Kafka')
    expect(f).toEqual({ tags: ['Kafka'] })
    expect(toggleIn(f, 'tags', 'Java')).toEqual({ tags: ['Kafka', 'Java'] })
    expect(toggleIn(f, 'tags', 'Kafka')).toBeNull()
    expect(toggleIn({ tags: ['a'] }, 'types', 'word')).toEqual({ tags: ['a'], types: ['word'] })
  })

  it('restores All for one section without clearing other restrictions', () => {
    expect(allIn({ types: ['word'], tags: ['Grammar'], cefr: ['B2'] }, 'types')).toEqual({ tags: ['Grammar'], cefr: ['B2'] })
    expect(allIn({ tags: ['Grammar'] }, 'tags')).toBeNull()
    expect(allIn(null, 'directions')).toBeNull()
  })
})

describe('filter summary with tag paths', () => {
  it('names a nested tag by its last part', () => {
    expect(filterSummary({ tags: ['Grammar/Articles & nouns', 'claude'] })).toBe('Articles & nouns, claude')
  })
})

describe('filter chips', () => {
  it('lists each active value, removable on its own', () => {
    const f = { types: ['word' as const], tags: ['Grammar/Articles & nouns'], pos: ['phrasal_verb' as const], cefr: ['B2' as const, 'C1' as const, 'C2' as const], directions: ['reverse' as const] }
    const chips = filterChips(f)
    expect(chips.map((c) => c.label)).toEqual(['Words', 'Grammar › Articles & nouns', 'Phrasal verb', 'B2+', 'RU → EN'])
    expect(chips[1]!.without).toEqual({ types: ['word'], pos: ['phrasal_verb'], cefr: ['B2', 'C1', 'C2'], directions: ['reverse'] })
    expect(chips[3]!.without?.cefr).toBeUndefined()
    expect(filterChips({ cefr: ['C1', 'B1'] }).map((c) => c.label)).toEqual(['B1, C1'])
    expect(filterChips({ tags: ['claude'] })[0]!.without).toBeNull()
    expect(filterChips(null)).toEqual([])
  })
})
