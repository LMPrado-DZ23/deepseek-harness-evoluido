import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type { StudioIdentityService } from '@dz23-studio/identity'
import { createRouteHealthHandler } from '../src/index.ts'
import type { StudioRouteHealthService } from '../src/service.ts'

function response() {
  const state = { status: 0, body: '', headers: {} as Record<string, string> }
  return {
    state,
    value: {
      writableEnded: false,
      writeHead: (status: number, headers: Record<string, string>) => { state.status = status; state.headers = headers },
      end: (body: string) => { state.body = body },
    } as unknown as ServerResponse,
  }
}

function request(method = 'GET', cookie = 'dz23_studio_session=token') {
  return { method, headers: { cookie } } as IncomingMessage
}

describe('route-health HTTP', () => {
  it('requires a session and returns only that tenant records', async () => {
    const service = {
      list: vi.fn(() => [{ route: 'ollama', state: 'OK' }]),
      switches: vi.fn(() => [{ from_route: 'omniroute', to_route: 'deepseek-official' }]),
    } as unknown as StudioRouteHealthService
    const identity = {
      authenticate: vi.fn(() => Promise.resolve({ org_id: 'org-1', tenant_id: 'tenant-1' })),
    } as unknown as StudioIdentityService
    const target = response()
    await createRouteHealthHandler(service, identity)(request(), target.value)
    expect(target.state.status).toBe(200)
    expect(JSON.parse(target.state.body)).toMatchObject({ routes: [{ route: 'ollama' }] })
    expect(service.list).toHaveBeenCalledWith({ orgId: 'org-1', tenantId: 'tenant-1' })
  })

  it('rejects non-GET requests and invalid sessions in plain language', async () => {
    const service = { list: vi.fn(), switches: vi.fn() } as unknown as StudioRouteHealthService
    const identity = { authenticate: vi.fn(() => Promise.reject(new Error('Sessão encerrada.'))) } as unknown as StudioIdentityService
    const wrongMethod = response()
    await createRouteHealthHandler(service, identity)(request('POST'), wrongMethod.value)
    expect(wrongMethod.state.status).toBe(405)
    const invalid = response()
    await createRouteHealthHandler(service, identity)(request(), invalid.value)
    expect(invalid.state.status).toBe(401)
    expect(JSON.parse(invalid.state.body)).toEqual({ error: 'Sessão encerrada.' })
  })

  it('does not write twice after the response has ended', async () => {
    const service = { list: vi.fn(), switches: vi.fn() } as unknown as StudioRouteHealthService
    const identity = { authenticate: vi.fn() } as unknown as StudioIdentityService
    const ended = response()
    Object.defineProperty(ended.value, 'writableEnded', { value: true })
    await createRouteHealthHandler(service, identity)(request('POST'), ended.value)
    expect(ended.state.status).toBe(0)
  })
})
