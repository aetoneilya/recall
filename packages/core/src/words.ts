// Words: dedupe keys, card faces and the reverse card's blanked example.
// Server and web use the same functions so a card looks the same everywhere.
import {
  CEFR_LEVELS, PARTS_OF_SPEECH,
  type Cefr, type Direction, type Example, type PartOfSpeech, type VerbForms, type Word,
} from './types.ts'
import { cleanTag } from './tags.ts'

// "began · begun", "learned / learnt · learned / learnt": variants by " / ",
// past · participle. Word cards and the irregular-verbs pack's facts.
export function formsLine(f: VerbForms): string {
  return `${f.past.join(' / ')} · ${f.participle.join(' / ')}`
}

// "To  Frown " → "frown". The dedupe key ignores case, extra spaces and the
// infinitive "to ", so "to frown" and "frown" (both verbs) are one word.
export function normalizeTerm(term: string): string {
  return term.toLowerCase().replace(/\s+/g, ' ').trim().replace(/^to /, '')
}

// Words are unique per deck by (normalised term, part of speech): "frown"
// the verb and "frown" the noun are two words.
export function dedupeKey(term: string, pos: PartOfSpeech): string {
  return `${normalizeTerm(term)}|${pos}`
}

const POS_LABELS: Record<PartOfSpeech, string | null> = {
  noun: 'n.', verb: 'v.', adjective: 'adj.', adverb: 'adv.', phrasal_verb: 'phr. v.', idiom: 'idiom',
  phrase: 'phrase', preposition: 'prep.', conjunction: 'conj.', pronoun: 'pron.', interjection: 'interj.', other: null,
}

export function posLabel(pos: PartOfSpeech): string | null {
  return POS_LABELS[pos] ?? null
}

