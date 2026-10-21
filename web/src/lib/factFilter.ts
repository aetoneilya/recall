// Search and filters for the Topics list, on the device like the words'.
import { factKey, type FactStatus } from '@recall/core'
import type { FactItem } from './types.ts'
import { dirState, type DirState } from './wordFilter.ts'

export interface FactFilter {
  q: string
  // A topic deck id, '' = every topic.
  deck: string
  state: DirState | ''
  // 'all' hides nothing; '' (the default) hides rejected facts.
  status: FactStatus | 'all' | ''
}

export const emptyFactFilter = (): FactFilter => ({ q: '', deck: '', state: '', status: '' })

const fold = (s: string) => s.toLowerCase().replace(/ё/g, 'е')

// Every space-separated piece of the query must occur in the question, the
// answer or the tags.
export function factMatches(f: FactItem, q: string): boolean {
  const parts = fold(q).split(/\s+/).filter(Boolean)
  if (!parts.length) return true
  const h = fold([f.front, f.back, ...f.tags].join('\n'))
  return parts.every((p) => h.includes(p))
}

// Filtered, grouped by topic in `deckOrder` (unknown decks last), and within
// a topic in the order the facts were written.
export function filterFacts(all: FactItem[], f: FactFilter, deckOrder: string[] = []): FactItem[] {
  const rank = (id: string) => {
    const i = deckOrder.indexOf(id)
    return i < 0 ? deckOrder.length : i
  }
  return all
    .filter((x) => {
      if (f.status === '' ? x.status === 'rejected' : f.status !== 'all' && x.status !== f.status) return false
      if (f.deck && x.deckId !== f.deck) return false
      if (f.state && dirState(x.card) !== f.state) return false
      return factMatches(x, f.q)
    })
    .sort((a, b) => rank(a.deckId) - rank(b.deckId) || a.deckName.localeCompare(b.deckName) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

// Consecutive runs of one topic, for section headers.
export function groupByDeck(list: FactItem[]): { deckId: string; deckName: string; facts: FactItem[] }[] {
  const out: { deckId: string; deckName: string; facts: FactItem[] }[] = []
  for (const x of list) {
    const last = out.at(-1)
    if (last && last.deckId === x.deckId) last.facts.push(x)
    else out.push({ deckId: x.deckId, deckName: x.deckName, facts: [x] })
  }
  return out
}

// Another fact of the same topic with this question (the server's rule).
export function duplicateFact(all: FactItem[] | null, deckId: string, front: string, except?: string): FactItem | null {
  const k = factKey(front)
  if (!k) return null
  return all?.find((x) => x.deckId === deckId && x.id !== except && factKey(x.front) === k) ?? null
}
