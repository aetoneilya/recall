import { mount } from 'svelte'
import App from './App.svelte'
import './app.css'
import { boot, editOutbox, kv, loadMe, outbox, wordOutbox } from './lib/app.svelte.ts'
import { session } from './lib/review.svelte.ts'
import { router } from './lib/router.svelte.ts'
import { applyTheme, loadTheme } from './lib/theme.ts'
import { showToast, toast } from './lib/toast.svelte.ts'
import { hasUnsaved } from './lib/unsaved.ts'
import { initUpdates, justUpdated, setSettle } from './lib/update.ts'

applyTheme(loadTheme())
await boot()
mount(App, { target: document.getElementById('app')! })
void loadMe()
void session.start()

if (import.meta.env.PROD && 'serviceWorker' in navigator && !location.search.includes('mock')) {
  initUpdates(() => ({
    parts: router.route.parts,
    card: !!session.current,
    revealed: session.revealed,
    unsaved: hasUnsaved(),
    pendingUndo: !!toast.action,
  }))
}
// Before an update reloads the page: queued writes reach IndexedDB (a read
// after them in the same store completes only once they have).
setSettle(async () => {
  await Promise.all([outbox.persisted(), wordOutbox.persisted(), editOutbox.persisted()])
  await new Promise((r) => queueMicrotask(() => r(null)))
  await kv.get('review')
})
if (justUpdated()) showToast('Updated')
