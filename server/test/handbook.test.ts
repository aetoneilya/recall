// The grammar handbook pack: its format, the build script, adding it (rules
// with pools, theory cards, write items topped up to two; idempotent by
// import ref) and the handbook read API. Fixtures are invented test topics.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { buildHandbook } from '../data/packs/build-grammar-handbook.ts'
import { DEFAULT_DATA_DIR } from '../src/config.ts'
import { listExercises } from '../src/exercises.ts'
import { createFact, factItem, handbookRef, searchFacts } from '../src/facts.ts'
import { parsePack, setPacks, usePackDir, type Pack } from '../src/pack-data.ts'
import { addPack, handbook, listPacks, topicExercises } from '../src/packs.ts'
import { createDeck } from '../src/repo.ts'
import { buildQueue } from '../src/study.ts'
import { callTool, deck, listen, makeCtx, send, TZ, type TestCtx } from './helpers.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const PARTS = [path.join(here, 'fixtures', 'handbook-part-a.json'), path.join(here, 'fixtures', 'handbook-part-b.json')]
const raw = () => JSON.parse(JSON.stringify(buildHandbook(PARTS))) as { items: Record<string, any>[] } & Record<string, unknown>
const load = (data = raw()): Pack => {
  const p = parsePack(data)
  setPacks([p])
  return p
}

afterEach(() => usePackDir(DEFAULT_DATA_DIR))

describe('grammar handbook format', () => {
  it('merges the parts and validates them', () => {
    const p = load()
    expect(p).toMatchObject({ id: 'grammar-handbook', name: 'Grammar handbook', format: 'grammar-handbook', verbs: null })
    expect(p.topics!.map((t) => [t.id, t.group, t.level, t.cards.length, t.exercises.length, t.write.length])).toEqual([
      ['third-person-s', 'Present tenses', 'A2', 3, 4, 1], ['past-simple-ed', 'Past tenses', 'A2', 3, 3, 0],
    ])
    expect(p.facts.map((f) => f.key)).toEqual([
      'third-person-s', 'third-person-s:card:0', 'third-person-s:card:1', 'third-person-s:card:2',
      'past-simple-ed', 'past-simple-ed:card:0', 'past-simple-ed:card:1', 'past-simple-ed:card:2',
    ])
    expect(p.facts[0]).toMatchObject({ front: 'Third person -s (invented test topic)', back: expect.stringMatching(/^\*\*he \/ she/), tags: ['Grammar', 'Present tenses'] })
    expect(p.facts[1]!.tags).toEqual(['Grammar theory', 'Present tenses'])

    const bad = (f: (d: ReturnType<typeof raw>) => void) => {
      const d = raw()
      f(d)
      return () => parsePack(d)
    }
    expect(bad((d) => (d.items[0]!.level = 'Z1'))).toThrow(/topic 0 \(third-person-s\): level/)
    expect(bad((d) => (d.items[0]!.cards = d.items[0]!.cards.slice(0, 2)))).toThrow(/3–6 cards/)
    expect(bad((d) => (d.items[0]!.exercises[0].type = 'gap'))).toThrow(/exercise 0 must be choose or spot/)
    expect(bad((d) => (d.items[0]!.exercises[0].answer = 'nope'))).toThrow(/exercise 0: the answer must be one of the options/)
    expect(bad((d) => d.items[0]!.exercises.push({ ...d.items[0]!.exercises[0] }))).toThrow(/repeats/)
    expect(bad((d) => (d.items[1]!.exercises = d.items[1]!.exercises.slice(0, 2)))).toThrow(/at least 3 exercises/)
    expect(bad((d) => (d.items[0]!.write = [{ prompt: '' }]))).toThrow(/write 0: the task is empty/)
    expect(bad((d) => (d.items[1]!.id = 'third-person-s'))).toThrow(/appears twice/)
    expect(bad((d) => (d.items[0]!.summary = ''))).toThrow(/summary is missing/)
  })

  const bundled = path.join(DEFAULT_DATA_DIR, 'packs', 'grammar-handbook.json')
  it.skipIf(!fs.existsSync(bundled))('loads the bundled handbook, every rule with a full pool', () => {
    const p = parsePack(JSON.parse(fs.readFileSync(bundled, 'utf8')))
    expect(p.topics!.length).toBeGreaterThan(0)
    for (const t of p.topics!) expect(topicExercises(p.id, t).filter((e) => e.type === 'write')).toHaveLength(2)
  })

  it.skipIf(!fs.existsSync(bundled))('adds the bundled handbook into a fresh English deck, once', () => {
    const p = load(JSON.parse(fs.readFileSync(bundled, 'utf8')))
    const ctx = makeCtx()
    const en = deck(ctx, 20)
    const topics = p.topics!
    const cards = topics.reduce((n, t) => n + t.cards.length, 0)
    const pool = topics.reduce((n, t) => n + topicExercises(p.id, t).length, 0)
    const r = addPack(ctx.db, ctx.user.id, 'grammar-handbook', ctx.now())
    // A question asked by two topics lands once (the deck's duplicate rule).
    expect(r).toMatchObject({ deck: { id: en.id }, exercises: pool })
    expect(r.added + r.duplicates).toBe(topics.length + cards)
    const count = (sql: string) => (ctx.db.prepare(sql).get() as { n: number }).n
    expect(count("SELECT count(*) AS n FROM facts WHERE import_ref LIKE 'pack:grammar-handbook:%:card:%'")).toBe(cards - r.duplicates)
    expect(count("SELECT count(*) AS n FROM fact_exercises WHERE type = 'write'")).toBe(topics.length * 2)
    // Every rule reviews in exercise mode; the handbook lists every topic.
    expect(handbook(ctx.db, ctx.user.id, en.id).topics).toHaveLength(topics.length)
    // Again: nothing new.
    expect(addPack(ctx.db, ctx.user.id, 'grammar-handbook', ctx.now())).toMatchObject({ added: 0, exercises: 0 })
  })

  it('is built by the script, which refuses a broken part and writes nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-handbook-'))
    const script = path.join(here, '..', 'data', 'packs', 'build-grammar-handbook.ts')
    const out = path.join(dir, 'grammar-handbook.json')
    execFileSync(process.execPath, [script, ...PARTS, out], { stdio: 'pipe' })
    expect(parsePack(JSON.parse(fs.readFileSync(out, 'utf8'))).topics).toHaveLength(2)
    const broken = path.join(dir, 'broken.json')
    fs.writeFileSync(broken, JSON.stringify([{ id: 'x' }]))
    const other = path.join(dir, 'other.json')
    expect(() => execFileSync(process.execPath, [script, PARTS[0]!, broken, other], { stdio: 'pipe' })).toThrow(/topic 1 \(x\)/)
    expect(fs.existsSync(other)).toBe(false)
    fs.rmSync(dir, { recursive: true })
  })
})

