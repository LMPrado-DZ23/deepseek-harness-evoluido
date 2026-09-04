import t from '../i18n/pwa.pt-BR.json'

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

/**
 * Where the shell HTML the person is looking at came from. The worker writes it into its own cache
 * (Cache Storage — no other browser storage is used anywhere in this product) BEFORE answering the
 * navigation, so the page can read it as soon as it boots and say the truth out loud.
 *
 * Why this exists: the server sends `cache-control: no-store` on every `/studio/` response and
 * answers 401 once the session is over, and the worker used to serve the cached shell with no notion
 * of either. After a session ended, going offline brought the whole authenticated interface back and
 * the only thing the person was told was "you are offline" — while the truth was "your session
 * ended". Nothing leaks (no project data is ever cached, and `/api/` is never cached at all), but the
 * state is one nobody can understand, especially on a shared device.
 */
export type ShellSource = 'network' | 'cache'
export const SHELL_SOURCE_PATH = `${SW_SCOPE}__shell-source`
export const SHELL_SOURCE_HEADER = 'x-dz23-shell-source'
/** A page that signs the person out tells the worker, and the copy of the interface saved here goes away. */
export const SHELL_LOGOUT_MESSAGE = 'dz23:shell-logout'
export const SHELL_CLEARED_MESSAGE = 'dz23:shell-cleared'
/** The status the server answers on `/studio/` once the session is over. */
export const SESSION_ENDED_STATUS = 401

function escapeHtml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;')
}

/**
 * The last-resort page: no network AND no copy of the shell on this device (the browser evicts the
 * Cache Storage under storage pressure while keeping the worker registered, so this is a state real
 * people reach). It used to be `new Response('', { status: 503 })` — no body, no content type — which
 * Chrome turns into `net::ERR_HTTP_RESPONSE_CODE_FAILURE` and its own error screen, in English. That
 * is strictly worse than having no service worker at all, because without one the browser would have
 * shown its ordinary "no internet" page in the person's language. So: a real page, in pt-BR, that says
 * what happened and what to do.
 */
export function offlineShellHtml(): string {
  const { title, body, retry } = t.offline.shellUnavailable
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${escapeHtml(title)}</title>`
    + `<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;`
    + `font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#0f1430;color:#f4f6ff;padding:24px}`
    + `main{max-width:34rem}h1{font-size:1.35rem;margin:0 0 .75rem}p{margin:0 0 .75rem;opacity:.9}</style></head>`
    + `<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p><p>${escapeHtml(retry)}</p></main></body></html>`
}