// Placeholders in idioms ("take the mickey out of someone") match any word.
const PLACEHOLDER = /^(someone|somebody|something|smb|smth|sb|sth|one's|oneself|your|yourself|one)$/i

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Simple English inflections of one word: frown → frowns/frowned/frowning,
// cry → cries/cried, make → making, stop → stopped/stopping.
function inflections(w: string): string[] {
  const out = new Set([w, `${w}s`, `${w}es`, `${w}ed`, `${w}d`, `${w}ing`, `${w}er`, `${w}est`])
  if (/[^aeiou]y$/.test(w)) {
    const stem = w.slice(0, -1)
    for (const s of ['ies', 'ied', 'ier', 'iest']) out.add(stem + s)
  }
  if (/e$/.test(w)) out.add(`${w.slice(0, -1)}ing`)
  if (/[^aeiou][aeiou][^aeiouwxy]$/.test(w)) {
    const last = w.at(-1)!
    for (const s of ['ed', 'ing', 'er', 'est']) out.add(w + last + s)
  }
  return [...out].sort((a, b) => b.length - a.length)
}

// The words of a term to look for in an example: no "to ", no "(it)",
// no trailing "…", "!" or "?".
function termWords(term: string): string[] {
  const t = term
    .replace(/\([^)]*\)/g, ' ')
    .replace(/…|\.\.\./g, ' ')
    .replace(/[!?,;:"“”]/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^to /, '')
  return t ? t.split(' ') : []
}

// Replaces the term (in any of its simple inflected forms) in the example
// with "___", case-insensitively. null when the term isn't found.
export function blankTerm(example: string, term: string): string | null {
  const words = termWords(term)
  if (!words.length) return null
  const parts = words.map((w) => (PLACEHOLDER.test(w) ? "[\\p{L}']+" : `(?:${inflections(w).map(esc).join('|')})`))
  const re = new RegExp(`(?<![\\p{L}'])${parts.join("[\\s-]+")}(?![\\p{L}])`, 'iu')
  if (!re.test(example)) return null
  return example.replace(new RegExp(re.source, 'giu'), '___')
}

// One side of a card. Fields that don't apply to the side are null / [].
export interface FaceSide {
  term: string | null
  ipa: string | null
  posLabel: string | null
  translations: string[]
  // Example sentence in the target language; on the reverse front the term is blanked as "___".
  example: string | null
  exampleTranslation: string | null
  note: string | null
}

export interface WordFace {
  direction: Direction
  front: FaceSide
  back: FaceSide
}

const side = (s: Partial<FaceSide>): FaceSide => ({
  term: null, ipa: null, posLabel: null, translations: [], example: null, exampleTranslation: null, note: null, ...s,
})

type FaceWord = Pick<Word, 'term' | 'pos' | 'translations' | 'ipa' | 'examples' | 'note'>

// forward (recognition): term + IPA → translations, first example, note.
// reverse (production): translations + the first example with the term
// blanked → term + IPA + the full example. When the term can't be found in
// the example, the reverse front shows the example's translation instead.
export function wordFace(word: FaceWord, direction: Direction): WordFace {
  const pos = posLabel(word.pos)
  const ex: Example | undefined = word.examples[0]
  if (direction === 'forward') {
    return {
      direction,
      front: side({ term: word.term, ipa: word.ipa, posLabel: pos }),
      back: side({ translations: word.translations, example: ex?.text ?? null, exampleTranslation: ex?.translation ?? null, note: word.note }),
    }
  }
  const blanked = ex ? blankTerm(ex.text, word.term) : null
  return {
    direction,
    front: side({
      translations: word.translations,
      posLabel: pos,
      example: blanked,
      exampleTranslation: blanked ? null : ex?.translation ?? null,
    }),
    back: side({ term: word.term, ipa: word.ipa, posLabel: pos, example: ex?.text ?? null, exampleTranslation: ex?.translation ?? null, note: word.note }),
  }
}

export interface WordInput {
  term: string
  pos: PartOfSpeech
  translations: string[]
  ipa?: string | null
  examples?: { text: string; translation?: string | null }[]
  note?: string | null
  tags?: string[]
  cefr?: Cefr | null
}

export const LIMITS = { term: 200, translation: 300, translations: 20, examples: 5, example: 500, note: 2000, tags: 30, tag: 100 }

const blankToNull = (s: string | null | undefined) => {
  const t = s?.replace(/\s+/g, ' ').trim()
  return t ? t : null
}

// "/fraʊn/" or "[fraʊn]" → "fraʊn".
export function cleanIpa(ipa: string | null | undefined): string | null {
  const t = blankToNull(ipa)
  return t ? blankToNull(t.replace(/^[/[]+|[/\]]+$/g, '')) : null
}

export type CleanWord = Required<Omit<WordInput, 'examples'>> & { examples: Example[] }

// Trims and normalises a word; returns the cleaned word or a human-readable problem.
export function cleanWord(input: WordInput): { word: CleanWord } | { error: string } {
  const term = (input.term ?? '').replace(/\s+/g, ' ').trim()
  if (!term) return { error: 'term is empty' }
  if (term.length > LIMITS.term) return { error: `term is longer than ${LIMITS.term} characters` }
  if (!PARTS_OF_SPEECH.includes(input.pos)) return { error: `unknown part of speech ${input.pos}; one of ${PARTS_OF_SPEECH.join(', ')}` }
  const translations: string[] = []
  for (const t of input.translations ?? []) {
    const s = blankToNull(t)
    if (s && !translations.includes(s)) translations.push(s)
  }
  if (!translations.length) return { error: 'at least one translation is required' }
  if (translations.length > LIMITS.translations) return { error: `at most ${LIMITS.translations} translations` }
  if (translations.some((t) => t.length > LIMITS.translation)) return { error: `a translation is longer than ${LIMITS.translation} characters` }
  const examples: Example[] = []
  for (const e of input.examples ?? []) {
    const text = blankToNull(e?.text)
    if (!text) continue
    if (text.length > LIMITS.example) return { error: `an example is longer than ${LIMITS.example} characters` }
    examples.push({ text, translation: blankToNull(e.translation) })
  }
  if (examples.length > LIMITS.examples) return { error: `at most ${LIMITS.examples} examples` }
  const note = input.note?.trim() || null
  if (note && note.length > LIMITS.note) return { error: `note is longer than ${LIMITS.note} characters` }
  const tags: string[] = []
  for (const t of input.tags ?? []) {
    const s = cleanTag(t, LIMITS.tag)
    if (s && !tags.includes(s)) tags.push(s)
  }
  if (tags.length > LIMITS.tags) return { error: `at most ${LIMITS.tags} tags` }
  const cefr = input.cefr ?? null
  if (cefr !== null && !CEFR_LEVELS.includes(cefr)) return { error: `unknown CEFR level ${cefr}` }
  return { word: { term, pos: input.pos, translations, ipa: cleanIpa(input.ipa), examples, note, tags, cefr } }
}
