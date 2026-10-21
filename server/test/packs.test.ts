// Content packs: the bundled file, validation, adding a pack (idempotent, in
// pack order in the queue), and irregular-verb forms on word items.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_DATA_DIR } from '../src/config.ts'
import { createFact, searchFacts } from '../src/facts.ts'
import { formsLine } from '@recall/core'
import { currentPacks, irregularVerbFact, packLoader, parsePack, setPacks, usePackDir, verbForms } from '../src/pack-data.ts'
import { addPack, listPacks } from '../src/packs.ts'
import { createTopicDeck, searchWords, updateDeck } from '../src/repo.ts'
import { buildQueue } from '../src/study.ts'
import { addWord, callTool, deck, listen, makeCtx, send, TZ, type TestCtx } from './helpers.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const verb = (v: string, past: string[], participle: string[], rank = 1) => ({
  verb: v, past, participle, translation: `${v} ru`, example: { text: `They ${past[0]} it.`, translation: 'Пример.' }, note: null, rank,
})
const pack = (items: unknown[], extra: object = {}) => ({ id: 'irregular-verbs', name: 'Irregular verbs', description: 'd', kind: 'topic', format: 'irregular-verbs', items, ...extra })

afterEach(() => usePackDir(DEFAULT_DATA_DIR))

describe('pack data', () => {
  it('loads the bundled irregular verbs pack', () => {
    const [p] = currentPacks()
    expect(p).toMatchObject({ id: 'irregular-verbs', name: 'Irregular verbs', kind: 'topic', format: 'irregular-verbs' })
    expect(p!.facts).toHaveLength(159)
    expect(p!.facts[0]).toEqual({
      key: 'be',
      front: '**to be**\nбыть, находиться',
      back: '**was / were · been**\n\n*We were at home all evening.*\nМы весь вечер были дома.\n\nwas — с I/he/she/it, were — с you/we/they',
      tags: [],
    })
  })

  it('renders variants and leaves out a missing note', () => {
    const f = irregularVerbFact(verb('learn', ['learned', 'learnt'], ['learned', 'learnt']))
    expect(f.back).toBe('**learned / learnt · learned / learnt**\n\n*They learned it.*\nПример.')
    expect(formsLine({ past: ['got'], participle: ['gotten', 'got'] })).toBe('got · gotten / got')
  })

  it('validates the shape and refuses Markdown in the data', () => {
    expect(() => parsePack(pack([verb('begin', ['began'], ['begun'])]))).not.toThrow()
    expect(() => parsePack(pack([verb('begin', ['began'], ['begun'])], { id: 'Bad Id' }))).toThrow(/id/)
    expect(() => parsePack(pack([verb('begin', ['began'], ['begun'])], { kind: 'language' }))).toThrow(/kind/)
    expect(() => parsePack(pack([verb('begin', ['began'], ['begun'])], { format: 'csv' }))).toThrow(/format/)
    expect(() => parsePack(pack([]))).toThrow(/non-empty/)
    expect(() => parsePack(pack([verb('begin', [], ['begun'])]))).toThrow(/item 0 \(begin\): past/)
    expect(() => parsePack(pack([verb('begin', ['began'], ['begun']), verb('begin', ['began'], ['begun'])]))).toThrow(/twice/)
    expect(() => parsePack(pack([{ ...verb('begin', ['began'], ['begun']), note: 'a *star*' }]))).toThrow(/Markdown/)
    // Generic facts packs.
    expect(parsePack({ id: 'sql', name: 'SQL', kind: 'topic', format: 'facts', items: [{ key: 'join', front: 'What is a JOIN?', back: 'Rows from two tables.' }] }).facts)
      .toEqual([{ key: 'join', front: 'What is a JOIN?', back: 'Rows from two tables.', tags: [] }])
    expect(() => parsePack({ id: 'sql', name: 'SQL', kind: 'topic', format: 'facts', items: [{ front: 'Q' }] })).toThrow(/key, front and back/)
  })

  it('skips a broken file in the packs folder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-packs-'))
    fs.mkdirSync(path.join(dir, 'packs'))
    fs.writeFileSync(path.join(dir, 'packs', 'a.json'), JSON.stringify(pack([verb('begin', ['began'], ['begun'])])))
    fs.writeFileSync(path.join(dir, 'packs', 'b.json'), '{ not json')
    expect(packLoader(dir)().map((p) => p.id)).toEqual(['irregular-verbs'])
    expect(packLoader(path.join(dir, 'nowhere'))()).toEqual([])
    fs.rmSync(dir, { recursive: true })
  })
})

