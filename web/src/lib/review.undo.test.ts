// The review session store with its services faked: undo takes back one
// rating only, the study day turns without a server, a deck's cached queue
// keeps what was done to it, and the minimum gap survives a reload.
import { newCardState, type QueueItem, type Word } from '@recall/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  offline: false,
  byDeck: {} as Record<string, unknown[]>,
  listeners: [] as (() => void)[],
  pending: new Set<string>(),
  // The device's IndexedDB: what a reload finds (JSON, as a structured clone would keep it).
  kv: new Map<string, string>(),
}))

vi.mock('./app.svelte.ts', async () => {
  const { NetworkError } = await import('./api.ts')
  const deck = (id: string) => ({ id, name: id, targetLang: 'en', nativeLang: 'ru', newPerDay: 20, forwardEnabled: true, reverseEnabled: true, reverseAfterDays: null, typeAnswer: 'off', reviewFilter: null, createdAt: '' })
  const decks = ['A', 'B'].map((id) => ({ id, name: id, hasLanguages: true, counts: { new: 0, learning: 0, review: 0 } }))
  return {
    status: { day: { timeZone: 'Europe/Moscow', startHour: 4 }, online: true },
    flushNow: async () => true,
    scheduleFlush: () => {},
    kv: {
      get: async (k: string) => (h.kv.has(k) ? JSON.parse(h.kv.get(k)!) : undefined),
      set: async (k: string, v: unknown) => void h.kv.set(k, JSON.stringify(v)),
      del: async (k: string) => void h.kv.delete(k),
    },
    outbox: { add: () => {}, undo: () => {}, pending: 0, pendingFor: (id: string) => h.pending.has(id), onCards: () => {} },
    api: {
      queue: async (_n: number, d?: string) => {
        if (h.offline) throw new NetworkError('offline')
        const items = h.byDeck[d ?? 'A'] ?? []
        return { items, counts: { new: items.length, learning: 0, review: 0 }, decks }
      },
      patchDeck: async (id: string, p: object) => ({ ...deck(id), ...p }),
      practice: async () => [],
    },
  }
})
vi.mock('./decks.ts', () => ({ getDecks: async () => null, hasDeckLanguages: () => true }))
vi.mock('./toast.svelte.ts', () => ({ showToast: () => {}, errorText: (e: unknown) => String(e) }))
vi.mock('./telegram.ts', () => ({ haptic: { impact: () => {}, notify: () => {}, select: () => {} } }))

const word = (id: string, deckId: string, tags: string[] = []): Word => ({
  id, deckId, term: id, pos: 'noun', translations: ['x'], ipa: null, examples: [], note: null, tags, freqRank: null, cefr: null,
  status: 'active', createdBy: 'user', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
})
const item = (id: string, deckId = 'A', direction: 'forward' | 'reverse' = 'forward', tags: string[] = []): QueueItem => ({
  kind: 'word',
  card: { id: `cd_${id}_${direction}`, wordId: id, factId: null, direction, suspended: false, schedule: newCardState(new Date('2026-10-01T00:00:00Z')) },
  word: word(id, deckId, tags),
  deckName: deckId,
})
const ids = (s: { queue: { main: QueueItem[]; learning: QueueItem[] } }) => [...s.queue.learning, ...s.queue.main].map((x) => x.card.id)

async function open(at: string) {
  vi.useFakeTimers({ now: new Date(at), toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const { session } = await import('./review.svelte.ts')
  await session.start()
  return session
}
type Session = Awaited<ReturnType<typeof open>>
const answer = (session: Session, rating: 1 | 2 | 3 | 4) => {
  vi.advanceTimersByTime(300)
  session.reveal()
  vi.advanceTimersByTime(300)
  expect(session.rate(rating)).toBe(true)
}

beforeEach(() => {
  vi.resetModules()
  h.offline = false
  h.listeners = []
  h.pending = new Set()
  h.kv = new Map()
  const store = new Map<string, string>([['reviewDeck', 'A']])
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) })
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: (_: string, f: () => void) => void h.listeners.push(f) })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('undo', () => {
  it('takes back the rating only: a direction turned off since stays off', async () => {
    h.byDeck = { A: [item('a'), item('c', 'A', 'reverse'), item('d')] }
    const session = await open('2026-10-21T09:00:00Z')
    session.decks = { A: { id: 'A', forwardEnabled: true, reverseEnabled: true } as never }
    answer(session, 3)
    session.applyDeck({ ...session.decks.A!, reverseEnabled: false })
    expect(session.undo()).toBe(true)
    expect(session.current?.card.id).toBe('cd_a_forward')
    expect(ids(session)).toEqual(['cd_a_forward', 'cd_d_forward'])
    expect(session.stats.reviewed).toBe(0)
  })

  it('takes back the rating only: a filter set since keeps its cards out', async () => {
    h.byDeck = { A: [item('a', 'A', 'forward', ['x']), item('c'), item('d', 'A', 'forward', ['x'])] }
    const session = await open('2026-10-21T10:00:00Z')
    answer(session, 4)
    h.byDeck = { A: [item('d', 'A', 'forward', ['x'])] }
    await session.setFilter({ tags: ['x'] })
    expect(ids(session)).toEqual(['cd_d_forward'])
    session.undo()
    // a is in the filter: back on top; c stays out.
    expect(ids(session)).toEqual(['cd_a_forward', 'cd_d_forward'])
    expect(session.current?.card.id).toBe('cd_a_forward')
  })

  it("doesn't bring the card back when the filter now leaves it out", async () => {
    h.byDeck = { A: [item('a'), item('d', 'A', 'forward', ['x'])] }
    const session = await open('2026-10-21T11:00:00Z')
    answer(session, 4)
    h.byDeck = { A: [item('d', 'A', 'forward', ['x'])] }
    await session.setFilter({ tags: ['x'] })
    session.undo()
    expect(ids(session)).toEqual(['cd_d_forward'])
    expect(session.current?.card.id).toBe('cd_d_forward')
  })
})

