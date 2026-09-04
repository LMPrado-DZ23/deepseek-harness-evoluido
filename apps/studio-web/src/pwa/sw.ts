/// <reference lib="webworker" />
// Studio service worker: offline shell only. Project data (anything under
// /api/) is never cached; see policy.ts. Bundled by Vite to /studio/sw.js.
import {
  decide, OFFLINE_STATUS, offlineApiResponseBody, offlineShellHtml, PRECACHE_PATHS, SESSION_ENDED_STATUS,
  SHELL_CLEARED_MESSAGE, SHELL_LOGOUT_MESSAGE, SHELL_SOURCE_HEADER, SHELL_SOURCE_PATH, SW_CACHE_PREFIX,
  type ShellSource,
} from './policy'

declare const self: ServiceWorkerGlobalScope
declare const __DZ23_SW_VERSION__: string

const CACHE_NAME = `${SW_CACHE_PREFIX}${__DZ23_SW_VERSION__}`
const SHELL_NETWORK_TIMEOUT_MS = 4_000

/** Network-first must not hang on a stalled server: after the timeout the cached shell wins. */
function fetchWithTimeout(request: Request, timeoutMs: number): Promise<Response> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('shell-network-timeout')), timeoutMs)
    fetch(request).then(response => { clearTimeout(timer); resolvePromise(response) }, error => { clearTimeout(timer); reject(error) })
  })
}

/** The page reads this back on boot: it is the only way it can know the screen is a saved copy. */
async function markShellSource(cache: Cache, source: ShellSource): Promise<void> {
  await cache.put(SHELL_SOURCE_PATH, new Response(source, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } }))
}

/** The session is over: the copy of the authenticated interface saved on this device goes with it. */
async function clearShellCaches(): Promise<void> {
  const names = await caches.keys()
  await Promise.all(names.filter(name => name.startsWith(SW_CACHE_PREFIX)).map(name => caches.delete(name)))
}

self.addEventListener('message', event => {
  if ((event.data as { type?: unknown } | null | undefined)?.type !== SHELL_LOGOUT_MESSAGE) return
  event.waitUntil((async () => {
    await clearShellCaches()
    const port = event.ports[0]
    if (port !== undefined) { port.postMessage({ type: SHELL_CLEARED_MESSAGE }); return }
    for (const client of await self.clients.matchAll()) client.postMessage({ type: SHELL_CLEARED_MESSAGE })
  })())
})

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME)
    await cache.addAll([...PRECACHE_PATHS])
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names.filter(name => name.startsWith(SW_CACHE_PREFIX) && name !== CACHE_NAME).map(name => caches.delete(name)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', event => {
  const request = event.request
  const url = new URL(request.url)
  const decision = decide(request.method, url, self.location.origin)
  if (decision === 'bypass') return
  if (decision === 'api') {
    event.respondWith(fetch(request).catch((error: unknown) => {
      // A request the page itself cancelled is not "offline".
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      return new Response(offlineApiResponseBody(self.navigator?.onLine === true), {
        status: OFFLINE_STATUS, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    }))
    return
  }
  if (decision === 'shell-asset') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME)
      const cached = await cache.match(request)
      if (cached !== undefined) return cached
      const response = await fetch(request)
      if (response.ok) await cache.put(request, response.clone())
      return response
    })())
    return
  }
  // shell-html: network first, cached shell as offline fallback
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME)
    try {
      const response = await fetchWithTimeout(request, SHELL_NETWORK_TIMEOUT_MS)
      if (response.ok) { await cache.put(PRECACHE_PATHS[0], response.clone()); await markShellSource(cache, 'network') }
      // The server answers 401 on /studio/ once the session is over. Keeping the shell cached after
      // that is what made the interface come back offline for whoever picks the device up next.
      else if (response.status === SESSION_ENDED_STATUS) await clearShellCaches()
      return response
    } catch {
      const fallback = await cache.match(PRECACHE_PATHS[0])
      if (fallback !== undefined) {
        await markShellSource(cache, 'cache')
        // The page cannot read the headers of its own navigation, so the marker above is what it
        // actually reads; the header is here for whoever inspects the response (tests, DevTools).
        const headers = new Headers(fallback.headers)
        headers.set(SHELL_SOURCE_HEADER, 'cache')
        return new Response(fallback.body, { status: fallback.status, statusText: fallback.statusText, headers })
      }
      // No network and no copy left on this device: a page the person can read, not an empty 503.
      return new Response(offlineShellHtml(), {
        status: OFFLINE_STATUS, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
  })())
})
