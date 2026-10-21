import { api } from './app.svelte.ts'
import type { DeckWithCounts } from './types.ts'

// Deck list shared by the screens that only need names and ids; refetched
// after a minute or on demand.
let cached: { at: number; p: Promise<DeckWithCounts[]> } | null = null

export function getDecks(force = false): Promise<DeckWithCounts[]> {
  if (force || !cached || Date.now() - cached.at > 60_000) {
    const p = api.decks()
    cached = { at: Date.now(), p }
    p.catch(() => (cached = null))
  }
  return cached.p
}
