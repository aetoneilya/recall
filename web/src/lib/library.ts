// The Cards tab's list: one deck's words, questions and grammar rules,
// searched, filtered and sorted together on the device.
import { tagAncestors, tagMatches, type CardType, type Cefr, type Direction, type PartOfSpeech, type WordStatus } from '@recall/core'
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
  state: DirState | ''
  // 'all' hides nothing; '' (the default) hides rejected cards.
  status: WordStatus | 'all' | ''
  // Words only.
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

export function libraryRows(words: WordItem[], facts: FactItem[], deckId: string, f: LibraryFilter): Row[] {
  const tagsOk = (ts: string[]) => f.tags.every((t) => ts.some((c) => tagMatches(t, c)))
  const statusOk = (s: WordStatus) => (f.status === '' ? s !== 'rejected' : f.status === 'all' || s === f.status)
  const out: Row[] = []
  if (!f.type || f.type === 'word') {
    for (const w of words) {
      if (w.deckId !== deckId || !statusOk(w.status)) continue
      if (!tagsOk(w.tags)) continue
      if (f.pos && w.pos !== f.pos) continue
      if (f.cefr && w.cefr !== f.cefr) continue
      if (f.state && !dirs.some((d) => dirState(w.cards[d]) === f.state)) continue
      if (!matches(w, f.q)) continue
      out.push({ kind: 'word', id: w.id, item: w })
    }
  }
  if (f.type !== 'word' && !f.pos && !f.cefr) {
    for (const x of facts) {
      if (x.deckId !== deckId || !statusOk(x.status)) continue
      const t = factType(x)
      if (f.type && f.type !== t) continue
      if (!tagsOk(x.tags)) continue
      if (f.state && dirState(x.card) !== f.state) continue
      if (!factMatches(x, f.q)) continue
      out.push({ kind: t, id: x.id, item: x })
    }
  }
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

// Drill-down: every choice narrows (AND), so an option's count is how many
// of the cards already shown have it too — counted on `rows`, the list under
// the full filter. A tag counts for each of its ancestors as well, once per
// card. Options at 0 don't appear; the caller keeps the selected ones.
export function libraryFacets(rows: Row[]): Facets {
  const types: Partial<Record<CardType, number>> = {}
  const tags = new Map<string, number>()
  const pos = new Map<PartOfSpeech, number>()
  const cefr = new Map<Cefr, number>()
  const states = new Map<DirState, number>()
  const bump = <K>(m: Map<K, number>, k: K) => m.set(k, (m.get(k) ?? 0) + 1)
  for (const r of rows) {
    types[r.kind] = (types[r.kind] ?? 0) + 1
    const paths = new Set<string>()
    for (const t of r.item.tags) for (const p of [...tagAncestors(t), t]) paths.add(p)
    for (const p of paths) bump(tags, p)
    const st = new Set<DirState>()
    if (r.kind === 'word') {
      bump(pos, r.item.pos)
      if (r.item.cefr) bump(cefr, r.item.cefr)
      for (const d of dirs) {
        const x = dirState(r.item.cards[d])
        if (x) st.add(x)
      }
    } else {
      const x = dirState(r.item.card)
      if (x) st.add(x)
    }
    for (const x of st) bump(states, x)
  }
  const list = <K extends string>(m: Map<K, number>) => [...m].map(([value, n]) => ({ value, n })).sort((a, b) => b.n - a.n || a.value.localeCompare(b.value))
  return { types, tags: list(tags), pos: list(pos), cefr: list(cefr), states: list(states) }
}
