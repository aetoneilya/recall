// Service worker template; scripts/sw-plugin.ts fills in the precache list
// and version at build time.
const VERSION = self.__VERSION__
const PRECACHE = self.__PRECACHE__
const CACHE = `recall-shell-${VERSION}`

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('recall-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  // Data never goes through the SW cache: the app keeps it in IndexedDB.
  // OAuth and MCP pages are server-rendered and must always hit the network.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/mcp')) return

  const scope = new URL(self.registration.scope)
  const isShell = req.mode === 'navigate' && (url.pathname === scope.pathname || url.pathname === `${scope.pathname}index.html`)
  if (isShell) {
    // The shell is versioned with its assets, so cache-first is safe and
    // makes a cold start on a flaky connection instant.
    event.respondWith(
      caches.match('./', { ignoreSearch: true }).then((hit) => hit || fetch(req)),
    )
    return
  }
  if (req.mode === 'navigate') return

  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && url.pathname.includes('/assets/')) {
            const copy = res.clone()
            caches.open(CACHE).then((cache) => cache.put(req, copy))
          }
          return res
        }),
    ),
  )
})
