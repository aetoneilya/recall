// A fact's search and duplicate check, on the device like the words'.
import { factKey } from '@recall/core'
import type { FactItem } from './types.ts'

const fold = (s: string) => s.toLowerCase().replace(/ё/g, 'е')

// Every space-separated piece of the query must occur in the question, the
// answer or the tags.
export function factMatches(f: FactItem, q: string): boolean {
  const parts = fold(q).split(/\s+/).filter(Boolean)
  if (!parts.length) return true
  const h = fold([f.front, f.back, ...f.tags].join('\n'))
  return parts.every((p) => h.includes(p))
}

// Another fact of the same deck with this question (the server's rule).
export function duplicateFact(all: FactItem[] | null, deckId: string, front: string, except?: string): FactItem | null {
  const k = factKey(front)
  if (!k) return null
  return all?.find((x) => x.deckId === deckId && x.id !== except && factKey(x.front) === k) ?? null
}
