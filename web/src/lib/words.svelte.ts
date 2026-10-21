// The whole word collection, cached on the device so the Words screen opens
// instantly, filters as you type and works offline. Loaded in pages of 500,
// refreshed in the background, patched in place after edits.
import { api, kv, status } from './app.svelte.ts'
import { session } from './review.svelte.ts'
import { errorText, showToast } from './toast.svelte.ts'
import type { WordItem } from './types.ts'

const PAGE = 500
const STALE_MS = 60_000

class WordStore {
  all = $state.raw<WordItem[] | null>(null)
  loading = $state(false)
  error = $state('')
  private loadedAt = 0
  private version = -1
  private restored = false
  // Deleted here, DELETE not sent yet (held for undo): kept out of loads.
  private deleting = new Set<string>()

  // Paints from the cache, then refetches if it is older than a minute (or
  // words changed elsewhere, e.g. offline adds just synced).
  async ensure(force = false) {
    if (!this.restored) {
      this.restored = true
      const cached = await kv.get<WordItem[]>('words')
      if (cached && !this.all) this.all = cached
    }
    if (force || this.version !== status.wordsVersion || Date.now() - this.loadedAt > STALE_MS) await this.load()
  }

  async load() {
    if (this.loading) return
    this.loading = true
    const version = status.wordsVersion
    try {
      const out: WordItem[] = []
      for (let offset = 0; ; offset += PAGE) {
        const page = await api.words({ limit: PAGE, offset, status: undefined })
        out.push(...page.words)
        if (page.words.length < PAGE || out.length >= page.total) break
      }
      this.all = out.filter((w) => !this.deleting.has(w.id))
      this.loadedAt = Date.now()
      this.version = version
      this.error = ''
      void kv.set('words', out)
    } catch (e) {
      this.error = errorText(e)
    } finally {
      this.loading = false
    }
  }

  get(id: string): WordItem | undefined {
    return this.all?.find((w) => w.id === id)
  }

  upsert(w: WordItem) {
    const list = this.all ?? []
    const i = list.findIndex((x) => x.id === w.id)
    this.all = i < 0 ? [w, ...list] : [...list.slice(0, i), w, ...list.slice(i + 1)]
    this.save()
  }

  remove(id: string) {
    if (!this.all) return
    this.all = this.all.filter((w) => w.id !== id)
    this.save()
  }

  // Deletes with an undo: the word disappears at once, the DELETE goes out
  // when the toast does (or the page is hidden). Undo puts it back as it was.
  deleteWithUndo(w: WordItem, onUndo?: () => void) {
    const index = this.all?.findIndex((x) => x.id === w.id) ?? -1
    this.deleting.add(w.id)
    this.remove(w.id)
    const restore = () => {
      this.deleting.delete(w.id)
      const list = this.all ?? []
      const at = index < 0 ? 0 : Math.min(index, list.length)
      if (!list.some((x) => x.id === w.id)) this.all = [...list.slice(0, at), w, ...list.slice(at)]
      this.save()
    }
    showToast(`Deleted “${w.term}”`, {
      action: {
        label: 'Undo',
        run: () => {
          restore()
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
            restore()
            showToast(`Not deleted: ${errorText(e)}`)
          },
        )
      },
    })
  }

  private save() {
    if (this.all) void kv.set('words', this.all)
  }
}

export const words = new WordStore()
