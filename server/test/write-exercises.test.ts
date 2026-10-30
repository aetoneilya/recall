// Write items: the learner writes their own sentence for a rule, Claude
// graded it. Storage and the grading API remain compatible; study excludes
// these tasks. Rules here are invented.
import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { addExercises, listExercises, pickExercises, pickForReview, updateExercise, type ExerciseRow } from '../src/exercises.ts'
import { createFact, factItem } from '../src/facts.ts'
import { GRADE_SCHEMA, gradeWrite } from '../src/grade.ts'
import { createDeck } from '../src/repo.ts'
import { buildQueue, reviewOptions } from '../src/study.ts'
import { claudeMessage, fakeClaude, listen, makeCtx, send, TZ, type TestCtx } from './helpers.ts'

const choose = (n: number) => ({ type: 'choose' as const, text: `Item ${n} ___ here.`, options: ['is', 'are'], answer: 'is', explain: null })
const write = (n: number, rubric: string | null = 'Uses the rule.') => ({ type: 'write' as const, prompt: `Напиши тестовое предложение номер ${n}.`, rubric })

function rule(ctx: TestCtx, items: Parameters<typeof addExercises>[3] = []) {
  const deck = createDeck(ctx.db, ctx.user.id, { name: `Grammar ${Math.random()}` }, ctx.now())
  const { fact, cardId } = createFact(ctx.db, ctx.user.id, { deckId: deck.id, fact: { front: 'Invented rule', back: 'Use **is** with one thing.' }, status: 'active', createdBy: 'user' }, ctx.now())
  const made = items.length ? addExercises(ctx.db, ctx.user.id, fact.id, items, 'user', ctx.now()) : { created: [] }
  return { deck, fact, cardId, ids: made.created.map((c) => c.id) }
}

const rows = (ctx: TestCtx, factId: string) => ctx.db.prepare("SELECT * FROM fact_exercises WHERE fact_id = ? AND status = 'active'").all(factId) as unknown as ExerciseRow[]

describe('write items', () => {
  it('are stored with their rubric, no answer, deduped among themselves', () => {
    const ctx = makeCtx()
    const { fact } = rule(ctx)
    const r = addExercises(ctx.db, ctx.user.id, fact.id, [write(1), write(1, null), write(2, null), { type: 'write', prompt: ' ' }], 'claude', ctx.now())
    expect(r.created.map((c) => c.index)).toEqual([0, 2])
    expect(r.duplicates.map((d) => d.index)).toEqual([1])
    expect(r.errors).toEqual([{ index: 3, error: 'the task is empty' }])
    const [a, b] = listExercises(ctx.db, ctx.user.id, fact.id)
    expect(a).toMatchObject({ type: 'write', prompt: 'Напиши тестовое предложение номер 1.', answer: '', accepted: [], rubric: 'Uses the rule.', explain: null })
    expect(a).not.toHaveProperty('options')
    expect(b!.rubric).toBeNull()
    expect(updateExercise(ctx.db, ctx.user.id, a!.id, { rubric: 'Past simple only.' })).toMatchObject({ rubric: 'Past simple only.', prompt: a!.prompt })
  })

  it('never enter study rounds, including when grading is available', () => {
    const ctx = makeCtx()
    const writesOnly = rule(ctx, [write(1), write(2), write(3), choose(1), choose(2)])
    // Two tap items + writes: still a plain fact card, on any server.
    expect(pickForReview(rows(ctx, writesOnly.fact.id), true)).toEqual([])
    expect(reviewOptions(ctx.db, ctx.user.id, TZ, ctx.now(), writesOnly.deck.id, null).types).toEqual([{ value: 'fact', n: 1 }])

    const full = rule(ctx, [choose(1), choose(2), choose(3), choose(4), write(1), write(2), write(3)])
    const pool = rows(ctx, full.fact.id)
    for (let i = 0; i < 30; i++) {
      const off = pickForReview(pool, false)
      expect(off.map((x) => x.type)).toEqual(['choose', 'choose', 'choose'])
      const on = pickForReview(pool, true)
      expect(on).toHaveLength(3)
      expect(on.every((x) => x.type === 'choose')).toBe(true)
    }
    // Unseen write items cannot replace already seen tap items.
    ctx.db.prepare("UPDATE fact_exercises SET last_shown_at = '2026-10-01' WHERE type = 'choose'").run()
    expect(pickForReview(rows(ctx, full.fact.id), true).every((x) => x.type === 'choose')).toBe(true)
    // pickExercises alone caps write items at one, even when nothing else is left.
    expect(pickExercises([...pool.filter((x) => x.type === 'write'), pool[0]!]).map((x) => x.type).sort()).toEqual(['choose', 'write'])

    const q = (grading: boolean) => buildQueue(ctx.db, ctx.user.id, TZ, ctx.now(), { deckId: full.deck.id, grading }).items[0]!
    const item = q(true)
    expect(item.kind === 'fact' && item.exercises).toHaveLength(3)
    const w = item.kind === 'fact' ? item.exercises!.find((e) => e.type === 'write') : undefined
    expect(w).toBeUndefined()
    const plain = q(false)
    expect(plain.kind === 'fact' && plain.exercises!.every((e) => e.type === 'choose')).toBe(true)
    // FactItem counts only the items that can be studied.
    expect(factItem(ctx.db, ctx.user.id, full.fact.id, ctx.now()).exercises).toEqual({ active: 4, flagged: 0, needsReview: 0 })
  })
})

