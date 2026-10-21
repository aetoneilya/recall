// Thin wrapper over the Telegram Mini App SDK. Everything is a no-op outside
// Telegram, so callers don't branch.

interface TgWebApp {
  initData: string
  colorScheme: 'light' | 'dark'
  themeParams: Record<string, string | undefined>
  version: string
  ready(): void
  expand(): void
  isVersionAtLeast(v: string): boolean
  disableVerticalSwipes?(): void
  setHeaderColor?(c: string): void
  setBackgroundColor?(c: string): void
  onEvent(e: string, fn: () => void): void
  openTelegramLink?(url: string): void
  enableClosingConfirmation?(): void
  disableClosingConfirmation?(): void
  BackButton: { show(): void; hide(): void; onClick(fn: () => void): void; offClick(fn: () => void): void }
  HapticFeedback: {
    impactOccurred(s: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void
    notificationOccurred(t: 'error' | 'success' | 'warning'): void
    selectionChanged(): void
  }
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TgWebApp }
  }
}

function app(): TgWebApp | undefined {
  const w = typeof window !== 'undefined' ? window.Telegram?.WebApp : undefined
  return w?.initData ? w : undefined
}

export const inTelegram = () => !!app()
export const initData = () => app()?.initData

export function setupTelegram(): void {
  const tg = app()
  if (!tg) return
  document.documentElement.dataset.telegram = ''
  tg.ready()
  tg.expand()
  // Otherwise a downward swipe on the card closes the Mini App.
  if (tg.isVersionAtLeast('7.7')) tg.disableVerticalSwipes?.()
  applyTheme(tg)
  tg.onEvent('themeChanged', () => applyTheme(tg))
}

function applyTheme(tg: TgWebApp) {
  const p = tg.themeParams
  const root = document.documentElement
  root.dataset.theme = tg.colorScheme
  const map: Record<string, string | undefined> = {
    '--bg': p.secondary_bg_color ?? p.bg_color,
    '--surface': p.section_bg_color ?? p.bg_color,
    '--text': p.text_color,
    '--muted': p.hint_color,
    '--accent': p.button_color ?? p.link_color,
    '--accent-text': p.button_text_color,
    '--link': p.link_color,
  }
  for (const [k, v] of Object.entries(map)) {
    if (v) root.style.setProperty(k, v)
    else root.style.removeProperty(k)
  }
  if (tg.isVersionAtLeast('6.1')) {
    tg.setHeaderColor?.('secondary_bg_color')
    tg.setBackgroundColor?.('secondary_bg_color')
  }
}

let backHandler: (() => void) | null = null

// Shows the native back button with `fn` as its action, or hides it.
export function setBackButton(fn: (() => void) | null): void {
  const tg = app()
  if (!tg || !tg.isVersionAtLeast('6.1')) return
  if (backHandler) tg.BackButton.offClick(backHandler)
  backHandler = fn
  if (fn) {
    tg.BackButton.onClick(fn)
    tg.BackButton.show()
  } else tg.BackButton.hide()
}

export const haptic = {
  impact(style: 'light' | 'medium' | 'heavy' | 'soft' | 'rigid' = 'light') {
    const tg = app()
    if (tg?.isVersionAtLeast('6.1')) tg.HapticFeedback.impactOccurred(style)
  },
  notify(type: 'error' | 'success' | 'warning') {
    const tg = app()
    if (tg?.isVersionAtLeast('6.1')) tg.HapticFeedback.notificationOccurred(type)
  },
  select() {
    const tg = app()
    if (tg?.isVersionAtLeast('6.1')) tg.HapticFeedback.selectionChanged()
  },
}

// Opens a t.me link inside Telegram (the bot's chat) instead of a browser
// tab. false outside Telegram: the caller's own link does the job.
export function openTelegramLink(url: string): boolean {
  const tg = app()
  if (!tg?.openTelegramLink || !tg.isVersionAtLeast('6.1')) return false
  tg.openTelegramLink(url)
  return true
}

// Asks before the Mini App is closed (swipe down, ✕); see unsaved.ts.
export function setClosingConfirmation(on: boolean): void {
  const tg = app()
  if (!tg || !tg.isVersionAtLeast('6.2')) return
  if (on) tg.enableClosingConfirmation?.()
  else tg.disableClosingConfirmation?.()
}
