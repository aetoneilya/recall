// Hash router: #/words, #/word/wd_x, #/fact/ft_x, #/add, #/progress, #/test. History entries carry a
// depth so Back (ours or Telegram's) can tell an in-app step from a deep link.

import { parseRoute, type Route } from './route.ts'

export type { Route, Tab } from './route.ts'

const parse = (hash: string): Route => parseRoute(hash)

export const router = $state({ route: parse(location.hash) })

function depth(): number {
  return (history.state as { depth?: number } | null)?.depth ?? 0
}

function sync() {
  router.route = parse(location.hash)
}

addEventListener('popstate', sync)
addEventListener('hashchange', sync)

export function navigate(path: string, opts: { replace?: boolean } = {}) {
  const url = `${location.pathname}${location.search}#${path}`
  if (opts.replace) history.replaceState({ depth: depth() }, '', url)
  else history.pushState({ depth: depth() + 1 }, '', url)
  sync()
}

export function parentOf(r: Route): string | null {
  const [a, b] = r.parts
  if (!a) return null
  if (a === 'word' || a === 'add') return r.query.get('from') ?? (a === 'add' ? '/' : '/words')
  if (a === 'fact') return r.query.get('from') ?? '/words'
  if (a === 'deck' || a === 'decks' || a === 'packs') return r.query.get('from') ?? '/words'
  if (a === 'practice') return r.query.get('from') ?? '/'
  if (a === 'handbook') return b ? `/handbook?deck=${r.query.get('deck') ?? ''}` : r.query.get('from') ?? '/words'
  if (a === 'test') return '/progress'
  if (b) return `/${a}`
  return null
}

export function back() {
  if (depth() > 0) history.back()
  else {
    const p = parentOf(router.route)
    navigate(p ?? '/', { replace: true })
  }
}
