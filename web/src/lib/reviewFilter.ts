// The review filter's labels and one-line summary ("Phrasal verbs · B2+").
import { CEFR_LEVELS, cleanReviewFilter, tagEnabled, tagMatches, type CardType, type Cefr, type Direction, type Facet, type PartOfSpeech, type ReviewFilter } from '@recall/core'
import type { TagState } from './tagTree.ts'
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

// "B2+" when the levels run from one up to C2 (levels are OR: any of
// them); else listed in order.
export function cefrLabel(levels: Cefr[]): string {
  const idx = levels.map((l) => CEFR_LEVELS.indexOf(l)).sort((a, b) => a - b)
  const top = CEFR_LEVELS.length - 1
  const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1]! + 1)
  if (idx.length > 1 && contiguous && idx.at(-1) === top) return `${CEFR_LEVELS[idx[0]!]}+`
  return idx.map((i) => CEFR_LEVELS[i]).join(', ')
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
  if (f.tagSelection) parts.push(...filterChips({ tagSelection: f.tagSelection }).map((c) => c.label))
  return parts.join(' · ')
}

// One value toggled in one of the filter's lists; empty lists drop out.
export function toggleIn<K extends Facet>(f: ReviewFilter | null, key: K, value: NonNullable<ReviewFilter[K]>[number]): ReviewFilter | null {
  const cur = (f?.[key] ?? []) as unknown[]
  const next = cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value]
  const out: ReviewFilter = { ...(f ?? {}), [key]: next }
  if (!next.length) delete out[key]
  return Object.keys(out).length ? out : null
}

export function allIn(f: ReviewFilter | null, key: Facet): ReviewFilter | null {
  const out = { ...(f ?? {}) }
  delete out[key]
  return Object.keys(out).length ? out : null
}

type ChoiceFacet = Exclude<Facet, 'tags'>

export const choiceOn = (f: ReviewFilter | null, key: ChoiceFacet, value: string) => f?.[key] === undefined || (f[key] as string[]).includes(value)

// Missing means all checked. Keep an empty draft row until it is corrected;
// it cannot be saved as an empty array (the API reads that as unrestricted).
export function toggleChoice(f: ReviewFilter | null, key: ChoiceFacet, value: string, available: readonly string[]): ReviewFilter | null {
  const current = (f?.[key] ?? available) as readonly string[]
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value]
  if (available.every((v) => next.includes(v))) return allIn(f, key)
  return { ...f, [key]: next }
}

export function emptyChoices(f: ReviewFilter | null): boolean {
  const keys: ChoiceFacet[] = f?.types && !f.types.includes('word') ? ['types'] : ['types', 'pos', 'cefr', 'directions']
  return keys.some((k) => f?.[k] !== undefined && !f[k]!.length)
}

function tagChoices(f: ReviewFilter | null, tags: readonly string[]): NonNullable<ReviewFilter['tagSelection']> {
  if (!f?.tags?.length) return f?.tagSelection ?? {}
  // Retain an old required-tag filter until the user edits its checkboxes.
  return { values: Object.fromEntries(tags.map((t) => [t, f.tags!.some((s) => tagMatches(s, t))])), untagged: false }
}

export function reviewTagState(f: ReviewFilter | null, path: string, tags: readonly string[]): TagState {
  const selection = tagChoices(f, tags)
  const branch = [...new Set([path, ...tags.filter((t) => tagMatches(path, t))])]
  const states = branch.map((t) => tagEnabled(selection, t))
  return states.every(Boolean) ? 'on' : states.some(Boolean) ? 'mixed' : 'off'
}

function withTagChoices(f: ReviewFilter | null, selection: NonNullable<ReviewFilter['tagSelection']>): ReviewFilter | null {
  const out = { ...f }
  delete out.tags
  const clean = cleanReviewFilter({ tagSelection: selection })?.tagSelection
  if (clean) out.tagSelection = clean
  else delete out.tagSelection
  return Object.keys(out).length ? out : null
}

export function toggleReviewTag(f: ReviewFilter | null, path: string, tags: readonly string[]): ReviewFilter | null {
  const selection = tagChoices(f, tags)
  const enabled = reviewTagState(f, path, tags) !== 'on'
  const values = Object.fromEntries([...Object.entries(selection.values ?? {}).filter(([t]) => !tagMatches(path, t)), [path, enabled]])
  return withTagChoices(f, { ...selection, values })
}

export const untaggedOn = (f: ReviewFilter | null) => !f?.tags?.length && f?.tagSelection?.untagged !== false

export function toggleUntagged(f: ReviewFilter | null, tags: readonly string[]): ReviewFilter | null {
  return withTagChoices(f, { ...tagChoices(f, tags), untagged: !untaggedOn(f) })
}

export interface FilterChip {
  key: string
  label: string
  // The filter without this chip (null when nothing is left).
  without: ReviewFilter | null
}

// The active filter as removable chips: one per type, tag, part of speech and
// direction; the levels as one ("B2+", "B1, C1").
export function filterChips(f: ReviewFilter | null | undefined, langs?: [string | null, string | null]): FilterChip[] {
  if (!f) return []
  const out: FilterChip[] = []
  const drop = <K extends Facet>(k: K, v?: string) =>
    cleanReviewFilter({ ...f, [k]: v === undefined ? [] : ((f[k] ?? []) as string[]).filter((x) => x !== v) })
  for (const t of f.types ?? []) out.push({ key: `type:${t}`, label: TYPE_NAMES[t], without: drop('types', t) })
  for (const t of f.tags ?? []) out.push({ key: `tag:${t}`, label: t.split('/').join(' › '), without: drop('tags', t) })
  for (const p of f.pos ?? []) out.push({ key: `pos:${p}`, label: cap(POS_NAMES[p]), without: drop('pos', p) })
  if (f.cefr?.length) out.push({ key: 'cefr', label: cefrLabel(f.cefr), without: drop('cefr') })
  for (const d of f.directions ?? []) out.push({ key: `dir:${d}`, label: directionName(d, langs), without: drop('directions', d) })
  for (const [path, enabled] of Object.entries(f.tagSelection?.values ?? {})) {
    const values = Object.fromEntries(Object.entries(f.tagSelection!.values ?? {}).filter(([t]) => t !== path))
    out.push({ key: `tag-choice:${path}`, label: `${enabled ? 'Include' : 'Without'} ${path.split('/').join(' › ')}`, without: cleanReviewFilter({ ...f, tagSelection: { ...f.tagSelection, values } }) })
  }
  if (f.tagSelection?.untagged === false) out.push({ key: 'untagged', label: 'Without untagged', without: cleanReviewFilter({ ...f, tagSelection: { ...f.tagSelection, untagged: true } }) })
  return out
}
