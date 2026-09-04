/// <reference lib="webworker" />
// Studio service worker: offline shell only. Project data (anything under
// /api/) is never cached; see policy.ts. Bundled by Vite to /studio/sw.js.
import { decide, OFFLINE_STATUS, offlineApiResponseBody, PRECACHE_PATHS, SW_CACHE_PREFIX } from './policy'

declare const self: ServiceWorkerGlobalScope
declare const __DZ23_SW_VERSION__: string

const CACHE_NAME = `${SW_CACHE_PREFIX}${__DZ23_SW_VERSION__}`

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
    event.respondWith(fetch(request).catch(() => new Response(offlineApiResponseBody(), {
      status: OFFLINE_STATUS, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })))
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
      const response = await fetch(request)
      if (response.ok) await cache.put(PRECACHE_PATHS[0], response.clone())
      return response
    } catch {
      const fallback = await cache.match(PRECACHE_PATHS[0])
      if (fallback !== undefined) return fallback
      return new Response('', { status: OFFLINE_STATUS })
    }
  })())
})
