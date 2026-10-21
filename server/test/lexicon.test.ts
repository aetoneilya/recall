import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { lemmaCandidates, loadLexicon, parseFrequencies, parseScale, parseVocabTest, scalePosition } from '../src/lexicon.ts'
import { convertPair, convertTags, englishSide, looksLikeWordPair, mergeTranslations, parseExtra, splitTranslations, termAndPos } from '../src/vocab-convert.ts'
import { FREQ, SCALE, TEST_DATA, testLexicon } from './helpers.ts'

describe('flashcard → word conversion', () => {
  it('finds the English side', () => {
    expect(englishSide('to frown', 'хмуриться')).toBe('front')
    expect(englishSide('сильная сторона', 'forte')).toBe('back')
    expect(englishSide('inundated (заказами)', 'заваленный заказами')).toBe('front')
    expect(englishSide('What is CAS?', 'Compare and swap')).toBeNull()
    expect(englishSide('один', 'два')).toBeNull()
  })

  it('derives the part of speech from the term', () => {
    expect(termAndPos('everyday (adj.)')).toEqual({ term: 'everyday', pos: 'adjective' })
    expect(termAndPos('to give up')).toEqual({ term: 'to give up', pos: 'phrasal_verb' })
    expect(termAndPos('to frown')).toEqual({ term: 'to frown', pos: 'verb' })
    expect(termAndPos('out of pocket (expenses)')).toEqual({ term: 'out of pocket (expenses)', pos: 'phrase' })
    expect(termAndPos('forte')).toEqual({ term: 'forte', pos: 'other' })
  })

  it('splits translations only where it is safe', () => {
    expect(splitTranslations('оптимизировать, упрощать')).toEqual(['оптимизировать', 'упрощать'])
    expect(splitTranslations('не так плохо, как о нём говорят')).toEqual(['не так плохо, как о нём говорят'])
    expect(splitTranslations('нельзя быть уверенным, что…')).toEqual(['нельзя быть уверенным, что…'])
    expect(splitTranslations('вы все (разг., BrE)')).toEqual(['вы все (разг., BrE)'])
    expect(splitTranslations('ставка; заявка')).toEqual(['ставка', 'заявка'])
    expect(mergeTranslations(['кстати говоря, учти (разг.)'], ['кстати говоря', 'учти', 'между прочим'])).toEqual(['кстати говоря, учти (разг.)', 'между прочим'])
    expect(mergeTranslations(['хмуриться'], ['Хмуриться', 'морщить лоб'])).toEqual(['хмуриться', 'морщить лоб'])
  })

  it('parses IPA out of extra and keeps the rest as a note', () => {
    expect(parseExtra('IPA: /fraʊn/\nне путать с frow')).toEqual({ ipa: 'fraʊn', note: 'не путать с frow' })
    expect(parseExtra('/ˈəʊvəhedz/')).toEqual({ ipa: 'ˈəʊvəhedz', note: null })
    expect(parseExtra(undefined)).toEqual({ ipa: null, note: null })
  })

  it('turns breadcrumb tags into the source and drops direction tags', () => {
    expect(convertTags(['wuthering heights', 'vocab'])).toEqual({ source: 'wuthering heights', tags: ['wuthering heights', 'vocab'] })
    expect(convertTags(['Russian → English'])).toEqual({ source: null, tags: [] })
    expect(convertTags(['vocab'])).toEqual({ source: null, tags: ['vocab'] })
  })

  it('accepts only term-like basic pairs', () => {
    expect(looksLikeWordPair('to frown', 'хмуриться')).toBe(true)
    expect(looksLikeWordPair('What is a race condition?', 'Гонка')).toBe(false)
    expect(looksLikeWordPair('Rate limiting', '- **token bucket** — токены')).toBe(false)
    expect(convertPair('накладные расходы', 'overheads')).toEqual({ term: 'overheads', pos: 'other', translations: ['накладные расходы'], englishOn: 'back' })
  })
})

describe('lexicon', () => {
  it('parses the frequency list in either column order', () => {
    expect([...parseFrequencies('lemma\trank\nthe\t1\nbe\t2\n')]).toEqual([['the', 1], ['be', 2]])
    expect([...parseFrequencies('1\tthe\n2\tbe')]).toEqual([['the', 1], ['be', 2]])
    expect([...parseFrequencies('# comment\nthe\nbe')]).toEqual([['the', 1], ['be', 2]])
  })

  it('lemmatises lookups', () => {
    const lex = testLexicon()
    expect(lemmaCandidates('cries')).toContain('cry')
    expect(lex.lemmaRank('cried')).toBe(900)
    expect(lex.lemmaRank('frowning')).toBe(2500)
    expect(lex.lemmaRank('stopped')).toBe(400)
    expect(lex.lemmaRank('houses')).toBe(150)
    expect(lex.rank('to frown')).toBe(2500)
    expect(lex.rank('the bone')).toBe(1800)
    expect(lex.rank('unknownword')).toBeNull()
    expect(lex.lemma('Frowned')).toBe('frown')
    expect(lex.lemma('the bone')).toBeNull()
  })

  it('reads the test and scale files', () => {
    const t = parseVocabTest(TEST_DATA)
    expect(t.bands).toHaveLength(8)
    expect(t.bands[1]).toMatchObject({ from: 1001, to: 2000 })
    expect(t).toMatchObject({ bandSize: 1000, itemsPerBand: 3, pseudowordShare: 0.25, scoring: { method: 'corrected', smooth: true, invalidFalseAlarmRate: 0.5 } })
    expect(parseVocabTest(JSON.stringify({ bands: { '1000': ['a'], '2k': ['b'] }, pseudowords: ['x'], scoring: { name: 'I_SDT' } }))).toMatchObject({
      bands: [{ from: 1, to: 1000, words: ['a'] }, { from: 1001, to: 2000, words: ['b'] }],
      scoring: { method: 'isdt' },
    })
    const s = parseScale(SCALE)
    expect(s.calibration).toEqual({ adultSize: 42000, expectedInList: 26686, listSize: null })
    expect(s.points.map((p) => [p.id, p.group, p.approximate])).toEqual([['A1', 'learner', false], ['B1', 'learner', false], ['child5', 'native', true], ['adult20', 'native', false]])
    expect(scalePosition(s.points, 2000)).toMatchObject({ level: { id: 'A1' }, next: { id: 'B1' } })
    expect(scalePosition(s.points, 500)).toMatchObject({ level: null, next: { id: 'A1' } })
  })

  it('degrades without files and picks them up when they appear', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-data-'))
    const lex = loadLexicon(dir)
    expect(lex.hasFrequencies()).toBe(false)
    expect(lex.rank('frown')).toBeNull()
    expect(lex.vocabTest()).toBeNull()
    expect(lex.scale()).toBeNull()
    fs.writeFileSync(path.join(dir, 'en-freq.tsv'), FREQ)
    fs.writeFileSync(path.join(dir, 'vocab-test.json'), '{broken')
    // A fresh loader sees them at once (the cached one re-checks every 30 s).
    const again = loadLexicon(dir)
    expect(again.rank('frown')).toBe(2500)
    expect(again.vocabTest()).toBeNull()
    fs.rmSync(dir, { recursive: true })
  })
})
