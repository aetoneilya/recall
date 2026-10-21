// Hash routes, parsed without touching `location` so they can be tested.
// Telegram appends its launch parameters to the hash — after a "?", after a
// bare "&", or as the whole hash (#tgWebAppData=…) — so every tgWebApp* key
// is dropped and a hash of nothing but those is home.

export type Tab = 'review' | 'words' | 'inbox' | 'progress' | 'settings'

export interface Route {
  path: string
  parts: string[]
  query: URLSearchParams
  tab: Tab
}

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '')
  const cut = raw.search(/[?&]/)
  let p = cut < 0 ? raw : raw.slice(0, cut)
  const q = new URLSearchParams(cut < 0 ? '' : raw.slice(cut + 1))
  for (const k of [...q.keys()]) if (k.startsWith('tgWebApp')) q.delete(k)
  if (p.startsWith('tgWebApp') || p.includes('=')) p = ''
  let parts = p.split('/').filter(Boolean).map((s) => decodeURIComponent(s))
  const [a, b] = parts
  // Aliases: the bot's deep links (#/words/<id>, #/words/new?term=…,
  // #/dashboard) and links from before words replaced notes.
  if (a === 'words' && b === 'new') parts = ['add']
  else if (a === 'words' && b) parts = ['word', b]
  else if (a === 'dashboard' || a === 'stats') parts = ['progress']
  else if (a === 'browse' || a === 'note') parts = ['words']
  const first = parts[0] ?? ''
  // Pushed screens belong to the tab they were opened from.
  const from = q.get('from') ?? ''
  const tab: Tab =
    first === 'words' || first === 'word'
      ? 'words'
      : first === 'add'
        ? from.startsWith('/words') || from.startsWith('/word/') ? 'words' : 'review'
        : first === 'inbox'
          ? 'inbox'
          : first === 'progress' || first === 'test'
            ? 'progress'
            : first === 'settings'
              ? 'settings'
              : 'review'
  return { path: '/' + parts.join('/'), parts, query: q, tab }
}
