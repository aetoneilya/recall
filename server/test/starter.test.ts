// Starter word sets (pack format "words"): validation, adding into the
// English deck as words with both cards (tagged Starter/<level>, deduped like
// add_words, idempotent by import ref, introduced in file order), listing,
// and the route.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_DATA_DIR } from '../src/config.ts'
import { packLoader, parsePack, setPacks, usePackDir } from '../src/pack-data.ts'
import { addPack, listPacks } from '../src/packs.ts'
import { createDeck, searchWords } from '../src/repo.ts'
import { buildQueue } from '../src/study.ts'
import { addWord, deck, listen, makeCtx, send, TZ, wordOf, type TestCtx } from './helpers.ts'

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'starter-test.json')
const fixture = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { items: Record<string, unknown>[] } & Record<string, unknown>
const load = (over: (d: ReturnType<typeof fixture>) => void = () => {}) => {
  const d = fixture()
  over(d)
  return parsePack(d)
}
const refs = (ctx: TestCtx) => (ctx.db.prepare('SELECT import_ref FROM words WHERE import_ref IS NOT NULL ORDER BY created_at').all() as { import_ref: string }[]).map((r) => r.import_ref)

afterEach(() => usePackDir(DEFAULT_DATA_DIR))

describe('the words format', () => {
  it('reads a starter set: level, cleaned words in file order', () => {
    const p = load()
    expect(p).toMatchObject({ id: 'starter-a1', name: 'Starter words A1', kind: 'topic', format: 'words', level: 'A1', facts: [] })
    expect(p.words!.map((w) => [w.word.term, w.word.pos, w.rank])).toEqual([['house', 'noun', 150], ['to eat', 'verb', 300], ['happy', 'adjective', 600], ['to get up', 'phrasal_verb', 800]])
    // IPA delimiters go, as for any word.
    expect(p.words![0]!.word).toMatchObject({ ipa: 'haʊs', translations: ['дом'], examples: [{ text: 'Our house is small.', translation: 'Наш дом маленький.' }], cefr: 'A1', note: null })
  })

  it('refuses a broken file, saying what is wrong', () => {
    expect(() => load((d) => (d.level = 'D1'))).toThrow(/level must be one of/)
    expect(() => load((d) => delete d.level)).toThrow(/level/)
    expect(() => load((d) => (d.items[1]!.term = 'eat'))).toThrow(/item 1 \(eat\): a verb is written "to eat"/)
    expect(() => load((d) => (d.items[0]!.pos = 'thing'))).toThrow(/item 0 \(house\): unknown part of speech thing/)
    expect(() => load((d) => (d.items[2]!.translations = []))).toThrow(/item 2 \(happy\): at least one translation/)
    expect(() => load((d) => (d.items[0]!.cefr = 'Z9'))).toThrow(/unknown CEFR level/)
    expect(() => load((d) => (d.items[0]!.rank = 'often'))).toThrow(/rank must be a number/)
    // "to eat" and "eat" are one word to the dedupe key.
    expect(() => load((d) => d.items.push({ ...d.items[1]!, term: 'To  eat' }))).toThrow(/"To eat" \(verb\) appears twice \(also as "to eat"\)/)
  })

  it('a broken file is logged and skipped; the others load', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packs-'))
    fs.mkdirSync(path.join(dir, 'packs'))
    fs.copyFileSync(FIXTURE, path.join(dir, 'packs', 'starter-a1.json'))
    const broken = fixture()
    broken.id = 'starter-a2'
    broken.items[1]!.term = 'eat'
    fs.writeFileSync(path.join(dir, 'packs', 'starter-a2.json'), JSON.stringify(broken))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      expect(packLoader(dir)().map((p) => p.id)).toEqual(['starter-a1'])
      expect(err).toHaveBeenCalledWith('cannot load pack starter-a2.json: item 1 (eat): a verb is written "to eat"')
      expect(log).toHaveBeenCalledWith('loaded packs: starter-a1 (4)')
    } finally {
      err.mockRestore()
      log.mockRestore()
    }
  })
})

