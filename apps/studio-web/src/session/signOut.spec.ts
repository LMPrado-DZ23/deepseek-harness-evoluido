import { describe, expect, it, vi } from 'vitest'
import { CSRF_STORAGE_KEY } from '../api'
import { HARNESS_SELECTION_STORAGE_KEY } from '../assistant/assistantLaunch'
import { SIGN_OUT_ENDPOINT, signOutCurrentSession, type SignOutPort } from './signOut'

function fixture(response: Response = Response.json({ signed_out: true })) {
  const removed: string[] = []
  const calls: string[] = []
  const port: SignOutPort = {
    fetch: vi.fn(async (input, init) => {
      calls.push(`${init.method}:${input}:${String((init.headers as Record<string, string>)['x-dz23-csrf'])}:${init.credentials}`)
      return response
    }),
    getCsrf: vi.fn(async () => 'csrf-1'),
    forgetShell: vi.fn(async () => { calls.push('forget-shell') }),
    sessionStorage: { removeItem: key => { removed.push(`session:${key}`) } },
    localStorage: { removeItem: key => { removed.push(`local:${key}`) } },
    redirect: vi.fn(path => { calls.push(`redirect:${path}`) }),
  }
  return { port, calls, removed }
}

describe('secure sign out', () => {
  it('revokes on the server before forgetting only DZ23-owned browser state', async () => {
    const f = fixture()

    await signOutCurrentSession(f.port)

    expect(f.calls).toEqual([
      `POST:${SIGN_OUT_ENDPOINT}:csrf-1:same-origin`,
      'forget-shell',
      'redirect:/login',
    ])
    expect(f.removed).toEqual([
      `session:${CSRF_STORAGE_KEY}`,
      `local:${HARNESS_SELECTION_STORAGE_KEY}`,
    ])
  })

  it('keeps local state and the current screen when server revocation fails', async () => {
    const f = fixture(Response.json({ error: 'Sessão não revogada.' }, { status: 401 }))

    await expect(signOutCurrentSession(f.port)).rejects.toThrow('Sessão não revogada.')

    expect(f.port.forgetShell).not.toHaveBeenCalled()
    expect(f.removed).toEqual([])
    expect(f.port.redirect).not.toHaveBeenCalled()
  })

  it('rejects a successful HTTP response that does not prove revocation', async () => {
    const f = fixture(new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } }))

    await expect(signOutCurrentSession(f.port)).rejects.toThrow('HTTP 200')
    expect(f.removed).toEqual([])
    expect(f.port.redirect).not.toHaveBeenCalled()
  })

  it('redirects after server revocation even if browser cleanup is unavailable', async () => {
    const f = fixture()
    vi.mocked(f.port.forgetShell).mockRejectedValueOnce(new Error('cache unavailable'))
    f.port.sessionStorage.removeItem = () => { throw new Error('storage unavailable') }

    await signOutCurrentSession(f.port)

    expect(f.removed).toEqual([`local:${HARNESS_SELECTION_STORAGE_KEY}`])
    expect(f.port.redirect).toHaveBeenCalledWith('/login')
  })
})
