// Hash routes, parsed without touching `location` so they can be tested.
// Telegram appends its launch parameters to the hash — after a "?", after a
// bare "&", or as the whole hash (#tgWebAppData=…) — so every tgWebApp* key
// is dropped and a hash of nothing but those is home.

export type Tab = 'review' | 'words' | 'progress' | 'settings'

export interface Route {
  path: string
  parts: string[]
  query: URLSearchParams
  tab: Tab
}

// A malformed escape (#/word/%E0) is kept as typed rather than throwing.
function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '')
  const cut = raw.search(/[?&]/)
  let p = cut < 0 ? raw : raw.slice(0, cut)
  const q = new URLSearchParams(cut < 0 ? '' : raw.slice(cut + 1))
  for (const k of [...q.keys()]) if (k.startsWith('tgWebApp')) q.delete(k)
  if (p.startsWith('tgWebApp') || p.includes('=')) p = ''
  let parts = p.split('/').filter(Boolean).map(decodeSafe)
  const [a, b] = parts
  // Aliases: the bot's deep links (#/words/<id>, #/words/new?term=…,
  // #/dashboard), links from before words replaced notes, and the inbox
  // that is gone (a proposal's link opens its editor).
  if (a === 'words' && b === 'new') parts = ['add']
  else if (a === 'inbox') parts = b ? [b.startsWith('ft_') ? 'fact' : 'word', b] : ['words']
  else if (a === 'words' && b) parts = ['word', b]
  else if (a === 'dashboard' || a === 'stats') parts = ['progress']
  else if (a === 'browse' || a === 'note') parts = ['words']
  const first = parts[0] ?? ''
  // Pushed screens belong to the tab they were opened from.
  const from = q.get('from') ?? ''
  // An editor belongs to the review card it was opened from, else to the Cards tab.
  const tab: Tab =
    first === 'fact'
      ? from === '/' ? 'review' : 'words'
      : first === 'words' || (first === 'word' && from !== '/')
      ? 'words'
      : first === 'word'
        ? 'review'
      : first === 'add' || first === 'practice'
        ? from.startsWith('/words') || from.startsWith('/word/') || from.startsWith('/handbook') ? 'words' : 'review'
      : first === 'handbook'
        ? 'words'
          : first === 'progress' || first === 'test'
            ? 'progress'
            : first === 'settings'
              ? 'settings'
              : 'review'
  return { path: '/' + parts.join('/'), parts, query: q, tab }
}
