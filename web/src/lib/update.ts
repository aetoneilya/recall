// App updates without user effort. A deploy ships a new service worker; it
// installs in the background, takes over at once (skipWaiting + claim) and
// the running page is then one version behind. Instead of waiting for the
// person to relaunch the app (on iOS a home-screen app is usually resumed,
// not reloaded, so that took one or two relaunches), the page reloads itself
// at the first moment nothing is lost or interrupted, and says "Updated".

export type Moment =
  // A tab or screen was just opened.
  | 'route'
  // The review queue ran out: the summary is showing.
  | 'summary'
  // Back in the foreground after a while away.
  | 'resume'

export interface Context {
  // Route parts, e.g. ['words'] or ['word', 'wd_1'].
  parts: string[]
  // A card is on screen in the review tab, and whether its answer shows.
  card: boolean
  revealed: boolean
  // Something typed and not saved (unsaved.ts), or a change held for an
  // Undo toast that a reload would drop.
  unsaved: boolean
  pendingUndo: boolean
}

// Screens with something in progress: forms, an editor, the vocabulary test.
const BUSY = new Set(['add', 'word', 'fact', 'test', 'practice'])

export function shouldApply(moment: Moment, c: Context): boolean {
  if (c.unsaved || c.pendingUndo) return false
  const [a] = c.parts
  if (BUSY.has(a ?? '')) return false
  const review = !a
  if (moment === 'summary') return review && !c.card
  if (moment === 'route') return !review || !c.card
  // Resuming: the card comes straight back from the cache, but a revealed
  // answer would flip back, so only before it shows.
  return !review || !c.card || !c.revealed
}

const FLAG = 'recall.updated'
// Away at least this long before a resume checks for (and applies) updates.
const AWAY_MS = 30_000
const CHECK_EVERY_MS = 5 * 60_000

let ready = false
let context: () => Context = () => ({ parts: [], card: false, revealed: false, unsaved: true, pendingUndo: false })
let lastCheck = 0
let reg: ServiceWorkerRegistration | undefined

// Registers the service worker and starts watching for a new version.
export function initUpdates(ctx: () => Context): void {
  context = ctx
  const sw = navigator.serviceWorker
  // Without a controller this is the first install, not an update.
  const hadController = !!sw.controller
  // Not applied right here: the next safe moment does it, so a page being
  // read never reloads under the reader.
  sw.addEventListener('controllerchange', () => {
    if (hadController) ready = true
  })
  sw.register('/sw.js').then(
    (r) => {
      reg = r
      lastCheck = Date.now()
    },
    (e) => console.warn('Service worker registration failed', e),
  )
  let hiddenAt = 0
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now()
      return
    }
    if (!hiddenAt || Date.now() - hiddenAt < AWAY_MS) return
    if (ready) checkpoint('resume')
    else if (reg && Date.now() - lastCheck > CHECK_EVERY_MS) {
      lastCheck = Date.now()
      // The new worker's takeover fires controllerchange above.
      reg.update().catch(() => {})
    }
  })
}

// What must be on disk before a reload (the last rating's outbox write);
// set by the app, given at most a second.
let settle: () => Promise<unknown> = async () => {}
export function setSettle(fn: () => Promise<unknown>) {
  settle = fn
}

// Called at moments that may be safe to reload (route changes, session end).
export function checkpoint(moment: Moment): void {
  if (!ready || !shouldApply(moment, context())) return
  ready = false
  try {
    sessionStorage.setItem(FLAG, '1')
  } catch {
    // No toast after the reload; the update still applies.
  }
  void Promise.race([settle().catch(() => {}), new Promise((r) => setTimeout(r, 1000))]).then(() => location.reload())
}

// After the reload: whether to say "Updated".
export function justUpdated(): boolean {
  try {
    if (!sessionStorage.getItem(FLAG)) return false
    sessionStorage.removeItem(FLAG)
    return true
  } catch {
    return false
  }
}
