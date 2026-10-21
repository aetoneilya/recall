// "Log in with Telegram" outside the Mini App, as a small state machine the
// Login screen renders:
//
//   preparing → ready ──tap──→ waiting ──poll ok──→ ok
//                 ↑                │
//                 └── expired / ✖ ─┘ (a fresh link, with a notice)
//
// The link is fetched before the tap so the button can be a real
// <a target="_blank">: iOS only hands t.me to the Telegram app from a direct
// tap, not from window.open after an await. While waiting it polls every
// 1.5 s, and at once when the page becomes visible again (the user is back
// from Telegram).
import { HttpError, NetworkError } from './api.ts'
import type { LoginPoll, LoginStart, MeUser } from './types.ts'

export type LoginState =
  | { kind: 'preparing' }
  // `renewed`: the previous link expired or was cancelled in the bot.
  | { kind: 'ready'; url: string; expiresAt: number; renewed: boolean }
  | { kind: 'waiting'; url: string; expiresAt: number }
  | { kind: 'ok'; user: MeUser }
  // The bot is off (503): only the password works.
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }

export interface LoginApi {
  loginTelegram(): Promise<LoginStart>
  pollLogin(nonce: string): Promise<LoginPoll>
}

export interface VisibilitySource {
  readonly visibilityState: string
  addEventListener(type: 'visibilitychange', fn: () => void): void
  removeEventListener(type: 'visibilitychange', fn: () => void): void
}

export interface LoginFlowOptions {
  api: LoginApi
  onChange: (s: LoginState) => void
  visibility?: VisibilitySource
  pollMs?: number
  now?: () => number
}

export const POLL_MS = 1500
// An untapped link is swapped this long before it expires, so a tap always
// leaves the user a few minutes in Telegram.
export const RENEW_EARLY_MS = 2 * 60_000

export class TelegramLogin {
  state: LoginState = { kind: 'preparing' }
  private api: LoginApi
  private onChange: (s: LoginState) => void
  private visibility: VisibilitySource | undefined
  private pollMs: number
  private now: () => number
  private nonce = ''
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private expiryTimer: ReturnType<typeof setTimeout> | undefined
  private inflight = false
  private stopped = false
  // Bumped per link, so a late answer about an old link is ignored.
  private gen = 0

  constructor(o: LoginFlowOptions) {
    this.api = o.api
    this.onChange = o.onChange
    this.visibility = o.visibility ?? (typeof document === 'undefined' ? undefined : document)
    this.pollMs = o.pollMs ?? POLL_MS
    this.now = o.now ?? Date.now
    this.visibility?.addEventListener('visibilitychange', this.onVisible)
  }

  // Fetches a fresh link. Also the retry after an error.
  async prepare(renewed = false): Promise<void> {
    if (this.stopped) return
    const gen = ++this.gen
    this.clearTimers()
    this.set({ kind: 'preparing' })
    let start: LoginStart
    try {
      start = await this.api.loginTelegram()
    } catch (e) {
      if (gen !== this.gen || this.stopped) return
      this.set(startError(e))
      return
    }
    if (gen !== this.gen || this.stopped) return
    this.nonce = start.nonce
    const expiresAt = new Date(start.expiresAt).getTime()
    this.set({ kind: 'ready', url: start.url, expiresAt, renewed })
    // An untapped link quietly renews early; one being waited on runs out
    // first and then renews with a notice.
    const fire = () => {
      if (this.state.kind === 'ready') void this.prepare(renewed && this.state.renewed)
      else if (this.state.kind === 'waiting') {
        const left = expiresAt - this.now()
        if (left > 0) this.expiryTimer = setTimeout(fire, left)
        else void this.prepare(true)
      }
    }
    this.expiryTimer = setTimeout(fire, Math.max(0, expiresAt - RENEW_EARLY_MS - this.now()))
  }

  // The user tapped the link (the browser opens it; don't prevent default).
  begin(): void {
    const s = this.state
    if (s.kind !== 'ready' || this.stopped) return
    this.set({ kind: 'waiting', url: s.url, expiresAt: s.expiresAt })
    this.schedule()
  }

  // Back to the button, keeping the same link (it may still be confirmed later
  // in the bot, so the next tap picks it up).
  cancel(): void {
    const s = this.state
    if (s.kind !== 'waiting') return
    clearTimeout(this.pollTimer)
    this.set({ kind: 'ready', url: s.url, expiresAt: s.expiresAt, renewed: false })
  }

  // Unmount: no more requests, timers or listeners.
  stop(): void {
    this.stopped = true
    this.clearTimers()
    this.visibility?.removeEventListener('visibilitychange', this.onVisible)
  }

  async pollNow(): Promise<void> {
    if (this.state.kind !== 'waiting' || this.inflight || this.stopped) return
    clearTimeout(this.pollTimer)
    const gen = this.gen
    this.inflight = true
    let r: LoginPoll | null
    try {
      r = await this.api.pollLogin(this.nonce)
    } catch {
      // Offline or a hiccup: keep trying until the link expires.
      r = null
    } finally {
      this.inflight = false
    }
    if (this.stopped || gen !== this.gen || this.state.kind !== 'waiting') return
    if (r?.status === 'ok') {
      this.clearTimers()
      this.set({ kind: 'ok', user: r.user })
      this.stop()
    } else if (r?.status === 'expired') void this.prepare(true)
    else this.schedule()
  }

  private onVisible = () => {
    if (this.visibility?.visibilityState === 'visible') void this.pollNow()
  }

  private schedule() {
    clearTimeout(this.pollTimer)
    this.pollTimer = setTimeout(() => void this.pollNow(), this.pollMs)
  }

  private clearTimers() {
    clearTimeout(this.pollTimer)
    clearTimeout(this.expiryTimer)
  }

  private set(s: LoginState) {
    this.state = s
    this.onChange(s)
  }
}

function startError(e: unknown): LoginState {
  if (e instanceof HttpError && e.status === 503) return { kind: 'unavailable' }
  if (e instanceof HttpError && e.status === 429) return { kind: 'error', message: 'Too many login attempts — try again in a few minutes' }
  if (e instanceof NetworkError) return { kind: 'error', message: 'Offline — connect to log in' }
  return { kind: 'error', message: e instanceof Error ? e.message : String(e) }
}

// "4:07" until the link expires.
export function countdown(expiresAt: number, now: number): string {
  const s = Math.max(0, Math.ceil((expiresAt - now) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
