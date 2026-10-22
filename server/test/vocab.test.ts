import { describe, expect, it } from 'vitest'
import type { CardState } from '@recall/core'
import { dashboard } from '../src/dashboard.ts'
import { makeLexicon } from '../src/lexicon.ts'
import { defaultDeck, STATE_COLUMNS, stateValues, updateDeck } from '../src/repo.ts'
import { answerVocabTest, createVocabTest, isdt, listVocabTests, nonIncreasing, scoreItems, vocabularySummary, type TestItem } from '../src/vocab.ts'
import { addWord, cardsOf, makeCtx, TZ, type TestCtx } from './helpers.ts'

const state = (at: string, stability: number, s: 0 | 2 = 2): CardState => ({
  due: new Date(Date.parse(at) + stability * 86400_000).toISOString(), stability, difficulty: 5, elapsedDays: 0, scheduledDays: stability,
  learningSteps: 0, reps: 1, lapses: 0, state: s, lastReview: s ? at : null,
})

// A review at `at` leaving the card in review with `stability`.
function reviewed(ctx: TestCtx, cardId: string, at: string, stability: number, { before = 0 as 0 | 2, rating = 3 } = {}) {
  const after = state(at, stability)
  ctx.db.prepare(`UPDATE cards SET ${STATE_COLUMNS} WHERE id = ?`).run(...stateValues(after), cardId)
  ctx.db.prepare('INSERT INTO review_logs(id, card_id, rating, reviewed_at, duration_ms, "before", "after") VALUES (?, ?, ?, ?, 5000, ?, ?)')
    .run(`${cardId}-${at}`, cardId, rating, at, JSON.stringify(state(at, 1, before)), JSON.stringify(after))
}

// Marks a word's forward card as solidly known now.
function know(ctx: TestCtx, wordId: string) {
  reviewed(ctx, cardsOf(ctx, wordId)[0]!.id, '2026-10-20T09:00:00.000Z', 200)
}

// Deterministic "random".
const seeded = (seed = 1) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646

