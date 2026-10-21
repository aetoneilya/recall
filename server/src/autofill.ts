// ✨ Autofill: Claude drafts a word (translations, IPA, examples, CEFR, a
// usage note) from a bare term. Structured outputs guarantee the JSON shape;
// the server-side refusal fallback re-runs a declined request on another model.
import Anthropic from '@anthropic-ai/sdk'
import type { BetaContentBlockParam, BetaMessage, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { CEFR_LEVELS, cleanWord, LIMITS, PARTS_OF_SPEECH, type CleanWord, type Deck, type Example, type Word } from '@recall/core'
import type { AppContext } from './context.ts'
import type { Db } from './db.ts'
import { lexiconOf } from './lexicon.ts'
import { findDuplicate, HttpError, LANGUAGE_NAMES } from './repo.ts'
import { studyDay } from './study.ts'
import { userDayOptions, type User } from './users.ts'

// The slice of the SDK client autofill uses; tests pass a fake.
export interface AutofillClient {
  beta: { messages: { create(body: MessageCreateParamsNonStreaming): Promise<BetaMessage> } }
}

export const FALLBACK_BETA = 'server-side-fallback-2026-07-01'
const MAX_TOKENS = 8000

export function autofillClient(ctx: AppContext): AutofillClient | null {
  if (ctx.autofill === undefined) {
    ctx.autofill = ctx.cfg.anthropicApiKey
      ? new Anthropic({ apiKey: ctx.cfg.anthropicApiKey, timeout: 30_000 })
      : null
  }
  return ctx.autofill
}

const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] })

const SENSE = {
  type: 'object',
  additionalProperties: false,
  required: ['term', 'pos', 'translations', 'ipa', 'examples', 'note', 'cefr'],
  properties: {
    term: { type: 'string', description: 'Dictionary base form; verbs with "to" ("to frown"), phrasal verbs and idioms as a whole.' },
    pos: { type: 'string', enum: [...PARTS_OF_SPEECH] },
    translations: { type: 'array', items: { type: 'string' }, description: 'Natural translations, most common first; 1-5.' },
    ipa: nullable({ type: 'string', description: 'General American IPA without slashes.' }),
    examples: {
      type: 'array',
      description: '1-2 natural example sentences.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'translation'],
        properties: { text: { type: 'string' }, translation: nullable({ type: 'string' }) },
      },
    },
    note: nullable({ type: 'string', description: 'Short usage note in the native language: register, collocations, pitfalls.' }),
    cefr: nullable({ type: 'string', enum: [...CEFR_LEVELS] }),
  },
}

export const AUTOFILL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['draft', 'alternatives'],
  properties: {
    draft: SENSE,
    alternatives: { type: 'array', items: SENSE, description: 'Other common senses or parts of speech of the same term; empty if unambiguous.' },
  },
}

export function systemPrompt(deck: Pick<Deck, 'targetLang' | 'nativeLang'>): string {
  const target = LANGUAGE_NAMES[deck.targetLang] ?? deck.targetLang
  const native = LANGUAGE_NAMES[deck.nativeLang] ?? deck.nativeLang
  return `You are a bilingual ${target}–${native} lexicographer filling in a learner's vocabulary card.
Given a ${target} term (and maybe a hint about the intended sense), return:
- term: the dictionary base form (verbs as "to …"; keep phrasal verbs and idioms whole; fix obvious typos);
- pos: its part of speech;
- translations: natural ${native} equivalents a native speaker would use, most frequent first, 1–5, no explanations;
- ipa: General American pronunciation in IPA, without slashes (pick General American consistently, never British);
- examples: 1–2 natural, everyday ${target} sentences using the term, each with a ${native} translation;
- note: a concise usage note in ${native} (register, typical collocations, false friends) or null;
- cefr: your CEFR estimate (A1–C2) or null for idioms you can't place.
Put the most common sense in draft. If the term has other common senses or parts of speech, give each in alternatives (at most 3); otherwise alternatives is empty. Use the hint to choose the draft sense.
If a context sentence is given, the term is used in it: the draft is the sense it has there, and the sentence is the draft's first example, verbatim, with its translation.`
}

export type Draft = Omit<CleanWord, 'tags'>

const sameText = (a: string, b: string) => a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase()

// The sentence the word was met in goes first (kept with Claude's translation
// when Claude used it verbatim), the others after it, at most 5.
export function withFirstExample(examples: Example[], sentence: string): Example[] {
  const text = sentence.replace(/\s+/g, ' ').trim()
  if (!text || text.length > LIMITS.example) return examples
  const own = examples.find((e) => sameText(e.text, text))
  return [own ?? { text, translation: null }, ...examples.filter((e) => e !== own)].slice(0, LIMITS.examples)
}

function toDraft(raw: unknown): Draft | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const cefr = typeof r.cefr === 'string' && (CEFR_LEVELS as readonly string[]).includes(r.cefr) ? r.cefr : null
  const examples = Array.isArray(r.examples) ? r.examples.slice(0, 5) : []
  const c = cleanWord({
    term: String(r.term ?? ''),
    pos: (PARTS_OF_SPEECH as readonly string[]).includes(String(r.pos)) ? (r.pos as Draft['pos']) : 'other',
    translations: Array.isArray(r.translations) ? r.translations.map(String).slice(0, 10) : [],
    ipa: typeof r.ipa === 'string' ? r.ipa : null,
    examples: examples.map((e: unknown) => ({ text: String((e as { text?: unknown })?.text ?? ''), translation: (e as { translation?: string | null })?.translation ?? null })),
    note: typeof r.note === 'string' ? r.note : null,
    cefr: cefr as Draft['cefr'],
  })
  if ('error' in c) return null
  const { tags: _t, ...draft } = c.word
  return draft
}

