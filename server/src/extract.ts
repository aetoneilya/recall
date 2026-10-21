// Picking words to learn from a pasted paragraph or a photo of a page: Claude
// reads the text (vision for photos) and proposes lemmas this learner likely
// doesn't know, each with the sentence it appeared in. The server then drops
// words already in the deck and very frequent ones below the learner's
// estimated known band (en-freq.tsv ranks). One call on the autofill budget.
import type { BetaContentBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { normalizeTerm, PARTS_OF_SPEECH, type Deck, type PartOfSpeech } from '@recall/core'
import { structuredCall } from './autofill.ts'
import type { AppContext } from './context.ts'
import type { Db } from './db.ts'
import { lexiconOf, termTokens, type Lexicon } from './lexicon.ts'
import { HttpError, LANGUAGE_NAMES } from './repo.ts'
import type { User } from './users.ts'
import { vocabularySummary } from './vocab.ts'

export const MAX_CANDIDATES = 12
// Without a vocabulary test, assume the learner knows the most frequent lemmas up to this rank.
export const DEFAULT_KNOWN_BELOW = 2000
// A band counts as known when this share of its lemmas is (test or app).
const KNOWN_SHARE = 0.8
// Claude's image limit is 5 MB of base64.
export const MAX_IMAGE_BYTES = 3_750_000
const MAX_TEXT = 4000
// Deck terms passed to Claude to skip (the server filters them anyway).
const MAX_DECK_TERMS = 600

export type ImageType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
export const IMAGE_TYPES: readonly ImageType[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

export type ExtractSource =
  | { kind: 'text'; text: string }
  | { kind: 'image'; data: Uint8Array; mediaType: ImageType; caption?: string }

export interface Candidate {
  term: string
  pos: PartOfSpeech
  // The sentence of the text the word appeared in.
  sentence: string | null
  // A short translation in that context.
  gloss: string | null
}

export interface LearnerLevel {
  // In-list lemmas, test and app combined; null without the frequency list.
  estimate: number | null
  cefr: string | null
  // Single words more frequent than this rank are assumed known.
  knownBelow: number
  basis: 'test+app' | 'app' | null
}

export function learnerLevel(db: Db, userId: string, lex: Lexicon, now: Date, deckId?: string): LearnerLevel {
  const cur = lex.hasFrequencies() ? vocabularySummary(db, userId, lex, now, deckId).current : null
  if (!cur) return { estimate: null, cefr: null, knownBelow: DEFAULT_KNOWN_BELOW, basis: null }
  let knownBelow = DEFAULT_KNOWN_BELOW
  if (cur.basis === 'test+app' && cur.perBand.length) {
    const gap = cur.perBand.find((b) => Math.max(b.known, b.srs) < KNOWN_SHARE)
    knownBelow = Math.max(500, gap ? gap.from : cur.perBand.at(-1)!.to + 1)
  }
  return { estimate: cur.adjusted, cefr: cur.cefr.level?.id ?? null, knownBelow, basis: cur.basis }
}

const CANDIDATES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      description: `At most ${MAX_CANDIDATES + 6} words, most useful first.`,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['term', 'pos', 'sentence', 'gloss'],
        properties: {
          term: { type: 'string', description: 'Dictionary base form; verbs with "to"; phrasal verbs and idioms whole.' },
          pos: { type: 'string', enum: [...PARTS_OF_SPEECH] },
          sentence: { anyOf: [{ type: 'string', description: 'The sentence of the text it appears in, verbatim (line breaks and hyphenation joined).' }, { type: 'null' }] },
          gloss: { anyOf: [{ type: 'string', description: 'A short translation as used there.' }, { type: 'null' }] },
        },
      },
    },
  },
}

