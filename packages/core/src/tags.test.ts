import { describe, expect, it } from 'vitest'
import { cleanFact, cleanReviewFilter, cleanTag, cleanWord, inReviewFilter, renamedTag, tagAncestors, tagLeaf, tagMatches, tagParent } from './index.ts'

describe('hierarchical tags', () => {
  it('matches a tag and everything under it, at the "/" boundary', () => {
    expect(tagMatches('Grammar', 'Grammar')).toBe(true)
    expect(tagMatches('Grammar', 'Grammar/Tenses')).toBe(true)
    expect(tagMatches('Grammar', 'Grammar/Tenses/Past')).toBe(true)
    expect(tagMatches('Grammar/Tenses', 'Grammar/Tenses/Past')).toBe(true)
    expect(tagMatches('Grammar', 'Grammarly')).toBe(false)
    expect(tagMatches('Grammar/Tenses', 'Grammar')).toBe(false)
    expect(tagMatches('grammar', 'Grammar')).toBe(false)
  })

  it('splits a path into ancestors, leaf and parent', () => {
    expect(tagAncestors('a/b/c')).toEqual(['a', 'a/b'])
    expect(tagAncestors('a')).toEqual([])
    expect(tagLeaf('a/b')).toBe('b')
    expect(tagLeaf('a')).toBe('a')
    expect(tagParent('a/b/c')).toBe('a/b')
    expect(tagParent('a')).toBeNull()
  })

  it('renames a tag with its descendants only', () => {
    expect(renamedTag('Tenses', 'Tenses', 'Grammar/Tenses')).toBe('Grammar/Tenses')
    expect(renamedTag('Tenses/Past', 'Tenses', 'Grammar/Tenses')).toBe('Grammar/Tenses/Past')
    expect(renamedTag('Tensesx', 'Tenses', 'Grammar/Tenses')).toBeNull()
  })

  it('cleans each segment and drops empty ones', () => {
    expect(cleanTag('a//b ')).toBe('a/b')
    expect(cleanTag(' Grammar /  Articles   &  nouns/ ')).toBe('Grammar/Articles & nouns')
    expect(cleanTag('/')).toBe('')
    expect(cleanTag('abc/def', 4)).toBe('abc')
    const w = cleanWord({ term: 'x', pos: 'noun', translations: ['y'], tags: ['a//b ', 'a/b', ' / '] })
    expect('word' in w && w.word.tags).toEqual(['a/b'])
    const f = cleanFact({ front: 'q', back: 'a', tags: ['Grammar/ Tenses', 'Grammar/Tenses'] })
    expect('fact' in f && f.fact.tags).toEqual(['Grammar/Tenses'])
  })

  it('takes descendants in the review filter', () => {
    const rule = { type: 'rule' as const, tags: ['Grammar/Tenses'] }
    const word = { type: 'word' as const, tags: ['Grammarly'] }
    expect(inReviewFilter({ tags: ['Grammar'] }, rule)).toBe(true)
    expect(inReviewFilter({ tags: ['Grammar'] }, word)).toBe(false)
    expect(inReviewFilter({ tags: ['Grammar/Modals', 'Grammar/Tenses'] }, rule)).toBe(false)
    expect(inReviewFilter({ tags: ['Grammar', 'Grammar/Tenses'] }, rule)).toBe(true)
    expect(inReviewFilter({ tags: ['Grammar/Tenses/Past'] }, rule)).toBe(false)
    expect(cleanReviewFilter({ tags: ['Grammar/ Tenses', 'Grammar/Tenses'] })).toEqual({ tags: ['Grammar/Tenses'] })
  })
})
