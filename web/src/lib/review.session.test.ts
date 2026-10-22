// The review session store with its services faked: what "+5 new" does at
// the end of a session.
import { newCardState, type QueueItem, type Word } from '@recall/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  queues: [] as { items: unknown[]; counts: { new: number; learning: number; review: number }; decks: unknown[] }[],
  gate: null as Promise<void> | null,
  toasts: [] as string[],
}))

vi.mock('./app.svelte.ts', () => {
  const deck = { id: 'dk_en', name: 'English', targetLang: 'en', nativeLang: 'ru', newPerDay: 2, forwardEnabled: true, reverseEnabled: true, reverseAfterDays: null, typeAnswer: 'off', reviewFilter: null, createdAt: '', counts: {}, tags: [] }
  return {
    status: { day: { timeZone: 'Europe/Moscow', startHour: 4 }, online: true },
    flushNow: async () => {
      if (h.gate) await h.gate
      return true
    },
    scheduleFlush: () => {},
    kv: { get: async () => undefined, set: async () => {}, del: async () => {} },
    outbox: { add: () => {}, undo: () => {}, pending: 0, pendingFor: () => false, onCards: () => {} },
    api: {
      queue: async () => h.queues.shift() ?? { items: [], counts: { new: 0, learning: 0, review: 0 }, decks: [{ id: 'dk_en', name: 'English', hasLanguages: true, counts: { new: 0, learning: 0, review: 0 } }] },
      extraNew: async () => ({ ...deck, extraNewToday: 5 }),
      decks: async () => [deck],
    },
  }
})
vi.mock('./decks.ts', () => ({ getDecks: async () => [], hasDeckLanguages: () => true }))
vi.mock('./toast.svelte.ts', () => ({ showToast: (t: string) => void h.toasts.push(t), errorText: (e: unknown) => String(e) }))
vi.mock('./telegram.ts', () => ({ haptic: { impact: () => {}, notify: () => {}, select: () => {} } }))

const word = (id: string): Word => ({
  id, deckId: 'dk_en', term: id, pos: 'noun', translations: ['x'], ipa: null, examples: [], note: null, tags: [], freqRank: null, cefr: null,
  status: 'active', createdBy: 'user', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
})
const item = (id: string): QueueItem => ({ kind: 'word', card: { id: `cd_${id}`, wordId: id, factId: null, direction: 'forward', suspended: false, schedule: newCardState(new Date()) }, word: word(id), deckName: 'English' })
const decks = [{ id: 'dk_en', name: 'English', hasLanguages: true, counts: { new: 0, learning: 0, review: 0 } }]
const page = (items: QueueItem[]) => ({ items, counts: { new: items.length, learning: 0, review: 0 }, decks })

describe('+5 new at the end of a session', () => {
  beforeEach(() => {
    h.queues = []
    h.gate = null
    h.toasts = []
  })

  it('waits for the round asked after the allowance grew, even with a refresh already on its way', async () => {
    const { session } = await import('./review.svelte.ts')
    session.deckId = 'dk_en'
    h.queues.push(page([]))
    await session.refresh()
    expect(session.current).toBeNull()
    // A refresh still uploading when +5 is tapped: its queue predates the extra allowance.
    let open!: () => void
    h.gate = new Promise((r) => (open = r))
    h.queues.push(page([]), page([item('alpha'), item('bravo')]))
    const pending = session.refresh()
    const more = session.moreNew(5)
    open()
    h.gate = null
    // When +5 is done the new cards are there (not only once the other refresh ends).
    await more
    expect(session.current?.card.id).toBe('cd_alpha')
    await pending
    expect(h.toasts).toEqual([])
  })

  it('says why when the new cards could not be loaded', async () => {
    const { session } = await import('./review.svelte.ts')
    session.deckId = 'dk_en'
    h.queues.push(page([]))
    await session.refresh()
    const { api } = await import('./app.svelte.ts')
    const queue = api.queue
    ;(api as { queue: unknown }).queue = async () => {
      throw new Error('500 queue failed')
    }
    await session.moreNew(5)
    ;(api as { queue: unknown }).queue = queue
    expect(h.toasts).toEqual(["Couldn't load the new cards: 500 queue failed"])
  })
})
