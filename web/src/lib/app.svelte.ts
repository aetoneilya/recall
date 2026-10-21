// App-wide services and connection state. Created once in boot(), before the
// UI mounts.
import type { DayOptions } from '@recall/core'
import { createApi, NotAllowedError, type Api, type AuthError } from './api.ts'
import { isMock } from './env.ts'
import { setFsrs } from './fsrs.ts'
import { openKV, type KV } from './idb.ts'
import { Outbox, type OutboxOp } from './outbox.ts'
import { initData, inTelegram, setupTelegram } from './telegram.ts'
import { showToast } from './toast.svelte.ts'
import type { FsrsParams, Me } from './types.ts'
import { initViewport } from './viewport.ts'
import { WordOutbox, type PendingWord } from './wordOutbox.ts'

export const status = $state({
  // 'login': the login screen; 'denied': a Telegram account that isn't
  // allowed (deniedId is its id, when the server said so).
  auth: 'ok' as 'ok' | 'login' | 'denied',
  deniedId: null as number | null,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  pending: 0,
  // Words added offline, waiting to upload.
  pendingWords: 0,
  // Bumped whenever words changed outside the screen showing them.
  wordsVersion: 0,
  syncing: false,
  // The last upload attempt failed; pending ratings are worth showing then.
  syncFailed: false,
  lastSync: 0,
  inbox: 0,
  me: null as Me | null,
  day: { timeZone: 'Europe/Moscow', startHour: 4 } as DayOptions,
  telegram: false,
  mock: isMock,
})

export let api: Api
export let kv: KV
export let outbox: Outbox
export let wordOutbox: WordOutbox

export async function boot(): Promise<void> {
  setupTelegram()
  initViewport()
  status.telegram = inTelegram()
  const fetchImpl = isMock ? (await import('../mock/server.ts')).mockFetch : undefined
  api = createApi({
    fetch: fetchImpl,
    initData,
    onUnauthorized,
    onNetwork: (ok) => (status.online = ok),
  })
  // Mock data lives in its own database so it never mixes with real cards.
  kv = openKV(isMock ? 'recall-mock' : 'recall')
  outbox = new Outbox(
    {
      load: () => kv.get<OutboxOp[]>('outbox'),
      save: (ops) => kv.set('outbox', ops),
    },
    api,
  )
  outbox.onDropped = (ops, e) => console.warn('Dropped unsyncable ops', ops, e)
  outbox.subscribe((n) => (status.pending = n))
  await outbox.init()
  wordOutbox = new WordOutbox({ load: () => kv.get<PendingWord[]>('wordOutbox'), save: (w) => kv.set('wordOutbox', w) }, api)
  wordOutbox.subscribe((n) => (status.pendingWords = n))
  await wordOutbox.init()

  const savedDay = await kv.get<DayOptions>('day')
  if (savedDay) status.day = savedDay
  setFsrs(await kv.get<FsrsParams | null>('fsrs'))
  addEventListener('online', () => {
    status.online = true
    void flushNow()
  })
  addEventListener('offline', () => (status.online = false))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushNow()
  })
}

// Any 401. Inside Telegram there is no other way in, so even a bare
// 'unauthorized' (stale initData) lands on the denied screen.
export function onUnauthorized(e: AuthError): void {
  if (e instanceof NotAllowedError) {
    status.auth = 'denied'
    status.deniedId = e.telegramId
    return
  }
  status.auth = inTelegram() ? 'denied' : 'login'
}

export async function loadMe(): Promise<void> {
  try {
    setMe(await api.me())
  } catch {
    // Offline or signed out; the cached study-day settings stay.
  }
}

export function setMe(me: Me): void {
  status.me = me
  status.day = { timeZone: me.timeZone || status.day.timeZone, startHour: me.dayStartHour ?? status.day.startHour }
  void kv.set('day', { ...status.day })
  // Older servers send no FSRS parameters: the defaults.
  setFsrs(me.fsrs ?? null)
  void kv.set('fsrs', me.fsrs ? $state.snapshot(me.fsrs) : null)
}

let timer: ReturnType<typeof setTimeout> | undefined
let backoff = 0

export function scheduleFlush(delayMs = 4000): void {
  clearTimeout(timer)
  timer = setTimeout(() => void flushNow(), delayMs)
}

// Uploads the outbox; on failure retries with backoff (10 s → 5 min).
export async function flushNow(): Promise<boolean> {
  clearTimeout(timer)
  if (wordOutbox?.size) void flushWords()
  if (!outbox || outbox.size === 0) return true
  status.syncing = true
  const r = await outbox.flush()
  status.syncing = false
  status.syncFailed = !r.ok
  if (r.ok) {
    backoff = 0
    status.lastSync = Date.now()
    return true
  }
  if (r.reason !== 'auth') {
    backoff = Math.min(backoff ? backoff * 2 : 10_000, 300_000)
    scheduleFlush(backoff)
  }
  return false
}

export function signedIn(): void {
  status.auth = 'ok'
  status.deniedId = null
  void flushNow()
}

// Uploads words added offline and says what happened to them.
async function flushWords(): Promise<void> {
  const r = await wordOutbox.flush()
  if (!r.added.length && !r.duplicates.length && !r.failed.length) return
  status.wordsVersion++
  const parts: string[] = []
  if (r.added.length) parts.push(r.added.length === 1 ? `Added “${r.added[0]}”` : `Added ${r.added.length} words`)
  if (r.duplicates.length) parts.push(`${r.duplicates.map((t) => `“${t}”`).join(', ')} already there`)
  if (r.failed.length) parts.push(`${r.failed.map((f) => `“${f.term}”`).join(', ')} not saved: ${r.failed[0].error}`)
  showToast(parts.join(' · '), { ms: 4000 })
}
