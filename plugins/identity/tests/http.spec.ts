import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearSessionCookies,
  COOKIE_HEADER_LIMIT_BYTES,
  createIdentityHttpHandler,
  authenticatedMutation,
  CSRF_COOKIE,
  deviceOf,
  IDENTITY_ROUTE_CONTRACTS,
  parseCookies,
  parseCookieValues,
  requiredSessionToken,
  serializeSessionCookies,
  SECURE_SESSION_COOKIE,
  SESSION_COOKIE,
  SESSION_GENERATION_COOKIE,
  singleHeader,
} from '../src/http.ts'
import type { SessionRecord } from '../src/model.ts'
import { IdentityError, type StudioIdentityService } from '../src/service.ts'

const session: SessionRecord = {
  session_id: 'session-1', user_id: 'user-1', org_id: 'org-1', tenant_id: 'tenant-1',
  token_hash: 'a'.repeat(64), csrf_hash: 'b'.repeat(64), device_label: 'Notebook',
  user_agent: 'Vitest', ip_truncated: '127.0.0.0/24', created_at: '2026-09-02T00:00:00.000Z',
  last_seen_at: '2026-09-02T00:00:00.000Z', expires_sliding_at: '2026-09-16T00:00:00.000Z',
  expires_absolute_at: '2026-12-01T00:00:00.000Z', last_strong_auth_at: null,
  last_strong_auth_method: null, revoked_at: null, revoked_reason: null, harness_session_ids: [],
}

function fakeService() {
  return {
    requestMagicCode: vi.fn(() => Promise.resolve()),
    verifyMagicCode: vi.fn(() => Promise.resolve({ token: 'session-token', csrfToken: 'csrf-token', session })),
    beginPasskeyLogin: vi.fn(() => Promise.resolve({ challengeId: 'challenge', options: { challenge: 'abc' } })),
    finishPasskeyLogin: vi.fn(() => Promise.resolve({ token: 'passkey-token', csrfToken: 'passkey-csrf', session })),
    personalPrincipal: vi.fn(() => ({ userId: 'user_local', orgId: 'org_local', tenantId: 'tenant_local', sessionId: 'session_local' })),
    authenticate: vi.fn<(token: string) => Promise<SessionRecord>>(() => Promise.resolve(session)),
    validateCsrfToken: vi.fn(),
    cookiesAreSecure: false,
    csrfTokenFor: vi.fn(() => Promise.resolve('csrf-token')),
    beginPasskeyRegistration: vi.fn(() => Promise.resolve({ challengeId: 'reg', options: { challenge: 'reg-c' } })),
    finishPasskeyRegistration: vi.fn(() => Promise.resolve()),
    beginStepUp: vi.fn(() => Promise.resolve({ challengeId: 'step', options: { challenge: 'step-c' } })),
    finishStepUp: vi.fn(() => Promise.resolve()),
    listDevices: vi.fn(() => [session]),
    revokeSession: vi.fn(() => Promise.resolve()),
    revokeAllSessions: vi.fn(() => Promise.resolve()),
    bindHarnessSession: vi.fn(() => Promise.resolve()),
    isSharedHarnessClientAllowed: vi.fn(() => true),
    // A conferência de Host e Origin alcança toda rota autenticada, e não só as
    // da identidade: o dublê precisa responder por ela.
    assertRequestTrust: vi.fn(),
  }
}

const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))))

