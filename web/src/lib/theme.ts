// Manual light/dark override on top of prefers-color-scheme. Telegram sets
// data-theme itself from its colour scheme.
export type ThemeChoice = 'auto' | 'light' | 'dark'

export function loadTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem('theme')
    return v === 'light' || v === 'dark' ? v : 'auto'
  } catch {
    return 'auto'
  }
}

export function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement
  if (choice === 'auto') delete root.dataset.theme
  else root.dataset.theme = choice
  try {
    if (choice === 'auto') localStorage.removeItem('theme')
    else localStorage.setItem('theme', choice)
  } catch {
    // Storage unavailable; the choice lasts for this page load.
  }
}