export function extractPrompt(deck: Pick<Deck, 'targetLang' | 'nativeLang'>, level: LearnerLevel, image: boolean): string {
  const target = LANGUAGE_NAMES[deck.targetLang] ?? deck.targetLang
  const native = LANGUAGE_NAMES[deck.nativeLang] ?? deck.nativeLang
  const where = image ? `the ${target} text in the image (a book page, a screenshot)` : `a ${target} text`
  const lvl = [
    level.cefr ? `about CEFR ${level.cefr}` : null,
    level.estimate !== null ? `a vocabulary of about ${Math.round(level.estimate / 100) * 100} lemmas` : null,
  ].filter(Boolean).join(', ')
  return `You help a ${native}-speaking learner of ${target}${lvl ? ` (${lvl})` : ''} pick words to learn from ${where}.
They very likely know the ~${level.knownBelow} most frequent ${target} lemmas.
Return the words and expressions of the text that this learner most likely does not know yet and that are worth learning: less frequent words, phrasal verbs, idioms and collocations.
Skip proper names, numbers, very common words, typos, and the terms listed as already in the learner's deck.
For each: the dictionary base form (verbs as "to …"), its part of speech, the sentence of the text where it appears (verbatim, line breaks and hyphenation joined), and a short ${native} translation as used there.
${image ? `If there is no readable ${target} text in the image, return no candidates.\n` : ''}Order by usefulness; at most ${MAX_CANDIDATES + 6}.`
}

// Normalised terms and lemmas of the deck's words (any status).
function deckTerms(db: Db, userId: string, deckId: string, lex: Lexicon): { known: Set<string>; recent: string[] } {
  const rows = db.prepare('SELECT term FROM words WHERE user_id = ? AND deck_id = ? ORDER BY created_at DESC').all(userId, deckId) as { term: string }[]
  const known = new Set<string>()
  for (const { term } of rows) {
    known.add(normalizeTerm(term))
    const l = lex.lemma(term)
    if (l) known.add(l)
  }
  return { known, recent: rows.slice(0, MAX_DECK_TERMS).map((r) => normalizeTerm(r.term)) }
}

// Drops deck words, frequent single words and repeats; at most MAX_CANDIDATES.
export function filterCandidates(raw: unknown, known: Set<string>, lex: Lexicon, knownBelow: number): Candidate[] {
  const out: Candidate[] = []
  const seen = new Set<string>()
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { candidates?: unknown }).candidates) ? (raw as { candidates: unknown[] }).candidates : []
  for (const c of list) {
    if (!c || typeof c !== 'object') continue
    const r = c as Record<string, unknown>
    const term = typeof r.term === 'string' ? r.term.replace(/\s+/g, ' ').trim() : ''
    if (!term || term.length > 100) continue
    const key = normalizeTerm(term)
    const lemma = lex.lemma(term)
    if (seen.has(key) || known.has(key) || (lemma && known.has(lemma))) continue
    if (termTokens(term).length === 1) {
      const rank = lex.rank(term)
      if (rank !== null && rank < knownBelow) continue
    }
    seen.add(key)
    const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, max) : null)
    out.push({
      term,
      pos: (PARTS_OF_SPEECH as readonly string[]).includes(String(r.pos)) ? (r.pos as PartOfSpeech) : 'other',
      sentence: str(r.sentence, 500),
      gloss: str(r.gloss, 80),
    })
    if (out.length >= MAX_CANDIDATES) break
  }
  return out
}

export async function extractCandidates(ctx: AppContext, user: User, deck: Deck, src: ExtractSource): Promise<{ candidates: Candidate[]; level: LearnerLevel }> {
  const lex = lexiconOf(ctx)
  const level = learnerLevel(ctx.db, user.id, lex, ctx.now(), deck.id)
  const { known, recent } = deckTerms(ctx.db, user.id, deck.id, lex)
  const skip = recent.length ? `\n\nAlready in the learner's deck (skip): ${recent.join(', ')}` : ''
  let content: string | BetaContentBlockParam[]
  if (src.kind === 'text') {
    const text = src.text.trim().slice(0, MAX_TEXT)
    if (!text) throw new HttpError(400, 'text is empty')
    content = `Text:\n${text}${skip}`
  } else {
    if (src.data.byteLength > MAX_IMAGE_BYTES) throw new HttpError(413, 'image is too large')
    content = [
      { type: 'image', source: { type: 'base64', media_type: src.mediaType, data: Buffer.from(src.data).toString('base64') } },
      { type: 'text', text: `${src.caption?.trim() ? `Caption: ${src.caption.trim().slice(0, 500)}\n` : ''}Pick the words from the text in this image.${skip}` },
    ]
  }
  const parsed = await structuredCall(ctx, user, {
    label: 'extract',
    detail: src.kind === 'text' ? `chars=${src.text.length}` : `image=${src.data.byteLength}`,
    system: extractPrompt(deck, level, src.kind === 'image'),
    content,
    schema: CANDIDATES_SCHEMA,
  })
  return { candidates: filterCandidates(parsed, known, lex, level.knownBelow), level }
}
