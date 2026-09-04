import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OFFLINE_STATUS, PRECACHE_PATHS, SW_CACHE_PREFIX } from './policy'

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
    addEventListener: (name: string, listener: Listener) => { listeners.set(name, listener) },
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
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
