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
  it('sends only an approval the server issued, never a tier the client asserts', async () => {
    const fake = transport(() => json(200, { integration: { enabled: true } }))
    const api = createHubApi(fake)
    await api.setEnabled('x', true)
    expect(JSON.parse(String(fake.calls[0]!.init.body))).toEqual({ enabled: true })
    await api.setEnabled('x', true, { approval_id: 'ap-1' })
    expect(JSON.parse(String(fake.calls[1]!.init.body))).toEqual({ enabled: true, approval: { approval_id: 'ap-1' } })
    await api.testSmtp('a@b.test', { approval_id: 'ap-2' })
    expect(JSON.parse(String(fake.calls[2]!.init.body))).toEqual({ to: 'a@b.test', approval: { approval_id: 'ap-2' } })
  })
  it('builds the download link with encoded ids and lists projects from the application API', async () => {
    const fake = transport(() => json(200, { projects: [] }))
    const api = createHubApi(fake)
    expect(api.downloadHref('p 1', 'e/2')).toBe('/api/studio/hub/projects/p%201/exports/e%2F2/download')
    await api.projects()
    expect(fake.calls[0]!.input).toBe('/api/studio/apps/projects')
  })
})

describe('installSkillBody — a rota que nenhuma tela chamava (T-11)', () => {
  it('bate no endereço certo, com POST, CSRF e o texto no corpo', async () => {
    const fake = transport(() => json(200, { integration: { integration_id: 'i-1', skill_body_installed: true } }))
    const api = createHubApi(fake)
    const devolvida = await api.installSkillBody('i-1', 'INSTRUÇÃO DA HABILIDADE')

    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]!.input).toBe('/api/studio/hub/integrations/i-1/skill-body')
    expect(fake.calls[0]!.init.method).toBe('POST')
    // Escrita: o cabeçalho de CSRF vai junto, como em toda mutação do hub.
    expect((fake.calls[0]!.init.headers as Record<string, string>)['x-dz23-csrf']).toBe('tok=1')
    expect(JSON.parse(String(fake.calls[0]!.init.body))).toEqual({ body: 'INSTRUÇÃO DA HABILIDADE' })
    // E a tela recebe o que precisa para parar de oferecer instalar de novo.
    expect(devolvida).toMatchObject({ skill_body_installed: true })
  })

  it('escapa o identificador no endereço', async () => {
    // Um id com barra montaria outro caminho e bateria noutra rota.
    const fake = transport(() => json(200, { integration: {} }))
    await createHubApi(fake).installSkillBody('a/b', 'x')
    expect(fake.calls[0]!.input).toBe('/api/studio/hub/integrations/a%2Fb/skill-body')
  })

  it('a recusa do servidor chega como erro, e não como sucesso silencioso', async () => {
    // O servidor confere assinatura, tamanho e impressão. Engolir a recusa faria
    // a tela dizer "texto instalado" sobre uma habilidade que continua vazia.
    const api = createHubApi(transport(() => json(400, { error: 'O texto não bate com o tamanho declarado no manifesto.' })))
    const erro = await api.installSkillBody('i-1', 'x').catch((value: unknown) => value)
    expect(erro).toBeInstanceOf(HubApiError)
    expect((erro as HubApiError).message).toContain('tamanho declarado')
  })
})
