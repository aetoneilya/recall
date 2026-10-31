// Editable form state for a word (add screen and editor) and its
// conversion to the API's WordInput. Strings stay strings while editing;
// empty fields become null on the way out.
import { withWordTopics, type Cefr, type PartOfSpeech, type WordInput } from '@recall/core'
import type { Draft } from './types.ts'

export interface ExampleForm {
  text: string
  translation: string
}

export interface WordForm {
  term: string
  pos: PartOfSpeech
  translations: string[]
  ipa: string
  examples: ExampleForm[]
  note: string
  tags: string
  cefr: Cefr | ''
}

export const POS_NAMES: Record<PartOfSpeech, string> = {
  noun: 'noun', verb: 'verb', adjective: 'adjective', adverb: 'adverb', phrasal_verb: 'phrasal verb', idiom: 'idiom',
  phrase: 'phrase', preposition: 'preposition', conjunction: 'conjunction', pronoun: 'pronoun', interjection: 'interjection', other: 'other',
}

// A part of speech to start manual entry with: "to X up" phrasal verb,
// "to X" verb, several words phrase, else noun.
export function guessPos(term: string): PartOfSpeech {
  const t = term.trim().toLowerCase().replace(/\s+/g, ' ')
  if (/^to \S+ (up|out|off|on|in|down|over|away|back|through|around|about|along|by|for|after|into)$/.test(t)) return 'phrasal_verb'
  if (/^to \S+$/.test(t)) return 'verb'
  if (t.includes(' ')) return 'phrase'
  return 'noun'
}

export function emptyForm(term = '', tags = ''): WordForm {
  return { term, pos: guessPos(term), translations: [], ipa: '', examples: [], note: '', tags, cefr: '' }
}

type Fill = Pick<Draft, 'term' | 'pos' | 'translations' | 'ipa' | 'examples' | 'note' | 'cefr'> & { tags?: string[] }

export function formFrom(w: Fill): WordForm {
  return {
    term: w.term,
    pos: w.pos,
    translations: [...w.translations],
    ipa: w.ipa ?? '',
    examples: w.examples.map((e) => ({ text: e.text, translation: e.translation ?? '' })),
    note: w.note ?? '',
    tags: (w.tags ?? []).join(', '),
    cefr: w.cefr ?? '',
  }
}

// Keep provenance/manual tags, replace only the previous autofill's topic.
export function withDraftTags(current: string, previous: string[], proposed: string[] = []): { tags: string; autoTags: string[] } {
  const result = withWordTopics(current.split(',').map((t) => t.trim()).filter(Boolean), previous, proposed)
  return { tags: result.tags.join(', '), autoTags: result.autoTags }
}

const orNull = (s: string) => (s.trim() ? s.trim() : null)

export function formToInput(f: WordForm): WordInput {
  return {
    term: f.term.trim(),
    pos: f.pos,
    translations: f.translations.map((t) => t.trim()).filter(Boolean),
    ipa: orNull(f.ipa.replace(/^[/[]+|[/\]]+$/g, '')),
    examples: f.examples.filter((e) => e.text.trim()).map((e) => ({ text: e.text.trim(), translation: orNull(e.translation) })),
    note: orNull(f.note),
    tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean),
    cefr: f.cefr || null,
  }
}

// The sentence the word was met in leads the examples (unless already there).
export function withContext(examples: ExampleForm[], context: string): ExampleForm[] {
  const c = context.replace(/\s+/g, ' ').trim()
  if (!c) return examples
  const same = examples.find((e) => e.text.trim().toLowerCase() === c.toLowerCase())
  return [{ text: c, translation: same?.translation ?? '' }, ...examples.filter((e) => e !== same)].slice(0, 5)
}

// Translations to add to an existing word: the new ones, case-insensitively.
export function newTranslations(existing: string[], proposed: string[]): string[] {
  const have = new Set(existing.map((t) => t.trim().toLowerCase()))
  return proposed.filter((t) => t.trim() && !have.has(t.trim().toLowerCase()))
}
