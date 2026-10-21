// Grammar exercises: pools, picking, the review flow's attempts, the import
// and Claude's top-up. Rules here are invented (the real pool is private).
import type { BetaMessage, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AutofillClient } from '../src/autofill.ts'
import { addExercises, listExercises, pickExercises, updateExercise } from '../src/exercises.ts'
import { createFact, factItem } from '../src/facts.ts'
import { importExercises, parseRules, preferReviewed, ruleBack, type RuleFile } from '../src/import-exercises.ts'
import { createTopicDeck } from '../src/repo.ts'
import { applyReviews, buildQueue, undoReview } from '../src/study.ts'
import { exerciseTopupTick, topupCandidates, topupFact } from '../src/topup.ts'
import { callTool, listen, makeCtx, send, TZ, type TestCtx } from './helpers.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const gap = (n: number, answer = `w${n}`) => ({ type: 'gap' as const, prompt: `Sentence ${n} ___ here. (hint)`, answer, accepted: [], explain: `why ${n}` })
const fix = (n: number) => ({ type: 'fix' as const, prompt: `He go there ${n} times.`, answer: `He goes there ${n} times.`, explain: null })

function rule(ctx: TestCtx, items: ReturnType<typeof gap | typeof fix>[] = []) {
  const deck = createTopicDeck(ctx.db, ctx.user.id, { name: `Grammar ${Math.random()}` }, ctx.now())
  const { fact, cardId } = createFact(ctx.db, ctx.user.id, { deckId: deck.id, fact: { front: 'Third person -s', back: 'He/she/it **goes**.' }, status: 'active', createdBy: 'user' }, ctx.now())
  if (items.length) addExercises(ctx.db, ctx.user.id, fact.id, items, 'user', ctx.now())
  return { deck, fact, cardId }
}

describe('exercise pools', () => {
  it('validates and dedupes by prompt', () => {
    const ctx = makeCtx()
    const { fact } = rule(ctx)
    const r = addExercises(ctx.db, ctx.user.id, fact.id, [gap(1), gap(2), { ...gap(1), answer: 'other' }, { type: 'gap', prompt: 'no gap', answer: 'x' }, fix(1)], 'claude', ctx.now())
    expect(r.created.map((c) => c.index)).toEqual([0, 1, 4])
    expect(r.duplicates).toEqual([{ index: 2, existingId: r.created[0]!.id, existingStatus: 'active' }])
    expect(r.errors).toEqual([{ index: 3, error: 'a gap prompt needs exactly one ___' }])
    expect(listExercises(ctx.db, ctx.user.id, fact.id).map((e) => [e.type, e.answer, e.createdBy, e.shownCount])).toEqual([['gap', 'w1', 'claude', 0], ['gap', 'w2', 'claude', 0], ['fix', 'He goes there 1 times.', 'claude', 0]])
    expect(factItem(ctx.db, ctx.user.id, fact.id, ctx.now()).exercises).toEqual({ active: 3, flagged: 0, needsReview: 0 })
    const e = updateExercise(ctx.db, ctx.user.id, r.created[1]!.id, { status: 'flagged' })
    expect(e.status).toBe('flagged')
    expect(() => updateExercise(ctx.db, 'us_nobody', e.id, { status: 'active' })).toThrow(/not found/)
    expect(() => updateExercise(ctx.db, ctx.user.id, e.id, { prompt: 'Sentence 1 ___ here. (hint)' })).toThrow(/already has/)
  })

  it('picks the least recently shown, at most two of a type, randomly among equals', () => {
    const pool = [
      { id: 'a', type: 'gap', last_shown_at: '2026-10-01' }, { id: 'b', type: 'gap', last_shown_at: null }, { id: 'c', type: 'gap', last_shown_at: null },
      { id: 'd', type: 'gap', last_shown_at: null }, { id: 'e', type: 'fix', last_shown_at: '2026-10-05' }, { id: 'f', type: 'fix', last_shown_at: '2026-09-01' },
    ]
    for (let i = 0; i < 20; i++) {
      const p = pickExercises(pool)
      expect(p).toHaveLength(3)
      expect(p.filter((x) => x.type === 'gap')).toHaveLength(2)
      expect(p.filter((x) => x.last_shown_at === null)).toHaveLength(2)
      expect(p.map((x) => x.id)).toContain('f')
    }
    const seen = new Set(Array.from({ length: 40 }, () => pickExercises(pool).map((x) => x.id).sort().join()))
    expect(seen.size).toBeGreaterThan(1)
    // Only one type: the cap gives way.
    expect(pickExercises(pool.slice(0, 4))).toHaveLength(3)
  })
})

