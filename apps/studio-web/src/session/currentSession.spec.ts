import { describe, expect, it, vi } from 'vitest'
import { CURRENT_SESSION_ENDPOINT, currentSessionMode, currentSessionScope } from './currentSession'

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

describe('escopo dos recibos locais', () => {
  const principal = { userId: 'u', orgId: 'o', tenantId: 't' }
  it('usa os três identificadores devolvidos pelo servidor', async () => {
    await expect(currentSessionScope(async () => Response.json({ principal }))).resolves.toEqual(['u', 'o', 't'])
  })
  it.each(['userId', 'orgId', 'tenantId'])('não reutiliza recibo sem %s válido', async field => {
    for (const value of ['', null, 2]) {
      await expect(currentSessionScope(async () => Response.json({ principal: { ...principal, [field]: value } }))).resolves.toBeNull()
    }
  })
  it('não infere o titular quando autenticação ou leitura falham', async () => {
    await expect(currentSessionScope(async () => Response.json({ principal }, { status: 401 }))).resolves.toBeNull()
    await expect(currentSessionScope(async () => Response.json(null))).resolves.toBeNull()
    await expect(currentSessionScope(async () => { throw new Error('offline') })).resolves.toBeNull()
  })
})