describe('adding a starter set', () => {
  it('adds active words with both cards to the English deck, tagged, in file order, deduped, once', () => {
    const ctx = makeCtx()
    setPacks([load()])
    const en = deck(ctx, 0)
    // A word the deck has already (dropped, even) counts as a duplicate.
    addWord(ctx, 'happy', { pos: 'adjective', status: 'rejected' })
    expect(listPacks(ctx.db, ctx.user.id)).toEqual([{
      id: 'starter-a1', name: 'Starter words A1', description: 'A tiny invented set for the tests.', format: 'words', level: 'A1',
      count: 4, added: false, missing: 3, deckId: en.id, deckName: 'English',
    }])

    const r = addPack(ctx.db, ctx.user.id, 'starter-a1', ctx.now(), { lex: ctx.lexicon })
    expect(r).toMatchObject({ deck: { id: en.id }, added: 3, alreadyAdded: 0, duplicates: 1, exercises: 0 })
    const words = searchWords(ctx.db, ctx.user.id, { status: 'active', sort: 'recent' }, ctx.now()).words
    expect(words.map((w) => [w.term, w.status, w.createdBy, w.tags]).sort()).toEqual([
      ['house', 'active', 'import', ['Starter/A1']], ['to eat', 'active', 'import', ['Starter/A1']], ['to get up', 'active', 'import', ['Starter/A1']],
    ])
    expect(words.every((w) => w.cards.forward && w.cards.reverse)).toBe(true)
    // The frequency rank comes from the list, as for any word.
    expect(words.find((w) => w.term === 'house')!.freqRank).toBe(150)
    // The import ref is the item's place in the file; created a millisecond apart.
    expect(refs(ctx)).toEqual(['pack:starter-a1:0', 'pack:starter-a1:1', 'pack:starter-a1:3'])
    const times = (ctx.db.prepare('SELECT created_at FROM words WHERE import_ref IS NOT NULL ORDER BY created_at').all() as { created_at: string }[]).map((x) => Date.parse(x.created_at))
    expect(times.map((t) => t - times[0]!)).toEqual([0, 1, 2])

    // The daily curriculum picks two of the pack's words, one direction
    // per word. Reopening keeps the choice; storage still keeps file order.
    ctx.db.prepare('UPDATE decks SET new_per_day = 2 WHERE id = ?').run(en.id)
    const queued = buildQueue(ctx.db, ctx.user.id, TZ, ctx.now()).items
    expect(queued).toHaveLength(2)
    expect(new Set(queued.map((it) => wordOf(it).id)).size).toBe(2)
    expect(queued.every((it) => it.card.direction === 'forward' && wordOf(it).tags.includes('Starter/A1'))).toBe(true)
    expect(buildQueue(ctx.db, ctx.user.id, TZ, ctx.now()).items.map((it) => it.card.id)).toEqual(queued.map((it) => it.card.id))

    expect(listPacks(ctx.db, ctx.user.id)[0]).toMatchObject({ added: true, missing: 0, deckId: en.id })
    expect(addPack(ctx.db, ctx.user.id, 'starter-a1', ctx.now())).toMatchObject({ added: 0, alreadyAdded: 3, duplicates: 1 })

    // The set grows: only the new word comes, after the others.
    setPacks([load((d) => d.items.push({ term: 'window', pos: 'noun', translations: ['окно'], ipa: 'ˈwɪndoʊ', examples: [], cefr: 'A1', note: null, rank: 900 }))])
    expect(listPacks(ctx.db, ctx.user.id)[0]).toMatchObject({ count: 5, added: true, missing: 1 })
    ctx.clock.t = new Date(ctx.now().getTime() + 60_000)
    expect(addPack(ctx.db, ctx.user.id, 'starter-a1', ctx.now())).toMatchObject({ added: 1, alreadyAdded: 3, duplicates: 1 })
    expect(refs(ctx).at(-1)).toBe('pack:starter-a1:4')
  })

  it('goes into a chosen deck with languages, not into one without', () => {
    const ctx = makeCtx()
    setPacks([load()])
    deck(ctx)
    const other = createDeck(ctx.db, ctx.user.id, { name: 'English 2', targetLang: 'es', nativeLang: 'ru' }, ctx.now())
    const plain = createDeck(ctx.db, ctx.user.id, { name: 'Notes' }, ctx.now())
    expect(() => addPack(ctx.db, ctx.user.id, 'starter-a1', ctx.now(), { deckId: plain.id })).toThrow(/languages/)
    expect(addPack(ctx.db, ctx.user.id, 'starter-a1', ctx.now(), { deckId: other.id })).toMatchObject({ deck: { id: other.id }, added: 4 })
    // Later adds go where its words are.
    expect(listPacks(ctx.db, ctx.user.id)[0]).toMatchObject({ deckId: other.id, deckName: 'English 2' })
  })

  it('creates the English deck for a new account', () => {
    const ctx = makeCtx()
    setPacks([load()])
    expect(listPacks(ctx.db, ctx.user.id)[0]).not.toHaveProperty('deckId')
    expect(addPack(ctx.db, ctx.user.id, 'starter-a1', ctx.now())).toMatchObject({ deck: { name: 'English', targetLang: 'en' }, added: 4 })
  })
})

describe('the starter route', () => {
  let ctx: TestCtx
  let url: string
  let close: () => Promise<void>
  beforeAll(async () => {
    ctx = makeCtx({ DEV: '1', OWNER_TELEGRAM_ID: '1001' })
    const s = await listen(ctx)
    url = s.url
    close = s.close
  })
  afterAll(() => close())

  it('lists and adds it like any pack', async () => {
    setPacks([load()])
    const list = (await (await fetch(`${url}/api/packs`)).json()) as { packs: unknown[] }
    expect(list.packs[0]).toMatchObject({ id: 'starter-a1', format: 'words', level: 'A1', count: 4, added: false })
    const r = await send(`${url}/api/packs/starter-a1`, 'POST', {})
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ added: 4, deck: { name: 'English' }, packs: [{ id: 'starter-a1', added: true, missing: 0 }] })
  })
})
