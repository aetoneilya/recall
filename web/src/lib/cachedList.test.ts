// The device-cached card lists (words, facts) with the network and IDB faked.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  kv: new Map<string, unknown>(),
  pages: null as null | (() => Promise<{ words: unknown[]; total: number }>),
}))

vi.mock('./app.svelte.ts', () => ({
  status: { wordsVersion: 0, factsVersion: 0 },
  kv: {
    get: async (k: string) => structuredClone(h.kv.get(k)),
    set: async (k: string, v: unknown) => void h.kv.set(k, structuredClone(v)),
    del: async (k: string) => void h.kv.delete(k),
  },
  api: {
    words: () => (h.pages ? h.pages() : Promise.reject(new Error('offline'))),
    facts: () => Promise.reject(new Error('offline')),
  },
}))
vi.mock('./review.svelte.ts', () => ({ session: { markStale: () => {} } }))
vi.mock('./toast.svelte.ts', () => ({ showToast: () => {}, errorText: (e: unknown) => String(e) }))
vi.mock('./telegram.ts', () => ({ haptic: { impact: () => {} } }))

const w = (id: string, note = '') => ({ id, term: id, note, deckId: 'dk', tags: [], cards: {} }) as never
const ids = (list: unknown) => (list as { id: string }[] | undefined)?.map((x) => x.id)
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('cached card lists', () => {
  beforeEach(() => {
    h.kv.clear()
    h.pages = null
    vi.resetModules()
  })

  it('an edit made before the Cards tab was opened goes into the device copy, not over it', async () => {
    h.kv.set('words', [w('a'), w('b'), w('c')])
    const { words } = await import('./words.svelte.ts')
    words.upsert(w('b', 'fixed'))
    words.remove('c')
    await tick()
    expect(ids(h.kv.get('words'))).toEqual(['a', 'b'])
    expect((h.kv.get('words') as { note: string }[])[1]!.note).toBe('fixed')
    await words.ensure()
    expect(ids(words.all)).toEqual(['a', 'b'])
  })

  it('without a device copy, one edited card is never saved as the whole list', async () => {
    const { facts } = await import('./facts.svelte.ts')
    facts.upsert(w('x'))
    await tick()
    expect(h.kv.has('facts')).toBe(false)
    expect(ids(facts.all)).toEqual(['x'])
  })

  it('a word added and undone during a paged load stays gone', async () => {
    let release!: () => void
    h.pages = () => new Promise((r) => (release = () => r({ words: [w('a'), w('n')], total: 2 })))
    const { words } = await import('./words.svelte.ts')
    const loading = words.ensure(true)
    await tick()
    words.upsert(w('n'))
    words.remove('n')
    release()
    await loading
    expect(ids(words.all)).toEqual(['a'])
    expect(ids(h.kv.get('words'))).toEqual(['a'])
  })
})