describe('verb forms', () => {
  it('derives forms for irregular verbs only, by lemma', () => {
    expect(verbForms('to be', 'verb')).toEqual({ past: ['was', 'were'], participle: ['been'] })
    expect(verbForms('get', 'verb')).toEqual({ past: ['got'], participle: ['gotten', 'got'] })
    expect(verbForms('To Begin', 'verb')).toEqual({ past: ['began'], participle: ['begun'] })
    expect(verbForms('to frown', 'verb')).toBeNull()
    expect(verbForms('lead', 'noun')).toBeNull()
    expect(verbForms('to lead', 'verb')).toEqual({ past: ['led'], participle: ['led'] })
    expect(verbForms('to give up', 'phrasal_verb')).toEqual({ past: ['gave up'], participle: ['given up'] })
    expect(verbForms('to give up', 'verb')).toBeNull()
  })

  it('puts them on word items and queue items, not in the database', () => {
    const ctx = makeCtx()
    deck(ctx, 5)
    const begin = addWord(ctx, 'to begin', { pos: 'verb' })
    addWord(ctx, 'lead', { pos: 'noun' })
    addWord(ctx, 'to frown', { pos: 'verb' })
    expect(begin.forms).toEqual({ past: ['began'], participle: ['begun'] })
    const items = searchWords(ctx.db, ctx.user.id, { sort: 'alpha' }, ctx.now()).words
    expect(items.map((w) => [w.term, w.forms ?? null])).toEqual([['lead', null], ['to begin', { past: ['began'], participle: ['begun'] }], ['to frown', null]])
    const q = buildQueue(ctx.db, ctx.user.id, TZ, ctx.now()).items
    expect(q.find((i) => i.kind === 'word' && i.word.term === 'to begin')).toMatchObject({ word: { forms: { participle: ['begun'] } } })
    expect(Object.keys(ctx.db.prepare('SELECT * FROM words LIMIT 1').get() as object)).not.toContain('forms')
    // Without the pack there are none.
    setPacks([])
    expect(searchWords(ctx.db, ctx.user.id, { q: 'begin' }, ctx.now()).words[0]!.forms).toBeUndefined()
  })
})

