import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type { StudioIdentityService } from '@dz23-studio/identity'
import { createRouteHealthHandler, createRouteSwitchHandler } from '../src/index.ts'
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
      authenticate: vi.fn(() => Promise.resolve({ org_id: 'org-1', tenant_id: 'tenant-1' })), assertRequestTrust: () => {} } as unknown as StudioIdentityService
    const target = response()
    await createRouteHealthHandler(service, identity)(request(), target.value)
    expect(target.state.status).toBe(200)
    expect(JSON.parse(target.state.body)).toMatchObject({ routes: [{ route: 'ollama' }] })
    expect(service.list).toHaveBeenCalledWith({ orgId: 'org-1', tenantId: 'tenant-1' })
  })

  it('rejects non-GET requests and invalid sessions in plain language', async () => {
    const service = { list: vi.fn(), switches: vi.fn() } as unknown as StudioRouteHealthService
    const identity = { authenticate: vi.fn(() => Promise.reject(new Error('Sessão encerrada.'))), assertRequestTrust: () => {} } as unknown as StudioIdentityService
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
    const identity = { authenticate: vi.fn(), assertRequestTrust: () => {} } as unknown as StudioIdentityService
    const ended = response()
    Object.defineProperty(ended.value, 'writableEnded', { value: true })
    await createRouteHealthHandler(service, identity)(request('POST'), ended.value)
    expect(ended.state.status).toBe(0)
  })
})

describe('ligar e desligar uma conexão pela tela', () => {
  const identidade = { authenticate: vi.fn(() => Promise.resolve({ org_id: 'org-1', tenant_id: 'tenant-1' })), assertRequestTrust: () => {} } as unknown as StudioIdentityService
  const corpo = (texto: string, method = 'POST') => Object.assign((async function * () { yield Buffer.from(texto) })(), { method, headers: { cookie: 'dz23_studio_session=token', 'x-dz23-csrf': 'c' } }) as unknown as IncomingMessage
  const servico = () => ({
    list: vi.fn(() => [{ route: 'ollama', enabled: true }, { route: 'cli-claude', enabled: true }]),
    switches: vi.fn(() => []),
    setRouteEnabled: vi.fn(() => Promise.resolve()),
  })

  it('desliga a rota pedida, no escopo da sessão, e devolve a lista com os nomes', async () => {
    const service = servico()
    const alvo = response()
    const identity = { ...identidade, validateCsrfToken: () => {} } as unknown as StudioIdentityService
    await createRouteSwitchHandler(service as unknown as StudioRouteHealthService, identity, () => ({ 'cli-claude': 'Claude Code' }))(corpo('{"route":"ollama","enabled":false}'), alvo.value)
    expect(alvo.state.status).toBe(200)
    expect(service.setRouteEnabled).toHaveBeenCalledWith({ orgId: 'org-1', tenantId: 'tenant-1' }, 'ollama', false)
    expect(JSON.parse(alvo.state.body)).toMatchObject({ names: { 'cli-claude': 'Claude Code' }, routes: [{ route: 'ollama' }, { route: 'cli-claude' }] })
  })

  it('recusa método errado, sessão inválida, corpo inválido, corpo grande e rota desconhecida', async () => {
    const identity = { ...identidade, validateCsrfToken: () => {} } as unknown as StudioIdentityService
    const casos: [IncomingMessage, StudioIdentityService, number][] = [
      [corpo('{}', 'GET'), identity, 405],
      [corpo('{"route":"ollama","enabled":false}'), { authenticate: vi.fn(() => Promise.reject(new Error('Sessão encerrada.'))), assertRequestTrust: () => {} } as unknown as StudioIdentityService, 401],
      [corpo('não é json'), identity, 400],
      [corpo('null'), identity, 400],
      [corpo('{"route":"ollama","enabled":"sim"}'), identity, 400],
      [corpo('{"route":"","enabled":true}'), identity, 400],
      [corpo(`{"route":"${'x'.repeat(5000)}","enabled":true}`), identity, 400],
      [corpo('{"route":"cli-nada","enabled":true}'), identity, 404],
    ]
    for (const [pedido, id, status] of casos) {
      const service = servico()
      const alvo = response()
      await createRouteSwitchHandler(service as unknown as StudioRouteHealthService, id)(pedido, alvo.value)
      expect(alvo.state.status).toBe(status)
      expect(service.setRouteEnabled).not.toHaveBeenCalled()
    }
  })

  it('o corpo pode chegar como texto, e o GET devolve os nomes', async () => {
    const service = servico()
    const alvo = response()
    const identity = { ...identidade, validateCsrfToken: () => {} } as unknown as StudioIdentityService
    const pedido = Object.assign((async function * () { yield '{"route":"cli-claude",'; yield '"enabled":true}' })(), { method: 'POST', headers: { cookie: 'dz23_studio_session=token' } }) as unknown as IncomingMessage
    await createRouteSwitchHandler(service as unknown as StudioRouteHealthService, identity)(pedido, alvo.value)
    expect(service.setRouteEnabled).toHaveBeenCalledWith({ orgId: 'org-1', tenantId: 'tenant-1' }, 'cli-claude', true)
    expect(JSON.parse(alvo.state.body).names).toEqual({})
    const lista = response()
    await createRouteHealthHandler({ list: () => [], switches: () => [] } as unknown as StudioRouteHealthService, identidade, () => ({ ollama: 'Ollama local' }))(request(), lista.value)
    expect(JSON.parse(lista.state.body).names).toEqual({ ollama: 'Ollama local' })
  })
})
