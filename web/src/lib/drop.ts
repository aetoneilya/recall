import { api } from './app.svelte.ts'
import { facts } from './facts.svelte.ts'
import { session } from './review.svelte.ts'
import { errorText, showToast } from './toast.svelte.ts'
import { words } from './words.svelte.ts'

// Drop: the card is never shown again but kept (status rejected), so the
// same word or question isn't added again. Undo (and Restore in the Cards
// tab) brings it back.
export async function dropCard(kind: 'word' | 'fact', id: string, text: string, on = true): Promise<boolean> {
  const plain = text.replace(/[`*_#>]/g, '').replace(/\s+/g, ' ').trim()
  const label = plain.length > 40 ? `${plain.slice(0, 39)}…` : plain
  try {
    if (kind === 'word') {
      const w = await api.dropWord(id, on)
      words.upsert(w)
      session.patchWord(w)
    } else {
      const f = await api.dropFact(id, on)
      facts.upsert(f)
      session.patchFact(f)
    }
    session.markStale()
    if (on) showToast(`Dropped “${label}”`, { action: { label: 'Undo', run: () => void dropCard(kind, id, text, false) } })
    else {
      showToast(`Restored “${label}”`)
      void session.refresh()
    }
    return true
  } catch (e) {
    showToast(errorText(e))
    return false
  }
}
