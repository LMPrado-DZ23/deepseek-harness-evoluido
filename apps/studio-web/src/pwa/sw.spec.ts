import { beforeEach, describe, expect, it, vi } from 'vitest'
import pwa from '../i18n/pwa.pt-BR.json'
import { OFFLINE_STATUS, PRECACHE_PATHS, SHELL_CLEARED_MESSAGE, SHELL_LOGOUT_MESSAGE, SHELL_SOURCE_HEADER, SHELL_SOURCE_PATH, SW_CACHE_PREFIX } from './policy'

type Listener = (event: never) => void
const listeners = new Map<string, Listener>()
const store = new Map<string, Map<string, Response>>()

function fakeCaches() {
  return {
    open: async (name: string) => {
      const bucket = store.get(name) ?? new Map<string, Response>()
      store.set(name, bucket)
      const keyOf = (input: Request | string) => typeof input === 'string' ? new URL(input, 'http://127.0.0.1:4179').href : input.url
      return {
        addAll: async (paths: string[]) => { for (const path of paths) bucket.set(keyOf(path), await fetch(new Request(keyOf(path)))) },
        match: async (input: Request | string) => bucket.get(keyOf(input))?.clone(),
        put: async (input: Request | string, response: Response) => { bucket.set(keyOf(input), response) },
      }
    },
    keys: async () => [...store.keys()],
    delete: async (name: string) => store.delete(name),
  }
}

function fetchEvent(request: Request) {
  let promise: Promise<Response> | undefined
  const event = { request, respondWith: (value: Promise<Response>) => { promise = value } }
  ;(listeners.get('fetch') as (event: unknown) => void)(event)
  return promise
}

beforeEach(async () => {
  listeners.clear(); store.clear()
  vi.resetModules()
  vi.stubGlobal('self', {
    location: { origin: 'http://127.0.0.1:4179' },
    navigator: { onLine: false },
    addEventListener: (name: string, listener: Listener) => { listeners.set(name, listener) },
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined, matchAll: async () => [] },
  })
  vi.stubGlobal('caches', fakeCaches())
  vi.stubGlobal('fetch', vi.fn(async (input: Request | string) => new Response(`ok:${typeof input === 'string' ? input : input.url}`, { status: 200 })))
  await import('./sw')
})

describe('built service worker behaviour', () => {
  it('precaches the shell on install and drops older shell caches on activate', async () => {
    const waits: Promise<unknown>[] = []
    ;(listeners.get('install') as (event: unknown) => void)({ waitUntil: (p: Promise<unknown>) => waits.push(p) })
    await Promise.all(waits)
    const [name] = [...store.keys()]
    expect(name?.startsWith(SW_CACHE_PREFIX)).toBe(true)
    expect([...store.get(name!)!.keys()].map(url => new URL(url).pathname)).toEqual([...PRECACHE_PATHS])
    store.set(`${SW_CACHE_PREFIX}old`, new Map())
    const activations: Promise<unknown>[] = []
    ;(listeners.get('activate') as (event: unknown) => void)({ waitUntil: (p: Promise<unknown>) => activations.push(p) })
    await Promise.all(activations)
    expect(store.has(`${SW_CACHE_PREFIX}old`)).toBe(false)
    expect(store.has(name!)).toBe(true)
  })

  it('answers /api/ requests from the network only and with a 503 OFFLINE body when the network fails', async () => {
    const online = await fetchEvent(new Request('http://127.0.0.1:4179/api/studio/apps/projects'))
    expect(await online!.text()).toContain('ok:')
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const offline = await fetchEvent(new Request('http://127.0.0.1:4179/api/studio/apps/projects'))
    expect(offline!.status).toBe(OFFLINE_STATUS)
    expect(await offline!.json()).toEqual({ error: 'OFFLINE', offline: true })
    for (const bucket of store.values()) for (const url of bucket.keys()) expect(new URL(url).pathname.startsWith('/api/')).toBe(false)
  })

  it('serves hashed assets cache-first and the shell network-first with the cached shell as fallback', async () => {
    const asset = new Request('http://127.0.0.1:4179/studio/assets/main-abc.js')
    await fetchEvent(asset)
    expect(fetch).toHaveBeenCalledTimes(1)
    await fetchEvent(asset)
    expect(fetch).toHaveBeenCalledTimes(1)
    const shell = new Request('http://127.0.0.1:4179/studio/')
    expect(await (await fetchEvent(shell))!.text()).toContain('ok:')
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    expect(await (await fetchEvent(new Request('http://127.0.0.1:4179/studio/projects/x')))!.text()).toContain('ok:')
    // A stalled server (connection accepted, never answered) must not hang the shell: the cached copy wins after the timeout.
    vi.useFakeTimers()
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise(() => undefined))
    const stalled = fetchEvent(new Request('http://127.0.0.1:4179/studio/'))
    await vi.advanceTimersByTimeAsync(4_100)
    expect(await (await stalled)!.text()).toContain('ok:')
    vi.useRealTimers()
    // A request the page aborted is not an offline condition.
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new DOMException('aborted', 'AbortError'))
    await expect(fetchEvent(new Request('http://127.0.0.1:4179/api/studio/apps/health'))).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchEvent(new Request('http://127.0.0.1:4179/healthz'))).toBeUndefined()
    expect(fetchEvent(new Request('http://127.0.0.1:4179/studio/', { method: 'POST' }))).toBeUndefined()
  })
})

