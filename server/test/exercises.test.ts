// Grammar exercises: pools, picking, the review flow's attempts, the import
// and Claude's top-up. Rules here are invented (the real pool is private).
import type { BetaMessage, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AutofillClient } from '../src/autofill.ts'
import { addExercises, listExercises, pickExercises, updateExercise } from '../src/exercises.ts'
import { createFact, factItem } from '../src/facts.ts'
import { importExercises, parseRules, preferReviewed, ruleBack, ruleTags, type RuleFile } from '../src/import-exercises.ts'
import { createDeck } from '../src/repo.ts'
import { applyReviews, buildQueue, undoReview } from '../src/study.ts'
import { exerciseTopupTick, topupCandidates, topupFact } from '../src/topup.ts'
import { callTool, listen, makeCtx, send, TZ, type TestCtx } from './helpers.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const gap = (n: number, answer = `w${n}`) => ({ type: 'gap' as const, prompt: `Sentence ${n} ___ here. (hint)`, answer, accepted: [], explain: `why ${n}` })
const fix = (n: number) => ({ type: 'fix' as const, prompt: `He go there ${n} times.`, answer: `He goes there ${n} times.`, explain: null })

function rule(ctx: TestCtx, items: ReturnType<typeof gap | typeof fix>[] = []) {
  const deck = createDeck(ctx.db, ctx.user.id, { name: `Grammar ${Math.random()}` }, ctx.now())
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

  it('picks the least recently shown, at most two of a type, in rand order among equals', () => {
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
  it('picks the same items on every fetch of the day until the card is rated', () => {
    const ctx = makeCtx()
    const big = rule(ctx, Array.from({ length: 12 }, (_, i) => gap(i)))
    const picked = (now = ctx.now()) => {
      const item = buildQueue(ctx.db, ctx.user.id, TZ, now).items.find((i) => i.kind === 'fact' && i.fact.id === big.fact.id)
      return (item as { exercises?: { id: string }[] } | undefined)?.exercises?.map((e) => e.id)
    }
    const first = picked()!
    expect(first).toHaveLength(3)
    for (let i = 0; i < 10; i++) expect(picked()).toEqual(first)
    // Another day (or a rating, which bumps reps) is a new draw; a new draw
    // over 12 equal items differs from the first one for most seeds, so
    // check over a few days rather than one.
    const days = Array.from({ length: 5 }, (_, i) => picked(new Date(ctx.now().getTime() + (i + 1) * 86400_000))!.join())
    expect(days.some((d) => d !== first.join())).toBe(true)
  })

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
      deck: { name: 'English', created: false },
      rules: { created: 2, existing: 0 },
      exercises: { created: 6, existing: 0, duplicates: 0, replaced: 0, invalid: [{ rule: 'since-for', index: 3, error: 'a gap prompt needs exactly one ___' }] },
    })
    const facts = ctx.db.prepare('SELECT front, tags, import_ref, created_by FROM facts ORDER BY created_at').all()
    expect(facts).toEqual([
      { front: 'Third person -s', tags: '["Grammar/Agreement","Grammar/My rules"]', import_ref: 'rules:third-person-s', created_by: 'import' },
      { front: 'since vs for', tags: '["Grammar/Prepositions","Grammar/My rules"]', import_ref: 'rules:since-for', created_by: 'import' },
    ])
    // --tag is the root; a rule without a group only gets "My rules".
    expect(ruleTags('Grammar', ' ')).toEqual(['Grammar/My rules'])
    expect(ruleTags('English grammar', 'Word order')).toEqual(['English grammar/Word order', 'English grammar/My rules'])
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

  it('cuts odd per-review fields to size instead of refusing the batch', async () => {
    const { fact, cardId } = rule(ctx, [gap(1), gap(2), gap(3)])
    const [ex] = listExercises(ctx.db, ctx.user.id, fact.id)
    const other = rule(ctx).cardId
    const at = (min: number) => new Date(ctx.now().getTime() + min * 60_000)
    const r = await send(`${url}/api/reviews`, 'POST', [
      { id: 'rv-long', cardId, rating: 3, reviewedAt: at(1).toISOString(), durationMs: -3.6,
        exercises: [{ id: ex!.id, given: 'x'.repeat(501), correct: true }, ...Array.from({ length: 11 }, () => ({ id: 'ex_' + 'y'.repeat(200), given: '', correct: false }))] },
      // An offset is read as the instant it names.
      { id: 'rv-offset', cardId: other, rating: 3, reviewedAt: '2026-10-21T15:00:00+03:00', durationMs: 1200.4 },
    ])
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ applied: 2 })
    expect(ctx.db.prepare("SELECT length(given) AS n FROM exercise_attempts WHERE review_log_id = 'rv-long'").all()).toEqual([{ n: 500 }])
    expect(ctx.db.prepare("SELECT id, reviewed_at, duration_ms FROM review_logs WHERE id IN ('rv-long', 'rv-offset') ORDER BY id").all())
      .toEqual([{ id: 'rv-long', reviewed_at: at(1).toISOString(), duration_ms: 0 }, { id: 'rv-offset', reviewed_at: '2026-10-21T12:00:00.000Z', duration_ms: 1200 }])
  })
})

