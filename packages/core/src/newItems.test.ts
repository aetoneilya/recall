import { describe, expect, it } from 'vitest'
import { newItemOrder, type NewStudyItem } from './newItems.ts'
import { wordTopic } from './wordTopics.ts'

const DAY = '2026-10-31'
const word = (id: string, extra: Partial<NewStudyItem> = {}): NewStudyItem => ({
  id, kind: 'word', term: id, createdAt: `${DAY}T00:00:00Z`, tags: [], ...extra,
})

describe('new-word curriculum', () => {
  it('prefers easy, common words over rare advanced words, regardless of import order', () => {
    const items = [word('rare', { cefr: 'C2', freqRank: 28000 }), word('middle', { cefr: 'B1', freqRank: 4000 }),
      word('everyday', { cefr: 'A1', freqRank: 40 }), word('basic', { cefr: 'A1', freqRank: 900 })].map((item) => ({ ...item, tags: ['Topic/Home'] }))
    expect(newItemOrder(items, DAY)).toEqual(['everyday', 'basic', 'middle', 'rare'])
  })

  it('uses frequency when CEFR is missing and admits expressions without a rank', () => {
    expect(newItemOrder([word('rare', { freqRank: 25000 }), word('common', { freqRank: 50 }),
      word('expression', { tags: ['Topic/Travel'] })], DAY)).toEqual(['common', 'expression', 'rare'])
  })

  it('introduces small context series and keeps only a few themes in focus', () => {
    const items = ['Travel', 'Work', 'Food', 'Home', 'Health'].flatMap((topic) =>
      Array.from({ length: 6 }, (_, i) => word(`${topic}-${i}`, { cefr: 'A2', tags: [`Topic/${topic}`] })))
    const ids = newItemOrder(items, DAY)
    const themes = ids.map((id) => id.split('-')[0])
    expect(themes[0]).toBe(themes[1])
    const firstRun = themes.findIndex((topic) => topic !== themes[0])
    expect([2, 3]).toContain(firstRun)
    expect(new Set(themes.slice(0, 6)).size).toBeLessThanOrEqual(3)
    expect(new Set(ids).size).toBe(items.length)
  })

  it('occasionally offers the adjacent level without jumping to a distant one', () => {
    const items = Array.from({ length: 30 }, (_, i) => word(`easy-${i}`, { cefr: 'A1' }))
      .concat([word('next', { cefr: 'A2' }), word('advanced', { cefr: 'C2' })])
    const ids = newItemOrder(items, DAY)
    expect(ids.slice(0, 4).every((id) => id.startsWith('easy-'))).toBe(true)
    expect(ids.indexOf('next')).toBeLessThan(15)
    expect(ids.at(-1)).toBe('advanced')
  })

  it('promotes long-waiting advanced words instead of starving them behind new easy imports', () => {
    const items = [word('easy', { cefr: 'A1' }), word('waiting', { cefr: 'C2', createdAt: '2024-01-01T00:00:00Z' })]
    expect(newItemOrder(items, DAY)[0]).toBe('waiting')
  })

  it('leaves facts, familiar words and words without metadata in their source slots', () => {
    const items = [word('hard', { cefr: 'C2' }), word('fact', { kind: 'fact' }), word('reverse', { familiar: true, cefr: 'C2' }),
      word('unknown'), word('easy', { cefr: 'A1' })]
    expect(newItemOrder(items, DAY)).toEqual(['easy', 'fact', 'reverse', 'unknown', 'hard'])
  })

  it('keeps chronological round-robin source mixing when no word has metadata', () => {
    const items = [word('book1', { tags: ['Books/One'] }), word('book2', { tags: ['Books/Two'] }), word('article', { tags: ['Articles'] }), word('plain')]
    expect(newItemOrder(items, DAY)).toEqual(['book1', 'article', 'plain', 'book2'])
  })

  it('is reproducible within a day and varies its theme choices between days', () => {
    const items = Array.from({ length: 8 }, (_, i) => word(`word-${i}`, { cefr: 'B1', tags: [`Topic/Context${i}`] }))
    expect(newItemOrder(items, DAY)).toEqual(newItemOrder(items, DAY))
    expect(newItemOrder(items, DAY)).not.toEqual(newItemOrder(items, '2026-11-01'))
  })

  it('keeps the saved order after ratings/edits/removals and appends newly added items', () => {
    const items = [word('hard', { cefr: 'C2' }), word('easy', { cefr: 'A1' }), word('middle', { cefr: 'B1' })]
    const plan = newItemOrder(items, DAY)
    expect(newItemOrder([word('middle', { cefr: 'A1' }), word('hard', { cefr: 'A1' }), word('added', { cefr: 'A1' })], DAY, plan))
      .toEqual([...plan, 'added'])
  })
})

describe('word topics', () => {
  it('uses explicit context tags regardless of provenance or tag order', () => {
    expect(wordTopic({ term: 'ticket', tags: ['claude', 'Books/Some novel', 'Topic/Work'] })).toBe('work')
    expect(wordTopic({ term: 'unspecified', tags: ['Books/Some novel', 'claude'] })).toBeNull()
  })

  it('recognises common English contexts and respects sense and language', () => {
    expect(wordTopic({ term: 'ticket', tags: [] })).toBe('travel')
    expect(wordTopic({ term: 'to book', pos: 'verb', tags: [] })).toBe('travel')
    expect(wordTopic({ term: 'book', pos: 'noun', tags: [] })).toBe('education')
    expect(wordTopic({ term: 'gift', tags: [], language: 'de' })).toBeNull()
    expect(wordTopic({ term: 'train', tags: [], language: 'fr' })).toBeNull()
  })
})
