// A whole collection (every word, every fact) cached on the device so the
// Cards tab opens instantly, filters as you type and works offline. Loaded in
// pages of 500, refreshed in the background, patched in place after edits.
import { kv } from './app.svelte.ts'
import { errorText } from './toast.svelte.ts'

const PAGE = 500
const STALE_MS = 60_000

type Edit<T> = (list: T[]) => T[]

export interface ListSource<T> {
  key: string
  page: (offset: number, limit: number) => Promise<{ items: T[]; total: number }>
  // Bumped when the collection changed elsewhere (offline adds just synced).
  version: () => number
  // Where a new item goes: words show newest first, facts in creation order.
  newFirst: boolean
}

// The loaded pages with what was changed here meanwhile (null = removed): the
// local copy is newer than a page fetched before the change.
export function mergeTouched<T extends { id: string }>(pages: T[], touched: Map<string, T | null>): T[] {
  const merged = pages.flatMap((x) => (touched.has(x.id) ? (touched.get(x.id) ? [touched.get(x.id)!] : []) : [x]))
  for (const [id, x] of touched) if (x && !pages.some((y) => y.id === id)) merged.unshift(x)
  return merged
}

export class CachedList<T extends { id: string }> {
  all = $state.raw<T[] | null>(null)
  loading = $state(false)
  error = $state('')
  private src: ListSource<T>
  private loadedAt = 0
  private version = -1
  private restoring: Promise<void> | null = null
  // `all` is the whole collection (restored or loaded), not only edits made
  // before it arrived. Only a whole list is saved: one edited card must never
  // replace the device's copy.
  private whole = false
  // Edits made before the cache was read, replayed onto it when it is.
  private early: Edit<T>[] = []
  // What changed here during a load (null = removed).
  private touched = new Map<string, T | null>()
  // Deleted here, DELETE not sent yet (held for undo): kept out of loads.
  protected deleting = new Set<string>()

  constructor(src: ListSource<T>) {
    this.src = src
  }

  // Paints from the cache, then refetches if it is older than a minute (or
  // the collection changed elsewhere).
  async ensure(force = false) {
    await this.restore()
    if (force || this.version !== this.src.version() || Date.now() - this.loadedAt > STALE_MS) await this.load()
  }

  // The device's copy only, no network. One read, shared by every caller.
  restore(): Promise<void> {
    this.restoring ??= (async () => {
      const cached = await kv.get<T[]>(this.src.key)
      if (this.whole || !cached) return
      const edited = this.early.length > 0
      this.all = this.early.reduce((list, edit) => edit(list), cached)
      this.early = []
      this.whole = true
      if (edited) this.save()
    })()
    return this.restoring
  }

  async load() {
    if (this.loading) return
    this.loading = true
    this.touched = new Map()
    const version = this.src.version()
    try {
      const out: T[] = []
      for (let offset = 0; ; offset += PAGE) {
        const page = await this.src.page(offset, PAGE)
        out.push(...page.items)
        if (page.items.length < PAGE || out.length >= page.total) break
      }
      this.all = mergeTouched(out, this.touched).filter((x) => !this.deleting.has(x.id))
      this.whole = true
      this.early = []
      this.loadedAt = Date.now()
      this.version = version
      this.error = ''
      // Without what is held for an undo: it doesn't come back on a cold start.
      this.save()
    } catch (e) {
      this.error = errorText(e)
    } finally {
      this.loading = false
      this.touched = new Map()
    }
  }

  get(id: string): T | undefined {
    return this.all?.find((x) => x.id === id)
  }

  upsert(item: T) {
    this.change(item.id, item, (list) => {
      const i = list.findIndex((x) => x.id === item.id)
      if (i >= 0) return [...list.slice(0, i), item, ...list.slice(i + 1)]
      return this.src.newFirst ? [item, ...list] : [...list, item]
    })
  }

  remove(id: string) {
    this.change(id, null, (list) => list.filter((x) => x.id !== id))
  }

  // Puts back an item removed for an undo, where it was.
  protected putBack(item: T, index: number) {
    this.deleting.delete(item.id)
    this.change(item.id, item, (list) => {
      if (list.some((x) => x.id === item.id)) return list
      const at = index < 0 ? (this.src.newFirst ? 0 : list.length) : Math.min(index, list.length)
      return [...list.slice(0, at), item, ...list.slice(at)]
    })
  }

  private change(id: string, value: T | null, edit: Edit<T>) {
    if (this.loading) this.touched.set(id, value)
    if (this.all || value) this.all = edit(this.all ?? [])
    if (this.whole) this.save()
    else {
      this.early.push(edit)
      void this.restore()
    }
  }

  private save() {
    if (this.whole && this.all) void kv.set(this.src.key, this.all)
  }
}
