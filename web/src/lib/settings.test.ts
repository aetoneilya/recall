import { describe, expect, it, vi } from 'vitest'
import { HttpError } from './api.ts'
import { patchMeOptimistic, relTime, searchZones, type MeStore } from './settings.ts'
import type { Me, MePatch } from './types.ts'

const ME: Me = {
  user: { id: 'us_1', telegramId: 1, name: 'Ilya', isOwner: true },
  authenticatedVia: 'session',
  timeZone: 'Europe/Moscow',
  dayStartHour: 4,
  today: '2026-10-21',
  reminderTime: '09:00',
  eveningReminderTime: '21:00',
  botUsername: 'bot',
}

function store(initial: Me) {
  let me: Me | null = initial
  const history: Me[] = []
  const s: MeStore = { get: () => me, set: (m) => { me = m; history.push(m) } }
  return { s, history, now: () => me! }
}

// A request the test resolves or rejects by hand.
function deferred() {
  let resolve!: (m: Me) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<Me>((a, b) => ((resolve = a), (reject = b)))
  return { promise, resolve, reject }
}

describe('optimistic PATCH /api/me', () => {
  it('shows the change at once and keeps the server answer', async () => {
    const st = store(ME)
    const req = deferred()
    const done = patchMeOptimistic(st.s, { reminderTime: '08:30' }, () => req.promise, vi.fn())
    expect(st.now().reminderTime).toBe('08:30')
    req.resolve({ ...ME, reminderTime: '08:30', today: '2026-10-22' })
    expect(await done).toBe(true)
    expect(st.now()).toMatchObject({ reminderTime: '08:30', today: '2026-10-22' })
  })

  it('rolls back and reports on error', async () => {
    const st = store(ME)
    const onError = vi.fn()
    const err = new HttpError(400, 'must be HH:MM (24 h)')
    const ok = await patchMeOptimistic(st.s, { eveningReminderTime: null, reminderTime: '25:00' }, async () => Promise.reject(err), onError)
    expect(ok).toBe(false)
    expect(st.history[0]).toMatchObject({ eveningReminderTime: null, reminderTime: '25:00' })
    expect(st.now()).toEqual(ME)
    expect(onError).toHaveBeenCalledWith(err)
  })

  it("rolls back only its own fields, and not over a newer edit", async () => {
    const st = store(ME)
    const a = deferred()
    const b = deferred()
    const send = vi.fn((p: MePatch) => (p.timeZone ? a.promise : b.promise))
    const first = patchMeOptimistic(st.s, { timeZone: 'Asia/Tbilisi', reminderTime: '07:00' }, send, vi.fn())
    const second = patchMeOptimistic(st.s, { reminderTime: '07:30' }, send, vi.fn())
    a.reject(new Error('boom'))
    await first
    // timeZone reverts; reminderTime was changed again since, so it stays.
    expect(st.now()).toMatchObject({ timeZone: 'Europe/Moscow', reminderTime: '07:30' })
    b.resolve({ ...ME, reminderTime: '07:30' })
    await second
    expect(st.now()).toMatchObject({ timeZone: 'Europe/Moscow', reminderTime: '07:30' })
  })

  it('a success does not clobber a newer edit still in flight', async () => {
    const st = store(ME)
    const a = deferred()
    const b = deferred()
    let call = 0
    const send = () => (++call === 1 ? a.promise : b.promise)
    const first = patchMeOptimistic(st.s, { reminderTime: '07:00' }, send, vi.fn())
    const second = patchMeOptimistic(st.s, { reminderTime: '07:30' }, send, vi.fn())
    a.resolve({ ...ME, reminderTime: '07:00' })
    await first
    expect(st.now().reminderTime).toBe('07:30')
    b.resolve({ ...ME, reminderTime: '07:30' })
    await second
    expect(st.now().reminderTime).toBe('07:30')
  })

  it('does nothing before /api/me has loaded', async () => {
    const send = vi.fn()
    expect(await patchMeOptimistic({ get: () => null, set: vi.fn() }, { reminderTime: '07:00' }, send, vi.fn())).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('settings helpers', () => {
  it('searches zones by city, region and words', () => {
    const zones = ['Europe/Moscow', 'America/New_York', 'Asia/Tbilisi', 'UTC']
    expect(searchZones(zones, 'new york')).toEqual(['America/New_York'])
    expect(searchZones(zones, 'europe mos')).toEqual(['Europe/Moscow'])
    expect(searchZones(zones, '')).toEqual(zones)
  })

  it('says when a token was last used', () => {
    const now = Date.parse('2026-10-21T12:00:00Z')
    expect(relTime('2026-10-21T11:59:30Z', now)).toBe('just now')
    expect(relTime('2026-10-21T11:15:00Z', now)).toBe('45 min ago')
    expect(relTime('2026-10-21T07:00:00Z', now)).toBe('5 h ago')
    expect(relTime('2026-10-20T09:00:00Z', now)).toBe('yesterday')
    expect(relTime('2026-10-17T09:00:00Z', now)).toBe('4 days ago')
    expect(relTime('2026-09-02T09:00:00Z', now)).toBe('2 Sept')
  })
})