describe('exercise reviews', () => {
  it('puts three items in the queue item of a rule with a pool, and none with fewer than three', () => {
    const ctx = makeCtx()
    const small = rule(ctx, [gap(1), gap(2)])
    const big = rule(ctx, [gap(1), gap(2), gap(3), fix(1), fix(2)])
    const items = buildQueue(ctx.db, ctx.user.id, TZ, ctx.now()).items
    const of = (id: string) => items.find((i) => i.kind === 'fact' && i.fact.id === id)
    expect(of(small.fact.id)).not.toHaveProperty('exercises')
    const ex = (of(big.fact.id) as { exercises: { id: string; answer: string; type: string }[] }).exercises
    expect(ex).toHaveLength(3)
    expect(ex[0]).toEqual(expect.objectContaining({ id: expect.stringMatching(/^ex_/), prompt: expect.any(String), answer: expect.any(String), accepted: [] }))
    expect(ex.every((e) => 'explain' in e)).toBe(true)
  })

  it('keeps each item attempt with the review, idempotently, and undo takes it back', () => {
    const ctx = makeCtx()
    const { fact, cardId } = rule(ctx, [gap(1), gap(2), gap(3), fix(1)])
    const [a, b, c, d] = listExercises(ctx.db, ctx.user.id, fact.id)
    const review = {
      id: 'rv-1', cardId, rating: 2 as const, reviewedAt: ctx.now().toISOString(),
      exercises: [{ id: a!.id, given: 'w1', correct: true }, { id: b!.id, given: 'nope', correct: true, overridden: true }, { id: c!.id, given: 'x', correct: false, bad: true }, { id: 'ex_foreign', given: 'x', correct: true }],
    }
    expect(applyReviews(ctx.db, ctx.user.id, [review])).toMatchObject({ applied: 1 })
    expect(applyReviews(ctx.db, ctx.user.id, [review])).toMatchObject({ applied: 0, skipped: 1 })
    const after = new Map(listExercises(ctx.db, ctx.user.id, fact.id).map((e) => [e.id, e]))
    expect(after.get(a!.id)).toMatchObject({ shownCount: 1, correctCount: 1, wrongCount: 0, lastShownAt: review.reviewedAt, status: 'active', needsReview: false })
    expect(after.get(b!.id)).toMatchObject({ shownCount: 1, correctCount: 1, needsReview: true })
    expect(after.get(c!.id)).toMatchObject({ shownCount: 1, correctCount: 0, wrongCount: 0, status: 'flagged' })
    expect(after.get(d!.id)).toMatchObject({ shownCount: 0 })
    expect(ctx.db.prepare('SELECT count(*) AS n FROM exercise_attempts').get()).toEqual({ n: 3 })
    // A flagged item is out of the pool; three remain, so the rule still reviews by exercises.
    expect(factItem(ctx.db, ctx.user.id, fact.id, ctx.now()).exercises).toEqual({ active: 3, flagged: 1, needsReview: 1 })

    undoReview(ctx.db, ctx.user.id, 'rv-1')
    expect(listExercises(ctx.db, ctx.user.id, fact.id).find((e) => e.id === a!.id)).toMatchObject({ shownCount: 0, correctCount: 0, lastShownAt: null })
    expect(ctx.db.prepare('SELECT count(*) AS n FROM exercise_attempts').get()).toEqual({ n: 0 })
  })
})

const rules = (): RuleFile[] => [
  { id: 'third-person-s', group: 'Agreement', title: 'Third person -s', rule: 'He/she/it — **-s**.', fromNotes: ['He ==goes== home.', 'She like tea → LIKES'], items: [gap(1), gap(2), fix(1)] },
  { id: 'since-for', group: 'Prepositions', title: 'since vs for', rule: '**since** + a point, **for** + a period.', fromNotes: [], items: [gap(3), gap(4), gap(5), { type: 'gap', prompt: 'broken', answer: 'x' }] },
]

