// Search, filters and sorting for the word list, done on the device: the
// whole collection is cached, so typing filters instantly and offline.
import type { Cefr, Direction, PartOfSpeech, WordStatus } from '@recall/core'
import type { CardSummary, WordItem } from './types.ts'

// What a direction's card is to the learner right now.
export type DirState = 'new' | 'learning' | 'known' | 'fading' | 'suspended' | 'off'
export const DIR_STATES: readonly DirState[] = ['new', 'learning', 'known', 'fading', 'suspended']

// Known = review state with retrievability ≥ 0.9, as on the server.
export function dirState(c: CardSummary | null | undefined): DirState | null {
  if (!c) return null
  if (!c.enabled) return 'off'
  if (c.suspended) return 'suspended'
  if (c.state === 'new') return 'new'
  if (c.state === 'learning' || c.state === 'relearning') return 'learning'
  return (c.retrievability ?? 0) >= 0.9 ? 'known' : 'fading'
}

export type WordSort = 'recent' | 'alpha' | 'freq' | 'difficulty'

export interface WordFilter {
  q: string
  // 'all' hides nothing; '' (the default) hides rejected words.
  status: WordStatus | 'all' | ''
  pos: PartOfSpeech | ''
  cefr: Cefr | ''
  state: DirState | ''
  sort: WordSort
}

export const emptyFilter = (): WordFilter => ({ q: '', status: '', pos: '', cefr: '', state: '', sort: 'recent' })

const fold = (s: string) => s.toLowerCase().replace(/ё/g, 'е')

function haystack(w: WordItem): string {
  return fold(
    [w.term, ...w.translations, ...w.examples.flatMap((e) => [e.text, e.translation ?? '']), w.note ?? '', ...w.tags].join('\n'),
  )
}

// Every space-separated piece of the query must occur somewhere in the word.
export function matches(w: WordItem, q: string): boolean {
  const parts = fold(q).split(/\s+/).filter(Boolean)
  if (!parts.length) return true
  const h = haystack(w)
  return parts.every((p) => h.includes(p))
}

const sortKey = (term: string) => fold(term).replace(/^(to|a|an|the)\s+/, '')
const maxLapses = (w: WordItem) => Math.max(w.cards.forward?.lapses ?? 0, w.cards.reverse?.lapses ?? 0)
const maxDifficulty = (w: WordItem) => Math.max(w.cards.forward?.difficulty ?? 0, w.cards.reverse?.difficulty ?? 0)

export function filterWords(words: WordItem[], f: WordFilter): WordItem[] {
  const dirs: Direction[] = ['forward', 'reverse']
  const out = words.filter((w) => {
    if (f.status === '' ? w.status === 'rejected' : f.status !== 'all' && w.status !== f.status) return false
    if (f.pos && w.pos !== f.pos) return false
    if (f.cefr && w.cefr !== f.cefr) return false
    if (f.state && !dirs.some((d) => dirState(w.cards[d]) === f.state)) return false
    return matches(w, f.q)
  })
  const by: Record<WordSort, (a: WordItem, b: WordItem) => number> = {
    recent: (a, b) => b.createdAt.localeCompare(a.createdAt),
    alpha: (a, b) => sortKey(a.term).localeCompare(sortKey(b.term)),
    freq: (a, b) => (a.freqRank ?? Infinity) - (b.freqRank ?? Infinity) || sortKey(a.term).localeCompare(sortKey(b.term)),
    difficulty: (a, b) => maxLapses(b) - maxLapses(a) || maxDifficulty(b) - maxDifficulty(a),
  }
  return out.sort(by[f.sort])
}
