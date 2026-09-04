import { describe, expect, it } from 'vitest'
import { createHubApi, csrfFromCookie, HubApiError, type HubTransport } from './hubApi'

function transport(handler: (input: string, init: RequestInit) => Response): HubTransport & { calls: Array<{ input: string; init: RequestInit }> } {
  const calls: Array<{ input: string; init: RequestInit }> = []
  return { calls, cookie: () => 'dz23_studio_session=s; dz23_studio_csrf=tok%3D1', fetch: async (input, init) => { calls.push({ input, init }); return handler(input, init) } }
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('hub api client', () => {
  it('reads the CSRF token from the cookie and sends it only on writes', async () => {
    expect(csrfFromCookie('a=1; dz23_studio_csrf=tok%3D1')).toBe('tok=1')
    const fake = transport((input, init) => init.method === 'POST' ? json(200, { configured: true, secret_ref: 'X', tier: 'T1' }) : json(200, { configured: false, secret_ref: null, tier: 'T1' }))
    const api = createHubApi(fake)
    await api.smtp(); await api.configureSmtp('DZ23_APP_SMTP')
    expect(fake.calls).toHaveLength(2)
    expect(fake.calls[0]!.input).toBe('/api/studio/hub/smtp')
    expect((fake.calls[0]!.init.headers as Record<string, string>)['x-dz23-csrf']).toBeUndefined()
    expect((fake.calls[1]!.init.headers as Record<string, string>)['x-dz23-csrf']).toBe('tok=1')
    expect((fake.calls[1]!.init.headers as Record<string, string>)['content-type']).toBe('application/json')
    expect(fake.calls[1]!.init.credentials).toBe('same-origin')
  })
  it('turns the service worker offline answer into a typed offline error', async () => {
    const api = createHubApi(transport(() => json(503, { error: 'OFFLINE', offline: true })))
    const error = await api.events().catch((value: unknown) => value)
    expect(error).toBeInstanceOf(HubApiError)
    expect((error as HubApiError).offline).toBe(true)
    expect((error as HubApiError).status).toBe(503)
  })
  it('surfaces the server message of a refusal', async () => {
    const api = createHubApi(transport(() => json(403, { error: 'recusado pelo servidor' })))
    await expect(api.setEnabled('x', true)).rejects.toMatchObject({ status: 403, message: 'recusado pelo servidor', offline: false })
  })
  it('builds the download link with encoded ids and lists projects from the application API', async () => {
    const fake = transport(() => json(200, { projects: [] }))
    const api = createHubApi(fake)
    expect(api.downloadHref('p 1', 'e/2')).toBe('/api/studio/hub/projects/p%201/exports/e%2F2/download')
    await api.projects()
    expect(fake.calls[0]!.input).toBe('/api/studio/apps/projects')
  })
})
