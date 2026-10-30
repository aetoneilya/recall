// Keeps exercise pools stocked with Claude (only with ANTHROPIC_API_KEY): a
// rule whose pool has fewer than TOPUP_BELOW active, never-shown items gets
// TOPUP_COUNT new ones — at most one attempt per rule per day, each call on
// the user's autofill budget (autofill.structuredCall). One structured call
// writes tap items (choose, spot) and checks each of them (selfCheck: the
// rule, one right option, no grammatical distractor, no giveaway); the
// server keeps the ones that also pass core.cleanExercise, have no hint in
// parentheses and aren't repeats.
import { cleanExercise, type ExerciseInput } from '@recall/core'
import { autofillClient, structuredCall } from './autofill.ts'
import type { AppContext } from './context.ts'
import { addExercises, listExercises } from './exercises.ts'
import { getFact } from './facts.ts'
import { allowedUser } from './users.ts'

export const TOPUP_BELOW = 8
export const TOPUP_COUNT = 15
const DAY_MS = 86400_000

export const TOPUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'text', 'options', 'answer', 'wrong', 'explain', 'selfCheck'],
        properties: {
          type: { type: 'string', enum: ['choose', 'spot'] },
          text: { type: 'string', description: 'choose: one sentence with exactly one "___". spot: a natural sentence with exactly one mistake.' },
          options: { type: 'array', items: { type: 'string' }, description: 'choose: 2-4 options; spot: 1-4 replacements for the wrong word(s). "—" means nothing (zero article / delete).' },
          answer: { type: 'string', description: 'The one right option, exactly as in options.' },
          wrong: { anyOf: [{ type: 'string', description: 'spot: the wrong whole word(s), exactly as they appear once in the text.' }, { type: 'null' }] },
          explain: { type: 'string', description: 'One short line in Russian on why.' },
          selfCheck: {
            type: 'object',
            additionalProperties: false,
            required: ['practisesTheRule', 'exactlyOneRight', 'noDistractorGrammatical', 'noGiveaway'],
            properties: {
              practisesTheRule: { type: 'boolean', description: 'The item tests exactly this rule.' },
              exactlyOneRight: { type: 'boolean', description: 'Re-read: the answer is grammatical and natural in this sentence.' },
              noDistractorGrammatical: { type: 'boolean', description: 'Try every other option in the sentence: none of them is grammatical or natural.' },
              noGiveaway: { type: 'boolean', description: 'Nothing in the sentence translates, names or hints the answer.' },
            },
          },
        },
      },
    },
  },
}

export function topupSystem(): string {
  return `You write grammar exercises for a Russian-speaking learner of English (B2), one rule at a time. They are answered by tapping on a phone, so there are two types. choose — one sentence with exactly one "___" and 2-4 options, e.g. "The backup runs ___ 3 a.m." with ["at", "in", "on"], answer "at"; "—" as an option means nothing there (the zero article). spot — a natural sentence with exactly one mistake of this rule; "wrong" is the wrong whole word(s) exactly as they appear (once) in the sentence, options are 1-4 replacements with the answer among them, e.g. "His shoes gets wet every time it rains." wrong "gets", options ["get", "getting", "got"], answer "get"; the answer "—" means "delete it" ("See you on next week." wrong "on"). Take the distractors from the rule's own contrast set (at / in / on; a / the / —; is / are), so that exactly one option is grammatical in that sentence. No hints in parentheses, nothing that translates or names the answer. Use varied everyday and work contexts (software, travel, family), different subjects and tenses, both types. Don't repeat or lightly reword the existing sentences. "explain" is one short line in Russian. Then check each item honestly in selfCheck — try every option in the sentence; it is fine to mark a weak item false.`
}

interface Candidate {
  user_id: string
  fact_id: string
}

// Rules (facts with a pool) running low on fresh items and not attempted in a
// day. Write items don't count either way: the top-up writes tap items only.
export function topupCandidates(ctx: AppContext): Candidate[] {
  const since = new Date(ctx.now().getTime() - DAY_MS).toISOString()
  return ctx.db.prepare(`
    SELECT f.user_id, f.id AS fact_id FROM facts f
    JOIN fact_exercises e ON e.fact_id = f.id AND e.type <> 'write'
    LEFT JOIN exercise_topups t ON t.fact_id = f.id
    WHERE f.status = 'active' AND (t.attempted_at IS NULL OR t.attempted_at < ?)
    GROUP BY f.id HAVING sum(e.status = 'active' AND e.shown_count = 0 AND e.type IN ('choose', 'spot')) < ?
    ORDER BY f.user_id, f.created_at`).all(since, TOPUP_BELOW) as unknown as Candidate[]
}

