// Keeps exercise pools stocked with Claude (only with ANTHROPIC_API_KEY): a
// rule whose pool has fewer than TOPUP_BELOW active, never-shown items gets
// TOPUP_COUNT new ones — at most one attempt per rule per day, each call on
// the user's autofill budget (autofill.structuredCall). One structured call
// writes the items and checks each of them (selfCheck); the server keeps the
// ones that pass its own checks too (core.cleanExercise, the answer grades
// as correct, a fix prompt doesn't, no repeated prompt).
import { checkExercise, cleanExercise, type ExerciseInput } from '@recall/core'
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
        required: ['type', 'prompt', 'answer', 'accepted', 'explain', 'selfCheck'],
        properties: {
          type: { type: 'string', enum: ['gap', 'fix', 'rewrite'] },
          prompt: { type: 'string', description: 'gap: one sentence with exactly one "___" and a hint in parentheses. fix: a sentence with exactly one mistake. rewrite: "sentence → cue ___".' },
          answer: { type: 'string', description: 'gap: what fills the gap. fix: the whole corrected sentence. rewrite: what completes the cue.' },
          accepted: { type: 'array', items: { type: 'string' }, description: 'Other answers that are equally correct; usually empty.' },
          explain: { type: 'string', description: 'One short line in Russian on why.' },
          selfCheck: {
            type: 'object',
            additionalProperties: false,
            required: ['practisesTheRule', 'oneClearAnswer', 'answerIsCorrect'],
            properties: {
              practisesTheRule: { type: 'boolean', description: 'The item tests exactly this rule.' },
              oneClearAnswer: { type: 'boolean', description: 'Only the answer (and the accepted variants) is right; no other natural answer fits.' },
              answerIsCorrect: { type: 'boolean', description: 'Re-read: the answer is grammatical and fits the prompt and hint.' },
            },
          },
        },
      },
    },
  },
}

export function topupSystem(): string {
  return `You write grammar exercises for a Russian-speaking learner of English (B2), for one rule at a time. Each item has exactly one clearly correct answer, plus equally right variants in "accepted". Types: gap — one sentence with exactly one "___" and a hint in parentheses (the base verb, a tense or number cue), e.g. "The list of jobs ___ longer every hour. (be)" → "is"; fix — a natural sentence with exactly one mistake of this rule, the answer is the whole corrected sentence; rewrite — "sentence → cue ___", the answer completes the cue. Use varied, everyday and work contexts (software, travel, family), different subjects and tenses; mostly gap, some fix, few rewrite. Never make an answer hinge on spelling, punctuation or a rare word. Don't repeat or lightly reword the existing prompts. "explain" is one short line in Russian. Then check each item honestly in selfCheck; it is fine to mark a weak one false.`
}

interface Candidate {
  user_id: string
  fact_id: string
}

// Rules (facts with a pool) running low on fresh items and not attempted in a day.
export function topupCandidates(ctx: AppContext): Candidate[] {
  const since = new Date(ctx.now().getTime() - DAY_MS).toISOString()
  return ctx.db.prepare(`
    SELECT f.user_id, f.id AS fact_id FROM facts f
    JOIN fact_exercises e ON e.fact_id = f.id
    LEFT JOIN exercise_topups t ON t.fact_id = f.id
    WHERE f.status = 'active' AND (t.attempted_at IS NULL OR t.attempted_at < ?)
    GROUP BY f.id HAVING sum(e.status = 'active' AND e.shown_count = 0) < ?
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
    `Existing prompts (don't repeat these):`,
    ...pool.map((e) => `- ${e.prompt}`),
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
    if (sc.practisesTheRule !== true || sc.oneClearAnswer !== true || sc.answerIsCorrect !== true) continue
    const r = cleanExercise({ type: it.type as ExerciseInput['type'], prompt: String(it.prompt ?? ''), answer: String(it.answer ?? ''), accepted: Array.isArray(it.accepted) ? it.accepted.map(String) : [], explain: typeof it.explain === 'string' ? it.explain : null })
    if ('error' in r) continue
    if (!checkExercise(r.item.answer, r.item).correct) continue
    if (r.item.type === 'fix' && checkExercise(r.item.prompt, r.item).correct) continue
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
