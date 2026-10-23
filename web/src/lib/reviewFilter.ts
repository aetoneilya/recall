// The review filter's labels and one-line summary ("Phrasal verbs · B2").
import { CEFR_LEVELS, cleanReviewFilter, type CardType, type Cefr, type Direction, type PartOfSpeech, type ReviewFilter } from '@recall/core'
import { POS_NAMES } from './wordForm.ts'

export const TYPE_NAMES: Record<CardType, string> = { word: 'Words', fact: 'Q&A', rule: 'Grammar' }

const PLURAL: Partial<Record<PartOfSpeech, string>> = {
  noun: 'nouns', verb: 'verbs', adjective: 'adjectives', adverb: 'adverbs', phrasal_verb: 'phrasal verbs', idiom: 'idioms', phrase: 'phrases',
  preposition: 'prepositions', conjunction: 'conjunctions', pronoun: 'pronouns', interjection: 'interjections',
}
export const posPlural = (p: PartOfSpeech) => PLURAL[p] ?? POS_NAMES[p]

export function directionName(d: Direction, langs: [string | null, string | null] = ['en', 'ru']): string {
  const [t, n] = langs.map((l) => (l ?? '').toUpperCase())
  return d === 'forward' ? `${t} → ${n}` : `${n} → ${t}`
}

// The levels in order. Never "B2+": the filter drills down, so several
// levels select the cards that have all of them (none), not a range.
export function cefrLabel(levels: Cefr[]): string {
  return [...levels].sort((a, b) => CEFR_LEVELS.indexOf(a) - CEFR_LEVELS.indexOf(b)).join(', ')
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

// Empty for no filter.
export function filterSummary(f: ReviewFilter | null | undefined, langs?: [string | null, string | null]): string {
  if (!f) return ''
  const parts: string[] = []
  if (f.types?.length) parts.push(f.types.map((t) => TYPE_NAMES[t]).join(', '))
  // Paths by their last part: "Grammar/Tenses" → "Tenses".
  if (f.tags?.length) parts.push(f.tags.map((t) => t.slice(t.lastIndexOf('/') + 1)).join(', '))
  if (f.pos?.length) parts.push(cap(f.pos.map(posPlural).join(', ')))
  if (f.cefr?.length) parts.push(cefrLabel(f.cefr))
  if (f.directions?.length === 1) parts.push(directionName(f.directions[0]!, langs))
  return parts.join(' · ')
}

// One value toggled in one of the filter's lists; empty lists drop out.
export function toggleIn<K extends keyof ReviewFilter>(f: ReviewFilter | null, key: K, value: NonNullable<ReviewFilter[K]>[number]): ReviewFilter | null {
  const cur = (f?.[key] ?? []) as unknown[]
  const next = cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value]
  const out: ReviewFilter = { ...(f ?? {}), [key]: next }
  if (!next.length) delete out[key]
  return Object.keys(out).length ? out : null
}

export interface FilterChip {
  key: string
  label: string
  // The filter without this chip (null when nothing is left).
  without: ReviewFilter | null
}

// The active filter as removable chips: one per type, tag, part of speech and
// direction; the levels as one ("B2, C1").
export function filterChips(f: ReviewFilter | null | undefined, langs?: [string | null, string | null]): FilterChip[] {
  if (!f) return []
  const out: FilterChip[] = []
  const drop = <K extends keyof ReviewFilter>(k: K, v?: string) =>
    cleanReviewFilter({ ...f, [k]: v === undefined ? [] : ((f[k] ?? []) as string[]).filter((x) => x !== v) })
  for (const t of f.types ?? []) out.push({ key: `type:${t}`, label: TYPE_NAMES[t], without: drop('types', t) })
  for (const t of f.tags ?? []) out.push({ key: `tag:${t}`, label: t.split('/').join(' › '), without: drop('tags', t) })
  for (const p of f.pos ?? []) out.push({ key: `pos:${p}`, label: cap(POS_NAMES[p]), without: drop('pos', p) })
  if (f.cefr?.length) out.push({ key: 'cefr', label: cefrLabel(f.cefr), without: drop('cefr') })
  for (const d of f.directions ?? []) out.push({ key: `dir:${d}`, label: directionName(d, langs), without: drop('directions', d) })
  return out
}
