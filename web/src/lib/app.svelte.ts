// App-wide services and connection state. Created once in boot(), before the
// UI mounts.
import type { DayOptions } from '@recall/core'
import { createApi, NotAllowedError, type Api, type AuthError } from './api.ts'
import { isMock } from './env.ts'
import { setFsrs } from './fsrs.ts'
import { AccountKV } from './accountKV.ts'
import { EditOutbox, type PendingEdit } from './editOutbox.ts'
import { openKV } from './idb.ts'
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
  // The same for facts (edited from a review card).
  factsVersion: 0,
  syncing: false,
  // The last upload attempt failed; pending ratings are worth showing then.
  syncFailed: false,
  lastSync: 0,
  me: null as Me | null,
  day: { timeZone: 'Europe/Moscow', startHour: 4 } as DayOptions,
  telegram: false,
  mock: isMock,
})

export let api: Api
export let kv: AccountKV
export let outbox: Outbox
export let wordOutbox: WordOutbox
export let editOutbox: EditOutbox

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
  // Mock data lives in its own database (one per variant: each is another
  // account) so it never mixes with real cards.
  const variant = isMock ? new URLSearchParams(location.search).get('mock') : null
  kv = new AccountKV(openKV(isMock ? `recall-mock${variant ? `-${variant}` : ''}` : 'recall'))
  await kv.init()
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
  editOutbox = new EditOutbox({ load: () => kv.get<PendingEdit[]>('editOutbox'), save: (e) => kv.set('editOutbox', e) }, api)
  await editOutbox.init()

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
    await setMe(await api.me())
  } catch {
    // Offline or signed out; the cached study-day settings stay.
  }
}

export async function setMe(me: Me): Promise<void> {
  status.me = me
  const was = kv.confirmed
  const r = await kv.claim(me.user.id)
  if (r === 'switched') {
    // Another account on this device: start over under its own caches.
    await outbox.persisted()
    location.reload()
    return
  }
  status.day = { timeZone: me.timeZone || status.day.timeZone, startHour: me.dayStartHour ?? status.day.startHour }
  void kv.set('day', { ...status.day })
  // Older servers send no FSRS parameters: the defaults.
  setFsrs(me.fsrs ?? null)
  void kv.set('fsrs', me.fsrs ? $state.snapshot(me.fsrs) : null)
  // Uploads waited for the account to be known.
  if (!was) void flushNow()
}

// Signed out on this device: the account's caches go (uploads still pending
// stay for its next sign-in) and the app starts over.
export async function signOutLocally(): Promise<void> {
  await outbox.persisted()
  await kv.clear([...(outbox.size ? ['outbox'] : []), ...(wordOutbox.size ? ['wordOutbox'] : []), ...(editOutbox.size ? ['editOutbox'] : [])])
  location.reload()
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
  // Pending ratings belong to the cache owner: never sent under another
  // account's session. Until the signed-in account is known, nothing goes.
  if (!kv?.confirmed) {
    if (!status.online || !api) return false
    await loadMe()
    if (!kv.confirmed) return false
  }
  if (wordOutbox?.size) void flushWords()
  if (editOutbox?.size) void flushEdits()
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

// Uploads edits made offline; a refused one is said.
async function flushEdits(): Promise<void> {
  const r = await editOutbox.flush()
  if (!r.sent && !r.failed.length) return
  status.wordsVersion++
  status.factsVersion++
  if (r.failed.length) showToast(`${r.failed.length === 1 ? 'An edit' : `${r.failed.length} edits`} made offline not saved: ${r.failed[0]!.error}`, { ms: 4000 })
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
