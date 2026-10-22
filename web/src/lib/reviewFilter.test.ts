import { describe, expect, it } from 'vitest'
import { cefrLabel, filterSummary, toggleIn } from './reviewFilter.ts'

describe('review filter labels', () => {
  it('summarises a filter on one line', () => {
    expect(filterSummary(null)).toBe('')
    expect(filterSummary({ pos: ['phrasal_verb', 'idiom'], cefr: ['B2', 'C1', 'C2'] })).toBe('Phrasal verbs, idioms · B2+')
    expect(filterSummary({ types: ['rule'], tags: ['Grammar'] })).toBe('Grammar · Grammar')
    expect(filterSummary({ types: ['word', 'fact'], directions: ['reverse'] }, ['en', 'ru'])).toBe('Words, Q&A · RU → EN')
    expect(filterSummary({ directions: ['forward', 'reverse'] })).toBe('')
  })

  it('reads CEFR ranges', () => {
    expect(cefrLabel(['C2', 'B2', 'C1'])).toBe('B2+')
    expect(cefrLabel(['A2', 'B2'])).toBe('A2, B2')
    expect(cefrLabel(['C2'])).toBe('C2')
  })

  it('toggles values in and drops empty lists', () => {
    const f = toggleIn(null, 'tags', 'Kafka')
    expect(f).toEqual({ tags: ['Kafka'] })
    expect(toggleIn(f, 'tags', 'Java')).toEqual({ tags: ['Kafka', 'Java'] })
    expect(toggleIn(f, 'tags', 'Kafka')).toBeNull()
    expect(toggleIn({ tags: ['a'] }, 'types', 'word')).toEqual({ tags: ['a'], types: ['word'] })
  })
})
