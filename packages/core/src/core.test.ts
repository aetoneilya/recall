import { describe, expect, it } from 'vitest'
import { blankTerm, cleanFact, formsLine, cleanIpa, cleanWord, dayKey, dedupeKey, factKey, itemOf, newCardState, nextDayStart, normalizeTerm, preview, review, wordFace, type QueueItem } from './index.ts'

describe('words', () => {
  const word = {
    term: 'to frown', pos: 'verb' as const, translations: ['хмуриться', 'морщить лоб'], ipa: 'fraʊn',
    examples: [{ text: 'She frowned at him.', translation: 'Она нахмурилась на него.' }], note: 'обычно frown at smb',
  }

  it('normalises the dedupe key', () => {
    expect(normalizeTerm('  To   Frown ')).toBe('frown')
    expect(dedupeKey('to frown', 'verb')).toBe(dedupeKey('Frown', 'verb'))
    expect(dedupeKey('frown', 'verb')).not.toBe(dedupeKey('frown', 'noun'))
  })

  it('blanks the term in simple inflected forms', () => {
    expect(blankTerm('She frowned at him.', 'to frown')).toBe('She ___ at him.')
    expect(blankTerm('Frowning, he left.', 'to frown')).toBe('___, he left.')
    expect(blankTerm('He cried and cried.', 'to cry')).toBe('He ___ and ___.')
    expect(blankTerm('They are making ends meet.', 'to make ends meet')).toBe('They are ___.')
    expect(blankTerm('We stopped there.', 'stop')).toBe('We ___ there.')
    expect(blankTerm('Two auction houses bid.', 'auction house')).toBe('Two ___ bid.')
    expect(blankTerm('Stop taking the mickey out of me!', 'take the mickey out of someone')).toBe('Stop ___!')
    expect(blankTerm('A frowny face.', 'to frown')).toBeNull()
    expect(blankTerm('Nothing here.', 'to frown')).toBeNull()
  })

  it('renders both directions', () => {
    expect(wordFace(word, 'forward')).toEqual({
      direction: 'forward',
      front: { term: 'to frown', ipa: 'fraʊn', posLabel: 'v.', translations: [], example: null, exampleTranslation: null, note: null },
      back: { term: null, ipa: null, posLabel: null, translations: ['хмуриться', 'морщить лоб'], example: 'She frowned at him.', exampleTranslation: 'Она нахмурилась на него.', note: 'обычно frown at smb' },
    })
    const rev = wordFace(word, 'reverse')
    expect(rev.front).toMatchObject({ term: null, translations: ['хмуриться', 'морщить лоб'], posLabel: 'v.', example: 'She ___ at him.', exampleTranslation: null })
    expect(rev.back).toMatchObject({ term: 'to frown', ipa: 'fraʊn', example: 'She frowned at him.' })
    // Term not found in the example: the front shows its translation instead.
    const odd = wordFace({ ...word, examples: [{ text: 'A scowl.', translation: 'Хмурый взгляд.' }] }, 'reverse')
    expect(odd.front).toMatchObject({ example: null, exampleTranslation: 'Хмурый взгляд.' })
    expect(wordFace({ ...word, examples: [], pos: 'other' }, 'reverse').front).toMatchObject({ example: null, exampleTranslation: null, posLabel: null })
  })

  it('cleans and validates', () => {
    const r = cleanWord({ term: ' to  frown ', pos: 'verb', translations: [' хмуриться ', 'хмуриться', ''], ipa: '/fraʊn/', examples: [{ text: ' ' }, { text: 'x' }], tags: ['a', 'a'] })
    expect(r).toEqual({ word: { term: 'to frown', pos: 'verb', translations: ['хмуриться'], ipa: 'fraʊn', examples: [{ text: 'x', translation: null }], note: null, tags: ['a'], cefr: null } })
    expect(cleanWord({ term: 'x', pos: 'verb', translations: [] })).toEqual({ error: 'at least one translation is required' })
    expect(cleanWord({ term: ' ', pos: 'verb', translations: ['a'] })).toEqual({ error: 'term is empty' })
    expect(cleanWord({ term: 'x', pos: 'thing' as never, translations: ['a'] })).toMatchObject({ error: expect.stringMatching(/part of speech/) })
    expect(cleanWord({ term: 'x', pos: 'noun', translations: ['a'], cefr: 'D1' as never })).toEqual({ error: 'unknown CEFR level D1' })
    expect(cleanWord({ term: 'x', pos: 'noun', translations: ['a'], examples: Array(6).fill({ text: 'e' }) })).toEqual({ error: 'at most 5 examples' })
    expect(cleanIpa('[ˈʌptɜːn]')).toBe('ˈʌptɜːn')
  })
})