export interface AutofillResult {
  draft: Draft
  alternatives: Draft[]
  freqRank: number | null
  // The deck already has this term (same normalised term and part of speech).
  duplicate: Word | null
}

function usageToday(db: Db, userId: string, day: string): number {
  return (db.prepare('SELECT calls FROM autofill_usage WHERE user_id = ? AND day = ?').get(userId, day) as { calls: number } | undefined)?.calls ?? 0
}

export interface StructuredCall {
  // For the log line: "autofill", "extract".
  label: string
  detail: string
  system: string
  content: string | BetaContentBlockParam[]
  schema: Record<string, unknown>
}

// One structured-output call on the user's daily budget: 503 without a
// client, 429 over the limit (checked and counted before the call, failures
// count too), 422 on a refusal, 504 / 502 on API trouble. Returns the parsed JSON.
export async function structuredCall(ctx: AppContext, user: User, call: StructuredCall): Promise<unknown> {
  const client = autofillClient(ctx)
  if (!client) throw new HttpError(503, 'autofill is not configured')
  const { db, cfg } = ctx
  const day = studyDay(ctx.now(), userDayOptions(cfg, user)).key
  const limit = cfg.autofillDailyLimit
  if (usageToday(db, user.id, day) >= limit) throw new HttpError(429, `daily autofill limit reached (${limit})`, { limit })
  // Count the attempt up front: failures cost tokens too.
  db.prepare(`INSERT INTO autofill_usage(user_id, day, calls) VALUES (?, ?, 1)
    ON CONFLICT(user_id, day) DO UPDATE SET calls = calls + 1`).run(user.id, day)

  let msg: BetaMessage
  try {
    msg = await client.beta.messages.create({
      model: cfg.claudeModel,
      max_tokens: MAX_TOKENS,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: call.schema } },
      system: call.system,
      messages: [{ role: 'user', content: call.content }],
    })
  } catch (e) {
    if (e instanceof Anthropic.APIConnectionTimeoutError) throw new HttpError(504, 'autofill timed out, try again')
    if (e instanceof Anthropic.RateLimitError) throw new HttpError(503, 'autofill is busy, try again in a minute')
    if (e instanceof Anthropic.APIError) {
      console.error(`autofill: API error ${e.status ?? ''}: ${e.message}`)
      throw new HttpError(502, 'autofill failed')
    }
    throw e
  }

  const u = msg.usage
  db.prepare('UPDATE autofill_usage SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE user_id = ? AND day = ?')
    .run(u.input_tokens ?? 0, u.output_tokens ?? 0, user.id, day)
  console.log(`${call.label} user=${user.id} ${call.detail} model=${msg.model} stop=${msg.stop_reason} in=${u.input_tokens} out=${u.output_tokens}`)

  if (msg.stop_reason === 'refusal') {
    throw new HttpError(422, 'Claude declined to fill in this term', { category: msg.stop_details?.category ?? null })
  }
  if (msg.stop_reason === 'max_tokens') throw new HttpError(502, 'autofill answer was cut off, try again')
  const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(502, 'autofill returned malformed JSON')
  }
}

export interface AutofillInput {
  term: string
  hint?: string
  // A sentence the term was met in: picks the sense and becomes the first example.
  context?: string
}

export async function autofill(ctx: AppContext, user: User, deck: Deck, input: AutofillInput): Promise<AutofillResult> {
  if (!autofillClient(ctx)) throw new HttpError(503, 'autofill is not configured')
  const term = input.term.replace(/\s+/g, ' ').trim()
  if (!term) throw new HttpError(400, 'term is empty')
  if (term.length > 200) throw new HttpError(400, 'term is longer than 200 characters')
  const hint = input.hint?.trim().slice(0, 300)
  const context = input.context?.replace(/\s+/g, ' ').trim().slice(0, 500)
  const { db } = ctx
  const lines = [`Term: ${term}`, ...(hint ? [`Hint: ${hint}`] : []), ...(context ? [`Context: ${context}`] : [])]
  const parsed = (await structuredCall(ctx, user, {
    label: 'autofill',
    detail: `term=${JSON.stringify(term)}`,
    system: systemPrompt(deck),
    content: lines.join('\n'),
    schema: AUTOFILL_SCHEMA,
  })) as { draft?: unknown; alternatives?: unknown } | null
  if (!parsed || typeof parsed !== 'object') throw new HttpError(502, 'autofill returned an incomplete word')
  const draft = toDraft(parsed.draft)
  if (!draft) throw new HttpError(502, 'autofill returned an incomplete word')
  const alternatives = (Array.isArray(parsed.alternatives) ? parsed.alternatives : [])
    .map(toDraft)
    .filter((d): d is Draft => d !== null && !(d.term === draft.term && d.pos === draft.pos))
    .slice(0, 3)
  if (context) draft.examples = withFirstExample(draft.examples, context)
  const lex = lexiconOf(ctx)
  return {
    draft,
    alternatives,
    freqRank: lex.rank(draft.term),
    duplicate: findDuplicate(db, user.id, deck.id, draft.term, draft.pos),
  }
}
