// Optimistic PATCH /api/me for the Settings screen: the change shows at once;
// if the server refuses it, the fields it touched go back to what they were,
// unless a later change has already replaced them.
import type { Me, MePatch } from './types.ts'

// The fields of Me a patch sets directly (requestRetention lives under fsrs).
export type MeFieldPatch = Omit<MePatch, 'requestRetention'>

export interface MeStore {
  get(): Me | null
  set(me: Me): void
}

export async function patchMeOptimistic(store: MeStore, patch: MeFieldPatch, send: (p: MePatch) => Promise<Me>, onError: (e: unknown) => void): Promise<boolean> {
  const before = store.get()
  if (!before) return false
  const keys = Object.keys(patch) as (keyof MeFieldPatch)[]
  const optimistic = { ...before, ...patch }
  store.set(optimistic)
  try {
    const saved = await send(patch)
    const now = store.get() ?? saved
    // A field changed again while this was in flight keeps the newer value;
    // its own request settles it.
    const merged = { ...saved } as Record<string, unknown>
    for (const k of Object.keys(now) as (keyof Me)[]) if (now[k] !== optimistic[k]) merged[k] = now[k]
    store.set(merged as unknown as Me)
    return true
  } catch (e) {
    const now = store.get()
    if (now) {
      const rolled = { ...now } as Record<string, unknown>
      for (const k of keys) if (now[k] === optimistic[k]) rolled[k] = before[k]
      store.set(rolled as unknown as Me)
    }
    onError(e)
    return false
  }
}

// "Europe/Moscow" → "Moscow · Europe"; "America/Argentina/Salta" → "Salta · America/Argentina".
export function zoneLabel(zone: string): string {
  const parts = zone.split('/')
  if (parts.length === 1) return zone
  const city = parts.at(-1)!.replace(/_/g, ' ')
  return `${city} · ${parts.slice(0, -1).join('/').replace(/_/g, ' ')}`
}

const offsets = new Map<string, string>()

// "UTC+3", "UTC−5:30" for `zone`, as of now. Cached: the picker lists
// ~400 zones and searches them on every keystroke.
export function zoneOffset(zone: string): string {
  let v = offsets.get(zone)
  if (v === undefined) {
    try {
      const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value
      v = (name ?? '').replace('GMT', 'UTC').replace('-', '−')
      if (v === 'UTC' || v === '') v = 'UTC'
    } catch {
      v = ''
    }
    offsets.set(zone, v)
  }
  return v
}

export function allZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
  const list = intl.supportedValuesOf?.('timeZone') ?? []
  // Some engines leave UTC out of the list.
  return list.includes('UTC') ? list : [...list, 'UTC']
}

export function searchZones(zones: string[], q: string): string[] {
  const words = q.toLowerCase().replace(/[_/]/g, ' ').split(/\s+/).filter(Boolean)
  if (!words.length) return zones
  return zones.filter((z) => {
    const hay = `${z} ${zoneOffset(z)}`.toLowerCase().replace(/[_/]/g, ' ')
    return words.every((w) => hay.includes(w))
  })
}

export function deviceZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null
  } catch {
    return null
  }
}

// "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", "12 Mar".
export function relTime(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime()
  const s = Math.max(0, (now - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  const d = Math.floor(s / 86400)
  if (d === 1) return 'yesterday'
  if (d < 7) return `${d} days ago`
  return shortDate(iso, now)
}

export function shortDate(iso: string, now = Date.now()): string {
  const d = new Date(iso)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString('en-GB', sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })
}