describe('import-exercises', () => {
  it('makes one fact per rule with its pool, in file order, and adds only what is new on a rerun', () => {
    const ctx = makeCtx()
    expect(() => parseRules([{ id: 'x' }])).toThrow(/id, title and rule/)
    expect(() => parseRules([...rules(), rules()[0]])).toThrow(/twice/)
    expect(ruleBack(rules()[0]!)).toBe('He/she/it — **-s**.\n\n**From your notes**\n- He **goes** home.\n- She like tea → LIKES')

    const dry = importExercises(ctx.db, ctx.user.id, rules(), { dryRun: true, now: ctx.now() })
    expect(dry.exercises.created).toBe(6)
    expect(ctx.db.prepare('SELECT count(*) AS n FROM facts').get()).toEqual({ n: 0 })

    const s = importExercises(ctx.db, ctx.user.id, rules(), { now: ctx.now() })
    expect(s).toEqual({
      deck: { name: 'Grammar', created: true },
      rules: { created: 2, existing: 0 },
      exercises: { created: 6, existing: 0, duplicates: 0, invalid: [{ rule: 'since-for', index: 3, error: 'a gap prompt needs exactly one ___' }] },
    })
    const facts = ctx.db.prepare('SELECT front, tags, import_ref, created_by FROM facts ORDER BY created_at').all()
    expect(facts).toEqual([
      { front: 'Third person -s', tags: '["Agreement"]', import_ref: 'rules:third-person-s', created_by: 'import' },
      { front: 'since vs for', tags: '["Prepositions"]', import_ref: 'rules:since-for', created_by: 'import' },
    ])
    expect(ctx.db.prepare("SELECT import_ref FROM fact_exercises ORDER BY rowid").all().map((r: any) => r.import_ref))
      .toEqual(['third-person-s:0', 'third-person-s:1', 'third-person-s:2', 'since-for:0', 'since-for:1', 'since-for:2'])
    expect(buildQueue(ctx.db, ctx.user.id, TZ, ctx.now()).items.map((i) => (i.kind === 'fact' ? i.fact.front : ''))).toEqual(['Third person -s', 'since vs for'])

    // Rerun: an edited title is not applied; a new item and a new rule are.
    const more = rules()
    more[0]!.title = 'Edited'
    more[0]!.items.push(gap(9))
    more.push({ id: 'new-rule', group: 'Word order', title: 'Questions', rule: 'Aux before subject.', fromNotes: [], items: [gap(10)] })
    const again = importExercises(ctx.db, ctx.user.id, more, { now: ctx.now() })
    expect(again).toMatchObject({ deck: { created: false }, rules: { created: 1, existing: 2 }, exercises: { created: 2, existing: 6 } })
    expect((ctx.db.prepare("SELECT front FROM facts WHERE import_ref = 'rules:third-person-s'").get() as any).front).toBe('Third person -s')
  })

  it('prefers a reviewed copy next to the file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-rules-'))
    const file = path.join(dir, 'rules.json')
    fs.writeFileSync(file, '[]')
    expect(preferReviewed(file)).toBe(file)
    fs.writeFileSync(path.join(dir, 'rules.reviewed.json'), '[]')
    expect(preferReviewed(file)).toBe(path.join(dir, 'rules.reviewed.json'))
    fs.rmSync(dir, { recursive: true })
  })
})

describe('exercise routes and tools', () => {
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

  it('lists, adds, flags and deletes items; reviews carry attempts; MCP tops up', async () => {
    const { fact, cardId } = rule(ctx)
    const api = async (method: string, p: string, body?: unknown) => {
      const r = method === 'GET' ? await fetch(`${url}/api${p}`) : await send(`${url}/api${p}`, method, body ?? {})
      return { status: r.status, body: (await r.json()) as any }
    }
    const added = await api('POST', `/facts/${fact.id}/exercises`, { items: [gap(1), gap(2), fix(1)] })
    expect(added).toMatchObject({ status: 201, body: { created: [{ index: 0 }, { index: 1 }, { index: 2 }], exercises: [{}, {}, {}] } })
    expect((await api('POST', `/facts/${fact.id}/exercises`, { items: [{ type: 'quiz', prompt: 'x', answer: 'y' }] })).status).toBe(400)
    const ids = added.body.exercises.map((e: any) => e.id)
    const q = await api('GET', '/queue')
    const item = q.body.items.find((i: any) => i.kind === 'fact')
    expect(item.exercises.map((e: any) => e.id).sort()).toEqual([...ids].sort())

    const rv = await api('POST', '/reviews', [{ id: 'rv-api', cardId, rating: 3, reviewedAt: ctx.now().toISOString(), exercises: ids.map((id: string) => ({ id, given: 'g', correct: true })) }])
    expect(rv.body).toMatchObject({ applied: 1 })
    expect((await api('GET', `/facts/${fact.id}/exercises`)).body.exercises.every((e: any) => e.shownCount === 1 && e.correctCount === 1)).toBe(true)
    expect((await api('POST', '/reviews', [{ id: 'rv-bad', cardId, rating: 3, reviewedAt: ctx.now().toISOString(), exercises: [{ id: 'x' }] }])).status).toBe(400)

    expect((await api('PATCH', `/exercises/${ids[0]}`, { status: 'flagged', needsReview: true })).body.exercise).toMatchObject({ status: 'flagged', needsReview: true })
    expect((await api('PATCH', `/exercises/${ids[0]}`, { prompt: 'no gap' })).status).toBe(400)
    expect((await api('DELETE', `/exercises/${ids[1]}`)).body).toEqual({ ok: true })
    expect((await api('DELETE', `/exercises/${ids[1]}`)).status).toBe(404)
    // Two active left: a plain fact card again.
    expect((await api('GET', '/queue')).body.items.find((i: any) => i.kind === 'fact')?.exercises).toBeUndefined()

    const mcp = await callTool(url, 'static-mcp-token', 'add_exercises', { factId: fact.id, items: [gap(2), gap(3), { ...gap(3), answer: 'dup' }] })
    expect(mcp).toMatchObject({ created: [{ index: 0 }, { index: 1 }], duplicates: [{ index: 2 }] })
    const listed = await callTool(url, 'static-mcp-token', 'list_exercises', { factId: fact.id })
    expect(listed.map((e: any) => [e.prompt.slice(0, 10), e.status, e.createdBy])).toEqual([
      ['Sentence 1', 'flagged', 'user'], ['He go ther', 'active', 'user'], ['Sentence 2', 'active', 'claude'], ['Sentence 3', 'active', 'claude'],
    ])
    expect((await callTool(url, 'static-mcp-token', 'list_exercises', { factId: 'ft_nope' })).error).toMatch(/not found/)
  })
})

