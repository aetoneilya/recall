import { describe, expect, it } from 'vitest'
import { blankTerm, cleanIpa, cleanWord, dayKey, dedupeKey, newCardState, nextDayStart, normalizeTerm, preview, review, wordFace } from './index.ts'

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
    expect(r).toEqual({ word: { term: 'to frown', pos: 'verb', translations: ['хмуриться'], ipa: 'fraʊn', examples: [{ text: 'x', translation: null }], note: null, source: null, tags: ['a'], cefr: null } })
    expect(cleanWord({ term: 'x', pos: 'verb', translations: [] })).toEqual({ error: 'at least one translation is required' })
    expect(cleanWord({ term: ' ', pos: 'verb', translations: ['a'] })).toEqual({ error: 'term is empty' })
    expect(cleanWord({ term: 'x', pos: 'thing' as never, translations: ['a'] })).toMatchObject({ error: expect.stringMatching(/part of speech/) })
    expect(cleanWord({ term: 'x', pos: 'noun', translations: ['a'], cefr: 'D1' as never })).toEqual({ error: 'unknown CEFR level D1' })
    expect(cleanWord({ term: 'x', pos: 'noun', translations: ['a'], examples: Array(6).fill({ text: 'e' }) })).toEqual({ error: 'at most 5 examples' })
    expect(cleanIpa('[ˈʌptɜːn]')).toBe('ˈʌptɜːn')
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
