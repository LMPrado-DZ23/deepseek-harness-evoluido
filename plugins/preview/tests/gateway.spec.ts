import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { createConnection } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPreviewGatewayHttpHandler, PREVIEW_COOKIE, SECURE_PREVIEW_COOKIE, type PreviewForwardPort } from '../src/gateway.ts'
import { PreviewError, type StudioPreviewService } from '../src/service.ts'

interface HttpResult {
  readonly status: number
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  readonly body: string
}

const openServers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => { if (error === undefined) resolve(); else reject(error) })
  })))
})

function fakeService(overrides: Partial<Pick<StudioPreviewService, 'exchange' | 'authorize'>> = {}) {
  return {
    exchange: vi.fn(() => Promise.resolve({ cookie: 'cookie-from-service', maxAge: 900 })),
    authorize: vi.fn(() => ({ previewId: 'preview-trusted', runtimeRef: 'runtime:trusted', maxAge: 900 })),
    ...overrides,
  } as unknown as StudioPreviewService
}

async function send(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  input: { method?: string; path?: string; headers?: Readonly<Record<string, string>>; body?: string } = {},
): Promise<HttpResult> {
  const server = createServer((request, response) => { void handler(request, response) })
  openServers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server did not bind TCP')
  return new Promise<HttpResult>((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1', port: address.port, method: input.method ?? 'GET', path: input.path ?? '/',
      headers: input.headers,
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.on('error', reject)
    if (input.body !== undefined) request.write(input.body)
    request.end()
  })
}

async function sendRaw(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  requestBytes: string,
): Promise<string> {
  const server = createServer((request, response) => { void handler(request, response) })
  openServers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server did not bind TCP')
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    const socket = createConnection({ host: '127.0.0.1', port: address.port }, () => socket.write(requestBytes))
    socket.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    socket.on('error', reject)
  })
}

function gateway(service = fakeService(), forward?: PreviewForwardPort, studioOrigin = 'http://studio.dz23.localhost:3210') {
  const trustedForward: PreviewForwardPort = forward ?? {
    forward: vi.fn(() => Promise.resolve({ status: 200, body: Buffer.from('forwarded') })),
  }
  return {
    service,
    forward: trustedForward,
    handler: createPreviewGatewayHttpHandler({ service, forward: trustedForward, studioOrigin }),
  }
}

const previewHost = 'p-0123456789abcdef01234567.dz23.localhost'

