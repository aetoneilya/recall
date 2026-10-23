// The whole word collection, cached on the device (cachedList.svelte.ts).
import { api, status } from './app.svelte.ts'
import { CachedList } from './cachedList.svelte.ts'
import { session } from './review.svelte.ts'
import { haptic } from './telegram.ts'
import { errorText, showToast } from './toast.svelte.ts'
import type { WordItem } from './types.ts'

class WordStore extends CachedList<WordItem> {
  constructor() {
    super({
      key: 'words',
      page: async (offset, limit) => {
        const page = await api.words({ limit, offset, status: undefined })
        return { items: page.words, total: page.total }
      },
      version: () => status.wordsVersion,
      newFirst: true,
    })
  }

  // Deletes with an undo: the word disappears at once, the DELETE goes out
  // when the toast does (or the page is hidden). Undo puts it back as it was.
  deleteWithUndo(w: WordItem, onUndo?: () => void) {
    haptic.impact('medium')
    const index = this.all?.findIndex((x) => x.id === w.id) ?? -1
    this.deleting.add(w.id)
    this.remove(w.id)
    showToast(`Deleted “${w.term}”`, {
      action: {
        label: 'Undo',
        run: () => {
          this.putBack(w, index)
          onUndo?.()
        },
      },
      expire: () => {
        api.deleteWord(w.id).then(
          () => {
            this.deleting.delete(w.id)
            session.markStale()
          },
          (e) => {
            this.putBack(w, index)
            showToast(`Not deleted: ${errorText(e)}`)
          },
        )
      },
    })
  }
}

export const words = new WordStore()
