// The Cards tab's list: one deck's words, questions and grammar rules,
// searched, filtered and sorted together on the device.
import type { CardType, Cefr, Direction, PartOfSpeech, WordStatus } from '@recall/core'
import { factMatches } from './factFilter.ts'
import type { FactItem, WordItem } from './types.ts'
import { dirState, matches, type DirState } from './wordFilter.ts'

export type LibrarySort = 'recent' | 'alpha' | 'freq' | 'difficulty'

export interface LibraryFilter {
  q: string
  // '' = every type.
  type: CardType | ''
  tag: string
  state: DirState | ''
  // 'all' hides nothing; '' (the default) hides rejected cards.
  status: WordStatus | 'all' | ''
  // Words only.
  pos: PartOfSpeech | ''
  cefr: Cefr | ''
  sort: LibrarySort
}

export const emptyLibraryFilter = (): LibraryFilter => ({ q: '', type: '', tag: '', state: '', status: '', pos: '', cefr: '', sort: 'recent' })

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
  const statusOk = (s: WordStatus) => (f.status === '' ? s !== 'rejected' : f.status === 'all' || s === f.status)
  const out: Row[] = []
  if (!f.type || f.type === 'word') {
    for (const w of words) {
      if (w.deckId !== deckId || !statusOk(w.status)) continue
      if (f.tag && !w.tags.includes(f.tag)) continue
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
      if (f.tag && !x.tags.includes(f.tag)) continue
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
