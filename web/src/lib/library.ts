// The Cards tab's list: one deck's words, questions and grammar rules,
// searched, filtered and sorted together on the device.
import { facetOptions, inReviewFilter, type CardFacts, type CardType, type Cefr, type Direction, type FacetItem, type PartOfSpeech, type ReviewFilter, type WordStatus } from '@recall/core'
import { factMatches } from './factFilter.ts'
import type { FactItem, WordItem } from './types.ts'
import { dirState, matches, type DirState } from './wordFilter.ts'

export type LibrarySort = 'recent' | 'alpha' | 'freq' | 'difficulty'

export interface LibraryFilter {
  q: string
  // '' = every type.
  type: CardType | ''
  // All of these, each with what's under it ("Grammar" takes "Grammar/Tenses").
  tags: string[]
  // A word passes when one of its cards is in this state.
  state: DirState | ''
  // 'all' hides nothing; '' (the default) hides rejected cards.
  status: WordStatus | 'all' | ''
  // Words only: other cards pass them.
  pos: PartOfSpeech | ''
  cefr: Cefr | ''
  sort: LibrarySort
}

export const emptyLibraryFilter = (): LibraryFilter => ({ q: '', type: '', tags: [], state: '', status: '', pos: '', cefr: '', sort: 'recent' })

export type Row = { kind: 'word'; id: string; item: WordItem } | { kind: 'fact' | 'rule'; id: string; item: FactItem }

// A fact with three or more active exercises is reviewed as a rule.
export const factType = (f: FactItem): 'fact' | 'rule' => ((f.exercises?.active ?? 0) >= 3 ? 'rule' : 'fact')

const fold = (s: string) => s.toLowerCase().replace(/ё/g, 'е')
const sortKey = (s: string) => fold(s).replace(/^(\*\*)?(to|a|an|the)\s+/, '').replace(/[*`_]/g, '')
const dirs: Direction[] = ['forward', 'reverse']
const lapses = (r: Row) => (r.kind === 'word' ? Math.max(r.item.cards.forward?.lapses ?? 0, r.item.cards.reverse?.lapses ?? 0) : r.item.card?.lapses ?? 0)
const created = (r: Row) => r.item.createdAt
const title = (r: Row) => (r.kind === 'word' ? r.item.term : r.item.front)

// The type, tag, part-of-speech and level picks as a review filter, so the
// list matches and counts like the review session (core.inReviewFilter /
// facetOptions): one value per single-valued facet, tags AND.
const asReviewFilter = (f: LibraryFilter): ReviewFilter => ({
  types: f.type ? [f.type] : [],
  tags: f.tags,
  pos: f.pos ? [f.pos] : [],
  cefr: f.cefr ? [f.cefr] : [],
})

// A row for the shared filter. No direction: the tab doesn't filter by it.
const cardFacts = (r: Row): CardFacts & FacetItem =>
  r.kind === 'word' ? { type: 'word', tags: r.item.tags, pos: r.item.pos, cefr: r.item.cefr } : { type: r.kind, tags: r.item.tags }

const statesOf = (r: Row): Set<DirState> => {
  const xs = r.kind === 'word' ? dirs.map((d) => dirState(r.item.cards[d])) : [dirState(r.item.card)]
  return new Set(xs.filter((x): x is DirState => !!x))
}

// The deck's cards under the status picked and the search: what every
// facet is counted among.
function searched(words: WordItem[], facts: FactItem[], deckId: string, f: LibraryFilter): Row[] {
  const statusOk = (s: WordStatus) => (f.status === '' ? s !== 'rejected' : f.status === 'all' || s === f.status)
  const out: Row[] = []
  for (const w of words) if (w.deckId === deckId && statusOk(w.status) && matches(w, f.q)) out.push({ kind: 'word', id: w.id, item: w })
  for (const x of facts) if (x.deckId === deckId && statusOk(x.status) && factMatches(x, f.q)) out.push({ kind: factType(x), id: x.id, item: x })
  return out
}

export function libraryRows(words: WordItem[], facts: FactItem[], deckId: string, f: LibraryFilter): Row[] {
  const rf = asReviewFilter(f)
  const out = searched(words, facts, deckId, f).filter((r) => inReviewFilter(rf, cardFacts(r)) && (!f.state || statesOf(r).has(f.state)))
  const by: Record<LibrarySort, (a: Row, b: Row) => number> = {
    recent: (a, b) => created(b).localeCompare(created(a)) || a.id.localeCompare(b.id),
    alpha: (a, b) => sortKey(title(a)).localeCompare(sortKey(title(b))),
    freq: (a, b) => ((a.kind === 'word' ? a.item.freqRank : null) ?? Infinity) - ((b.kind === 'word' ? b.item.freqRank : null) ?? Infinity) || sortKey(title(a)).localeCompare(sortKey(title(b))),
    difficulty: (a, b) => lapses(b) - lapses(a) || sortKey(title(a)).localeCompare(sortKey(title(b))),
  }
  return out.sort(by[f.sort])
}

// What a deck has, for the type chips and the tag picker.
// The header's "n of total": the deck's cards under the status picked alone
// (Dropped counts dropped ones), so the rows shown are always part of it.
export function deckTotal(words: WordItem[], facts: FactItem[], deckId: string, status: LibraryFilter['status']): number {
  return libraryRows(words, facts, deckId, { ...emptyLibraryFilter(), status }).length
}

export function deckContents(words: WordItem[], facts: FactItem[], deckId: string): { types: Record<CardType, number>; tags: { tag: string; n: number }[] } {
  const types: Record<CardType, number> = { word: 0, fact: 0, rule: 0 }
  const tags = new Map<string, number>()
  const add = (ts: string[]) => {
    for (const t of ts) tags.set(t, (tags.get(t) ?? 0) + 1)
  }
  for (const w of words) if (w.deckId === deckId && w.status !== 'rejected') (types.word++, add(w.tags))
  for (const x of facts) if (x.deckId === deckId && x.status !== 'rejected') (types[factType(x)]++, add(x.tags))
  return { types, tags: [...tags].map(([tag, n]) => ({ tag, n })).sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag)) }
}

export interface Facets {
  types: Partial<Record<CardType, number>>
  tags: { value: string; n: number }[]
  pos: { value: PartOfSpeech; n: number }[]
  cefr: { value: Cefr; n: number }[]
  states: { value: DirState; n: number }[]
}

// The pickers' options, as the review filter sheet counts them
// (core.facetOptions): a type, part of speech, level or state counted under
// the other picks (so the rest of its facet stays on offer), a tag under all
// of them plus that tag (tags AND); options at 0 are hidden, picked ones
// always stay. A tag counts for each of its ancestors too, once per card.
export function libraryFacets(words: WordItem[], facts: FactItem[], deckId: string, f: LibraryFilter): Facets {
  const rows = searched(words, facts, deckId, f)
  const rf = asReviewFilter(f)
  const shared = facetOptions(rows.filter((r) => !f.state || statesOf(r).has(f.state)).map(cardFacts), rf)
  const states = new Map<DirState, number>(f.state ? [[f.state, 0]] : [])
  for (const r of rows) if (inReviewFilter(rf, cardFacts(r))) for (const x of statesOf(r)) states.set(x, (states.get(x) ?? 0) + 1)
  return {
    types: Object.fromEntries(shared.types.map((t) => [t.value, t.n])),
    tags: shared.tags,
    pos: shared.pos,
    cefr: shared.cefr,
    states: [...states].map(([value, n]) => ({ value, n })).sort((a, b) => b.n - a.n || a.value.localeCompare(b.value)),
  }
}