describe('Claude top-up', () => {
  function message(body: unknown): BetaMessage {
    return { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null, stop_details: null,
      content: [{ type: 'text', text: JSON.stringify(body), citations: null }], usage: { input_tokens: 100, output_tokens: 50 } } as unknown as BetaMessage
  }
  const ok = { practisesTheRule: true, exactlyOneRight: true, noDistractorGrammatical: true, noGiveaway: true }
  const fake = (body: unknown) => {
    const calls: MessageCreateParamsNonStreaming[] = []
    const client: AutofillClient = { beta: { messages: { create: async (b) => (calls.push(b), message(body)) } } }
    return { client, calls }
  }

  it('asks for new tap items for a low pool once a day and keeps only the ones that check out', async () => {
    const { client, calls } = fake({
      items: [
        { type: 'choose', text: 'She ___ coffee every day.', options: ['drinks', 'drink', 'drinking'], answer: 'drinks', wrong: null, explain: 'she → -s', selfCheck: ok },
        { type: 'spot', text: 'He like jazz a lot.', options: ['likes', 'liking'], answer: 'likes', wrong: 'like', explain: '-s', selfCheck: ok },
        { type: 'choose', text: 'It ___ often here.', options: ['rains', 'rain'], answer: 'rains', wrong: null, explain: '', selfCheck: { ...ok, noDistractorGrammatical: false } },
        { type: 'choose', text: 'No gap in this one.', options: ['a', 'b'], answer: 'a', wrong: null, explain: '', selfCheck: ok },
        { type: 'choose', text: 'She ___ there. (live)', options: ['lives', 'live'], answer: 'lives', wrong: null, explain: '', selfCheck: ok },
        { type: 'spot', text: 'They plays well.', options: ['play'], answer: 'play', wrong: 'play', explain: '', selfCheck: ok },
        { type: 'gap', text: 'Old ___ type. (x)', options: [], answer: 'x', wrong: null, explain: '', selfCheck: ok },
      ],
    })
    const ctx = makeCtx({ OWNER_TELEGRAM_ID: '1001' }, undefined, client)
    const { fact } = rule(ctx, [gap(1), gap(2), gap(3)])
    // A plain fact (no pool) is never a candidate.
    createFact(ctx.db, ctx.user.id, { deckId: createDeck(ctx.db, ctx.user.id, { name: 'Plain' }, ctx.now()).id, fact: { front: 'Q', back: 'A' }, status: 'active', createdBy: 'user' }, ctx.now())
    expect(topupCandidates(ctx).map((c) => c.fact_id)).toEqual([fact.id])

    const r = await topupFact(ctx, ctx.user.id, fact.id)
    expect(r).toEqual({ proposed: 7, added: 2, dropped: 5 })
    expect(calls[0]).toMatchObject({ model: 'claude-opus-5-5', output_config: { effort: 'low', format: { type: 'json_schema' } } })
    expect(calls[0]!.messages[0]!.content).toMatch(/Rule: Third person -s[\s\S]*- Sentence 1 ___ here/)
    expect(calls[0]!.system).toMatch(/tapping/)
    expect(listExercises(ctx.db, ctx.user.id, fact.id).slice(3).map((e) => [e.type, e.prompt, e.options, e.wrong, e.createdBy])).toEqual([
      ['choose', 'She ___ coffee every day.', ['drinks', 'drink', 'drinking'], null, 'claude'], ['spot', 'He like jazz a lot.', ['likes', 'liking'], 'like', 'claude'],
    ])
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

const choose = (n: number, answer = 'at') => ({ type: 'choose' as const, text: `Thing ${n} runs ___ noon.`, options: ['at', 'in', 'on'], answer, explain: `at ${n}` })
const spot = (n: number) => ({ type: 'spot' as const, text: `The ${n} dogs barks loudly.`, wrong: 'barks', options: ['bark', 'barking'], answer: 'bark', explain: null })

describe('tap exercises', () => {
  it('stores choose and spot items with their options, deduped by text within their family', () => {
    const ctx = makeCtx()
    const { fact } = rule(ctx, [gap(1)])
    const r = addExercises(ctx.db, ctx.user.id, fact.id, [
      choose(1), spot(1), choose(1, 'in'), { type: 'choose', text: 'Sentence 1 ___ here. (hint)', options: ['w1', 'w2'], answer: 'w1' },
      { ...spot(2), wrong: 'bark' }, { ...choose(3), options: ['at'] },
    ], 'user', ctx.now())
    expect(r.created.map((c) => c.index)).toEqual([0, 1, 3])
    expect(r.duplicates.map((d) => d.index)).toEqual([2])
    expect(r.errors.map((e) => [e.index, e.error])).toEqual([[4, expect.stringMatching(/exactly once/)], [5, 'choose needs 2–4 options']])
    const pool = listExercises(ctx.db, ctx.user.id, fact.id)
    expect(pool.slice(1, 3)).toMatchObject([
      { type: 'choose', prompt: 'Thing 1 runs ___ noon.', options: ['at', 'in', 'on'], answer: 'at', wrong: null },
      { type: 'spot', prompt: 'The 1 dogs barks loudly.', options: ['bark', 'barking'], answer: 'bark', wrong: 'barks' },
    ])
    expect(pool[0]).not.toHaveProperty('options')
    expect(() => updateExercise(ctx.db, ctx.user.id, pool[2]!.id, { wrong: 'loudly', options: ['quietly'], answer: 'quietly' })).not.toThrow()
    expect(() => updateExercise(ctx.db, ctx.user.id, pool[2]!.id, { wrong: 'cats' })).toThrow(/exactly once/)
  })

  it('serves tap items only once there are three, and puts them first before that', () => {
    const ctx = makeCtx()
    const { fact } = rule(ctx, [gap(1), gap(2), gap(3), fix(1)])
    const served = () => {
      const it = buildQueue(ctx.db, ctx.user.id, TZ, ctx.now()).items.find((i) => i.kind === 'fact')
      return (it as { exercises: { type: string }[] }).exercises.map((e) => e.type)
    }
    expect(served().every((t) => t !== 'choose')).toBe(true)
    addExercises(ctx.db, ctx.user.id, fact.id, [choose(1)], 'user', ctx.now())
    for (let i = 0; i < 10; i++) expect(served()[0]).toBe('choose')
    addExercises(ctx.db, ctx.user.id, fact.id, [spot(1), choose(2)], 'user', ctx.now())
    for (let i = 0; i < 10; i++) expect(served().sort()).toEqual(['choose', 'choose', 'spot'])
  })

  it('replaces a rule\'s typed items with tap ones on --replace, keeping its card and history', () => {
    const ctx = makeCtx()
    importExercises(ctx.db, ctx.user.id, rules(), { now: ctx.now() })
    const factId = (ctx.db.prepare("SELECT id FROM facts WHERE import_ref = 'rules:third-person-s'").get() as { id: string }).id
    const cardId = (ctx.db.prepare('SELECT id FROM cards WHERE fact_id = ?').get(factId) as { id: string }).id
    applyReviews(ctx.db, ctx.user.id, [{ id: 'rv-keep', cardId, rating: 3, reviewedAt: ctx.now().toISOString() }])
    const tap = rules()
    tap[0]!.items = [choose(1), choose(2), spot(1)]
    tap[1]!.items = [gap(3), gap(4)]
    const dry = importExercises(ctx.db, ctx.user.id, tap, { now: ctx.now(), replace: true, dryRun: true })
    expect(dry.exercises).toMatchObject({ created: 3, replaced: 3 })
    expect(listExercises(ctx.db, ctx.user.id, factId).every((e) => e.status === 'active')).toBe(true)

    const s = importExercises(ctx.db, ctx.user.id, tap, { now: ctx.now(), replace: true })
    // The second rule brought no tap items: its typed ones stay.
    expect(s).toMatchObject({ rules: { created: 0, existing: 2 }, exercises: { created: 3, existing: 2, replaced: 3 } })
    const pool = listExercises(ctx.db, ctx.user.id, factId)
    expect(pool.map((e) => [e.type, e.status])).toEqual([['gap', 'flagged'], ['gap', 'flagged'], ['fix', 'flagged'], ['choose', 'active'], ['choose', 'active'], ['spot', 'active']])
    expect(ctx.db.prepare("SELECT import_ref FROM fact_exercises WHERE fact_id = ? AND type IN ('choose', 'spot') ORDER BY rowid").all(factId).map((r: any) => r.import_ref))
      .toEqual(['third-person-s:tap:0', 'third-person-s:tap:1', 'third-person-s:tap:2'])
    expect(ctx.db.prepare('SELECT id FROM cards WHERE fact_id = ?').get(factId)).toEqual({ id: cardId })
    expect(ctx.db.prepare("SELECT count(*) AS n FROM review_logs WHERE id = 'rv-keep'").get()).toEqual({ n: 1 })
    // Again: nothing changes.
    expect(importExercises(ctx.db, ctx.user.id, tap, { now: ctx.now(), replace: true }).exercises).toMatchObject({ created: 0, existing: 5, replaced: 0 })
  })

  it('prefers the choice copy, then the reviewed one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-rules-'))
    const file = path.join(dir, 'rules.json')
    for (const f of ['rules.json', 'rules.reviewed.json', 'rules.choice.json']) fs.writeFileSync(path.join(dir, f), '[]')
    expect(preferReviewed(file)).toBe(path.join(dir, 'rules.choice.json'))
    expect(preferReviewed(path.join(dir, 'rules.reviewed.json'))).toBe(path.join(dir, 'rules.reviewed.json'))
    fs.rmSync(dir, { recursive: true })
  })
})

