import { describe, expect, it } from 'vitest'
import { forgetSavedShell, shellSource } from './register'
import { SHELL_CLEARED_MESSAGE, SHELL_LOGOUT_MESSAGE, SHELL_SOURCE_PATH, SW_CACHE_PREFIX } from './policy'

/**
 * The page side of "this screen is the copy saved on this device". A page cannot read the headers of
 * its own navigation response, so the worker leaves the answer in Cache Storage and the page reads it
 * from there — these are the two halves of that contract, on the page's half.
 */
function fakeCacheStorage(entries: Record<string, string>, names: string[] = [`${SW_CACHE_PREFIX}v1`]): CacheStorage {
  const live = new Set(names)
  return {
    match: async (input: RequestInfo | URL) => {
      const key = String(input)
      return key in entries ? new Response(entries[key]) : undefined
    },
    keys: async () => [...live],
    delete: async (name: string) => live.delete(name),
    has: async () => false,
    open: async () => { throw new Error('not used') },
  } as unknown as CacheStorage
}

describe('what the page can learn about the screen it is showing', () => {
  it('reads the mark the worker left, and says nothing when nobody marked anything', async () => {
    expect(await shellSource(fakeCacheStorage({ [SHELL_SOURCE_PATH]: 'cache' }))).toBe('cache')
    expect(await shellSource(fakeCacheStorage({ [SHELL_SOURCE_PATH]: 'network' }))).toBe('network')
    // No worker yet, no Cache Storage, or a value nobody wrote: an unknown stays an unknown.
    expect(await shellSource(fakeCacheStorage({}))).toBeUndefined()
    expect(await shellSource(fakeCacheStorage({ [SHELL_SOURCE_PATH]: 'qualquer-coisa' }))).toBeUndefined()
    expect(await shellSource(undefined)).toBeUndefined()
  })
})

describe('signing out forgets the copy of the interface saved on this device', () => {
  it('asks the worker and reports the confirmation it got back', async () => {
    const sent: unknown[] = []
    const worker = {
      postMessage: (data: unknown, transfer: Transferable[]) => {
        sent.push(data)
        const port = transfer[0] as MessagePort
        port.postMessage({ type: SHELL_CLEARED_MESSAGE })
        port.start()
      },
    }
    const store = fakeCacheStorage({})
    const confirmed = await forgetSavedShell({ navigator: { serviceWorker: { controller: worker } } as unknown as Navigator, caches: store })
    expect(sent).toEqual([{ type: SHELL_LOGOUT_MESSAGE }])
    expect(confirmed).toBe(true)
  })

  it('deletes the shell caches from the page itself when there is no worker to ask', async () => {
    const store = fakeCacheStorage({}, [`${SW_CACHE_PREFIX}v1`, 'outro-cache'])
    const confirmed = await forgetSavedShell({ navigator: { serviceWorker: { controller: null } } as unknown as Navigator, caches: store })
    expect(confirmed).toBe(false)
    // Only the shell caches: nothing else on the origin is this worker's to delete.
    expect(await store.keys()).toEqual(['outro-cache'])
  })
})