describe('vocabulary test', () => {
  it('samples ~3 words per band plus 25% pseudowords, skipping words already in the app', () => {
    const ctx = makeCtx()
    addWord(ctx, 'w1')
    addWord(ctx, 'w38s', { pos: 'noun' })
    const t = createVocabTest(ctx.db, ctx.user.id, ctx.lexicon, ctx.now(), { rng: seeded() })
    expect(t.items).toHaveLength(32)
    expect(new Set(t.items.map((i) => i.id)).size).toBe(32)
    const words = t.items.map((i) => i.word)
    expect(words.filter((w) => w.startsWith('blorf'))).toHaveLength(8)
    expect(words).not.toContain('w1')
    // "w38s" lemmatises to w38, which is in the test bank: excluded too.
    expect(words).not.toContain('w38')
    // The answer key stays on the server.
    expect(Object.keys(t.items[0]!)).toEqual(['id', 'word'])
  })

  it('corrects for guessing per band, smooths and scores', () => {
    const ctx = makeCtx()
    const t = createVocabTest(ctx.db, ctx.user.id, ctx.lexicon, ctx.now(), { rng: seeded(7) })
    const items = JSON.parse((ctx.db.prepare('SELECT items FROM vocab_tests WHERE id = ?').get(t.testId) as { items: string }).items) as TestItem[]
    // Knows bands 1–4, nothing beyond; ticks 2 of 8 pseudowords (f = 0.25).
    let fakes = 0
    const answers = items.map((it) => ({ id: it.id, known: it.kind === 'real' ? it.band! < 4 : fakes++ < 2 }))
    const r = answerVocabTest(ctx.db, ctx.user.id, ctx.lexicon, t.testId, answers, ctx.now())
    expect(r.falseAlarmRate).toBe(0.25)
    expect(r.perBand.map((b) => b.known)).toEqual([1, 1, 1, 1, 0, 0, 0, 0])
    expect(r).toMatchObject({ estimate: 4000, adjusted: 4000, basis: 'test+app', reliability: 'low', valid: true, method: 'corrected', pseudowords: { items: 8, yes: 2 }, answered: 32 })
    // In-list 4000 → B1 among learners; ≈6295 native-equivalent → past the 5-year-old.
    expect(r.nativeEquivalent).toEqual({ value: 6295, approximate: true })
    expect(r.cefr).toMatchObject({ level: { id: 'B1' }, next: null })
    expect(r.scale.native).toMatchObject({ level: { id: 'child5', approximate: true }, next: { id: 'adult20' } })
    expect(r.interval![0]).toBeLessThanOrEqual(4000)
    expect(r.interval![1]).toBeGreaterThanOrEqual(4000)
    expect(() => answerVocabTest(ctx.db, ctx.user.id, ctx.lexicon, t.testId, answers, ctx.now())).toThrow(/already/)
    expect(listVocabTests(ctx.db, ctx.user.id)).toMatchObject([{ id: t.testId, items: 32, result: { estimate: 4000 } }])
  })

  it('implements the scoring formulas', () => {
    expect(isdt(1, 0)).toBe(1)
    expect(isdt(0.5, 0)).toBeCloseTo(0.6)
    expect(isdt(0.2, 0.3)).toBe(0)
    expect(nonIncreasing([1, 0.5, 0.8, 0], [3, 3, 3, 3])).toEqual([1, 0.65, 0.65, 0])
    const ctx = makeCtx()
    const data = ctx.lexicon.vocabTest()!
    const items: TestItem[] = [
      { id: 'a', word: 'x', kind: 'real', band: 0 }, { id: 'b', word: 'y', kind: 'real', band: 0 }, { id: 'c', word: 'z', kind: 'real', band: 0 },
      { id: 'p', word: 'q', kind: 'pseudo', band: null }, { id: 'r', word: 's', kind: 'pseudo', band: null }, { id: 't', word: 'u', kind: 'pseudo', band: null }, { id: 'v', word: 'w', kind: 'pseudo', band: null },
    ]
    const s = scoreItems(data, items, new Map([['a', true], ['b', true], ['c', false], ['p', true], ['r', false], ['t', false], ['v', false]]))
    // (2/3 − 1/4) / (1 − 1/4) = 0.556; bands without items take their neighbour's value.
    expect(s.known[0]).toBeCloseTo(0.5556, 3)
    expect(s.f).toBe(0.25)
    expect(s.noise).toBe(false)
    // Ticking pseudowords as often as real words is noise.
    const noisy = scoreItems(data, items, new Map([['a', true], ['b', false], ['c', false], ['p', true], ['r', true], ['t', false], ['v', false]]))
    expect(noisy).toMatchObject({ f: 0.5, noise: true })
  })

  it('raises the estimate between tests with words known in the app', () => {
    const ctx = makeCtx()
    const t = createVocabTest(ctx.db, ctx.user.id, ctx.lexicon, ctx.now(), { rng: seeded(3) })
    const items = JSON.parse((ctx.db.prepare('SELECT items FROM vocab_tests WHERE id = ?').get(t.testId) as { items: string }).items) as TestItem[]
    answerVocabTest(ctx.db, ctx.user.id, ctx.lexicon, t.testId, items.map((it) => ({ id: it.id, known: it.kind === 'real' && it.band! < 2 })), ctx.now())
    // Later: three band-6 words become known in the app; one multi-word phrase doesn't count.
    for (const term of ['w5001', 'w5002', 'w5003']) know(ctx, addWord(ctx, term).id)
    know(ctx, addWord(ctx, 'the w5004', { pos: 'phrase' }).id)
    const v = vocabularySummary(ctx.db, ctx.user.id, ctx.lexicon, ctx.now())
    expect(v.latestTest!.estimate).toBe(2000)
    expect(v.current).toMatchObject({ estimate: 2000, adjusted: 2003, srsKnown: 3, basis: 'test+app' })
    expect(v.current!.perBand[5]).toMatchObject({ known: 0, srs: 0.003 })
    expect(v.history).toMatchObject([{ testId: t.testId, estimate: 2000, adjusted: 2000 }])
  })

  it('is off without test data and rejects other users\' tests', () => {
    const ctx = makeCtx()
    const bare = makeLexicon(() => null, () => null, () => null)
    expect(() => createVocabTest(ctx.db, ctx.user.id, bare, ctx.now())).toThrow(/not installed/)
    expect(vocabularySummary(ctx.db, ctx.user.id, bare, ctx.now())).toMatchObject({ available: { frequencies: false, test: false, scale: false }, current: null, latestTest: null })
    const t = createVocabTest(ctx.db, ctx.user.id, ctx.lexicon, ctx.now())
    expect(() => answerVocabTest(ctx.db, 'us_other', ctx.lexicon, t.testId, [], ctx.now())).toThrow(/not found/)
    expect(() => answerVocabTest(ctx.db, ctx.user.id, ctx.lexicon, t.testId, [{ id: 'q1', known: true }], ctx.now())).toThrow(/at least half/)
  })
})

