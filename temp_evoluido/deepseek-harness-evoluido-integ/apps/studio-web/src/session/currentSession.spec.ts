import { describe, expect, it, vi } from 'vitest'
import { CURRENT_SESSION_ENDPOINT, currentSessionMode } from './currentSession'

describe('current browser session', () => {
  it.each(['authenticated', 'personal'] as const)('accepts the declared %s mode', async mode => {
    const fetchSession = vi.fn(async () => Response.json({ mode }))

    await expect(currentSessionMode(fetchSession)).resolves.toBe(mode)
    expect(fetchSession).toHaveBeenCalledWith(CURRENT_SESSION_ENDPOINT, { method: 'GET', credentials: 'same-origin' })
  })

  it('fails closed when the response is unauthenticated, malformed or unavailable', async () => {
    await expect(currentSessionMode(async () => Response.json({ error: 'login' }, { status: 401 }))).resolves.toBe('unavailable')
    await expect(currentSessionMode(async () => Response.json({ mode: 'owner' }))).resolves.toBe('unavailable')
    await expect(currentSessionMode(async () => { throw new Error('offline') })).resolves.toBe('unavailable')
  })
})