describe('a new study day in a warm session', () => {
  it('rolls over on resume, offline: the buried sibling shows and the tally starts again', async () => {
    h.byDeck = { A: [item('w'), item('w', 'A', 'reverse')] }
    const session = await open('2026-10-20T09:00:00Z')
    expect(ids(session)).toEqual(['cd_w_forward'])
    answer(session, 4)
    expect(ids(session)).toEqual([])
    expect(session.stats.reviewed).toBe(1)
    h.offline = true
    vi.setSystemTime(new Date('2026-10-21T09:00:00Z'))
    for (const f of h.listeners) f()
    await session.refresh()
    expect(ids(session)).toEqual(['cd_w_reverse'])
    expect(session.current?.card.id).toBe('cd_w_reverse')
    expect(session.stats.reviewed).toBe(0)
  })

  it('keeps a rating not uploaded yet when a queue fetched across the turn lacks it', async () => {
    h.byDeck = { A: [item('p'), item('q')] }
    const session = await open('2026-10-20T23:00:00Z')
    answer(session, 4)
    h.pending.add('cd_p_forward')
    // The day turns (04:00 Moscow = 01:00 UTC) and the server's queue still has p as new.
    vi.setSystemTime(new Date('2026-10-21T02:00:00Z'))
    await session.refresh()
    expect(ids(session)).toEqual(['cd_q_forward'])
  })
})

describe('switching decks offline', () => {
  it('a card dropped in one deck stays out after going to another and back', async () => {
    h.byDeck = { A: [item('a1'), item('a2')], B: [item('b1', 'B')] }
    const session = await open('2026-10-21T12:00:00Z')
    session.dropWord('a1')
    session.selectDeck('B')
    await session.refresh()
    h.offline = true
    session.selectDeck('A')
    await session.refresh()
    expect(ids(session)).toEqual(['cd_a2_forward'])
  })
})

describe('the minimum gap across a reload', () => {
  // A fresh store over the same device storage, as after closing the app.
  async function reload() {
    await Promise.resolve() // the queued persist
    vi.resetModules()
    const { session } = await import('./review.svelte.ts')
    h.offline = true
    await session.start()
    return session
  }

  it('keeps a card rated just before the reload resting', async () => {
    h.byDeck = { A: [item('a'), item('b')] }
    const session = await open('2026-10-21T13:00:00Z')
    expect(session.current?.card.id).toBe('cd_a_forward')
    answer(session, 1) // Again: a is due again in a minute
    answer(session, 4) // Easy: b is done for today
    expect(session.current).toBeNull()
    vi.advanceTimersByTime(2 * 60_000)
    const again = await reload()
    expect(again.recent.map((r) => r.cardId)).toEqual(['cd_a_forward', 'cd_b_forward'])
    // Due, but not rested: still the summary, and a comes back 5 min after its rating.
    expect(again.current).toBeNull()
    expect(again.comeBack()?.n).toBe(1)
    vi.advanceTimersByTime(3 * 60_000)
    expect(again.current?.card.id).toBe('cd_a_forward')
  })

  it('goes with the day', async () => {
    h.byDeck = { A: [item('a')] }
    const session = await open('2026-10-20T13:00:00Z')
    answer(session, 1)
    vi.setSystemTime(new Date('2026-10-21T13:00:00Z'))
    const again = await reload()
    expect(again.recent).toEqual([])
  })

  it('undo restores the gap history, persisted too', async () => {
    h.byDeck = { A: [item('a'), item('b')] }
    const session = await open('2026-10-21T14:00:00Z')
    answer(session, 1)
    answer(session, 1)
    expect(session.undo()).toBe(true)
    expect(session.current?.card.id).toBe('cd_b_forward')
    expect(session.recent.map((r) => r.cardId)).toEqual(['cd_a_forward'])
    const again = await reload()
    expect(again.recent.map((r) => r.cardId)).toEqual(['cd_a_forward'])
  })
})