describe('grading', () => {
  const grade = { grammatical: true, usesRule: true, corrected: 'There is a cat.', explain: 'Всё верно.', score: 2 }

  it('asks Claude with the rule, task, rubric and sentence, and returns the verdict without storing it', async () => {
    const { client, calls } = fakeClaude(() => claudeMessage(grade))
    const ctx = makeCtx({}, undefined, client)
    const { ids } = rule(ctx, [choose(1), choose(2), choose(3), write(1)])
    const r = await gradeWrite(ctx, ctx.user, ids[3]!, '  There  is a cat. ')
    expect(r).toEqual({ correct: true, corrected: 'There is a cat.', explain: 'Всё верно.', score: 2 })
    const body = calls[0]!
    expect(body).toMatchObject({ model: 'claude-opus-5-5', output_config: { effort: 'low', format: { type: 'json_schema', schema: GRADE_SCHEMA } } })
    expect(body.messages[0]!.content).toBe([
      'Rule: Invented rule', '', 'Use **is** with one thing.', '', 'Task: Напиши тестовое предложение номер 1.', 'Rubric: Uses the rule.', '', "Learner's sentence: There is a cat.",
    ].join('\n'))
    expect(body.system).toMatch(/Russian/)
    // The same autofill budget.
    expect(ctx.db.prepare('SELECT calls FROM autofill_usage').get()).toEqual({ calls: 1 })
    expect(ctx.db.prepare('SELECT shown_count FROM fact_exercises WHERE id = ?').get(ids[3]!)).toEqual({ shown_count: 0 })

    calls.length = 0
    const { client: c2 } = fakeClaude(() => claudeMessage({ ...grade, corrected: '', score: 1, explain: 'Нужен артикль.' }))
    ctx.autofill = c2
    expect(await gradeWrite(ctx, ctx.user, ids[3]!, 'There is cat.')).toEqual({ correct: false, corrected: 'There is cat.', explain: 'Нужен артикль.', score: 1 })
  })

  it('refuses other items and bad text, and maps API trouble like autofill', async () => {
    let next = () => claudeMessage(grade)
    const { client } = fakeClaude(() => next())
    const ctx = makeCtx({ AUTOFILL_DAILY_LIMIT: '4' }, undefined, client)
    const { ids } = rule(ctx, [choose(1), choose(2), choose(3), write(1)])
    await expect(gradeWrite(ctx, ctx.user, ids[0]!, 'x')).rejects.toMatchObject({ status: 400, message: 'only write items are graded' })
    await expect(gradeWrite(ctx, ctx.user, 'ex_nope', 'x')).rejects.toMatchObject({ status: 404 })
    await expect(gradeWrite(ctx, ctx.user, ids[3]!, '   ')).rejects.toMatchObject({ status: 400 })
    await expect(gradeWrite(ctx, ctx.user, ids[3]!, 'x'.repeat(501))).rejects.toMatchObject({ status: 400 })
    next = () => claudeMessage({ ...grade, score: 5 })
    await expect(gradeWrite(ctx, ctx.user, ids[3]!, 'x')).rejects.toMatchObject({ status: 502 })
    next = () => claudeMessage('', { stop_reason: 'refusal' })
    await expect(gradeWrite(ctx, ctx.user, ids[3]!, 'x')).rejects.toMatchObject({ status: 422, message: /grade/ })
    next = () => {
      throw new Anthropic.APIConnectionTimeoutError()
    }
    await expect(gradeWrite(ctx, ctx.user, ids[3]!, 'x')).rejects.toMatchObject({ status: 504 })
    next = () => claudeMessage(grade)
    await expect(gradeWrite(ctx, ctx.user, ids[3]!, 'x')).resolves.toMatchObject({ score: 2 })
    await expect(gradeWrite(ctx, ctx.user, ids[3]!, 'x')).rejects.toMatchObject({ status: 429, body: { limit: 4 } })
  })

  it('is a route; /api/me says whether it works here', async () => {
    const { client } = fakeClaude(() => claudeMessage(grade))
    for (const claude of [client, null]) {
      const ctx = makeCtx({ DEV: '1', OWNER_TELEGRAM_ID: '1001' }, undefined, claude)
      const s = await listen(ctx)
      try {
        const me = (await (await fetch(`${s.url}/api/me`)).json()) as { grading: boolean }
        expect(me.grading).toBe(!!claude)
        await fetch(`${s.url}/api/decks`)
        const f = (await (await send(`${s.url}/api/facts`, 'POST', { deckId: 'en', front: 'Invented rule', back: 'Text' })).json()) as { fact: { id: string } }
        const added = (await (await send(`${s.url}/api/facts/${f.fact.id}/exercises`, 'POST', { items: [write(1)] })).json()) as { created: { id: string }[]; exercises: { rubric: string }[] }
        expect(added.exercises[0]!.rubric).toBe('Uses the rule.')
        const r = await send(`${s.url}/api/exercises/${added.created[0]!.id}/grade`, 'POST', { text: 'There is a cat.' })
        if (claude) expect([r.status, await r.json()]).toEqual([200, { correct: true, corrected: 'There is a cat.', explain: 'Всё верно.', score: 2 }])
        else expect([r.status, await r.json()]).toEqual([503, { error: 'autofill is not configured' }])
        expect((await send(`${s.url}/api/exercises/${added.created[0]!.id}/grade`, 'POST', { text: '' })).status).toBe(400)
      } finally {
        await s.close()
      }
    }
  })
})