describe('Claude top-up', () => {
  function message(body: unknown): BetaMessage {
    return { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null, stop_details: null,
      content: [{ type: 'text', text: JSON.stringify(body), citations: null }], usage: { input_tokens: 100, output_tokens: 50 } } as unknown as BetaMessage
  }
  const ok = { practisesTheRule: true, oneClearAnswer: true, answerIsCorrect: true }
  const fake = (body: unknown) => {
    const calls: MessageCreateParamsNonStreaming[] = []
    const client: AutofillClient = { beta: { messages: { create: async (b) => (calls.push(b), message(body)) } } }
    return { client, calls }
  }

  it('asks for new items for a low pool once a day and keeps only the ones that check out', async () => {
    const { client, calls } = fake({
      items: [
        { type: 'gap', prompt: 'She ___ coffee every day. (drink)', answer: 'drinks', accepted: [], explain: 'she → -s', selfCheck: ok },
        { type: 'fix', prompt: 'He like jazz.', answer: 'He likes jazz.', accepted: [], explain: '-s', selfCheck: ok },
        { type: 'gap', prompt: 'It ___ often. (rain)', answer: 'rains', accepted: [], explain: '', selfCheck: { ...ok, oneClearAnswer: false } },
        { type: 'gap', prompt: 'Two gaps ___ and ___. (x)', answer: 'x', accepted: [], explain: '', selfCheck: ok },
        { type: 'fix', prompt: 'He likes jazz.', answer: 'He likes jazz!', accepted: [], explain: '', selfCheck: ok },
        { type: 'gap', prompt: 'Sentence 1 ___ here. (hint)', answer: 'w1', accepted: [], explain: '', selfCheck: ok },
      ],
    })
    const ctx = makeCtx({ OWNER_TELEGRAM_ID: '1001' }, undefined, client)
    const { fact } = rule(ctx, [gap(1), gap(2), gap(3)])
    // A plain fact (no pool) is never a candidate.
    createFact(ctx.db, ctx.user.id, { deckId: createTopicDeck(ctx.db, ctx.user.id, { name: 'Plain' }, ctx.now()).id, fact: { front: 'Q', back: 'A' }, status: 'active', createdBy: 'user' }, ctx.now())
    expect(topupCandidates(ctx).map((c) => c.fact_id)).toEqual([fact.id])

    const r = await topupFact(ctx, ctx.user.id, fact.id)
    expect(r).toEqual({ proposed: 6, added: 2, dropped: 4 })
    expect(calls[0]).toMatchObject({ model: 'claude-opus-5-5', output_config: { effort: 'low', format: { type: 'json_schema' } } })
    expect(calls[0]!.messages[0]!.content).toMatch(/Rule: Third person -s[\s\S]*- Sentence 1 ___ here/)
    expect(listExercises(ctx.db, ctx.user.id, fact.id).slice(3).map((e) => [e.prompt, e.createdBy])).toEqual([['She ___ coffee every day. (drink)', 'claude'], ['He like jazz.', 'claude']])
    expect(ctx.db.prepare('SELECT calls FROM autofill_usage').get()).toEqual({ calls: 1 })
    // Attempted today: not again until tomorrow.
    expect(topupCandidates(ctx)).toEqual([])
    await exerciseTopupTick(ctx)
    expect(calls).toHaveLength(1)
    ctx.clock.t = new Date(ctx.now().getTime() + 25 * 3600_000)
    await exerciseTopupTick(ctx)
    expect(calls).toHaveLength(2)
  })

  it('is off without a client', async () => {
    const ctx = makeCtx()
    rule(ctx, [gap(1), gap(2), gap(3)])
    await exerciseTopupTick(ctx)
    expect(ctx.db.prepare('SELECT count(*) AS n FROM exercise_topups').get()).toEqual({ n: 0 })
  })
})
