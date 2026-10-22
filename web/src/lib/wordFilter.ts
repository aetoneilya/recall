// A word's search and card state, on the device: the whole collection is
// cached, so typing filters instantly and offline (library.ts).
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
