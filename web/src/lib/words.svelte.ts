// The whole word collection, cached on the device so the Words screen opens
// instantly, filters as you type and works offline. Loaded in pages of 500,
// refreshed in the background, patched in place after edits.
import { api, kv, status } from './app.svelte.ts'
import { session } from './review.svelte.ts'
import { haptic } from './telegram.ts'
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
    await this.restore()
    if (force || this.version !== status.wordsVersion || Date.now() - this.loadedAt > STALE_MS) await this.load()
  }

  // The device's copy only, no network: for a screen that paints from it
  // while fetching something smaller of its own.
  async restore() {
    if (this.restored) return
    this.restored = true
    const cached = await kv.get<WordItem[]>('words')
    if (cached && !this.all) this.all = cached
  }

  async load() {
    if (this.loading) return
    this.loading = true
    this.touched = new Map()
    const version = status.wordsVersion
    try {
      const out: WordItem[] = []
      for (let offset = 0; ; offset += PAGE) {
        const page = await api.words({ limit: PAGE, offset, status: undefined })
        out.push(...page.words)
        if (page.words.length < PAGE || out.length >= page.total) break
      }
      // Changed here while the pages loaded: the local copy is newer.
      const touched = this.touched
      const merged = out.map((w) => touched.get(w.id) ?? w)
      for (const [id, x] of touched) if (!out.some((y) => y.id === id)) merged.unshift(x)
      this.all = merged.filter((w) => !this.deleting.has(w.id))
      this.loadedAt = Date.now()
      this.version = version
      this.error = ''
      // Without what is held for an undo: it doesn't come back on a cold start.
      void kv.set('words', this.all)
    } catch (e) {
      this.error = errorText(e)
    } finally {
      this.loading = false
      this.touched = new Map()
    }
  }
  // What upsert changed during a load.
  private touched = new Map<string, WordItem>()

  get(id: string): WordItem | undefined {
    return this.all?.find((w) => w.id === id)
  }

  upsert(w: WordItem) {
    if (this.loading) this.touched.set(w.id, w)
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
    haptic.impact('medium')
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