export interface TopupResult {
  proposed: number
  added: number
  // Dropped by the self-check, validation, grading or as a repeat.
  dropped: number
}

// One rule's top-up. The attempt is recorded first, so a failure waits a day too.
export async function topupFact(ctx: AppContext, userId: string, factId: string): Promise<TopupResult> {
  const { db } = ctx
  const user = allowedUser(db, ctx.cfg, userId)
  const fact = getFact(db, userId, factId)
  if (!user || !fact) return { proposed: 0, added: 0, dropped: 0 }
  db.prepare(`INSERT INTO exercise_topups(fact_id, attempted_at) VALUES (?, ?)
    ON CONFLICT(fact_id) DO UPDATE SET attempted_at = excluded.attempted_at, result = NULL`).run(factId, ctx.now().toISOString())
  const pool = listExercises(db, userId, factId)
  const content = [
    `Rule: ${fact.front}`,
    fact.back,
    '',
    `Existing sentences (don't repeat these):`,
    ...pool.filter((e) => e.type !== 'write').map((e) => `- ${e.prompt}`),
    '',
    `Write ${TOPUP_COUNT} new items.`,
  ].join('\n')
  let raw: unknown
  try {
    raw = await structuredCall(ctx, user, { label: 'exercises', detail: `fact=${factId}`, system: topupSystem(), content, schema: TOPUP_SCHEMA })
  } catch (e) {
    db.prepare('UPDATE exercise_topups SET result = ? WHERE fact_id = ?').run(JSON.stringify({ error: (e as Error).message }), factId)
    throw e
  }
  const items = Array.isArray((raw as { items?: unknown })?.items) ? ((raw as { items: unknown[] }).items as Record<string, unknown>[]) : []
  const keep: ExerciseInput[] = []
  for (const it of items) {
    const sc = (it.selfCheck ?? {}) as Record<string, unknown>
    if (sc.practisesTheRule !== true || sc.exactlyOneRight !== true || sc.noDistractorGrammatical !== true || sc.noGiveaway !== true) continue
    if (it.type !== 'choose' && it.type !== 'spot') continue
    const r = cleanExercise({
      type: it.type, text: String(it.text ?? ''), answer: String(it.answer ?? ''), options: Array.isArray(it.options) ? it.options.map(String) : [],
      wrong: typeof it.wrong === 'string' ? it.wrong : null, explain: typeof it.explain === 'string' ? it.explain : null,
    })
    if ('error' in r) continue
    // A hint in parentheses gives the answer away.
    if (/\(/.test(r.item.prompt)) continue
    keep.push(r.item)
  }
  const out = keep.length ? addExercises(db, userId, factId, keep, 'claude', ctx.now()) : { created: [], duplicates: [], errors: [] }
  const result = { proposed: items.length, added: out.created.length, dropped: items.length - out.created.length }
  db.prepare('UPDATE exercise_topups SET result = ? WHERE fact_id = ?').run(JSON.stringify(result), factId)
  console.log(`exercises top-up fact=${factId}: ${result.added} of ${result.proposed} added`)
  return result
}

// One pass over the rules that need it; stops for a user at their daily limit.
export async function exerciseTopupTick(ctx: AppContext) {
  if (!autofillClient(ctx)) return
  const limited = new Set<string>()
  for (const c of topupCandidates(ctx)) {
    if (limited.has(c.user_id)) continue
    try {
      await topupFact(ctx, c.user_id, c.fact_id)
    } catch (e) {
      const status = (e as { status?: number }).status
      if (status === 429) limited.add(c.user_id)
      else console.error(`exercises top-up fact=${c.fact_id}:`, (e as Error).message)
    }
  }
}

// Hourly, first ten minutes after start; off without ANTHROPIC_API_KEY.
export function startExerciseTopups(ctx: AppContext): () => void {
  if (!autofillClient(ctx)) return () => {}
  const run = () => exerciseTopupTick(ctx).catch((e) => console.error('exercises top-up:', e))
  const first = setTimeout(run, 10 * 60_000)
  const timer = setInterval(run, 3600_000)
  first.unref()
  timer.unref()
  return () => {
    clearTimeout(first)
    clearInterval(timer)
  }
}
