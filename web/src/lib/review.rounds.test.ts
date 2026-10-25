// The review session store with its services faked: rounds after a session.
// Once it has ended, learning cards come back only BATCH at a time; fewer
// wait for tomorrow. The latch survives a reload and goes with the day.
import { BATCH, newCardState, type CardState, type QueueItem, type Word } from '@recall/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  offline: false,
  byDeck: {} as Record<string, unknown[]>,
  listeners: [] as (() => void)[],
  // The device's IndexedDB: what a reload finds (JSON, as a structured clone would keep it).
  kv: new Map<string, string>(),
}))

vi.mock('./app.svelte.ts', async () => {
  const { NetworkError } = await import('./api.ts')
  const decks = [{ id: 'A', name: 'A', hasLanguages: true, counts: { new: 0, learning: 0, review: 0 } }]
  return {
    status: { day: { timeZone: 'Europe/Moscow', startHour: 4 }, online: true },
    flushNow: async () => true,
    scheduleFlush: () => {},
    kv: {
      get: async (k: string) => (h.kv.has(k) ? JSON.parse(h.kv.get(k)!) : undefined),
      set: async (k: string, v: unknown) => void h.kv.set(k, JSON.stringify(v)),
      del: async (k: string) => void h.kv.delete(k),
    },
    outbox: { add: () => {}, undo: () => {}, pending: 0, pendingFor: () => false, onCards: () => {} },
    api: {
      queue: async (_n: number, d?: string) => {
        if (h.offline) throw new NetworkError('offline')
        const items = h.byDeck[d ?? 'A'] ?? []
        return { items, counts: { new: items.length, learning: 0, review: 0 }, decks }
      },
      practice: async () => [],
    },
  }
})
vi.mock('./decks.ts', () => ({ getDecks: async () => null, hasDeckLanguages: () => true }))
vi.mock('./toast.svelte.ts', () => ({ showToast: () => {}, errorText: (e: unknown) => String(e) }))
vi.mock('./telegram.ts', () => ({ haptic: { impact: () => {}, notify: () => {}, select: () => {} } }))

// 12:00 MSK; the study day runs to 04:00 MSK (01:00Z) tomorrow.
const T0 = Date.parse('2026-10-21T09:00:00Z')
const min = (m: number) => new Date(T0 + m * 60_000)

const word = (id: string): Word => ({
  id, deckId: 'A', term: id, pos: 'noun', translations: ['x'], ipa: null, examples: [], note: null, tags: [], freqRank: null, cefr: null,
  status: 'active', createdBy: 'user', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
})
const item = (id: string, schedule: CardState = newCardState(new Date('2026-10-01T00:00:00Z'))): QueueItem => ({
  kind: 'word',
  card: { id: `cd_${id}`, wordId: id, factId: null, direction: 'forward', suspended: false, schedule },
  word: word(id),
  deckName: 'A',
})
// A card on its second learning step, rated an hour before `due` - 10 min.
const learning = (id: string, due: Date): QueueItem => item(id, {
  due: due.toISOString(), stability: 1, difficulty: 5, elapsedDays: 0, scheduledDays: 0, learningSteps: 1, reps: 1, lapses: 0, state: 1,
  lastReview: new Date(due.getTime() - 70 * 60_000).toISOString(),
})
// Learning cards waiting at these minutes past T0 (l0, l1, …).
const waiting = (...dues: number[]) => dues.map((m, i) => learning(`l${i}`, min(m)))

