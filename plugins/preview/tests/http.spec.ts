import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPreviewProjectHttpExtension, PREVIEW_ROUTE_CONTRACTS } from '../src/http.ts'
import { PreviewError, type PreviewActor, type StudioPreviewService } from '../src/service.ts'

interface HttpResult {
  readonly status: number
  readonly body: unknown
}

const openServers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => { if (error === undefined) resolve(); else reject(error) })
  })))
})

const actor: PreviewActor = {
  userId: 'user-1', orgId: 'org-1', tenantId: 'tenant-1', role: 'builder', sessionId: 'session-1',
}

const preview = {
  preview_id: 'preview-1', project_id: 'project-1', run_id: 'run-1', artifact_sha256: 'a'.repeat(64),
  state: 'READY' as const, health: 'OK' as const, url: 'http://p-0123456789abcdef01234567.localhost',
  created_at: '2026-09-03T12:00:00.000Z', ready_at: '2026-09-03T12:00:01.000Z',
  expires_at: '2026-09-03T12:30:00.000Z', stopped_at: null, stop_reason: null, failure_code: null,
}

function fakeService(overrides: Partial<StudioPreviewService> = {}) {
  return {
    list: vi.fn(() => [preview]),
    start: vi.fn(() => Promise.resolve({ preview, admissionTicket: 'admission-ticket' })),
    health: vi.fn(() => Promise.resolve(preview)),
    logs: vi.fn(() => Promise.resolve(['linha segura'])),
    verificationMessages: vi.fn(() => Promise.resolve([{ kind: 'code', email: 'owner@example.test', code: '123456', expiresAt: '2026-09-03T12:10:00.000Z' }])),
    heartbeat: vi.fn(() => Promise.resolve({ ...preview, expires_at: '2026-09-03T13:00:00.000Z' })),
    stop: vi.fn(() => Promise.resolve({ ...preview, state: 'STOPPED' as const })),
    ...overrides,
  } as unknown as StudioPreviewService
}

async function send(
  service: StudioPreviewService,
  input: { method?: string; suffix: string; actor?: PreviewActor; body?: string; contentType?: string },
): Promise<HttpResult> {
  const extension = createPreviewProjectHttpExtension(service)
  const server = createServer((request, response) => {
    void extension({
      request, response, actor: input.actor ?? actor, projectId: 'project-1', suffix: input.suffix,
    }).then(handled => {
      if (!handled && !response.writableEnded) {
        response.writeHead(404)
        response.end(JSON.stringify({ error: 'unhandled' }))
      }
    })
  })
  openServers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server did not bind TCP')
  return new Promise<HttpResult>((resolve, reject) => {
    const headers: Record<string, string> = {}
    if (input.contentType !== undefined) headers['content-type'] = input.contentType
    const request = httpRequest({
      hostname: '127.0.0.1', port: address.port, method: input.method ?? 'GET', path: '/', headers,
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: response.statusCode ?? 0, body: text === '' ? undefined : JSON.parse(text) as unknown })
      })
    })
    request.on('error', reject)
    if (input.body !== undefined) request.write(input.body)
    request.end()
  })
}

