// Every fact of the topic decks, cached on the device like the words
// (words.svelte.ts): the Topics list opens instantly, filters as you type and
// works offline. Loaded in pages of 500, patched in place after edits.
import { api, kv, status } from './app.svelte.ts'
import { session } from './review.svelte.ts'
import { haptic } from './telegram.ts'
import { errorText, showToast } from './toast.svelte.ts'
import type { FactItem } from './types.ts'

const PAGE = 500
const STALE_MS = 60_000

class FactStore {
  all = $state.raw<FactItem[] | null>(null)
  loading = $state(false)
  error = $state('')
  private loadedAt = 0
  private version = -1
  private restored = false
  // Deleted here, DELETE not sent yet (held for undo): kept out of loads.
  private deleting = new Set<string>()

  async ensure(force = false) {
    await this.restore()
    if (force || this.version !== status.factsVersion || Date.now() - this.loadedAt > STALE_MS) await this.load()
  }

  async restore() {
    if (this.restored) return
    this.restored = true
    const cached = await kv.get<FactItem[]>('facts')
    if (cached && !this.all) this.all = cached
  }

  async load() {
    if (this.loading) return
    this.loading = true
    this.touched = new Map()
    const version = status.factsVersion
    try {
      const out: FactItem[] = []
      for (let offset = 0; ; offset += PAGE) {
        const page = await api.facts({ limit: PAGE, offset })
        out.push(...page.facts)
        if (page.facts.length < PAGE || out.length >= page.total) break
      }
      // Changed here while the pages loaded: the local copy is newer.
      const touched = this.touched
      const merged = out.map((f) => touched.get(f.id) ?? f)
      for (const [id, x] of touched) if (!out.some((y) => y.id === id)) merged.unshift(x)
      this.all = merged.filter((f) => !this.deleting.has(f.id))
      this.loadedAt = Date.now()
      this.version = version
      this.error = ''
      // Without what is held for an undo: it doesn't come back on a cold start.
      void kv.set('facts', this.all)
    } catch (e) {
      this.error = errorText(e)
    } finally {
      this.loading = false
      this.touched = new Map()
    }
  }
  // What upsert changed during a load.
  private touched = new Map<string, FactItem>()

  get(id: string): FactItem | undefined {
    return this.all?.find((f) => f.id === id)
  }

  upsert(f: FactItem) {
    if (this.loading) this.touched.set(f.id, f)
    const list = this.all ?? []
    const i = list.findIndex((x) => x.id === f.id)
    this.all = i < 0 ? [...list, f] : [...list.slice(0, i), f, ...list.slice(i + 1)]
    this.save()
  }

  remove(id: string) {
    if (!this.all) return
    this.all = this.all.filter((f) => f.id !== id)
    this.save()
  }

  // Deletes with an undo: gone at once, the DELETE goes out when the toast
  // does. Undo puts it back where it was.
  deleteWithUndo(f: FactItem, onUndo?: () => void) {
    haptic.impact('medium')
    const index = this.all?.findIndex((x) => x.id === f.id) ?? -1
    this.deleting.add(f.id)
    this.remove(f.id)
    const restore = () => {
      this.deleting.delete(f.id)
      const list = this.all ?? []
      const at = index < 0 ? list.length : Math.min(index, list.length)
      if (!list.some((x) => x.id === f.id)) this.all = [...list.slice(0, at), f, ...list.slice(at)]
      this.save()
    }
    showToast('Card deleted', {
      action: {
        label: 'Undo',
        run: () => {
          restore()
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
            restore()
            showToast(`Not deleted: ${errorText(e)}`)
          },
        )
      },
    })
  }

  private save() {
    if (this.all) void kv.set('facts', this.all)
  }
}

export const facts = new FactStore()