async function open(at: Date) {
  vi.useFakeTimers({ now: at, toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const { session, comeBackText } = await import('./review.svelte.ts')
  await session.start()
  return Object.assign(session, { text: () => comeBackText(session.comeBack()!, Date.now()) })
}
type Session = Awaited<ReturnType<typeof open>>
const answer = (session: Session, rating: 1 | 2 | 3 | 4) => {
  vi.advanceTimersByTime(300)
  session.reveal()
  vi.advanceTimersByTime(300)
  expect(session.rate(rating)).toBe(true)
}
// A fresh store over the same device storage, as after closing the app.
async function reload() {
  await Promise.resolve() // the queued persist
  vi.resetModules()
  const { session, comeBackText } = await import('./review.svelte.ts')
  h.offline = true
  await session.start()
  return Object.assign(session, { text: () => comeBackText(session.comeBack()!, Date.now()) })
}

beforeEach(() => {
  vi.resetModules()
  h.offline = false
  h.listeners = []
  h.kv = new Map()
  const store = new Map<string, string>([['reviewDeck', 'A']])
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) })
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: (_: string, f: () => void) => void h.listeners.push(f) })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// l0 alone at 5 min (25 − the 20-min learn-ahead), nine more at 10, two at 13.
const DUES = [25, 30, 30, 30, 30, 30, 30, 30, 30, 30, 33, 33]

describe('the latch between rounds', () => {
  it('closes when the session hits empty and opens once BATCH learning cards are showable', async () => {
    expect(BATCH).toBe(10)
    h.byDeck = { A: [item('x'), ...waiting(...DUES)] }
    const session = await open(min(0))
    expect(session.current?.card.id).toBe('cd_x')
    expect(session.closed).toBe(false)
    answer(session, 4) // the last main card: nothing is showable after it
    expect(session.current).toBeNull()
    expect(session.closed).toBe(true)
    expect(session.comeBack()).toMatchObject({ n: 10 })
    expect(session.text()).toBe('Next round: 10 cards in ~10 min')
    // l0 is showable at 5 min, but alone it is no round.
    vi.advanceTimersByTime(9 * 60_000)
    expect(session.current).toBeNull()
    // The wake timer opens the round at the batch time, with the first card.
    vi.advanceTimersByTime(60_000)
    expect(session.current?.card.id).toBe('cd_l0')
    expect(session.closed).toBe(false)
    // The round runs until nothing is showable; cards coming due meanwhile join it.
    for (let i = 0; i < 9; i++) answer(session, 4)
    expect(session.current?.card.id).toBe('cd_l9')
    vi.advanceTimersByTime(3 * 60_000)
    for (const id of ['l9', 'l10', 'l11']) {
      expect(session.current?.card.id).toBe(`cd_${id}`)
      answer(session, 4)
    }
    expect(session.current).toBeNull()
    expect(session.closed).toBe(true)
    expect(session.comeBack()).toBeNull()
  })

  it("doesn't gate mid-session: a learning card due while main cards are left shows as before", async () => {
    h.byDeck = { A: [item('a'), item('b'), item('c')] }
    const session = await open(min(0))
    answer(session, 1) // a: Again, due in a minute
    expect(session.current?.card.id).toBe('cd_b')
    // Five minutes on, a is due and rested: it comes before c, alone as it is.
    vi.advanceTimersByTime(5 * 60_000)
    answer(session, 3)
    expect(session.current?.card.id).toBe('cd_a')
    expect(session.queue.main.map((x) => x.card.id)).toEqual(['cd_c'])
  })

  it("doesn't gate the day's first session: a few learning cards left from yesterday show", async () => {
    h.byDeck = { A: waiting(-20 * 60, -20 * 60 + 1) }
    const session = await open(min(0))
    expect(session.current?.card.id).toBe('cd_l0')
    expect(session.closed).toBe(false)
  })

  it('brings main cards at once with the latch closed (Check for more)', async () => {
    h.byDeck = { A: [item('x'), ...waiting(30, 31, 32)] }
    const session = await open(min(0))
    answer(session, 4)
    expect(session.closed).toBe(true)
    h.byDeck = { A: [item('fresh'), ...waiting(30, 31, 32)] }
    await session.refresh()
    expect(session.current?.card.id).toBe('cd_fresh')
    expect(session.closed).toBe(false)
  })
})

