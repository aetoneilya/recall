import { describe, expect, it } from 'vitest'
import { answerDiff, answerTolerance, checkAnswer, editDistance, normalizeAnswer } from './index.ts'

const frown = { term: 'to frown', translations: ['хмуриться', 'морщить лоб'] }

describe('normalizeAnswer', () => {
  it('ignores case, spacing, punctuation, "to" and articles in English', () => {
    expect(normalizeAnswer('  To   Frown! ', true)).toBe('frown')
    expect(normalizeAnswer('The  Moor.', true)).toBe('moor')
    expect(normalizeAnswer("don’t", true)).toBe('dont')
    expect(normalizeAnswer('well-being', true)).toBe('well being')
    expect(normalizeAnswer('take smb for granted', true)).toBe('take someone for granted')
  })
  it('folds ё into е and keeps Russian words', () => {
    expect(normalizeAnswer('Ёлка', false)).toBe('елка')
    expect(normalizeAnswer('to', true)).toBe('to')
  })
})

describe('checkAnswer', () => {
  it('accepts the term exactly, however it is typed', () => {
    expect(checkAnswer('frown', frown, 'reverse')).toEqual({ verdict: 'exact', distance: 0, matched: 'to frown', suggestedRating: 3 })
    expect(checkAnswer('To Frown.', frown, 'reverse').verdict).toBe('exact')
  })

  it('accepts listed alternative forms and optional words', () => {
    const grey = { term: 'grey/gray', translations: ['серый'] }
    expect(checkAnswer('gray', grey, 'reverse')).toMatchObject({ verdict: 'exact', matched: 'gray' })
    const easy = { term: 'take (it) easy', translations: ['не напрягаться'] }
    expect(checkAnswer('take it easy', easy, 'reverse').verdict).toBe('exact')
    expect(checkAnswer('take easy', easy, 'reverse').verdict).toBe('exact')
  })

  it('forward accepts any translation or a piece of one', () => {
    expect(checkAnswer('морщить лоб', frown, 'forward')).toMatchObject({ verdict: 'exact', matched: 'морщить лоб' })
    const seethe = { term: 'to seethe', translations: ['кипеть (от злости), бурлить'] }
    expect(checkAnswer('бурлить', seethe, 'forward').verdict).toBe('exact')
    expect(checkAnswer('кипеть', seethe, 'forward').verdict).toBe('exact')
    expect(checkAnswer('ежик', { term: 'hedgehog', translations: ['ёжик'] }, 'forward').verdict).toBe('exact')
  })

  it('treats a small typo as close (Hard)', () => {
    expect(checkAnswer('frwon', frown, 'reverse')).toEqual({ verdict: 'close', distance: 1, matched: 'to frown', suggestedRating: 2 })
    expect(checkAnswer('хмурится', frown, 'forward')).toMatchObject({ verdict: 'close', distance: 1 })
  })

  it('scales the tolerance with the length', () => {
    expect(answerTolerance(3)).toBe(0)
    expect(answerTolerance(5)).toBe(1)
    expect(answerTolerance(9)).toBe(2)
    const cat = { term: 'cat', translations: ['кот'] }
    expect(checkAnswer('cta', cat, 'reverse').verdict).toBe('wrong')
    const idiom = { term: 'a chicken and egg situation', translations: ['замкнутый круг'] }
    expect(checkAnswer('chiken and eg situaton', idiom, 'reverse').verdict).toBe('close')
    expect(checkAnswer('fron', frown, 'reverse').verdict).toBe('close')
    expect(checkAnswer('brown', frown, 'reverse').verdict).toBe('close')
    expect(checkAnswer('crown it', frown, 'reverse').verdict).toBe('wrong')
  })

  it('counts an inflected form of the term as close', () => {
    expect(checkAnswer('frowned', frown, 'reverse')).toMatchObject({ verdict: 'close', suggestedRating: 2 })
    expect(checkAnswer('cries', { term: 'to cry', translations: ['плакать'] }, 'reverse').verdict).toBe('close')
  })

  it('marks other words wrong and an empty answer as "I don\'t know"', () => {
    expect(checkAnswer('scowl', frown, 'reverse')).toMatchObject({ verdict: 'wrong', matched: 'to frown', suggestedRating: 1 })
    expect(checkAnswer('   ', frown, 'reverse')).toEqual({ verdict: 'empty', distance: 5, matched: 'to frown', suggestedRating: 1 })
    expect(checkAnswer('x', { term: 'y', translations: [] }, 'forward')).toMatchObject({ verdict: 'wrong', matched: null })
  })
})

describe('editDistance', () => {
  it('counts a transposition as one edit', () => {
    expect(editDistance('frwon', 'frown')).toBe(1)
    expect(editDistance('', 'abc')).toBe(3)
    expect(editDistance('kitten', 'sitting')).toBe(3)
  })
})

describe('answerDiff', () => {
  it('marks the letters that differ on both sides', () => {
    expect(answerDiff('frawn', 'to frown')).toEqual({
      input: [{ text: 'fr', same: true }, { text: 'a', same: false }, { text: 'wn', same: true }],
      expected: [{ text: 'fr', same: true }, { text: 'o', same: false }, { text: 'wn', same: true }],
    })
    expect(answerDiff('Frown', 'frown')).toEqual({ input: [{ text: 'Frown', same: true }], expected: [{ text: 'frown', same: true }] })
    expect(answerDiff('', 'moor').expected).toEqual([{ text: 'moor', same: false }])
  })
})