const shellSourceUrl = new URL(SHELL_SOURCE_PATH, 'http://127.0.0.1:4179').href
async function markedShellSource(): Promise<string | undefined> {
  for (const bucket of store.values()) {
    const marked = bucket.get(shellSourceUrl)
    if (marked !== undefined) return (await marked.clone().text()).trim()
  }
  return undefined
}

async function install(): Promise<void> {
  const waits: Promise<unknown>[] = []
  ;(listeners.get('install') as (event: unknown) => void)({ waitUntil: (p: Promise<unknown>) => waits.push(p) })
  await Promise.all(waits)
}

describe('with no network AND no copy of the shell left on the device', () => {
  /**
   * The browser evicts Cache Storage under storage pressure and keeps the worker registered, so a
   * person really does reach this state. The worker used to answer `new Response('', { status: 503 })`:
   * Chrome turns a body-less error status into net::ERR_HTTP_RESPONSE_CODE_FAILURE and shows its own
   * error screen, in English — strictly worse than having no worker at all, since the browser's own
   * "no internet" page would have been in the person's language.
   */
  it('answers a readable pt-BR page instead of an empty 503 the browser turns into its own error screen', async () => {
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const response = await fetchEvent(new Request('http://127.0.0.1:4179/studio/'))
    expect(response!.status).toBe(OFFLINE_STATUS)
    // A body-less answer is exactly the defect; a content type the browser will not render is the same defect.
    expect(response!.headers.get('content-type')).toBe('text/html; charset=utf-8')
    const html = await response!.text()
    expect(html.length).toBeGreaterThan(0)
    expect(html).toContain('<html lang="pt-BR"')
    expect(html).toContain(pwa.offline.shellUnavailable.title)
    expect(html).toContain(pwa.offline.shellUnavailable.body)
    expect(html).toContain(pwa.offline.shellUnavailable.retry)
    // The sentences come from the catalogue, never from the worker source.
    expect(html).not.toMatch(/lang="en"/u)
  })
})

describe('a shell that came back from the copy saved on this device', () => {
  it('is marked as such, so the interface can say it is a saved screen and not a live session', async () => {
    await install()
    // Online: the shell came from the server, and that is what the marker says.
    await fetchEvent(new Request('http://127.0.0.1:4179/studio/'))
    expect(await markedShellSource()).toBe('network')
    // Network gone: the cached shell is served, and the answer carries the mark.
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const fallback = await fetchEvent(new Request('http://127.0.0.1:4179/studio/'))
    expect(fallback!.status).toBe(200)
    expect(fallback!.headers.get(SHELL_SOURCE_HEADER)).toBe('cache')
    expect(await markedShellSource()).toBe('cache')
  })

  it('stops existing once the server says the session ended: a 401 on /studio/ drops every shell cache', async () => {
    await install()
    expect([...store.keys()].some(name => name.startsWith(SW_CACHE_PREFIX))).toBe(true)
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response('Entre para continuar.', { status: 401 }))
    const denied = await fetchEvent(new Request('http://127.0.0.1:4179/studio/'))
    expect(denied!.status).toBe(401)
    expect([...store.keys()].filter(name => name.startsWith(SW_CACHE_PREFIX))).toEqual([])
    // And with the caches gone, offline is the honest page — not the interface of whoever was signed in.
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const afterwards = await fetchEvent(new Request('http://127.0.0.1:4179/studio/'))
    expect(afterwards!.status).toBe(OFFLINE_STATUS)
    expect(await afterwards!.text()).toContain(pwa.offline.shellUnavailable.title)
  })

  it('is forgotten when the page signs the person out, and the worker confirms it', async () => {
    await install()
    const replies: unknown[] = []
    const waits: Promise<unknown>[] = []
    ;(listeners.get('message') as (event: unknown) => void)({
      data: { type: SHELL_LOGOUT_MESSAGE },
      ports: [{ postMessage: (value: unknown) => replies.push(value) }],
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    })
    await Promise.all(waits)
    expect([...store.keys()].filter(name => name.startsWith(SW_CACHE_PREFIX))).toEqual([])
    expect(replies).toEqual([{ type: SHELL_CLEARED_MESSAGE }])
    // Any other message is not a sign-out and must not delete anything.
    await install()
    ;(listeners.get('message') as (event: unknown) => void)({ data: { type: 'algo-outro' }, ports: [], waitUntil: (p: Promise<unknown>) => waits.push(p) })
    await Promise.all(waits)
    expect([...store.keys()].some(name => name.startsWith(SW_CACHE_PREFIX))).toBe(true)
  })
})
