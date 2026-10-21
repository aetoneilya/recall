import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpError } from './api.ts'
import { countdown, TelegramLogin, type LoginApi, type LoginState } from './login.ts'
import type { LoginPoll } from './types.ts'

const T0 = Date.parse('2026-10-21T10:00:00Z')
const USER = { id: 'us_1', telegramId: 111, name: 'Anna', isOwner: false }

// A document stand-in whose visibility the test flips.
function fakeVisibility() {
  const listeners = new Set<() => void>()
  return {
    visibilityState: 'visible',
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    listeners,
    set(v: 'visible' | 'hidden') {
      this.visibilityState = v
      for (const fn of listeners) fn()
    },
  }
}

function setup(answers: (LoginPoll | Error)[] = []) {
  let n = 0
  const api = {
    loginTelegram: vi.fn(async () => {
      n++
      return { nonce: `n${n}`, url: `https://t.me/bot?start=login_n${n}`, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() }
    }),
    pollLogin: vi.fn(async (_nonce: string): Promise<LoginPoll> => {
      const a = answers.shift() ?? { status: 'pending', expiresAt: '' }
      if (a instanceof Error) throw a
      return a
    }),
  } satisfies LoginApi
  const states: LoginState[] = []
  const vis = fakeVisibility()
  const flow = new TelegramLogin({ api, onChange: (s) => states.push(s), visibility: vis })
  return { api, flow, states, vis, kind: () => flow.state.kind }
}

describe('Telegram login flow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => vi.useRealTimers())

  it('prepares a link before the tap, then polls every 1.5 s until ok', async () => {
    const t = setup([{ status: 'pending', expiresAt: '' }, { status: 'pending', expiresAt: '' }, { status: 'ok', user: USER }])
    await t.flow.prepare()
    expect(t.flow.state).toMatchObject({ kind: 'ready', url: 'https://t.me/bot?start=login_n1', renewed: false })
    // Nothing is polled until the user taps the link.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(t.api.pollLogin).not.toHaveBeenCalled()

    t.flow.begin()
    expect(t.kind()).toBe('waiting')
    await vi.advanceTimersByTimeAsync(1499)
    expect(t.api.pollLogin).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(t.api.pollLogin).toHaveBeenCalledWith('n1')
    await vi.advanceTimersByTimeAsync(3000)
    expect(t.api.pollLogin).toHaveBeenCalledTimes(3)
    expect(t.flow.state).toEqual({ kind: 'ok', user: USER })
    // Done: no more polling, listener gone.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(t.api.pollLogin).toHaveBeenCalledTimes(3)
    expect(t.vis.listeners.size).toBe(0)
  })

  it('on 410 gets a fresh link and says so', async () => {
    const t = setup([{ status: 'expired' }])
    await t.flow.prepare()
    t.flow.begin()
    await vi.advanceTimersByTimeAsync(1500)
    expect(t.api.loginTelegram).toHaveBeenCalledTimes(2)
    expect(t.flow.state).toMatchObject({ kind: 'ready', url: 'https://t.me/bot?start=login_n2', renewed: true })
    await vi.advanceTimersByTimeAsync(5000)
    expect(t.api.pollLogin).toHaveBeenCalledTimes(1)
  })

  it('swaps an untapped link 2 min early, so a tap always gets at least 3 min', async () => {
    const t = setup()
    await t.flow.prepare()
    await vi.advanceTimersByTimeAsync(3 * 60_000 - 1)
    expect(t.flow.state).toMatchObject({ url: 'https://t.me/bot?start=login_n1' })
    await vi.advanceTimersByTimeAsync(1)
    expect(t.flow.state).toMatchObject({ kind: 'ready', url: 'https://t.me/bot?start=login_n2', renewed: false })
  })

  it('a link being waited on runs its full 5 min, then renews with a notice', async () => {
    const t = setup()
    await t.flow.prepare()
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    t.flow.begin()
    // Past the early-renew mark, still waiting on the same link.
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(t.flow.state).toMatchObject({ kind: 'waiting', url: 'https://t.me/bot?start=login_n1' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(t.flow.state).toMatchObject({ kind: 'ready', url: 'https://t.me/bot?start=login_n2', renewed: true })
    expect(t.api.loginTelegram).toHaveBeenCalledTimes(2)
  })

  it('a link waited on and cancelled is still swapped when its time comes', async () => {
    const t = setup()
    await t.flow.prepare()
    t.flow.begin()
    await vi.advanceTimersByTimeAsync(60_000)
    t.flow.cancel()
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(t.flow.state).toMatchObject({ kind: 'ready', url: 'https://t.me/bot?start=login_n2', renewed: false })
  })

  it('stops polling on unmount, even with a request in flight', async () => {
    let release!: (p: LoginPoll) => void
    const t = setup()
    t.api.pollLogin.mockImplementationOnce(() => new Promise<LoginPoll>((r) => (release = r)))
    await t.flow.prepare()
    t.flow.begin()
    await vi.advanceTimersByTimeAsync(1500)
    expect(t.api.pollLogin).toHaveBeenCalledTimes(1)
    t.flow.stop()
    release({ status: 'ok', user: USER })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(t.api.pollLogin).toHaveBeenCalledTimes(1)
    expect(t.kind()).toBe('waiting')
    expect(t.vis.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('polls at once when the page becomes visible again', async () => {
    const t = setup([{ status: 'pending', expiresAt: '' }, { status: 'ok', user: USER }])
    await t.flow.prepare()
    // Visible before the tap: nothing to poll yet.
    t.vis.set('visible')
    expect(t.api.pollLogin).not.toHaveBeenCalled()
    t.flow.begin()
    t.vis.set('hidden')
    expect(t.api.pollLogin).not.toHaveBeenCalled()
    t.vis.set('visible')
    expect(t.api.pollLogin).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(0)
    // The regular timer restarted from that poll.
    await vi.advanceTimersByTimeAsync(1500)
    expect(t.api.pollLogin).toHaveBeenCalledTimes(2)
    expect(t.kind()).toBe('ok')
  })

  it('keeps polling through network errors', async () => {
    const t = setup([new TypeError('Failed to fetch'), { status: 'ok', user: USER }])
    await t.flow.prepare()
    t.flow.begin()
    await vi.advanceTimersByTimeAsync(3000)
    expect(t.kind()).toBe('ok')
  })

  it('cancel goes back to the same link and stops polling', async () => {
    const t = setup()
    await t.flow.prepare()
    t.flow.begin()
    t.flow.cancel()
    expect(t.flow.state).toMatchObject({ kind: 'ready', url: 'https://t.me/bot?start=login_n1' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(t.api.pollLogin).not.toHaveBeenCalled()
  })

  it('reports a disabled bot and other start failures', async () => {
    const t = setup()
    t.api.loginTelegram.mockRejectedValueOnce(new HttpError(503, 'Telegram login is unavailable'))
    await t.flow.prepare()
    expect(t.flow.state).toEqual({ kind: 'unavailable' })
    t.api.loginTelegram.mockRejectedValueOnce(new HttpError(429, 'too many'))
    await t.flow.prepare()
    expect(t.flow.state).toMatchObject({ kind: 'error', message: expect.stringMatching(/Too many/) })
    await t.flow.prepare()
    expect(t.kind()).toBe('ready')
  })

  it('formats the countdown', () => {
    expect(countdown(T0 + 5 * 60_000, T0)).toBe('5:00')
    expect(countdown(T0 + 61_500, T0)).toBe('1:02')
    expect(countdown(T0, T0 + 1000)).toBe('0:00')
  })
})
