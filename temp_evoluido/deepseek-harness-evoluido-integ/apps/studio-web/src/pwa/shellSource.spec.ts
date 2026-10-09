import { describe, expect, it } from 'vitest'
import { forgetSavedShell, shellSource } from './register'
import { SHELL_CLEARED_MESSAGE, SHELL_LOGOUT_MESSAGE, SHELL_SOURCE_ANSWER, SHELL_SOURCE_REQUEST, SW_CACHE_PREFIX } from './policy'

/**
 * The page side of "this screen is the copy saved on this device". A page cannot read the headers of
 * its own navigation response, so it asks the worker that controls it and the worker answers about
 * the navigation that made THIS page — these are the two halves of that contract, on the page's half.
 */
/** A navigator whose page is controlled by a worker that answers `source` for it. */
function controlledBy(answer: unknown, options: { silent?: boolean } = {}): Navigator {
  return {
    serviceWorker: {
      controller: {
        postMessage: (data: unknown, transfer: Transferable[]) => {
          const port = transfer[0] as MessagePort
          expect(data).toEqual({ type: SHELL_SOURCE_REQUEST })
          if (options.silent === true) return
          port.postMessage(answer)
          port.start()
        },
      },
    },
  } as unknown as Navigator
}

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
  it('asks the worker that controls it, and says nothing when nobody answered', async () => {
    expect(await shellSource({ navigator: controlledBy({ type: SHELL_SOURCE_ANSWER, source: 'cache' }) })).toBe('cache')
    expect(await shellSource({ navigator: controlledBy({ type: SHELL_SOURCE_ANSWER, source: 'network' }) })).toBe('network')
    // The worker saw this page but has nothing marked for it, or answers something nobody wrote:
    // an unknown stays an unknown, and the interface says nothing extra.
    expect(await shellSource({ navigator: controlledBy({ type: SHELL_SOURCE_ANSWER, source: undefined }) })).toBeUndefined()
    expect(await shellSource({ navigator: controlledBy({ type: SHELL_SOURCE_ANSWER, source: 'qualquer-coisa' }) })).toBeUndefined()
    expect(await shellSource({ navigator: controlledBy({ type: 'outra-coisa', source: 'cache' }) })).toBeUndefined()
    // A worker that never answers must not leave the interface waiting for it.
    expect(await shellSource({ navigator: controlledBy({ type: SHELL_SOURCE_ANSWER, source: 'cache' }, { silent: true }) }, 10)).toBeUndefined()
  })

  /**
   * The defect this shape exists for, reproduced in Chromium with `Network.setBypassServiceWorker`:
   * a reload that bypasses the worker serves the shell straight from the server, and the page it
   * creates has NO controller. Reading a global mark left in Cache Storage by an earlier offline
   * visit, the page then told somebody with a live session "Mostrando a tela salva neste aparelho;
   * entre de novo quando a internet voltar." A page nobody controls has nobody to ask, and claims
   * nothing about a navigation the worker never saw.
   */
  it('claims nothing when the navigation bypassed the worker, however the device was left before', async () => {
    for (const controller of [null, undefined]) {
      expect(await shellSource({ navigator: { serviceWorker: { controller } } as unknown as Navigator })).toBeUndefined()
    }
    // A browser with no service worker support at all is the same unknown.
    expect(await shellSource({ navigator: {} as unknown as Navigator })).toBeUndefined()
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