describe('fewer than BATCH left for the day', () => {
  it("don't come back today: they wait for tomorrow's first session, and show first there", async () => {
    h.byDeck = { A: [item('x'), ...waiting(30, 31, 32)] }
    const session = await open(min(0))
    answer(session, 4)
    expect(session.current).toBeNull()
    expect(session.comeBack()).toEqual({ n: 3, at: null })
    expect(session.text()).toBe('3 cards wait for tomorrow')
    // Due and rested within the hour, but never a round today; no wake timer either.
    vi.advanceTimersByTime(60 * 60_000)
    await session.refresh()
    expect(session.current).toBeNull()
    // The deck switcher's other rows leave such a deck out.
    expect(session.waitsHere('A', { new: 0, learning: 3, review: 0 })).toBe(true)
    expect(session.waitsHere('A', { new: 1, learning: 3, review: 0 })).toBe(false)
    expect(session.waitsHere('B', { new: 0, learning: 3, review: 0 })).toBe(false)
    // Tomorrow: the server's queue has them (overdue, before a new card in this list); they come first.
    vi.setSystemTime(min(24 * 60))
    h.byDeck = { A: [item('n2'), ...waiting(30, 31, 32)] }
    for (const f of h.listeners) f()
    await session.refresh()
    expect(session.closed).toBe(false)
    expect(session.current?.card.id).toBe('cd_l0')
  })
})

describe('the latch across a reload', () => {
  it('stays closed, and the round opens at the same time', async () => {
    h.byDeck = { A: [item('x'), ...waiting(...DUES)] }
    const session = await open(min(0))
    answer(session, 4)
    expect(session.closed).toBe(true)
    vi.advanceTimersByTime(6 * 60_000) // l0 is showable: an open latch would show it
    const again = await reload()
    expect(again.ended).toEqual(['A'])
    expect(again.current).toBeNull()
    expect(again.text()).toBe('Next round: 10 cards in ~4 min')
    vi.advanceTimersByTime(4 * 60_000)
    expect(again.current?.card.id).toBe('cd_l0')
  })

  it('stays open mid-round, so the round goes on with fewer than BATCH left', async () => {
    h.byDeck = { A: [item('x'), ...waiting(...DUES)] }
    const session = await open(min(0))
    answer(session, 4)
    vi.advanceTimersByTime(14 * 60_000)
    for (let i = 0; i < 6; i++) answer(session, 4)
    expect(session.current?.card.id).toBe('cd_l6')
    const again = await reload()
    expect(again.ended).toEqual([])
    expect(again.current?.card.id).toBe('cd_l6')
  })

  it('goes with the day', async () => {
    h.byDeck = { A: [item('x'), ...waiting(30)] }
    const session = await open(min(0))
    answer(session, 4)
    expect(session.ended).toEqual(['A'])
    vi.setSystemTime(min(24 * 60))
    const again = await reload()
    expect(again.ended).toEqual([])
    expect(again.current?.card.id).toBe('cd_l0')
  })
})

describe('undo and the latch', () => {
  it('undoing the last rating of a round reopens it with that card first', async () => {
    h.byDeck = { A: [item('x'), ...waiting(30, 31)] }
    const session = await open(min(0))
    answer(session, 4)
    expect(session.closed).toBe(true)
    expect(session.undo()).toBe(true)
    expect(session.current?.card.id).toBe('cd_x')
    expect(session.revealed).toBe(true)
    expect(session.closed).toBe(false)
    // Persisted too: a reload finds the round open.
    const again = await reload()
    expect(again.closed).toBe(false)
    expect(again.current?.card.id).toBe('cd_x')
  })

  it('a round that ends again after the undo closes again', async () => {
    h.byDeck = { A: [item('x'), ...waiting(30, 31)] }
    const session = await open(min(0))
    answer(session, 4)
    session.undo()
    vi.advanceTimersByTime(300)
    expect(session.rate(4)).toBe(true)
    expect(session.current).toBeNull()
    expect(session.closed).toBe(true)
    expect(session.text()).toBe('2 cards wait for tomorrow')
  })
})
