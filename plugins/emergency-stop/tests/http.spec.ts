import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createEmergencyStopHttpExtension, EMERGENCY_STOP_ROUTE_CONTRACTS } from '../src/http.ts'
import type { EmergencyStopRecord } from '../src/model.ts'
import { StudioEmergencyStopService, type EmergencyStopRepository } from '../src/service.ts'

class MemoryRepository implements EmergencyStopRepository {
  readonly rows = new Map<string, EmergencyStopRecord>()
  stops() { return [...this.rows.values()] }
  putStop(record: EmergencyStopRecord) { this.rows.set(record.scope_id, record); return Promise.resolve() }
}

const actor = { userId: 'u-1', orgId: 'org-a', tenantId: 'tenant-a', role: 'owner' as const, sessionId: 's-1' }

function capture() {
  const chunks: string[] = []
  let status = 0
  const response = {
    writableEnded: false,
    writeHead(code: number) { status = code; return response },
    end(value?: string) { if (value !== undefined) chunks.push(value); response.writableEnded = true },
  }
  const body = () => chunks.length === 0 ? null : JSON.parse(chunks.join('')) as Record<string, unknown>
  return { response, get status() { return status }, body }
}

function request(method: string, body?: unknown): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]) as unknown as IncomingMessage
  stream.method = method
  stream.headers = body === undefined ? {} : { 'content-type': 'application/json' }
  return stream
}

function fixture(strong = true) {
  const repository = new MemoryRepository()
  const service = new StudioEmergencyStopService({
    repository,
    identity: { strongIdentityVerified: () => strong },
    now: () => new Date('2026-09-08T12:00:00.000Z'),
  })
  return { repository, service, extension: createEmergencyStopHttpExtension(service) }
}

async function call(f: ReturnType<typeof fixture>, suffix: string, method: string, body?: unknown) {
  const out = capture()
  const claimed = await f.extension({
    request: request(method, body),
    response: out.response as unknown as ServerResponse,
    actor, suffix,
  })
  return { claimed, status: out.status, body: out.body() ?? {} }
}

describe('a rota do botão de emergência', () => {
  it('declara contratos de rota válidos, e o piso de parar é `project.write`', () => {
    // O contrato não sabe expressar "identidade forte"; quem exige isso é o
    // serviço. O contrato é o piso, nunca o teto.
    expect(EMERGENCY_STOP_ROUTE_CONTRACTS.map(route => `${route.method} ${route.path}`)).toEqual([
      'GET /emergency-stop', 'POST /emergency-stop/engage', 'POST /emergency-stop/release',
    ])
    expect(EMERGENCY_STOP_ROUTE_CONTRACTS.every(route => route.access === 'authorized')).toBe(true)
  })

  it('não reivindica o que não é dela', async () => {
    const f = fixture()
    expect((await call(f, '/previews', 'GET')).claimed).toBe(false)
    expect((await call(f, '/emergency-stop-outra-coisa', 'GET')).claimed).toBe(false)
  })

  it('lê o estado, para e retoma pelo escopo de quem pediu', async () => {
    const f = fixture(true)
    expect((await call(f, '/emergency-stop', 'GET')).body).toEqual({
      emergency_stop: {
        org_id: 'org-a', tenant_id: 'tenant-a', stopped: false,
        engaged_by: null, engaged_at: null, reason: null,
        released_by: null, released_at: null, release_reason: null,
      },
    })
    const engaged = await call(f, '/emergency-stop/engage', 'POST', { reason: 'Cobrança em loop.' })
    expect(engaged.status).toBe(200)
    expect(engaged.body.emergency_stop).toMatchObject({ stopped: true, engaged_by: 'u-1', reason: 'Cobrança em loop.' })
    expect(engaged.body.surfaces).toEqual([])
    const released = await call(f, '/emergency-stop/release', 'POST', { reason: 'Provedor corrigiu e conferimos.' })
    expect(released.status).toBe(200)
    expect(released.body.emergency_stop).toMatchObject({ stopped: false, released_by: 'u-1' })
  })

  it('parar sem motivo é permitido; retomar sem motivo nem chega ao serviço', async () => {
    const f = fixture(true)
    expect((await call(f, '/emergency-stop/engage', 'POST', {})).status).toBe(200)
    expect((await call(f, '/emergency-stop/release', 'POST', {})).status).toBe(400)
    expect(f.service.state(actor).stopped).toBe(true)
  })

  it('falta de identidade forte responde 401, e não 403: a pessoa precisa da chave, não de um administrador', async () => {
    const f = fixture(false)
    await call(f, '/emergency-stop/engage', 'POST', {})
    const refused = await call(f, '/emergency-stop/release', 'POST', { reason: 'Achei que já dava para voltar.' })
    expect(refused.status).toBe(401)
    expect(f.service.state(actor).stopped).toBe(true)
  })

  it('corpo que não é JSON declarado não vira leitura de dados', async () => {
    const f = fixture()
    const out = capture()
    const raw = Readable.from([Buffer.from('{}', 'utf8')]) as unknown as IncomingMessage
    raw.method = 'POST'; raw.headers = {}
    await f.extension({ request: raw, response: out.response as unknown as ServerResponse, actor, suffix: '/emergency-stop/engage' })
    expect(out.status).toBe(400)
  })

  it('método não previsto no próprio sufixo é 404, não uma ação silenciosa', async () => {
    const f = fixture()
    expect((await call(f, '/emergency-stop/engage', 'GET')).status).toBe(404)
    expect((await call(f, '/emergency-stop', 'DELETE')).status).toBe(404)
    expect(f.service.state(actor).stopped).toBe(false)
  })
})
