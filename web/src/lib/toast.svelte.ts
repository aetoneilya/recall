import { HttpError, NetworkError } from './api.ts'

export interface ToastAction {
  label: string
  run: () => void
}

export const toast = $state({ message: '', action: null as ToastAction | null, id: 0 })
let timer: ReturnType<typeof setTimeout> | undefined
let onExpire: (() => void) | null = null

// A short message at the top; with `action`, a button on it (Undo). When the
// toast goes away without the action being used, `expire` runs — that's
// where a deferred change (a delete held for undo) is committed.
export function showToast(message: string, opts: { action?: ToastAction; ms?: number; expire?: () => void } = {}) {
  settle()
  toast.message = message
  toast.action = opts.action ?? null
  toast.id++
  onExpire = opts.expire ?? null
  clearTimeout(timer)
  timer = setTimeout(dismiss, opts.ms ?? (opts.action ? 5000 : 2600))
}

// Runs the action (and cancels the pending expire).
export function runToastAction() {
  const a = toast.action
  onExpire = null
  dismiss()
  a?.run()
}

export function dismiss() {
  clearTimeout(timer)
  settle()
  toast.message = ''
  toast.action = null
}

// A replaced or dismissed toast commits its deferred change.
function settle() {
  const f = onExpire
  onExpire = null
  f?.()
}

// The page is going away: commit now rather than lose it.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && onExpire) dismiss()
  })
}

export function errorText(e: unknown): string {
  if (e instanceof NetworkError) return 'Offline — try again when connected'
  if (e instanceof HttpError) return e.message
  return e instanceof Error ? e.message : String(e)
}