describe('adding a pack', () => {
  it('creates the topic deck and its facts, in pack order in the queue, and adds only what is missing on a rerun', () => {
    const ctx = makeCtx()
    deck(ctx, 0)
    const small = parsePack(pack([verb('be', ['was', 'were'], ['been']), verb('have', ['had'], ['had']), verb('do', ['did'], ['done']), verb('say', ['said'], ['said'])]))
    setPacks([small])
    expect(listPacks(ctx.db, ctx.user.id)).toEqual([{ id: 'irregular-verbs', name: 'Irregular verbs', description: 'd', count: 4, added: false, missing: 4 }])

    const r = addPack(ctx.db, ctx.user.id, 'irregular-verbs', ctx.now())
    expect(r).toMatchObject({ deck: { kind: 'topic', name: 'Irregular verbs', newPerDay: 5, inReview: true }, added: 4, alreadyAdded: 0, duplicates: 0 })
    const facts = searchFacts(ctx.db, ctx.user.id, {}, ctx.now()).facts
    expect(facts.map((f) => [f.front.split('\n')[0], f.status, f.createdBy, f.tags])).toEqual([
      ['**to be**', 'active', 'import', []], ['**to have**', 'active', 'import', []],
      ['**to do**', 'active', 'import', []], ['**to say**', 'active', 'import', []],
    ])
    expect(ctx.db.prepare('SELECT import_ref FROM facts ORDER BY created_at').all()).toEqual(['be', 'have', 'do', 'say'].map((v) => ({ import_ref: `pack:irregular-verbs:${v}` })))
    // New cards come most frequent first, whatever the ids say.
    const order = () => buildQueue(ctx.db, ctx.user.id, TZ, ctx.now()).items.map((i) => (i.kind === 'fact' ? i.fact.front.split('\n')[0] : ''))
    expect(order()).toEqual(['**to be**', '**to have**', '**to do**', '**to say**'])
    updateDeck(ctx.db, ctx.user.id, r.deck.id, { newPerDay: 2 })
    expect(order()).toEqual(['**to be**', '**to have**'])
    expect(listPacks(ctx.db, ctx.user.id)[0]).toMatchObject({ added: true, missing: 0, deckId: r.deck.id })

    // The pack grows; the deck was renamed meanwhile: new items join the same deck.
    updateDeck(ctx.db, ctx.user.id, r.deck.id, { name: 'Verbs' })
    setPacks([parsePack(pack([...['be', 'have', 'do', 'say'].map((v) => verb(v, ['x'], ['y'])), verb('go', ['went'], ['gone'])]))])
    expect(listPacks(ctx.db, ctx.user.id)[0]).toMatchObject({ added: true, missing: 1 })
    ctx.clock.t = new Date(ctx.now().getTime() + 60_000)
    expect(addPack(ctx.db, ctx.user.id, 'irregular-verbs', ctx.now())).toMatchObject({ deck: { id: r.deck.id }, added: 1, alreadyAdded: 4 })
    expect(addPack(ctx.db, ctx.user.id, 'irregular-verbs', ctx.now())).toMatchObject({ added: 0, alreadyAdded: 5 })
    expect(searchFacts(ctx.db, ctx.user.id, {}, ctx.now()).total).toBe(5)
    expect(() => addPack(ctx.db, ctx.user.id, 'nope', ctx.now())).toThrow(/no pack/)
  })

  it('fills an existing topic deck of that name, skipping questions it has', () => {
    const ctx = makeCtx()
    setPacks([parsePack(pack([verb('be', ['was', 'were'], ['been']), verb('go', ['went'], ['gone'])]))])
    const t = createTopicDeck(ctx.db, ctx.user.id, { name: 'irregular verbs' }, ctx.now())
    createFact(ctx.db, ctx.user.id, { deckId: t.id, fact: { front: '**to go**\ngo ru', back: 'went, gone' }, status: 'active', createdBy: 'user' }, ctx.now())
    const r = addPack(ctx.db, ctx.user.id, 'irregular-verbs', ctx.now())
    expect(r).toMatchObject({ deck: { id: t.id }, added: 1, duplicates: 1 })
  })
})

describe('pack routes and tools', () => {
  let ctx: TestCtx
  let url: string
  let close: () => Promise<void>
  beforeAll(async () => {
    ctx = makeCtx({ DEV: '1', OWNER_TELEGRAM_ID: '1001', MCP_TOKEN: 'static-mcp-token' })
    const s = await listen(ctx)
    url = s.url
    close = s.close
  })
  afterAll(async () => close())

  it('lists and adds packs over REST and MCP', async () => {
    const list = (await (await fetch(`${url}/api/packs`)).json()) as any
    expect(list.packs).toEqual([expect.objectContaining({ id: 'irregular-verbs', name: 'Irregular verbs', count: 159, added: false, missing: 159 })])
    const added = (await (await send(`${url}/api/packs/irregular-verbs`, 'POST', {})).json()) as any
    expect(added).toMatchObject({ added: 159, deck: { name: 'Irregular verbs' }, packs: [{ added: true, missing: 0 }] })
    expect((await send(`${url}/api/packs/nope`, 'POST', {})).status).toBe(404)
    expect(await callTool(url, 'static-mcp-token', 'list_packs')).toEqual([expect.objectContaining({ id: 'irregular-verbs', added: true, deckId: added.deck.id })])
    expect(await callTool(url, 'static-mcp-token', 'add_pack', { id: 'irregular-verbs' })).toMatchObject({ added: 0, alreadyAdded: 159 })
    // First thing in the session: the most frequent verb.
    const q = (await (await fetch(`${url}/api/queue`)).json()) as any
    expect(q.items[0]).toMatchObject({ kind: 'fact', fact: { front: '**to be**\nбыть, находиться' } })
    expect(q.items.filter((i: any) => i.kind === 'fact').length).toBe(5)
  })
})
