// The review session store with its services faked: what "+5 new" does at
// the end of a session, and how a session ends while cards still wait.
import { newCardState, type QueueItem, type Word } from '@recall/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GAP_MS } from './queue.ts'

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

describe('a learning card with nothing else left', () => {
  beforeEach(() => {
    h.queues = []
    h.gate = null
    h.toasts = []
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // Each test its own word and a later hour: the store is one for the file
  // and keeps today's ratings and its input lock.
  let hour = 0
  async function lone(id: string) {
    vi.useFakeTimers({ now: new Date(Date.parse('2026-10-21T06:00:00Z') + ++hour * 3600_000), toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const { session } = await import('./review.svelte.ts')
    session.deckId = 'dk_en'
    h.queues.push(page([item(id)]))
    await session.refresh()
    expect(session.current?.card.id).toBe(`cd_${id}`)
    return session
  }
  const answer = (session: Awaited<ReturnType<typeof lone>>, rating: 1 | 2 | 3 | 4) => {
    vi.advanceTimersByTime(300)
    session.reveal()
    vi.advanceTimersByTime(300)
    expect(session.rate(rating)).toBe(true)
  }

  it('ends on the summary instead of showing it again, and says when it comes back', async () => {
    const session = await lone('rumble')
    answer(session, 2) // Hard: back in 6 min, rested after 5
    expect(session.current).toBeNull()
    const back = session.comeBack()!
    expect(back.n).toBe(1)
    expect(back.at.getTime() - Date.now()).toBe(5 * 60_000)
    const { comeBackText } = await import('./review.svelte.ts')
    expect(comeBackText(back.n, back.at, Date.now())).toBe('1 card comes back in ~5 min')
    // No way to pull it early: the waiting screen's Show now is gone.
    expect('showNow' in session).toBe(false)
  })

  it('comes by itself once the gap is over (the wake timer), not at its 1-minute step', async () => {
    const session = await lone('strain')
    answer(session, 1) // Again: due in 1 min
    expect(session.current).toBeNull()
    vi.advanceTimersByTime(60_000)
    expect(session.current).toBeNull()
    vi.advanceTimersByTime(GAP_MS - 60_000 - 1_000)
    expect(session.current).toBeNull()
    vi.advanceTimersByTime(2_000)
    expect(session.current?.card.id).toBe('cd_strain')
  })

  it('with fewer than ten others, ends after the last one rather than repeating', async () => {
    vi.useFakeTimers({ now: new Date(Date.parse('2026-10-21T06:00:00Z') + ++hour * 3600_000), toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const { session } = await import('./review.svelte.ts')
    session.deckId = 'dk_en'
    h.queues.push(page([item('one'), item('two'), item('three')]))
    await session.refresh()
    for (const id of ['one', 'two', 'three']) {
      expect(session.current?.card.id).toBe(`cd_${id}`)
      answer(session, 1)
    }
    // All three due again in a minute; none comes back before 5 min.
    expect(session.current).toBeNull()
    const back = session.comeBack()!
    const { comeBackText } = await import('./review.svelte.ts')
    expect(comeBackText(back.n, back.at, Date.now())).toBe('3 cards come back in ~5 min')
    vi.advanceTimersByTime(GAP_MS)
    expect(session.current?.card.id).toBe('cd_one')
  })

  it('undo brings the rated card back at once', async () => {
    const session = await lone('court')
    answer(session, 2)
    expect(session.current).toBeNull()
    expect(session.undo()).toBe(true)
    expect(session.current?.card.id).toBe('cd_court')
    expect(session.revealed).toBe(true)
    // Rated again after the undo: the gap counts from this rating.
    vi.advanceTimersByTime(300)
    expect(session.rate(3)).toBe(true)
    expect(session.current).toBeNull()
  })

  it('peeks at the card a rating brings next', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-21T16:00:00Z'), toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const { session } = await import('./review.svelte.ts')
    session.deckId = 'dk_en'
    h.queues.push(page([item('alpha'), item('bravo')]))
    await session.refresh()
    expect(session.current?.card.id).toBe('cd_alpha')
    expect(session.peek?.card.id).toBe('cd_bravo')
  })
})