describe('verb forms', () => {
  it('joins variants with a slash and past · participle with a dot', () => {
    expect(formsLine({ past: ['began'], participle: ['begun'] })).toBe('began · begun')
    expect(formsLine({ past: ['was', 'were'], participle: ['been'] })).toBe('was / were · been')
  })
})

describe('facts', () => {
  it('keys a fact by its question, ignoring case, spacing and the final punctuation', () => {
    expect(factKey('  What is  a Deadlock? ')).toBe('what is a deadlock')
    expect(factKey('What is a deadlock')).toBe(factKey('what is a deadlock?!'))
    expect(factKey('What is a deadlock?')).not.toBe(factKey('What is a livelock?'))
  })

  it('cleans and validates, keeping the Markdown inside', () => {
    const back = '  Two steps:\r\n\r\n1. read\n2. write   \n\n```java\n  x++;\n```\n\n'
    expect(cleanFact({ front: ' Why is x++ racy? ', back, tags: ['java', ' java ', 'jmm', ''] })).toEqual({
      fact: { front: 'Why is x++ racy?', back: '  Two steps:\n\n1. read\n2. write\n\n```java\n  x++;\n```', tags: ['java', 'jmm'] },
    })
    expect(cleanFact({ front: '', back: 'a' })).toEqual({ error: 'front is empty' })
    expect(cleanFact({ front: 'q', back: '\n \n' })).toEqual({ error: 'back is empty' })
    expect(cleanFact({ front: 'q'.repeat(2001), back: 'a' })).toEqual({ error: 'front is longer than 2000 characters' })
  })

  it('finds the word or fact behind a queue item', () => {
    const card = { id: 'cd_1', wordId: null, factId: 'ft_1', direction: 'forward' as const, suspended: false, schedule: newCardState(new Date()) }
    const fact = { id: 'ft_1', deckId: 'dk_t', front: 'Q', back: 'A', tags: [], status: 'active' as const, createdBy: 'user' as const, createdAt: '', updatedAt: '' }
    const it: QueueItem = { kind: 'fact', card, fact, deckName: 'Java' }
    expect(itemOf(it)).toBe(fact)
  })
})

describe('schedule', () => {
  it('moves a new card forward and previews every rating', () => {
    const now = new Date('2026-10-21T10:00:00Z')
    const s = newCardState(now)
    const after = review(s, 3, now)
    expect(after.reps).toBe(1)
    expect(new Date(after.due).getTime()).toBeGreaterThan(now.getTime())
    const p = preview(s, now)
    expect(p[1].getTime()).toBeLessThanOrEqual(p[4].getTime())
  })
})

describe('day', () => {
  const opts = { timeZone: 'Europe/Moscow', startHour: 4 }
  it('counts 2 a.m. as the previous study day', () => {
    // 23:00 UTC = 02:00 MSK next calendar day
    expect(dayKey(new Date('2026-10-21T23:00:00Z'), opts)).toBe('2026-10-21')
    expect(dayKey(new Date('2026-10-22T02:00:00Z'), opts)).toBe('2026-10-22')
  })
  it('finds the next 4 a.m.', () => {
    expect(nextDayStart(new Date('2026-10-21T10:00:00Z'), opts).toISOString()).toBe('2026-10-22T01:00:00.000Z')
  })
})
