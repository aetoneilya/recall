// Every fact, cached on the device like the words (cachedList.svelte.ts).
import { api, status } from './app.svelte.ts'
import { CachedList } from './cachedList.svelte.ts'
import { session } from './review.svelte.ts'
import { haptic } from './telegram.ts'
import { errorText, showToast } from './toast.svelte.ts'
import type { FactItem } from './types.ts'

class FactStore extends CachedList<FactItem> {
  constructor() {
    super({
      key: 'facts',
      page: async (offset, limit) => {
        const page = await api.facts({ limit, offset })
        return { items: page.facts, total: page.total }
      },
      version: () => status.factsVersion,
      newFirst: false,
    })
  }

  // Deletes with an undo: gone at once, the DELETE goes out when the toast
  // does. Undo puts it back where it was.
  deleteWithUndo(f: FactItem, onUndo?: () => void) {
    haptic.impact('medium')
    const index = this.all?.findIndex((x) => x.id === f.id) ?? -1
    this.deleting.add(f.id)
    this.remove(f.id)
    showToast('Card deleted', {
      action: {
        label: 'Undo',
        run: () => {
          this.putBack(f, index)
          onUndo?.()
        },
      },
      expire: () => {
        api.deleteFact(f.id).then(
          () => {
            this.deleting.delete(f.id)
            session.markStale()
          },
          (e) => {
            this.putBack(f, index)
            showToast(`Not deleted: ${errorText(e)}`)
          },
        )
      },
    })
  }
}

export const facts = new FactStore()
