/**
 * Caching policy of the Studio service worker, kept pure so it can be unit
 * tested and shared by the worker and the page.
 *
 * - `shell`: the app shell (`/studio/`, its hashed assets, manifest, icons,
 *   brand image). Assets are immutable (hashed names) → cache-first; the
 *   shell HTML is network-first with the cached copy as offline fallback.
 * - `api`: anything under `/api/` — never cached, never served from cache. A
 *   request made offline receives a synthetic 503 so the interface can say
 *   "you are offline" instead of showing stale project data.
 * - `bypass`: everything else (other origins, non-GET) is left to the network.
 */
export type CacheDecision = 'shell-asset' | 'shell-html' | 'api' | 'bypass'

export const SW_CACHE_PREFIX = 'dz23-studio-shell-'
export const SW_SCOPE = '/studio/'
export const OFFLINE_STATUS = 503
export const OFFLINE_ERROR_CODE = 'OFFLINE'
/** The browser has a network but the Studio did not answer: a different message for the person, and a different cause. */
export const SERVICE_UNREACHABLE_ERROR_CODE = 'SERVICE_UNREACHABLE'

export function decide(method: string, url: URL, origin: string): CacheDecision {
  if (url.origin !== origin) return 'bypass'
  // Every method under /api/, not only GET: a POST that fails with no network used to surface as a
  // raw "Failed to fetch", so the sentence the catalogue has for a blocked action was never shown.
  // Nothing is cached or retried here — the answer is the same honest 503.
  if (url.pathname.startsWith('/api/')) return 'api'
  if (method !== 'GET') return 'bypass'
  if (!url.pathname.startsWith(SW_SCOPE)) return 'bypass'
  if (url.pathname.startsWith(`${SW_SCOPE}assets/`) || url.pathname.startsWith(`${SW_SCOPE}icons/`) || url.pathname.startsWith(`${SW_SCOPE}brand/`) || url.pathname === `${SW_SCOPE}manifest.json`) return 'shell-asset'
  if (url.pathname === SW_SCOPE || url.pathname === `${SW_SCOPE}index.html` || !/\.[a-z0-9]+$/iu.test(url.pathname)) return 'shell-html'
  return 'bypass'
}

/** Paths precached on install: only the shell entry points; hashed assets are cached as they are first loaded. */
export const PRECACHE_PATHS = [SW_SCOPE, `${SW_SCOPE}manifest.json`, `${SW_SCOPE}icons/icon-192.png`, `${SW_SCOPE}icons/icon-512.png`, `${SW_SCOPE}icons/maskable-512.png`] as const

export function offlineApiResponseBody(online = false): string {
  // `online` comes from navigator.onLine inside the worker: with a network, a failed API call is the
  // Studio being unreachable, not the person being offline. The interface says each in its own words.
  return online
    ? JSON.stringify({ error: SERVICE_UNREACHABLE_ERROR_CODE, offline: false, serviceUnreachable: true })
    : JSON.stringify({ error: OFFLINE_ERROR_CODE, offline: true })
}
