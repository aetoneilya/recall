import { describe, expect, it } from 'vitest'
import { addWords, createWord, defaultDeck, DuplicateWordError, refreshFreqRanks, searchWords, setWordStatus, updateWord } from '../src/repo.ts'
import { wordLogs } from '../src/study.ts'
import { addWord, cardsOf, makeCtx, rate } from './helpers.ts'

describe('words', () => {
  it('creates a word with two new cards and a frequency rank', () => {
    const ctx = makeCtx()
    const w = addWord(ctx, ' to  frown ', { pos: 'verb', translations: ['хмуриться', ' морщить лоб '], ipa: '/fraʊn/', cefr: 'B2', tags: ['book'] })
    expect(w).toMatchObject({ term: 'to frown', pos: 'verb', translations: ['хмуриться', 'морщить лоб'], ipa: 'fraʊn', cefr: 'B2', freqRank: 2500, status: 'active', createdBy: 'user', examples: [], note: null })
    expect(cardsOf(ctx, w.id).map((c) => [c.direction, c.schedule.state])).toEqual([['forward', 0], ['reverse', 0]])
    // Multi-word terms take their rarest component; unknown components give null.
    expect(addWord(ctx, 'the bone', { pos: 'phrase' }).freqRank).toBe(1800)
    expect(addWord(ctx, 'a broken bone', { pos: 'phrase' }).freqRank).toBeNull()
    expect(addWord(ctx, 'stopping', { pos: 'verb' }).freqRank).toBe(400)
    expect(addWord(ctx, 'auction houses', { pos: 'phrase' }).freqRank).toBe(6500)
    expect(addWord(ctx, 'zzyzx').freqRank).toBeNull()
  })

  it('dedupes on (normalised term, part of speech) and keeps cards and history on edits', () => {
    const ctx = makeCtx()
    const w = addWord(ctx, 'to frown', { pos: 'verb' })
    expect(() => addWord(ctx, 'Frown', { pos: 'verb' })).toThrow(DuplicateWordError)
    try {
      addWord(ctx, 'frown ', { pos: 'verb' })
    } catch (e) {
      expect((e as DuplicateWordError).status).toBe(409)
      expect((e as DuplicateWordError).existing.id).toBe(w.id)
    }
    // Another part of speech is another word.
    const noun = addWord(ctx, 'frown', { pos: 'noun' })

    const [fwd] = cardsOf(ctx, w.id)
    rate(ctx, fwd!.id, 3, ctx.now())
    const edited = updateWord(ctx.db, ctx.user.id, w.id, { translations: ['хмуриться', 'насупиться'], examples: [{ text: 'She frowned.' }], note: 'frown at smb' }, ctx.now())
    expect(edited).toMatchObject({ term: 'to frown', translations: ['хмуриться', 'насупиться'], examples: [{ text: 'She frowned.', translation: null }], note: 'frown at smb' })
    expect(cardsOf(ctx, w.id)[0]!.schedule.reps).toBe(1)
    expect(wordLogs(ctx.db, ctx.user.id, w.id)).toHaveLength(1)
    // Clearing with null; renaming onto another word's key is a duplicate.
    expect(updateWord(ctx.db, ctx.user.id, w.id, { note: null }, ctx.now()).note).toBeNull()
    expect(() => updateWord(ctx.db, ctx.user.id, noun.id, { pos: 'verb' }, ctx.now())).toThrow(DuplicateWordError)
    expect(() => updateWord(ctx.db, ctx.user.id, w.id, { translations: [' '] }, ctx.now())).toThrow(/at least one translation/)
    expect(setWordStatus(ctx.db, ctx.user.id, w.id, 'rejected', ctx.now()).status).toBe('rejected')
  })

  it('adds batches to the inbox, reporting duplicates with what differs', () => {
    const ctx = makeCtx()
    const existing = addWord(ctx, 'bid', { translations: ['ставка'], ipa: 'bɪd' })
    const r = addWords(ctx.db, ctx.user.id, {
      createdBy: 'claude',
      words: [
        { term: 'to frown', pos: 'verb', translations: ['хмуриться'] },
        { term: 'bid', pos: 'noun', translations: ['ставка', 'заявка'], ipa: 'bɪd', examples: [{ text: 'A high bid.' }] },
        { term: 'frown', pos: 'verb', translations: ['хмуриться'] },
        { term: '', pos: 'noun', translations: ['x'] },
      ],
    }, ctx.now(), ctx.lexicon)
    expect(r.deck.name).toBe('English')
    expect(r.created).toMatchObject([{ index: 0, term: 'to frown', status: 'inbox', freqRank: 2500 }])
    expect(r.duplicates).toEqual([
      { index: 1, existingId: existing.id, existingStatus: 'active', term: 'bid', pos: 'noun', differs: { newTranslations: ['заявка'], newExamples: [{ text: 'A high bid.', translation: null }] } },
      { index: 2, existingId: r.created[0]!.id, existingStatus: 'inbox', term: 'to frown', pos: 'verb', differs: { term: { existing: 'to frown', proposed: 'frown' } } },
    ])
    expect(r.errors).toEqual([{ index: 3, term: '', error: 'term is empty' }])
    expect(() => addWords(ctx.db, ctx.user.id, { deck: 'Klingon', createdBy: 'claude', words: [] }, ctx.now())).toThrow(/no deck/)
  })

  it('searches, filters and sorts with per-direction card summaries', () => {
    const ctx = makeCtx()
    const a = addWord(ctx, 'house', { at: new Date('2026-10-01T00:00:00Z'), cefr: 'A1' })
    const b = addWord(ctx, 'auction', { at: new Date('2026-10-02T00:00:00Z'), translations: ['аукцион'], cefr: 'B2' })
    addWord(ctx, 'zzyzx', { at: new Date('2026-10-03T00:00:00Z'), pos: 'other' })
    ctx.db.prepare("UPDATE cards SET lapses = 3, state = 2, stability = 2, last_review = '2026-10-20T09:00:00.000Z' WHERE word_id = ? AND direction = 'reverse'").run(b.id)
    const terms = (s: object) => searchWords(ctx.db, ctx.user.id, s, ctx.now()).words.map((w) => w.term)
    expect(terms({})).toEqual(['zzyzx', 'auction', 'house'])
    expect(terms({ sort: 'alpha' })).toEqual(['auction', 'house', 'zzyzx'])
    expect(terms({ sort: 'freq' })).toEqual(['house', 'auction', 'zzyzx'])
    expect(terms({ sort: 'difficulty' })[0]).toBe('auction')
    expect(terms({ q: 'аукц' })).toEqual(['auction'])
    expect(terms({ cefr: 'A1' })).toEqual(['house'])
    expect(terms({ pos: 'other' })).toEqual(['zzyzx'])
    expect(terms({ deck: 'en' })).toHaveLength(3)
    const r = searchWords(ctx.db, ctx.user.id, { q: 'auction' }, ctx.now())
    expect(r.total).toBe(1)
    expect(r.words[0]!.cards.forward).toMatchObject({ state: 'new', enabled: true, retrievability: null })
    expect(r.words[0]!.cards.reverse).toMatchObject({ state: 'review', lapses: 3, stability: 2 })
    expect(r.words[0]!.cards.reverse!.retrievability).toBeGreaterThan(0.5)
    expect(a.freqRank).toBe(150)
  })

  it('refreshes frequency ranks when the list changes', () => {
    const ctx = makeCtx()
    const w = createWord(ctx.db, ctx.user.id, { deckId: defaultDeck(ctx.db, ctx.user.id, ctx.now()).id, word: { term: 'frown', pos: 'verb', translations: ['x'] }, status: 'active', createdBy: 'user' }, ctx.now())
    expect(w.freqRank).toBeNull()
    expect(refreshFreqRanks(ctx.db, ctx.lexicon)).toBe(1)
    expect(searchWords(ctx.db, ctx.user.id, {}, ctx.now()).words[0]!.freqRank).toBe(2500)
  })
})