async function fixture(
  bindHost: '127.0.0.1' | '0.0.0.0' = '127.0.0.1',
  edge?: {
    required?: boolean
    secret?: string
    sharedHarnessClientAllowed?: boolean
    harnessAuthenticationUrl?: (baseUrl: string) => string | undefined
  },
) {
  const service = fakeService()
  const edgeRequired = edge?.required ?? edge !== undefined
  service.isSharedHarnessClientAllowed.mockReturnValue(edge?.sharedHarnessClientAllowed ?? !edgeRequired)
  const allowedHosts: string[] = []
  const allowedOrigins: string[] = []
  const server = createServer(createIdentityHttpHandler({
    service: service as unknown as StudioIdentityService,
    bindHost,
    allowedHosts,
    allowedOrigins,
    edgeRequired,
    // A fixture serve em `http://127.0.0.1`, que é o modo pessoal: ali o
    // navegador RECUSARIA um cookie `__Host-` (não há `Secure`), então o nome
    // é o sem prefixo. O caso com TLS tem teste próprio.
    secureCookies: false,
    ...(edge?.secret === undefined ? {} : { resolveEdgeSecret: () => Promise.resolve(edge.secret) }),
    ...(edge?.harnessAuthenticationUrl === undefined ? {} : { harnessAuthenticationUrl: edge.harnessAuthenticationUrl }),
  }))
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  const host = `127.0.0.1:${port}`
  const origin = `http://${host}`
  allowedHosts.push(host)
  allowedOrigins.push(origin)
  const request = (path: string, init: RequestInit = {}) => fetch(`${origin}/api/studio/identity${path}`, {
    ...init,
    headers: {
      host,
      origin,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  return { service, request, host, origin, allowedHosts, allowedOrigins }
}

const authHeaders = {
  cookie: `${SESSION_COOKIE}=session-token; ${CSRF_COOKIE}=csrf-token`,
  'x-dz23-csrf': 'csrf-token',
}

describe('identity HTTP boundary', () => {
  it('serializes secure cookies and parses malformed cookie values safely', () => {
    // Com TLS o nome leva `__Host-`: o navegador recusa gravar um cookie com
    // esse prefixo que traga `Domain`, e é isso que impede um subdomínio irmão
    // de plantar um segundo cookie de sessão no navegador da pessoa.
    expect(serializeSessionCookies('a b', 'c d', true)).toEqual([
      `${SECURE_SESSION_COOKIE}=a%20b; HttpOnly; Secure; SameSite=Lax; Path=/`,
      `${CSRF_COOKIE}=; Secure; SameSite=Lax; Path=/; Max-Age=0`,
    ])
    expect(serializeSessionCookies('local', 'unused', false)).toEqual([
      `${SESSION_COOKIE}=local; HttpOnly; SameSite=Lax; Path=/`,
      `${CSRF_COOKIE}=; SameSite=Lax; Path=/; Max-Age=0`,
    ])
    // Quatro: os dois marcadores antigos, o nome em uso E o outro nome. Quem
    // trocou a configuração (ligou ou desligou o TLS) não pode ficar com um
    // cookie órfão que nenhum caminho mais aceita e que ninguém consegue tirar.
    expect(clearSessionCookies()).toHaveLength(4)
    expect(clearSessionCookies().filter(cookie => cookie.startsWith(SECURE_SESSION_COOKIE))).toHaveLength(1)
    expect(clearSessionCookies().filter(cookie => cookie.startsWith(`${SESSION_COOKIE}=`))).toHaveLength(1)
    expect(clearSessionCookies(false).every(cookie => !cookie.includes('Secure'))).toBe(true)
    expect(parseCookies(undefined)).toEqual({})
    expect(parseCookies('a=1; lone; bad=%E0%A4%A')).toEqual({ a: '1', lone: '', bad: '' })
    expect(parseCookieValues('a=first; a=second; a=%E0%A4%A; b=other', 'a')).toEqual(['first', 'second'])
    // `cookiesAreSecure: false` escolhe o nome sem prefixo, que é o do modo
    // pessoal; com `true` o nome é `__Host-dz23_studio_session`.
    const inseguro = { cookiesAreSecure: false } as never
    expect(requiredSessionToken({ headers: { cookie: `${SESSION_COOKIE}=required` } } as never, inseguro)).toBe('required')
    expect(() => requiredSessionToken({ headers: {} } as never, inseguro)).toThrow(IdentityError)
    expect(() => requiredSessionToken({ headers: { cookie: `${SESSION_COOKIE}=` } } as never, inseguro)).toThrow(IdentityError)
    // ACHADO: dois cookies com o MESMO nome não deixam o cabeçalho escolher a
    // sessão — quem escreve o cabeçalho pode não ser a pessoa.
    expect(() => requiredSessionToken(
      { headers: { cookie: `${SESSION_COOKIE}=vitima; ${SESSION_COOKIE}=atacante` } } as never, inseguro,
    )).toThrow(IdentityError)
    // Com TLS, o nome sem prefixo NÃO é aceito: aceitá-lo reabriria o buraco.
    expect(() => requiredSessionToken(
      { headers: { cookie: `${SESSION_COOKIE}=required` } } as never, { cookiesAreSecure: true } as never,
    )).toThrow(IdentityError)
    expect(requiredSessionToken(
      { headers: { cookie: `${SECURE_SESSION_COOKIE}=required` } } as never, { cookiesAreSecure: true } as never,
    )).toBe('required')
    expect(singleHeader(undefined)).toBeUndefined()
    expect(singleHeader('one')).toBe('one')
    expect(singleHeader(['one'])).toBe('one')
    expect(singleHeader(['one', 'two'])).toBeUndefined()
    expect(deviceOf({ headers: {}, socket: {} } as never, 'Sem agente')).toEqual({
      label: 'Sem agente', userAgent: '', ipTruncated: 'unknown',
    })
  })

  it('serves magic-code request and verification without exposing the code', async () => {
    const f = await fixture()
    const started = await f.request('/magic/start', { method: 'POST', body: JSON.stringify({ email: 'a@example.com' }) })
    expect(started.status).toBe(202)
    expect(await started.json()).toEqual({ message: expect.stringContaining('código temporário') })
    expect(f.service.requestMagicCode).toHaveBeenCalledWith('a@example.com')
    const clientScoped = await f.request('/magic/start', {
      method: 'POST', body: JSON.stringify({ email: 'a@example.com', org_id: 'attacker-org' }),
    })
    expect(clientScoped.status).toBe(400)
    const verified = await f.request('/magic/verify', {
      method: 'POST',
      body: JSON.stringify({ email: 'a@example.com', code: '123456', device_label: 'Notebook' }),
    })
    expect(verified.status).toBe(200)
    expect(verified.headers.getSetCookie().join(';')).toContain('HttpOnly')
    expect(verified.headers.getSetCookie().join(';')).not.toContain(`${SESSION_GENERATION_COOKIE}=`)
    expect(await verified.clone().json()).toMatchObject({ session_generation: expect.stringMatching(/^[a-f0-9]{32}$/u) })
  })

  it('serves passkey login options and verification', async () => {
    const f = await fixture()
    expect((await f.request('/passkey/login/options', { method: 'POST', body: JSON.stringify({ email: 'a@example.com' }) })).status).toBe(200)
    const response = await f.request('/passkey/login/verify', {
      method: 'POST', body: JSON.stringify({ challenge_id: 'challenge', response: { id: 'cred' } }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.getSetCookie().join(';')).toContain('passkey-token')
    expect(response.headers.getSetCookie().join(';')).not.toContain(`${SESSION_GENERATION_COOKIE}=`)
    expect(await response.json()).toMatchObject({ session_generation: expect.stringMatching(/^[a-f0-9]{32}$/u) })
  })

  it('returns the implicit personal principal only on loopback', async () => {
    const local = await fixture()
    const localResponse = await local.request('/session', { method: 'GET' })
    expect(await localResponse.json()).toMatchObject({ mode: 'personal' })
    const remote = await fixture('0.0.0.0')
    remote.service.personalPrincipal.mockImplementation(() => undefined as never)
    const remoteResponse = await remote.request('/session', { method: 'GET' })
    expect(remoteResponse.status).toBe(401)
  })

  it('returns an authenticated session without secret hashes', async () => {
    const f = await fixture()
    const response = await f.request('/session', { method: 'GET', headers: { cookie: `${SESSION_COOKIE}=session-token` } })
    expect(await response.json()).toEqual({
      mode: 'authenticated',
      principal: { userId: 'user-1', orgId: 'org-1', tenantId: 'tenant-1', sessionId: 'session-1' },
    })
  })

  it('ACHADO: cookie sombra RECUSA a entrada, em vez de deixar o cabeçalho escolher a sessão', async () => {
    // Esta propriedade foi INVERTIDA de propósito. A versão anterior tentava
    // cada cookie de mesmo nome e ficava com o primeiro que autenticasse, e o
    // teste que a cobria usava um sombra INVÁLIDO — o caso fácil. A ameaça real
    // é o contrário: o token do atacante é uma sessão VÁLIDA dele. Aí a vítima
    // seguia usando o Studio dentro da sessão do atacante, e
    // `POST /passkey/register/verify` gravava a chave de acesso do dispositivo
    // dela na conta DELE.
    //
    // O que se perde é disponibilidade: quem carregar um cookie velho é
    // mandado entrar de novo. É a troca certa — a pessoa VÊ que não entrou,
    // em vez de não ver nada.
    const f = await fixture()
    f.service.authenticate.mockImplementation(token => token === 'session-token' || token === 'do-atacante'
      ? Promise.resolve(session)
      : Promise.reject(new IdentityError('invalid', 'invalid')))
    const sombraValida = await f.request('/csrf', {
      method: 'GET', headers: { cookie: `${SESSION_COOKIE}=do-atacante; ${SESSION_COOKIE}=session-token` },
    })
    expect(sombraValida.status).toBe(401)
    const sombraInvalida = await f.request('/csrf', {
      method: 'GET', headers: { cookie: `${SESSION_COOKIE}=lixo; ${SESSION_COOKIE}=session-token` },
    })
    expect(sombraInvalida.status).toBe(401)
    // Um cookie só continua funcionando, que é o caso de todo mundo.
    const limpo = await f.request('/csrf', {
      method: 'GET', headers: { cookie: `${SESSION_COOKIE}=session-token` },
    })
    expect(limpo.status).toBe(200)
    expect(await limpo.json()).toEqual({ csrf_token: 'csrf-token' })
  })

  it('authenticates mutations from the valid duplicate cookie and bounds adversarial candidates', async () => {
    const service = fakeService()
    service.authenticate.mockImplementation(async token => {
      if (token === 'valid') return session
      if (token === 'explode') throw new Error('storage unavailable')
      throw new IdentityError('invalid', 'invalid-session')
    })
    const request = (cookie: string, method = 'POST') => ({
      method,
      headers: { cookie, 'x-dz23-csrf': 'csrf-token' },
    }) as never

    await expect(authenticatedMutation(request(`${SESSION_COOKIE}=valid`), service as unknown as StudioIdentityService)).resolves.toBe(session)
    expect(service.validateCsrfToken).toHaveBeenCalledWith(session, 'csrf-token')
    // Dois cookies de mesmo nome: recusa, e sem sequer consultar o serviço —
    // a ambiguidade é resolvida antes de qualquer autenticação.
    service.authenticate.mockClear()
    await expect(authenticatedMutation(request(`${SESSION_COOKIE}=shadow; ${SESSION_COOKIE}=valid`), service as unknown as StudioIdentityService)).rejects.toMatchObject({ code: 'invalid' })
    expect(service.authenticate).not.toHaveBeenCalled()
    await expect(authenticatedMutation(request(`${SESSION_COOKIE}=valid`, 'GET'), service as unknown as StudioIdentityService)).resolves.toBe(session)
    await expect(authenticatedMutation(request(`${SESSION_COOKIE}=`), service as unknown as StudioIdentityService)).rejects.toMatchObject({ code: 'invalid' })
    await expect(authenticatedMutation(request(`${SESSION_COOKIE}=explode`), service as unknown as StudioIdentityService)).rejects.toThrow('storage unavailable')
    const tooMany = Array.from({ length: 65 }, (_, index) => `${SESSION_COOKIE}=candidate-${index}`).join('; ')
    await expect(authenticatedMutation(request(tooMany), service as unknown as StudioIdentityService)).rejects.toMatchObject({ code: 'invalid' })
    // O mesmo vale com TLS, e ali o nome sem prefixo não é sequer lido.
    const seguro = { ...service, cookiesAreSecure: true } as unknown as StudioIdentityService
    await expect(authenticatedMutation(request(`${SESSION_COOKIE}=valid`), seguro)).rejects.toMatchObject({ code: 'invalid' })
    await expect(authenticatedMutation(request(`${SECURE_SESSION_COOKIE}=valid`), seguro)).resolves.toBe(session)
  })

  it('requires the rotatable edge secret and blocks the process-wide Harness client at the edge', async () => {
    const edgeOnLoopback = await fixture('127.0.0.1', { secret: 'edge-secret' })
    expect((await edgeOnLoopback.request('/session', {
      method: 'GET', headers: { 'x-dz23-edge': 'edge-secret' },
    })).status).toBe(401)
    const f = await fixture('0.0.0.0', {
      secret: 'edge-secret',
      harnessAuthenticationUrl: baseUrl => `${baseUrl}?token=native-launch`,
    })
    expect((await f.request('/session', { method: 'GET' })).status).toBe(401)
    expect((await f.request('/session', { method: 'GET', headers: { 'x-dz23-edge': 'wrong' } })).status).toBe(401)
    const sessionResponse = await f.request('/session', {
      method: 'GET', headers: { 'x-dz23-edge': 'edge-secret', cookie: `${SESSION_COOKIE}=session-token` },
    })
    expect(sessionResponse.status).toBe(200)
    const exchange = await f.request('/harness/session', {
      method: 'GET', redirect: 'manual', headers: {
        'x-dz23-edge': 'edge-secret',
        'x-forwarded-for': '198.51.100.7, 127.0.0.1',
        'x-forwarded-proto': 'https',
        cookie: `${SESSION_COOKIE}=session-token`,
      },
    })
    expect(exchange.status).toBe(403)
    expect(exchange.headers.get('location')).toBeNull()
    expect(f.service.isSharedHarnessClientAllowed).toHaveBeenCalledWith(session)

    const defensiveForwarding = await fixture('0.0.0.0', {
      secret: 'edge-secret',
      sharedHarnessClientAllowed: true,
      harnessAuthenticationUrl: baseUrl => `${baseUrl}?token=native-launch`,
    })
    const forwardedHttp = await defensiveForwarding.request('/harness/session', {
      method: 'GET', redirect: 'manual', headers: {
        'x-dz23-edge': 'edge-secret',
        'x-forwarded-proto': 'http',
        cookie: `${SESSION_COOKIE}=session-token`,
      },
    })
    expect(forwardedHttp.headers.get('location')).toBe(`http://${defensiveForwarding.host}/?token=native-launch`)
    const invalidForwardedProtocol = await defensiveForwarding.request('/harness/session', {
      method: 'GET', redirect: 'manual', headers: {
        'x-dz23-edge': 'edge-secret',
        'x-forwarded-proto': 'ftp',
        cookie: `${SESSION_COOKIE}=session-token`,
      },
    })
    expect(invalidForwardedProtocol.headers.get('location')).toBe(`https://${defensiveForwarding.host}/?token=native-launch`)

    const personal = await fixture('127.0.0.1', {
      required: false,
      harnessAuthenticationUrl: baseUrl => `${baseUrl}?token=native-launch`,
    })
    const personalExchange = await personal.request('/harness/session', {
      method: 'GET', redirect: 'manual', headers: {
        'x-forwarded-proto': 'ftp',
        cookie: `${SESSION_COOKIE}=session-token`,
      },
    })
    expect(personalExchange.status).toBe(303)
    expect(personalExchange.headers.get('location')).toBe(`http://${personal.host}/?token=native-launch`)
    expect(personalExchange.headers.get('referrer-policy')).toBe('no-referrer')
  })

  it('fails closed when the edge secret or Harness connection is unavailable', async () => {
    const noSecret = await fixture('0.0.0.0', {})
    expect((await noSecret.request('/session', { method: 'GET', headers: { 'x-dz23-edge': 'anything' } })).status).toBe(401)
    const noHarness = await fixture()
    const response = await noHarness.request('/harness/session', {
      method: 'GET', headers: { cookie: `${SESSION_COOKIE}=session-token` },
    })
    expect(response.status).toBe(503)
  })

  it('limits magic-code requests in the application and returns retry guidance', async () => {
    const f = await fixture()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await f.request('/magic/start', {
        method: 'POST', body: JSON.stringify({ email: 'limited@example.com' }),
      })).status).toBe(202)
    }
    const limited = await f.request('/magic/start', {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE}=attacker-chosen-value` },
      body: JSON.stringify({ email: 'limited@example.com' }),
    })
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(limited.headers.get('x-ratelimit-limit')).toBe('5')
    expect(limited.headers.get('x-ratelimit-remaining')).toBe('0')
    expect(await limited.json()).toEqual({ error: expect.stringContaining('Muitas tentativas') })
  })

  it('handles every authenticated passkey and device operation with CSRF', async () => {
    const f = await fixture()
    const cases: Array<[string, unknown]> = [
      ['/passkey/register/options', {}],
      ['/passkey/register/verify', { challenge_id: 'reg', response: { id: 'cred' }, device_label: 'Hello' }],
      ['/passkey/step-up/options', {}],
      ['/passkey/step-up/verify', { challenge_id: 'step', response: { id: 'cred' } }],
      ['/devices/revoke', { session_id: 'other-session' }],
    ]
    for (const [path, body] of cases) {
      const response = await f.request(path, { method: 'POST', headers: authHeaders, body: JSON.stringify(body) })
      expect(response.status, path).toBe(200)
    }
    const devices = await f.request('/devices', { method: 'GET', headers: authHeaders })
    expect((await devices.json()) as object).toHaveProperty('devices')
    const self = await f.request('/devices/revoke', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ session_id: 'session-1' }),
    })
    expect(self.headers.getSetCookie().join(';')).toContain('Max-Age=0')
    const all = await f.request('/devices/revoke-all', { method: 'POST', headers: authHeaders, body: '{}' })
    expect(all.headers.getSetCookie().join(';')).toContain('Max-Age=0')
    expect(f.service.validateCsrfToken).toHaveBeenCalled()
  })

  it('revokes exactly the current session and clears its cookies on logout', async () => {
    const f = await fixture()
    const response = await f.request('/logout', { method: 'POST', headers: authHeaders })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ signed_out: true })
    expect(f.service.revokeSession).toHaveBeenCalledOnce()
    expect(f.service.revokeSession).toHaveBeenCalledWith(session, session.session_id)
    expect(f.service.revokeAllSessions).not.toHaveBeenCalled()
    expect(response.headers.getSetCookie().join(';')).toContain('Max-Age=0')
    expect(f.service.validateCsrfToken).toHaveBeenCalledWith(session, 'csrf-token')
  })

  it('does not revoke the current session when logout CSRF validation fails', async () => {
    const f = await fixture()
    f.service.validateCsrfToken.mockImplementationOnce(() => { throw new IdentityError('csrf', 'csrf') })

    const response = await f.request('/logout', { method: 'POST', headers: authHeaders })

    expect(response.status).toBe(401)
    expect(f.service.revokeSession).not.toHaveBeenCalled()
    expect(response.headers.getSetCookie()).toEqual([])
  })

  it('finishes logout and clears stale cookies when no active session remains', async () => {
    const f = await fixture()
    const absent = await f.request('/logout', { method: 'POST' })
    expect(absent.status).toBe(200)
    expect(await absent.json()).toEqual({ signed_out: true })
    expect(absent.headers.getSetCookie().join(';')).toContain('Max-Age=0')

    f.service.authenticate.mockRejectedValueOnce(new IdentityError('invalid', 'expired-session'))
    const expired = await f.request('/logout', {
      method: 'POST', headers: { cookie: `${SESSION_COOKIE}=expired-token` },
    })
    expect(expired.status).toBe(200)
    expect(await expired.json()).toEqual({ signed_out: true })
    expect(expired.headers.getSetCookie().join(';')).toContain('Max-Age=0')
    expect(f.service.validateCsrfToken).not.toHaveBeenCalled()
    expect(f.service.revokeSession).not.toHaveBeenCalled()
  })

  it('does not claim logout completion when session lookup fails unexpectedly', async () => {
    const f = await fixture()
    f.service.authenticate.mockRejectedValueOnce(new Error('storage unavailable: password=top-secret path=/srv/private'))

    const response = await f.request('/logout', {
      method: 'POST', headers: { cookie: `${SESSION_COOKIE}=session-token` },
    })

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'IDENTITY_INTERNAL_ERROR' })
    expect(response.headers.getSetCookie()).toEqual([])
    expect(f.service.revokeSession).not.toHaveBeenCalled()
  })

  it('sair com cookie ambíguo LIMPA o navegador e não revoga sessão nenhuma', async () => {
    // Sair é o único lugar onde ser permissivo é seguro: ele só REMOVE. Com
    // dois cookies de mesmo nome não dá para saber qual sessão a pessoa quis
    // encerrar, então o servidor não revoga nada — revogar por palpite
    // derrubaria a sessão errada — e limpa o navegador, que é o que a pessoa
    // consegue ver que aconteceu.
    const f = await fixture()
    f.service.authenticate.mockImplementation(token => token === 'session-token'
      ? Promise.resolve(session)
      : Promise.reject(new IdentityError('invalid', 'invalid-session')))

    const response = await f.request('/logout', {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE}=shadow; ${SESSION_COOKIE}=session-token`, 'x-dz23-csrf': 'wrong' },
    })

    expect(response.status).toBe(200)
    expect(f.service.revokeSession).not.toHaveBeenCalled()
    expect(response.headers.getSetCookie().length).toBeGreaterThan(0)
    expect(response.headers.getSetCookie().every(cookie => cookie.includes('Max-Age=0'))).toBe(true)
  })

  it('sair com UM cookie continua revogando a sessão de verdade', async () => {
    const f = await fixture()
    f.service.authenticate.mockImplementation(token => token === 'session-token'
      ? Promise.resolve(session)
      : Promise.reject(new IdentityError('invalid', 'invalid-session')))
    const response = await f.request('/logout', {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE}=session-token`, 'x-dz23-csrf': 'csrf-token' },
    })
    expect(response.status).toBe(200)
    expect(f.service.revokeSession).toHaveBeenCalled()
  })

  it('rejects an unbounded logout cookie set without claiming completion', async () => {
    const f = await fixture()
    const cookie = Array.from({ length: 65 }, (_, index) => `${SESSION_COOKIE}=candidate-${index}`).join('; ')
    expect(Buffer.byteLength(cookie)).toBeLessThan(COOKIE_HEADER_LIMIT_BYTES)
    const response = await f.request('/logout', { method: 'POST', headers: { cookie } })

    expect(response.status).toBe(401)
    expect(response.headers.getSetCookie()).toEqual([])
    expect(f.service.authenticate).not.toHaveBeenCalled()
  })

  it('accepts the exact Cookie budget and rejects one byte more before parsing or authentication', async () => {
    const exact = await fixture()
    const prefix = 'padding='
    const exactCookie = `${prefix}${'x'.repeat(COOKIE_HEADER_LIMIT_BYTES - Buffer.byteLength(prefix))}`
    expect(Buffer.byteLength(exactCookie)).toBe(COOKIE_HEADER_LIMIT_BYTES)
    expect((await exact.request('/session', { method: 'GET', headers: { cookie: exactCookie } })).status).toBe(200)

    const exceeded = await fixture()
    const oversizedCookie = `${exactCookie}x`
    const response = await exceeded.request('/logout', { method: 'POST', headers: { cookie: oversizedCookie } })
    expect(Buffer.byteLength(oversizedCookie)).toBe(COOKIE_HEADER_LIMIT_BYTES + 1)
    expect(response.status).toBe(431)
    expect(await response.json()).toEqual({ error: 'COOKIE_HEADER_TOO_LARGE' })
    expect(response.headers.getSetCookie()).toEqual([])
    expect(exceeded.service.authenticate).not.toHaveBeenCalled()
    expect(exceeded.service.revokeSession).not.toHaveBeenCalled()
  })

  it('does not expose any route that binds a client-supplied Harness session id', async () => {
    const f = await fixture()
    for (const method of ['POST', 'GET', 'PUT', 'DELETE'] as const) {
      const response = await f.request('/bind-agent', {
        method,
        headers: authHeaders,
        ...(method === 'GET' ? {} : { body: JSON.stringify({ harness_session_id: 'agent-roubada' }) }),
      })
      expect(response.status, method).toBe(404)
    }
    expect(f.service.bindHarnessSession).not.toHaveBeenCalled()
    const paths: readonly string[] = IDENTITY_ROUTE_CONTRACTS.map(contract => contract.path)
    expect(paths).not.toContain('/bind-agent')
    // Nenhuma rota contratada alcança o vínculo de sessão do Harness, e nenhuma
    // rota contratada cai na cauda 404 - contrato sem handler seria um 404 mudo.
    for (const contract of IDENTITY_ROUTE_CONTRACTS) {
      const response = await f.request(contract.path, {
        method: contract.method,
        headers: authHeaders,
        ...(contract.method === 'GET' ? {} : { body: JSON.stringify({ harness_session_id: 'agent-roubada' }) }),
      })
      expect(response.status, `${contract.method} ${contract.path}`).not.toBe(404)
    }
    expect(f.service.bindHarnessSession).not.toHaveBeenCalled()
  })

  it('rejects absent session, missing CSRF, untrusted host and untrusted origin', async () => {
    const f = await fixture()
    expect((await f.request('/devices', { method: 'GET' })).status).toBe(401)
    expect((await f.request('/devices/revoke', {
      method: 'POST', headers: { cookie: `${SESSION_COOKIE}=session-token` }, body: JSON.stringify({ session_id: 'other-session' }),
    })).status).toBe(200)
    f.service.validateCsrfToken.mockImplementationOnce(() => { throw new IdentityError('csrf', 'csrf') })
    expect((await f.request('/devices/revoke', { method: 'POST', headers: authHeaders, body: JSON.stringify({ session_id: 'other-session' }) })).status).toBe(401)
    f.allowedHosts.splice(0)
    expect((await f.request('/session', { method: 'GET' })).status).toBe(401)
    f.allowedHosts.push(f.host)
    expect((await f.request('/magic/start', {
      method: 'POST', headers: { origin: 'https://evil.example' }, body: JSON.stringify({ email: 'a@example.com' }),
    })).status).toBe(401)
  })

  it('contains invalid JSON, wrong content type, oversized bodies and unknown routes', async () => {
    const f = await fixture()
    const invalidJson = await f.request('/magic/start', { method: 'POST', body: '{' })
    expect(invalidJson.status).toBe(400)
    expect(await invalidJson.json()).toEqual({ error: 'JSON inválido.' })
    expect((await f.request('/magic/start', {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}',
    })).status).toBe(400)
    expect((await f.request('/magic/start', { method: 'POST', body: JSON.stringify({ value: 'x'.repeat(70_000) }) })).status).toBe(400)
    expect((await f.request('/missing', { method: 'GET', headers: authHeaders })).status).toBe(404)
  })

  it('maps not-found, lockout and validation failures to safe status codes', async () => {
    const f = await fixture()
    f.service.requestMagicCode.mockRejectedValueOnce(new IdentityError('locked', 'locked'))
    expect((await f.request('/magic/start', { method: 'POST', body: JSON.stringify({ email: 'a@example.com' }) })).status).toBe(429)
    f.service.requestMagicCode.mockRejectedValueOnce(new IdentityError('not-found', 'missing'))
    expect((await f.request('/magic/start', { method: 'POST', body: JSON.stringify({ email: 'a@example.com' }) })).status).toBe(404)
    expect((await f.request('/magic/start', { method: 'POST', body: JSON.stringify({ email: 'bad' }) })).status).toBe(400)
    f.service.requestMagicCode.mockRejectedValueOnce('non-error')
    const nonError = await f.request('/magic/start', { method: 'POST', body: JSON.stringify({ email: 'a@example.com' }) })
    expect(nonError.status).toBe(500)
    expect(await nonError.json()).toEqual({ error: 'IDENTITY_INTERNAL_ERROR' })
    f.service.requestMagicCode.mockRejectedValueOnce(new Error('token=super-secret C:\\private\\identity.db'))
    const secretFailure = await f.request('/magic/start', { method: 'POST', body: JSON.stringify({ email: 'a@example.com' }) })
    const secretFailureText = await secretFailure.text()
    expect(secretFailure.status).toBe(500)
    expect(secretFailureText).toBe('{"error":"IDENTITY_INTERNAL_ERROR"}')
    expect(secretFailureText).not.toContain('super-secret')
    expect(secretFailureText).not.toContain('identity.db')
    const head = await f.request('/missing', { method: 'HEAD', headers: { cookie: `${SESSION_COOKIE}=session-token` } })
    expect(head.status).toBe(404)
  })
})
