import { api } from './app.svelte.ts'
import type { DeckPatch, DeckWithCounts } from './types.ts'

// Deck list shared by the screens that only need names and ids; refetched
// after a minute or on demand.
let cached: { at: number; p: Promise<DeckWithCounts[]> } | null = null
const saving = new Map<string, Promise<unknown>>()

// Keep rapid edits ordered, and let a newly opened screen read after them.
export function saveDeck(id: string, patch: DeckPatch) {
  const before = saving.get(id) ?? Promise.resolve()
  const p = before.catch(() => {}).then(() => api.patchDeck(id, patch))
  saving.set(id, p)
  cached = null
  const settle = () => {
    if (saving.get(id) === p) saving.delete(id)
    cached = null
  }
  void p.then(settle, settle)
  return p
}

export function getDecks(force = false): Promise<DeckWithCounts[]> {
  if (force || !cached || Date.now() - cached.at > 60_000) {
    const p = saving.size ? Promise.allSettled([...saving.values()]).then(() => api.decks()) : api.decks()
    cached = { at: Date.now(), p }
    p.catch(() => (cached = null))
  }
  return cached.p
}

// A deck with languages takes words.
export const hasDeckLanguages = (d: { targetLang: string | null; nativeLang: string | null }) => !!d.targetLang && !!d.nativeLang