describe('adding the handbook', () => {
  const refs = (ctx: TestCtx) => (ctx.db.prepare('SELECT import_ref FROM facts ORDER BY created_at').all() as { import_ref: string }[]).map((r) => r.import_ref)

  it('makes a rule with its pool per topic and the theory cards, in file order, into the English deck', () => {
    const ctx = makeCtx()
    const p = load()
    const en = deck(ctx, 20)
    expect(listPacks(ctx.db, ctx.user.id)).toEqual([{ id: 'grammar-handbook', name: 'Grammar handbook', description: expect.any(String), count: 8, added: false, missing: 8, missingExercises: 0, deckId: en.id, deckName: 'English' }])
    const r = addPack(ctx.db, ctx.user.id, 'grammar-handbook', ctx.now())
    // 4 + 1 + 1 generated write items, 3 + 2 generated.
    expect(r).toMatchObject({ deck: { id: en.id }, added: 8, alreadyAdded: 0, duplicates: 0, exercises: 11 })
    expect(refs(ctx)).toEqual(p.facts.map((f) => `pack:grammar-handbook:${f.key}`))
    const facts = searchFacts(ctx.db, ctx.user.id, {}, ctx.now()).facts
    expect(facts.map((f) => [f.tags, f.createdBy, f.handbook])).toEqual([
      [['Grammar', 'Present tenses'], 'import', { topic: 'third-person-s', role: 'rule' }],
      ...[0, 1, 2].map(() => [['Grammar theory', 'Present tenses'], 'import', { topic: 'third-person-s', role: 'card' }]),
      [['Grammar', 'Past tenses'], 'import', { topic: 'past-simple-ed', role: 'rule' }],
      ...[0, 1, 2].map(() => [['Grammar theory', 'Past tenses'], 'import', { topic: 'past-simple-ed', role: 'card' }]),
    ])
    const pool = listExercises(ctx.db, ctx.user.id, facts[0]!.id)
    expect(pool.map((e) => e.type)).toEqual(['choose', 'choose', 'spot', 'choose', 'write', 'write'])
    expect(pool.slice(4).map((e) => [e.prompt, e.rubric])).toEqual([
      ['Напиши тестовое предложение о соседе в present simple.', 'Subject he/she + verb with -s.'],
      ['Напиши предложение, где нужно правило «Third person -s (invented test topic)».', 'Используй правило «Third person -s (invented test topic)» правильно.'],
    ])
    expect(ctx.db.prepare('SELECT import_ref FROM fact_exercises WHERE fact_id = ? ORDER BY rowid').all(facts[4]!.id)).toEqual(
      ['ex:0', 'ex:1', 'ex:2', 'write:0', 'write:1'].map((x) => ({ import_ref: `pack:grammar-handbook:past-simple-ed:${x}` })),
    )
    expect(listExercises(ctx.db, ctx.user.id, facts[4]!.id).filter((e) => e.type === 'write').map((e) => e.prompt)).toEqual([
      'Напиши предложение, где нужно правило «Past simple -ed (invented test topic)».', 'Напиши вопрос или отрицание, где нужно правило «Past simple -ed (invented test topic)».',
    ])
    // The rules review as rules; new cards come in file order.
    const q = buildQueue(ctx.db, ctx.user.id, TZ, ctx.now()).items
    expect(q.map((i) => (i.kind === 'fact' ? i.fact.id : ''))).toEqual(facts.map((f) => f.id))
    expect(q[0]).toMatchObject({ kind: 'fact', exercises: [{}, {}, {}] })
    expect(factItem(ctx.db, ctx.user.id, facts[1]!.id, ctx.now()).exercises).toBeUndefined()
  })

  it('adds only what is missing on a rerun, new exercises of old topics included', () => {
    const ctx = makeCtx()
    load()
    const en = deck(ctx)
    addPack(ctx.db, ctx.user.id, 'grammar-handbook', ctx.now())
    expect(addPack(ctx.db, ctx.user.id, 'grammar-handbook', ctx.now())).toMatchObject({ added: 0, alreadyAdded: 8, exercises: 0 })
    const d = raw()
    d.items[1]!.exercises.push({ type: 'choose', text: 'They ___ home late.', options: ['walked', 'walk'], answer: 'walked' })
    d.items.push({ ...d.items[1], id: 'third-topic', title: 'A third invented topic', cards: d.items[1]!.cards.map((c: any) => ({ ...c, front: `${c.front} (3)` })) })
    load(d)
    expect(listPacks(ctx.db, ctx.user.id)[0]).toMatchObject({ added: true, missing: 4, missingExercises: 1 })
    ctx.clock.t = new Date(ctx.now().getTime() + 60_000)
    // A grown pack: the new topic (4 facts, 4 + 2 items) and the new item of an old one.
    expect(addPack(ctx.db, ctx.user.id, 'grammar-handbook', ctx.now())).toMatchObject({ deck: { id: en.id }, added: 4, alreadyAdded: 8, exercises: 7 })
    expect(listPacks(ctx.db, ctx.user.id)[0]).toMatchObject({ missing: 0, missingExercises: 0 })
    // A flagged item stays out of the pool, and isn't re-added.
    const rule = searchFacts(ctx.db, ctx.user.id, { q: 'Past simple -ed' }, ctx.now()).facts.find((f) => f.handbook?.role === 'rule')!
    ctx.db.prepare("UPDATE fact_exercises SET status = 'flagged' WHERE fact_id = ? AND import_ref LIKE '%:ex:0'").run(rule.id)
    expect(addPack(ctx.db, ctx.user.id, 'grammar-handbook', ctx.now())).toMatchObject({ added: 0, exercises: 0 })
  })

  it('tops write items up to two, keeping the file\'s', () => {
    const p = load()
    const t = { ...p.topics![0]!, write: [...p.topics![0]!.write, p.topics![0]!.write[0]!, p.topics![0]!.write[0]!] }
    expect(topicExercises('grammar-handbook', t).filter((e) => e.type === 'write')).toHaveLength(3)
    expect(topicExercises('grammar-handbook', { ...t, write: [] }).filter((e) => e.type === 'write').map((e) => e.importRef)).toEqual([
      'pack:grammar-handbook:third-person-s:write:0', 'pack:grammar-handbook:third-person-s:write:1',
    ])
  })
})

