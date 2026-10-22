import { hasDeckLanguages } from './decks.ts'
import { navigate } from './router.svelte.ts'
import type { DeckSettings } from './types.ts'

// "+" opens the add screen straight away, as the type used last (a word,
// a question or a grammar rule; a word only in a deck with languages), into
// the given deck. The screens switch type in place (AddTypeSwitch).
export type AddType = 'word' | 'question' | 'rule'
const KEY = 'addType'

export function lastAddType(): AddType {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'question' || v === 'rule' ? v : 'word'
  } catch {
    return 'word'
  }
}

export function rememberAddType(t: AddType) {
  try {
    localStorage.setItem(KEY, t)
  } catch {
    // Not remembered: the next "+" opens a word.
  }
}

export function addPath(type: AddType, deck: Pick<DeckSettings, 'id' | 'targetLang' | 'nativeLang'> | undefined, from: string, term?: string): string {
  const t = type === 'word' && deck && !hasDeckLanguages(deck) ? 'question' : type
  const q = `?from=${encodeURIComponent(from)}${deck ? `&deck=${encodeURIComponent(deck.id)}` : ''}${term ? `&term=${encodeURIComponent(term)}` : ''}`
  return t === 'word' ? `/add${q}` : `/fact/new${q}${t === 'rule' ? '&rule=1' : ''}`
}

export function openAdd(deck: Pick<DeckSettings, 'id' | 'targetLang' | 'nativeLang'> | undefined, from: string, opts: { type?: AddType; term?: string } = {}) {
  navigate(addPath(opts.type ?? lastAddType(), deck, from, opts.term))
}
