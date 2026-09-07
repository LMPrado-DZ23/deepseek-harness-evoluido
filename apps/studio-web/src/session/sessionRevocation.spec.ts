import { describe, expect, it, vi } from 'vitest'
import {
  SESSION_REVOCATION_CHANNEL,
  SESSION_REVOCATION_STORAGE_KEY,
  followRemoteSessionRevocation,
  listenForSessionRevocation,
  parseSessionRevocationSignal,
  publishSessionRevocation,
  type SessionRevocationEnvironment,
} from './sessionRevocation'

const eventId = '0123456789abcdef0123456789abcdef'
const sourceId = '11111111111111111111111111111111'
const siblingSourceId = '22222222222222222222222222222222'

function environmentFixture() {
  const messages = new Set<(value: unknown) => void>()
  const storageListeners = new Set<(key: string | null, value: string | null) => void>()
  const posted: unknown[] = []
  const stored: Array<[string, string]> = []
  const removed: string[] = []
  let closes = 0
  const environment: SessionRevocationEnvironment = {
    sourceId,
    createId: () => eventId,
    createChannel: name => {
      expect(name).toBe(SESSION_REVOCATION_CHANNEL)
      return {
        postMessage: value => { posted.push(value); for (const listener of messages) listener(value) },
        onMessage: listener => { messages.add(listener); return () => { messages.delete(listener) } },
        close: () => { closes++ },
      }
    },
    store: (key, value) => { stored.push([key, value]); for (const listener of storageListeners) listener(key, value) },
    remove: key => { removed.push(key); for (const listener of storageListeners) listener(key, null) },
    onStorage: listener => { storageListeners.add(listener); return () => { storageListeners.delete(listener) } },
  }
  return { environment, posted, stored, removed, messages, storageListeners, closes: () => closes }
}

describe('cross-tab session revocation', () => {
  it('accepts only the closed versioned signal', () => {
    const valid = { schema_version: 1, kind: 'signed-out', event_id: eventId, source_id: sourceId }
    expect(parseSessionRevocationSignal(valid)).toEqual(valid)
    expect(parseSessionRevocationSignal({ ...valid, schema_version: 2 })).toBeNull()
    expect(parseSessionRevocationSignal({ ...valid, kind: 'logout' })).toBeNull()
    expect(parseSessionRevocationSignal({ ...valid, event_id: 'not-random' })).toBeNull()
    expect(parseSessionRevocationSignal({ ...valid, source_id: 'not-random' })).toBeNull()
    expect(parseSessionRevocationSignal(null)).toBeNull()
  })

  it('publishes the same data-free signal through both browser transports', () => {
    const fixture = environmentFixture()

    const signal = publishSessionRevocation(fixture.environment)

    expect(signal).toEqual({ schema_version: 1, kind: 'signed-out', event_id: eventId, source_id: sourceId })
    expect(fixture.posted).toEqual([signal])
    expect(fixture.stored).toEqual([[SESSION_REVOCATION_STORAGE_KEY, JSON.stringify(signal)]])
    expect(fixture.removed).toEqual([SESSION_REVOCATION_STORAGE_KEY])
    expect(fixture.closes()).toBe(1)
  })

  it('deduplicates BroadcastChannel and storage delivery and removes both listeners', async () => {
    const fixture = environmentFixture()
    const handled = vi.fn(async () => undefined)
    const stop = listenForSessionRevocation(handled, fixture.environment)

    publishSessionRevocation({ ...fixture.environment, sourceId: siblingSourceId })
    await vi.waitFor(() => expect(handled).toHaveBeenCalledTimes(1))

    stop()
    expect(fixture.messages.size).toBe(0)
    expect(fixture.storageListeners.size).toBe(0)
    expect(fixture.closes()).toBe(2)
  })

  it('does not make the sending tab react to its own channel', async () => {
    const fixture = environmentFixture()
    const handled = vi.fn(async () => undefined)
    const stop = listenForSessionRevocation(handled, fixture.environment)

    publishSessionRevocation(fixture.environment)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(handled).not.toHaveBeenCalled()
    stop()
  })

  it('keeps a newly authenticated session and redirects only after fail-closed cleanup', async () => {
    const cleanup = vi.fn(async () => undefined)
    const redirect = vi.fn()

    await expect(followRemoteSessionRevocation({ currentMode: async () => 'authenticated', clearOwnedState: cleanup, redirect })).resolves.toBe('kept-authenticated')
    expect(cleanup).not.toHaveBeenCalled()
    expect(redirect).not.toHaveBeenCalled()

    cleanup.mockRejectedValueOnce(new Error('cache unavailable'))
    await expect(followRemoteSessionRevocation({ currentMode: async () => { throw new Error('offline') }, clearOwnedState: cleanup, redirect })).resolves.toBe('redirected')
    expect(redirect).toHaveBeenCalledWith('/login')
  })
})