describe('handbook API', () => {
  it('lists the topics a deck holds and the user\'s own rules', () => {
    const ctx = makeCtx()
    load()
    const en = deck(ctx)
    const own = createFact(ctx.db, ctx.user.id, { deckId: en.id, fact: { front: 'My own rule', back: 'Mine.', tags: ['Grammar'] }, status: 'active', createdBy: 'user' }, ctx.now()).fact
    createFact(ctx.db, ctx.user.id, { deckId: en.id, fact: { front: 'Not grammar', back: 'x' }, status: 'active', createdBy: 'user' }, ctx.now())
    expect(handbook(ctx.db, ctx.user.id, en.id)).toEqual({ topics: [], mine: [{ factId: own.id, title: 'My own rule', rule: 'Mine.', exercises: 0 }] })
    addPack(ctx.db, ctx.user.id, 'grammar-handbook', ctx.now())
    const facts = searchFacts(ctx.db, ctx.user.id, { tag: 'Grammar' }, ctx.now()).facts.filter((f) => f.handbook)
    const cards = searchFacts(ctx.db, ctx.user.id, { tag: 'Grammar theory' }, ctx.now()).facts
    const h = handbook(ctx.db, ctx.user.id, en.id)
    expect(h.topics).toEqual([
      {
        id: 'third-person-s', group: 'Present tenses', title: 'Third person -s (invented test topic)', level: 'A2', summary: expect.stringMatching(/^\*\*he/),
        ruleFactId: facts[0]!.id, cardFactIds: cards.slice(0, 3).map((c) => c.id), exercises: 6,
      },
      { id: 'past-simple-ed', group: 'Past tenses', title: 'Past simple -ed (invented test topic)', level: 'A2', summary: expect.any(String), ruleFactId: facts[1]!.id, cardFactIds: cards.slice(3).map((c) => c.id), exercises: 5 },
    ])
    expect(h.mine.map((m) => m.factId)).toEqual([own.id])
    // Another deck has none; without the pack file the facts still tell.
    expect(handbook(ctx.db, ctx.user.id, createDeck(ctx.db, ctx.user.id, { name: 'Other' }, ctx.now()).id).topics).toEqual([])
    setPacks([])
    expect(handbook(ctx.db, ctx.user.id, en.id).topics[1]).toMatchObject({ id: 'past-simple-ed', group: 'Past tenses', title: 'Past simple -ed (invented test topic)', level: '', summary: expect.stringMatching(/Regular verbs/) })
    expect(handbookRef('pack:grammar-handbook:x:ex:1')).toBeNull()
    expect(handbookRef('pack:irregular-verbs:be')).toBeNull()
  })

  it('is a route; MCP adds the pack and write items', async () => {
    const ctx = makeCtx({ DEV: '1', OWNER_TELEGRAM_ID: '1001', MCP_TOKEN: 'static-mcp-token' })
    load()
    const s = await listen(ctx)
    try {
      const en = deck(ctx)
      expect(await callTool(s.url, 'static-mcp-token', 'add_pack', { id: 'grammar-handbook' })).toEqual({ deck: { id: en.id, name: 'English' }, added: 8, alreadyAdded: 0, duplicates: 0, exercises: 11 })
      const h = (await (await fetch(`${s.url}/api/handbook?deck=English`)).json()) as any
      expect(h.topics.map((t: any) => t.id)).toEqual(['third-person-s', 'past-simple-ed'])
      expect((await fetch(`${s.url}/api/handbook?deck=nope`)).status).toBe(404)
      const fact = (await (await fetch(`${s.url}/api/facts/${h.topics[0].ruleFactId}`)).json()) as any
      expect(fact.fact.handbook).toEqual({ topic: 'third-person-s', role: 'rule' })
      const rerun = (await (await send(`${s.url}/api/packs/grammar-handbook`, 'POST', { deckId: en.id })).json()) as any
      expect(rerun).toMatchObject({ added: 0, alreadyAdded: 8, exercises: 0, deck: { id: en.id, extraNewToday: 0 } })
      const practice = (await (await fetch(`${s.url}/api/practice?fact=${h.topics[0].ruleFactId}`)).json()) as any
      expect(practice.items).toHaveLength(3)

      const added = await callTool(s.url, 'static-mcp-token', 'add_exercises', {
        factId: h.topics[1].ruleFactId, items: [{ type: 'write', text: 'Напиши тестовое предложение о вчерашнем дне.', rubric: 'Past simple, regular verb.' }, { type: 'choose', text: 'x ___', options: ['a', 'b'] }],
      })
      expect(added).toMatchObject({ created: [{ index: 0 }], errors: [{ index: 1, error: 'answer is empty' }] })
      const listed = await callTool(s.url, 'static-mcp-token', 'list_exercises', { factId: h.topics[1].ruleFactId })
      expect(listed.at(-1)).toMatchObject({ type: 'write', prompt: 'Напиши тестовое предложение о вчерашнем дне.', rubric: 'Past simple, regular verb.', createdBy: 'claude' })
    } finally {
      await s.close()
    }
  })
})