describe('preview project HTTP extension', () => {
  it('declares every preview route with tenant-aware RBAC', () => {
    expect(PREVIEW_ROUTE_CONTRACTS).toHaveLength(7)
    expect(PREVIEW_ROUTE_CONTRACTS.every(route => route.access === 'authorized' && route.scope === 'project')).toBe(true)
    expect(PREVIEW_ROUTE_CONTRACTS.find(route => route.path.endsWith('/heartbeat'))?.permission).toBe('project.write')
    expect(PREVIEW_ROUTE_CONTRACTS.find(route => route.path.endsWith('/messages'))?.permission).toBe('project.write')
  })

  it('maps list, start, get/health, logs, preview messages, heartbeat and delete to the scoped service port', async () => {
    const service = fakeService()

    const listed = await send(service, { suffix: '/previews' })
    const started = await send(service, {
      method: 'POST', suffix: '/previews', contentType: 'application/json', body: JSON.stringify({ run_id: 'run-requested' }),
    })
    const fetched = await send(service, { suffix: '/previews/preview-1' })
    const logs = await send(service, { suffix: '/previews/preview-1/logs' })
    const messages = await send(service, { suffix: '/previews/preview-1/messages' })
    const heartbeat = await send(service, { method: 'POST', suffix: '/previews/preview-1/heartbeat' })
    const stopped = await send(service, { method: 'DELETE', suffix: '/previews/preview-1' })

    expect(listed).toEqual({ status: 200, body: { previews: [preview] } })
    expect(started).toEqual({
      status: 202,
      body: { preview, admission: { ticket: 'admission-ticket', transport: 'post-message-exchange' } },
    })
    expect(fetched).toEqual({ status: 200, body: { preview } })
    expect(logs).toEqual({ status: 200, body: { lines: ['linha segura'] } })
    expect(messages).toEqual({ status: 200, body: { messages: [{ email: 'owner@example.test', code: '123456', expires_at: '2026-09-03T12:10:00.000Z' }] } })
    expect(heartbeat).toMatchObject({ status: 200, body: { preview: { expires_at: '2026-09-03T13:00:00.000Z' } } })
    expect(stopped).toMatchObject({ status: 200, body: { preview: { state: 'STOPPED' } } })
    expect(service.list).toHaveBeenCalledWith(actor, 'project-1')
    expect(service.start).toHaveBeenCalledWith(actor, 'project-1', 'run-requested')
    expect(service.health).toHaveBeenCalledWith(actor, 'project-1', 'preview-1')
    expect(service.logs).toHaveBeenCalledWith(actor, 'project-1', 'preview-1')
    expect(service.verificationMessages).toHaveBeenCalledWith(actor, 'project-1', 'preview-1')
    expect(service.heartbeat).toHaveBeenCalledWith(actor, 'project-1', 'preview-1')
    expect(service.stop).toHaveBeenCalledWith(actor, 'project-1', 'preview-1')
  })

  it('preserves viewer identity for the service to deny writes', async () => {
    const viewer: PreviewActor = { ...actor, userId: 'viewer-1', role: 'viewer', sessionId: 'viewer-session' }
    const start = vi.fn(async (received: PreviewActor) => {
      expect(received).toEqual(viewer)
      throw new PreviewError('FORBIDDEN', 'viewer não escreve')
    })
    const service = fakeService({ start } as Partial<StudioPreviewService>)

    const response = await send(service, {
      method: 'POST', suffix: '/previews', actor: viewer, contentType: 'application/json', body: '{}',
    })

    expect(response).toEqual({ status: 403, body: { error: 'viewer não escreve' } })
  })

  it('preserves tenant scope and converts the service cross-tenant denial to 404', async () => {
    const outsider: PreviewActor = { ...actor, orgId: 'org-2', tenantId: 'tenant-2', sessionId: 'other-session' }
    const health = vi.fn(async (received: PreviewActor) => {
      expect(received).toEqual(outsider)
      throw new PreviewError('NOT_FOUND', 'Prévia não encontrada.')
    })
    const service = fakeService({ health } as Partial<StudioPreviewService>)

    const response = await send(service, { suffix: '/previews/preview-1', actor: outsider })

    expect(response).toEqual({ status: 404, body: { error: 'Prévia não encontrada.' } })
  })

  it('requires an auditable session before calling the service', async () => {
    const service = fakeService()
    const anonymousSession: PreviewActor = { ...actor, sessionId: '' }

    const response = await send(service, { suffix: '/previews', actor: anonymousSession })

    expect(response.status).toBe(403)
    expect(service.list).not.toHaveBeenCalled()
  })

  it.each([
    ['NOT_FOUND', 404], ['FORBIDDEN', 403], ['CONFLICT', 409], ['UNAVAILABLE', 503], ['INVALID', 400],
  ] as const)('maps %s service errors without exposing internals', async (code, status) => {
    const service = fakeService({ start: vi.fn(() => Promise.reject(new PreviewError(code, `safe-${code}`))) } as Partial<StudioPreviewService>)
    const response = await send(service, { method: 'POST', suffix: '/previews', contentType: 'application/json', body: '{}' })
    expect(response).toEqual({ status, body: { error: `safe-${code}` } })
  })

  it('rejects malformed input, oversized bodies and unsupported preview suffixes', async () => {
    const service = fakeService()
    const missingType = await send(service, { method: 'POST', suffix: '/previews', body: '{}' })
    const malformed = await send(service, { method: 'POST', suffix: '/previews', contentType: 'application/json', body: '{' })
    const oversized = await send(service, { method: 'POST', suffix: '/previews', contentType: 'application/json', body: JSON.stringify({ run_id: 'x'.repeat(9 * 1024) }) })
    const unknown = await send(service, { suffix: '/previews/preview-1/unknown' })
    const wrongMethod = await send(service, { method: 'PATCH', suffix: '/previews' })

    expect([missingType.status, malformed.status, oversized.status, unknown.status, wrongMethod.status]).toEqual([400, 400, 400, 404, 404])
    expect(service.start).not.toHaveBeenCalled()
  })

  it('returns a generic message for unexpected service failures', async () => {
    const service = fakeService({ health: vi.fn(() => Promise.reject(new Error('secret backend detail'))) } as Partial<StudioPreviewService>)
    const response = await send(service, { suffix: '/previews/preview-1' })
    expect(response).toEqual({ status: 500, body: { error: 'Não foi possível concluir a operação de prévia.' } })
  })
})