describe('preview gateway trust boundary', () => {
  it('rejects non-local or non-origin Studio configuration at construction', () => {
    const service = fakeService()
    const forward: PreviewForwardPort = { forward: vi.fn(() => Promise.resolve({ status: 200, body: Buffer.alloc(0) })) }
    expect(() => createPreviewGatewayHttpHandler({ service, forward, studioOrigin: 'https://studio.dz23.localhost:3210' })).not.toThrow()
    expect(() => createPreviewGatewayHttpHandler({ service, forward, studioOrigin: 'http://studio.example' })).toThrow('studio.dz23.localhost')
    expect(() => createPreviewGatewayHttpHandler({ service, forward, studioOrigin: 'http://studio.dz23.localhost:3210/path' })).toThrow('origem web local exata')
  })

  it('returns 421 for an invalid or ambiguous Host before consulting services', async () => {
    const h = gateway()
    const invalid = await send(h.handler, { headers: { host: 'attacker.example' } })
    const ambiguous = await send(h.handler, { headers: { host: `${previewHost},attacker.example` } })

    expect(invalid).toMatchObject({ status: 421, body: 'Host de prévia inválido.' })
    expect(ambiguous.status).toBe(421)
    expect(h.service.authorize).not.toHaveBeenCalled()
  })

  it('serves an admission bootstrap that receives the ticket by postMessage, never through a URL', async () => {
    const h = gateway()
    const page = await send(h.handler, { path: '/__dz23/admission?ticket=must-not-be-read', headers: { host: previewHost } })
    const script = await send(h.handler, { path: '/__dz23/admission.js', headers: { host: previewHost } })

    expect(page.status).toBe(200)
    expect(page.body).toContain('src="/__dz23/admission.js"')
    expect(page.body).not.toMatch(/[?#]ticket=|location\.(?:search|hash)|URLSearchParams/iu)
    expect(script.status).toBe(200)
    expect(script.body).toContain('DZ23_PREVIEW_ADMISSION')
    expect(script.body).toContain('JSON.stringify({ticket})')
    expect(script.body).not.toMatch(/[?#]ticket=|location\.(?:search|hash)|URLSearchParams/iu)
  })

  it('rejects admission from the wrong Origin without exchanging its ticket', async () => {
    const h = gateway()
    const result = await send(h.handler, {
      method: 'POST', path: '/__dz23/admission',
      headers: { host: previewHost, origin: 'http://attacker.example', 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: 'ticket-with-at-least-twenty-characters' }),
    })

    expect(result.status).toBe(403)
    expect(h.service.exchange).not.toHaveBeenCalled()
  })

  it('exchanges a valid ticket into a host-only hardened cookie', async () => {
    const h = gateway()
    const ticket = 'ticket-with-at-least-twenty-characters'
    const result = await send(h.handler, {
      method: 'POST', path: '/__dz23/admission',
      headers: { host: previewHost, origin: `http://${previewHost}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ticket }),
    })

    expect(result.status).toBe(204)
    expect(h.service.exchange).toHaveBeenCalledWith(previewHost, ticket)
    expect(result.headers['set-cookie']).toEqual([
      `${PREVIEW_COOKIE}=cookie-from-service; Path=/; Max-Age=900; HttpOnly; SameSite=Strict`,
    ])
  })

  it('uses a __Host cookie and preserves Secure on every cookie under an HTTPS public origin', async () => {
    const forward: PreviewForwardPort = { forward: vi.fn(() => Promise.resolve({ status: 200, headers: { 'set-cookie': 'app_session=value; Path=/loose' }, body: Buffer.from('ok') })) }
    const h = gateway(fakeService(), forward, 'https://studio.dz23.localhost:3210')
    const admitted = await send(h.handler, { method: 'POST', path: '/__dz23/admission', headers: { host: previewHost, origin: `https://${previewHost}`, 'content-type': 'application/json' }, body: JSON.stringify({ ticket: 'ticket-with-at-least-twenty-characters' }) })
    expect(admitted.headers['set-cookie']).toEqual([`${SECURE_PREVIEW_COOKIE}=cookie-from-service; Path=/; Max-Age=900; HttpOnly; SameSite=Strict; Secure`])
    const forwarded = await send(h.handler, { headers: { host: previewHost, cookie: `${SECURE_PREVIEW_COOKIE}=valid` } })
    expect(forwarded.headers['set-cookie']).toEqual([
      'app_session=value; Path=/; HttpOnly; SameSite=Strict; Secure',
      `${SECURE_PREVIEW_COOKIE}=valid; Path=/; Max-Age=900; HttpOnly; SameSite=Strict; Secure`,
    ])
  })

  it('returns 401 without a cookie and never forwards', async () => {
    const h = gateway()
    const result = await send(h.handler, { headers: { host: previewHost } })

    expect(result.status).toBe(401)
    expect(h.service.authorize).not.toHaveBeenCalled()
    expect(h.forward.forward).not.toHaveBeenCalled()
  })

  it('renews an active admission without forwarding to the generated application', async () => {
    const service = fakeService({
      authorize: vi.fn(() => ({ previewId: 'preview-trusted', runtimeRef: 'runtime:trusted', maxAge: 321 })),
    })
    const h = gateway(service)
    const renewed = await send(h.handler, {
      path: '/__dz23/refresh?at=1',
      headers: { host: previewHost, cookie: `${PREVIEW_COOKIE}=browser-cookie` },
    })
    const missing = await send(h.handler, { path: '/__dz23/refresh', headers: { host: previewHost } })

    expect(renewed.status).toBe(204)
    expect(renewed.headers['set-cookie']).toEqual([
      `${PREVIEW_COOKIE}=browser-cookie; Path=/; Max-Age=321; HttpOnly; SameSite=Strict`,
    ])
    expect(service.authorize).toHaveBeenCalledWith(previewHost, 'browser-cookie')
    expect(h.forward.forward).not.toHaveBeenCalled()
    expect(missing.status).toBe(401)
  })

  it('returns 401 for an expired or revoked admission without revealing an unknown host', async () => {
    const expiredService = fakeService({
      authorize: vi.fn(() => { throw new PreviewError('UNAUTHENTICATED', 'expired') }),
    })
    const expired = gateway(expiredService)
    const expiredResult = await send(expired.handler, {
      headers: { host: previewHost, cookie: `${PREVIEW_COOKIE}=expired-cookie` },
    })
    expect(expiredResult.status).toBe(401)
    expect(expired.forward.forward).not.toHaveBeenCalled()

    const missingService = fakeService({
      authorize: vi.fn(() => { throw new PreviewError('NOT_FOUND', 'missing') }),
    })
    const missing = gateway(missingService)
    const missingResult = await send(missing.handler, {
      headers: { host: previewHost, cookie: `${PREVIEW_COOKIE}=unknown-cookie` },
    })
    expect(missingResult.status).toBe(404)
    expect(missing.forward.forward).not.toHaveBeenCalled()
  })

  it('rejects unsupported methods and invalid cookie encoding before forwarding', async () => {
    const h = gateway()
    const method = await send(h.handler, { method: 'TRACE', headers: { host: previewHost } })
    const cookie = await send(h.handler, { headers: { host: previewHost, cookie: `${PREVIEW_COOKIE}=%ZZ` } })

    expect(method.status).toBe(405)
    expect(cookie.status).toBe(401)
    expect(h.forward.forward).not.toHaveBeenCalled()
  })

  it('forwards only to the runtime reference returned by authorization', async () => {
    const h = gateway()
    const result = await send(h.handler, {
      path: '/?runtimeRef=runtime:attacker&host=10.0.0.9&port=2375',
      headers: {
        host: previewHost,
        cookie: `${PREVIEW_COOKIE}=browser-cookie`,
        'x-runtime-ref': 'runtime:attacker',
        'x-preview-host': '10.0.0.9:2375',
      },
    })

    expect(result).toMatchObject({ status: 200, body: 'forwarded' })
    expect(h.service.authorize).toHaveBeenCalledWith(previewHost, 'browser-cookie')
    expect(h.forward.forward).toHaveBeenCalledTimes(1)
    expect(vi.mocked(h.forward.forward).mock.calls[0]?.[0]).toBe('runtime:trusted')
  })

  it('forwards a closed DTO allowlist, strips Studio credentials/proxy headers, and preserves only app cookies', async () => {
    const h = gateway()
    const result = await send(h.handler, {
      path: '/records?view=mine',
      headers: {
        host: previewHost,
        cookie: `${PREVIEW_COOKIE}=browser-cookie; app_session=app-value; theme=dark`,
        authorization: 'Bearer studio-secret',
        'x-forwarded-for': '203.0.113.4',
        'x-forwarded-host': 'attacker.example',
        'x-forwarded-proto': 'https',
        'x-runtime-ref': 'runtime:attacker',
        'x-dz23-edge': 'forged',
        accept: 'text/html',
        'accept-language': 'pt-BR',
        'user-agent': 'preview-test',
      },
    })

    expect(result.status).toBe(200)
    expect(h.forward.forward).toHaveBeenCalledWith('runtime:trusted', {
      method: 'GET',
      path: '/records?view=mine',
      headers: {
        accept: 'text/html',
        'accept-language': 'pt-BR',
        'user-agent': 'preview-test',
        cookie: 'app_session=app-value; theme=dark',
      },
      body: Buffer.alloc(0),
    })
    const forwarded = vi.mocked(h.forward.forward).mock.calls[0]?.[1]
    expect(JSON.stringify(forwarded)).not.toContain('studio-secret')
    expect(JSON.stringify(forwarded)).not.toContain('browser-cookie')
    expect(JSON.stringify(forwarded)).not.toContain('x-forwarded')
    expect(JSON.stringify(forwarded)).not.toContain('runtime:attacker')
    expect(JSON.stringify(forwarded)).not.toContain(previewHost)
  })

  it.each([
    ['absolute target', 'http://attacker.example/steal', previewHost, 400],
    ['scheme-relative target', '//attacker.example/steal', previewHost, 400],
    ['backslash target', '/safe\\..\\steal', previewHost, 400],
    ['invalid port', '/', `${previewHost}:65536`, 421],
  ])('rejects %s without forwarding', async (_label, path, host, status) => {
    const h = gateway()
    const result = await send(h.handler, { path, headers: { host, cookie: `${PREVIEW_COOKIE}=valid` } })
    expect(result.status).toBe(status)
    expect(h.forward.forward).not.toHaveBeenCalled()
  })

  it('rejects a control character in the request target without forwarding', async () => {
    const h = gateway()
    const response = await sendRaw(h.handler, `GET /bad\u0001target HTTP/1.1\r\nHost: ${previewHost}\r\nConnection: close\r\n\r\n`)

    expect(response).toMatch(/^HTTP\/1\.1 400 /u)
    expect(h.forward.forward).not.toHaveBeenCalled()
  })

  it('enforces the request body limit before forwarding', async () => {
    const h = gateway()
    const body = 'x'.repeat(2 * 1024 * 1024 + 1)
    const result = await send(h.handler, {
      method: 'POST', path: '/upload', body,
      headers: {
        host: previewHost, origin: `http://${previewHost}`, cookie: `${PREVIEW_COOKIE}=valid`,
        'content-type': 'application/octet-stream',
      },
    })

    expect(result.status).toBe(404)
    expect(h.forward.forward).not.toHaveBeenCalled()
  })

  it('filters hostile response headers and rewrites application cookies under gateway policy', async () => {
    const forward: PreviewForwardPort = {
      forward: vi.fn(() => Promise.resolve({
        status: 201,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src *; frame-ancestors *",
          'x-frame-options': 'ALLOWALL',
          connection: 'keep-alive, x-leak',
          'transfer-encoding': 'chunked',
          'x-leak': 'secret',
          'set-cookie': [
            `${PREVIEW_COOKIE}=stolen; Path=/`,
            'domain_cookie=bad; Domain=attacker.example; Path=/',
            'app_session=trusted-value; Path=/loose; SameSite=None',
          ],
        },
        body: Buffer.from('<h1>preview</h1>'),
      })),
    }
    const h = gateway(fakeService(), forward)
    const result = await send(h.handler, { headers: { host: previewHost, cookie: `${PREVIEW_COOKIE}=valid` } })

    expect(result.status).toBe(201)
    expect(result.headers['content-security-policy']).toContain('frame-ancestors http://studio.dz23.localhost:3210')
    expect(result.headers['content-security-policy']).toContain("script-src 'self' 'unsafe-inline'")
    expect(result.headers['content-security-policy']).toContain("style-src 'self' 'unsafe-inline'")
    expect(result.headers['content-security-policy']).not.toContain("'unsafe-eval'")
    expect(result.headers['content-security-policy']).not.toContain('default-src *')
    expect(result.headers['x-frame-options']).toBeUndefined()
    expect(result.headers['x-leak']).toBeUndefined()
    expect(result.headers['transfer-encoding']).toBeUndefined()
    expect(result.headers.connection).toBe('keep-alive')
    expect(result.headers.connection).not.toContain('x-leak')
    expect(result.headers['set-cookie']).toEqual([
      'app_session=trusted-value; Path=/; HttpOnly; SameSite=Strict',
      `${PREVIEW_COOKIE}=valid; Path=/; Max-Age=900; HttpOnly; SameSite=Strict`,
    ])
  })

  it('accepts only bounded safe cache headers and origin-form redirects from the runtime', async () => {
    const forward: PreviewForwardPort = {
      forward: vi.fn(() => Promise.resolve({
        status: 302,
        headers: {
          'content-type': ['text/plain'], etag: '"safe"', 'last-modified': 'Wed, 03 Sep 2026 12:00:00 GMT',
          location: '/entrar?next=%2F', 'set-cookie': 'app_session=value',
        },
        body: Buffer.from('redirect'),
      })),
    }
    const result = await send(gateway(fakeService(), forward).handler, { headers: { host: previewHost, cookie: `${PREVIEW_COOKIE}=valid` } })

    expect(result.status).toBe(302)
    expect(result.headers).toMatchObject({ etag: '"safe"', 'last-modified': 'Wed, 03 Sep 2026 12:00:00 GMT', location: '/entrar?next=%2F' })
    expect(result.headers['set-cookie']).toEqual([
      'app_session=value; Path=/; HttpOnly; SameSite=Strict',
      `${PREVIEW_COOKIE}=valid; Path=/; Max-Age=900; HttpOnly; SameSite=Strict`,
    ])
  })

  it('fails closed on an invalid runtime status, oversized response or authorization error', async () => {
    const invalid: PreviewForwardPort = {
      forward: vi.fn(() => Promise.resolve({ status: 700, body: Buffer.alloc(8 * 1024 * 1024 + 1) })),
    }
    const invalidResult = await send(gateway(fakeService(), invalid).handler, { headers: { host: previewHost, cookie: `${PREVIEW_COOKIE}=valid` } })
    const denied = gateway(fakeService({ authorize: vi.fn(() => { throw new Error('internal detail') }) }))
    const deniedResult = await send(denied.handler, { headers: { host: previewHost, cookie: `${PREVIEW_COOKIE}=valid` } })

    expect(invalidResult).toMatchObject({ status: 502, body: 'Resposta da prévia inválida.' })
    expect(deniedResult).toMatchObject({ status: 404, body: 'Prévia indisponível.' })
    expect(denied.forward.forward).not.toHaveBeenCalled()
  })

  it('fails closed on malformed, oversized or rejected admission payloads', async () => {
    const h = gateway(fakeService({ exchange: vi.fn(() => Promise.reject(new Error('denied'))) }))
    const headers = { host: previewHost, origin: `http://${previewHost}`, 'content-type': 'application/json' }
    const malformed = await send(h.handler, { method: 'POST', path: '/__dz23/admission', headers, body: '{' })
    const short = await send(h.handler, { method: 'POST', path: '/__dz23/admission', headers, body: JSON.stringify({ ticket: 'short' }) })
    const oversized = await send(h.handler, { method: 'POST', path: '/__dz23/admission', headers, body: JSON.stringify({ ticket: 'x'.repeat(8 * 1024) }) })
    const rejected = await send(h.handler, { method: 'POST', path: '/__dz23/admission', headers, body: JSON.stringify({ ticket: 'x'.repeat(24) }) })

    expect([malformed.status, short.status, oversized.status, rejected.status]).toEqual([404, 400, 404, 404])
  })

  it('rejects unsafe methods with a false Origin before cookie authorization', async () => {
    const h = gateway()
    const result = await send(h.handler, {
      method: 'DELETE', path: '/records/1',
      headers: { host: previewHost, origin: 'http://attacker.example', cookie: `${PREVIEW_COOKIE}=valid` },
    })

    expect(result.status).toBe(403)
    expect(h.service.authorize).not.toHaveBeenCalled()
    expect(h.forward.forward).not.toHaveBeenCalled()
  })

  it('uses exact frame-ancestors CSP without X-Frame-Options', async () => {
    const h = gateway()
    const result = await send(h.handler, { path: '/__dz23/admission', headers: { host: previewHost } })

    expect(result.headers['content-security-policy']).toContain('frame-ancestors http://studio.dz23.localhost:3210')
    expect(result.headers['content-security-policy']).not.toContain('frame-ancestors *')
    expect(result.headers['x-frame-options']).toBeUndefined()
  })
})