describe('dashboard', () => {
  it('counts per direction, reconstructs growth, activity, retention and coverage', () => {
    const ctx = makeCtx()
    const deck = defaultDeck(ctx.db, ctx.user.id, ctx.now())
    const house = addWord(ctx, 'house')
    const cry = addWord(ctx, 'to cry', { pos: 'verb' })
    const frown = addWord(ctx, 'to frown', { pos: 'verb' })
    addWord(ctx, 'zzz', { status: 'rejected' })
    const [hf, hr] = cardsOf(ctx, house.id)
    reviewed(ctx, hf!.id, '2026-10-01T09:00:00.000Z', 100)
    reviewed(ctx, hr!.id, '2026-10-02T09:00:00.000Z', 30, { before: 2, rating: 1 })
    reviewed(ctx, cardsOf(ctx, cry.id)[0]!.id, '2026-06-01T09:00:00.000Z', 5)
    reviewed(ctx, cardsOf(ctx, frown.id)[1]!.id, '2026-10-20T09:00:00.000Z', 50, { before: 2 })

    const d = dashboard(ctx.db, ctx.user.id, deck, ctx.lexicon, TZ, ctx.now())
    expect(d.counts).toEqual({
      words: { total: 4, active: 3, rejected: 1 },
      directions: {
        forward: { enabled: true, new: 1, learning: 0, known: 1, fading: 1, suspended: 0 },
        reverse: { enabled: true, new: 1, learning: 0, known: 2, fading: 0, suspended: 0 },
      },
      known: 2,
      mastered: 1,
    })
    expect(d.growth).toHaveLength(26)
    expect(d.growth.at(-1)).toEqual({ date: '2026-10-21', known: 2 })
    expect(d.growth.at(-4)!.known).toBe(0)
    // 20 weeks back (3 June) "to cry" was fresh.
    expect(d.growth.at(-21)).toEqual({ date: '2026-06-03', known: 1 })
    expect(d.activity.days).toHaveLength(90)
    expect(d.activity.totals).toEqual({ reviews: 3, timeMs: 15000 })
    expect(d.activity.days.find((x) => x.day === '2026-10-02')).toEqual({ day: '2026-10-02', reviews: 1, again: 1, timeMs: 5000 })
    expect(d.activity.streak).toEqual({ current: 1, longest: 2, studiedToday: false })
    expect(d.retention).toEqual({ forward: { rate: null, reviews: 0 }, reverse: { rate: 0.5, reviews: 2 } })
    expect(d.coverage.slice(0, 3)).toEqual([
      { from: 1, to: 1000, words: 2, known: 1 },
      { from: 1001, to: 2000, words: 0, known: 0 },
      { from: 2001, to: 5000, words: 1, known: 1 },
    ])
    expect(d.vocabulary.current).toMatchObject({ estimate: null, adjusted: 2, srsKnown: 2, basis: 'app', nativeEquivalent: { value: 3 } })

    // Without the reverse direction only "house" is known, and nothing is mastered.
    updateDeck(ctx.db, ctx.user.id, deck.id, { reverseEnabled: false })
    const off = dashboard(ctx.db, ctx.user.id, { ...deck, reverseEnabled: false }, ctx.lexicon, TZ, ctx.now())
    expect(off.counts).toMatchObject({ known: 1, mastered: 1, directions: { reverse: { enabled: false } } })
    expect(off.growth.at(-1)!.known).toBe(1)
  })
})
