/// <reference lib="webworker" />
// Studio service worker: offline shell only. Project data (anything under
// /api/) is never cached; see policy.ts. Bundled by Vite to /studio/sw.js.
import {
  decide, OFFLINE_STATUS, offlineApiResponseBody, offlineShellHtml, PRECACHE_PATHS, SESSION_ENDED_STATUS,
  SHELL_CLEARED_MESSAGE, SHELL_LOGOUT_MESSAGE, SHELL_SOURCE_ANSWER, SHELL_SOURCE_HEADER, SHELL_SOURCE_PATH,
  SHELL_SOURCE_REQUEST, shellSourceKey, SW_CACHE_PREFIX, type ShellSource,
} from './policy'

declare const self: ServiceWorkerGlobalScope
declare const __DZ23_SW_VERSION__: string

const CACHE_NAME = `${SW_CACHE_PREFIX}${__DZ23_SW_VERSION__}`
const SHELL_NETWORK_TIMEOUT_MS = 4_000

/**
 * A request for a SCREEN, not a request made by one. `mode` is 'navigate' only for a document the
 * browser is navigating to; `destination` says the same thing where it is exposed. Anything a page
 * fetches for itself is neither, whatever its path looks like.
 */
function isNavigation(request: Request): boolean {
  return request.mode === 'navigate' || request.destination === 'document'
}

/** Network-first must not hang on a stalled server: after the timeout the cached shell wins. */
function fetchWithTimeout(request: Request, timeoutMs: number): Promise<Response> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('shell-network-timeout')), timeoutMs)
    fetch(request).then(response => { clearTimeout(timer); resolvePromise(response) }, error => { clearTimeout(timer); reject(error) })
  })
}

/**
 * Where THIS navigation's shell came from, kept under the id of the page the answer will create. The
 * page asks for its own on boot (it cannot read the headers of its own navigation), and a page the
 * worker never saw — a reload that bypassed it — has nothing here and is told nothing.
 */
async function markShellSource(cache: Cache, clientId: string, source: ShellSource): Promise<void> {
  // No client id means no page will ever be able to ask about it: writing it would only leave litter.
  if (clientId === '') return
  await cache.put(shellSourceKey(clientId), new Response(source, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } }))
  await forgetMarksOfClosedPages(cache, clientId)
}

/** One mark per open page and no more: what a closed tab left behind is dropped on the next write. */
async function forgetMarksOfClosedPages(cache: Cache, keep: string): Promise<void> {
  const open = new Set((await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).map(client => client.id))
  // The page this mark is for does not exist yet — it is created BY the answer being written.
  open.add(keep)
  for (const request of await cache.keys()) {
    const url = new URL(request.url)
    if (url.pathname !== SHELL_SOURCE_PATH) continue
    const client = url.searchParams.get('client')
    if (client !== null && !open.has(client)) await cache.delete(request)
  }
}

/** The answer to "what am I looking at", for the page that asked and for no other. */
async function shellSourceOf(clientId: string): Promise<ShellSource | undefined> {
  if (clientId === '') return undefined
  const marked = await caches.match(shellSourceKey(clientId))
  if (marked === undefined) return undefined
  const value = (await marked.text()).trim()
  return value === 'cache' || value === 'network' ? value : undefined
}

/** The session is over: the copy of the authenticated interface saved on this device goes with it. */
async function clearShellCaches(): Promise<void> {
  const names = await caches.keys()
  await Promise.all(names.filter(name => name.startsWith(SW_CACHE_PREFIX)).map(name => caches.delete(name)))
}

self.addEventListener('message', event => {
  const type = (event.data as { type?: unknown } | null | undefined)?.type
  if (type === SHELL_SOURCE_REQUEST) {
    const port = event.ports[0]
    if (port === undefined) return
    // `event.source.id` is the page that asked. That is the whole guarantee: no page can be handed
    // another page's navigation, and a page with no controller never gets here at all.
    const client = (event.source as { id?: string } | null | undefined)?.id ?? ''
    event.waitUntil((async () => { port.postMessage({ type: SHELL_SOURCE_ANSWER, source: await shellSourceOf(client) }) })())
    return
  }
  if (type !== SHELL_LOGOUT_MESSAGE) return
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
  // The page this answer will belong to: `resultingClientId` on a navigation, `clientId` when a page
  // that already exists asks for one of these paths itself.
  const clientId = ((event as { resultingClientId?: string }).resultingClientId ?? '') || ((event as { clientId?: string }).clientId ?? '')
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME)
    try {
      const response = await fetchWithTimeout(request, SHELL_NETWORK_TIMEOUT_MS)
      if (response.ok) { await cache.put(PRECACHE_PATHS[0], response.clone()); await markShellSource(cache, clientId, 'network') }
      // The server answers 401 on /studio/ once the session is over. Keeping the shell cached after
      // that is what made the interface come back offline for whoever picks the device up next.
      //
      // Only a NAVIGATION says that, though. `decide()` calls every extensionless GET under /studio/
      // `shell-html`, which today is true — it is all the same single-page interface — but it means
      // a 401 on ANY such path threw away the whole saved shell. The day one of them is not the
      // interface (a probe, a callback, a second app mounted under the same prefix), one refusal
      // from it would have taken the offline shell of a person who was signed in perfectly well.
      // A screen being denied to somebody is what "the session is over" looks like; a background
      // request being denied is not.
      else if (response.status === SESSION_ENDED_STATUS && isNavigation(request)) await clearShellCaches()
      return response
    } catch {
      const fallback = await cache.match(PRECACHE_PATHS[0])
      if (fallback !== undefined) {
        await markShellSource(cache, clientId, 'cache')
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
