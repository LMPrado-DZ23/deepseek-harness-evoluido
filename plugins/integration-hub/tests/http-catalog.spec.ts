import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CSRF_COOKIE, IdentityError, SESSION_COOKIE, type SessionRecord, type StudioIdentityService } from '@dz23-studio/identity'
import type { StudioTenancyService } from '@dz23-studio/tenancy'
import { catalogQuery, createHubHttpHandler } from '../src/http.ts'
import { canonicalManifestBytes } from '../src/manifest.ts'
import type { HubEvent, IntegrationManifest, StudioExport, StudioIntegration } from '../src/model.ts'
import { IntegrationHubService, securityFingerprint, type HubActor, type HubRepository } from '../src/service.ts'

class MemoryRepository implements HubRepository {
  rows: StudioIntegration[] = []; eventRows: HubEvent[] = []
  integrations = (scope: HubActor) => this.rows.filter(row => sameScope(scope, row))
  integration = (scope: HubActor, integrationId: string) => this.rows.find(row => sameScope(scope, row) && row.integration_id === integrationId)
  putIntegration = async (value: StudioIntegration) => {
    this.rows = [...this.rows.filter(row => row.integration_id !== value.integration_id), value]
  }
  compareAndSwapIntegration = async (scope: HubActor, integrationId: string, expected: string, value: StudioIntegration) => {
    const current = this.integration(scope, integrationId)
    if (current === undefined || securityFingerprint(current) !== expected) return false
    await this.putIntegration(value); return true
  }
  exports = (): readonly StudioExport[] => []
  export = () => undefined
  putExport = async () => undefined
  eventPage = () => []
  eventCount = () => this.eventRows.length
  putEvent = async (value: HubEvent) => { this.eventRows = [...this.eventRows, value] }
  pruneEvents = async () => 0
  readonly switches = new Map<string, IntegrationKillSwitch>()
  killSwitch = (switchId: string) => this.switches.get(switchId)
  putKillSwitch = async (value: IntegrationKillSwitch) => { this.switches.set(value.switch_id, value) }
  killSwitches = (orgId: string) => [...this.switches.values()].filter(record => record.org_id === orgId)
}

function sameScope(scope: HubActor, value: { org_id: string; tenant_id: string }): boolean {
  return scope.orgId === value.org_id && scope.tenantId === value.tenant_id
}

const session = { session_id: 's1', user_id: 'u1', org_id: 'org-a', tenant_id: 'ws-a' } as SessionRecord
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publisherKeys = { dz23: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }
const servers: ReturnType<typeof createServer>[] = []
const roots: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function manifest(overrides: Partial<IntegrationManifest> = {}): IntegrationManifest {
  const value = {
    schema_version: 1, id: 'agenda', name: 'Agenda', version: '1.0.0', kind: 'skill',
    publisher: { id: 'dz23', name: 'DZ23' }, permissions: [], tier: 'T0', ...overrides,
  } as IntegrationManifest
  return { ...value, signature: sign(null, canonicalManifestBytes(value), privateKey).toString('base64') }
}

interface CatalogAnswer {
  channel: string
  integrations: Array<{ integration_id: string; name: string; health: { state: string; cost_state: string; calls: number } }>
  next_cursor: string | null
  total: number
  matched: number
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dz23-hub-catalog-'))
  roots.push(root)
  const repository = new MemoryRepository(); let id = 0
  const service = new IntegrationHubService({
    repository, exportsRoot: root, runsRoot: root, publisherKeys, channel: 'stable',
    secrets: { inspect: async () => ({ present: false, shapeOk: false }) },
    projects: { project: () => { throw Object.assign(new Error('nope'), { code: 'NOT_FOUND' }) }, runs: () => [] },
    now: () => new Date('2026-09-04T00:00:00.000Z'), createId: () => `id-${++id}`,
  })
  const identity = {
    authenticate: vi.fn((token: string) => token === 'session' ? Promise.resolve(session) : Promise.reject(new IdentityError('invalid', 'Sessão inválida.'))),
    validateCsrf: vi.fn((_s: unknown, cookie?: string, header?: string) => { if (cookie !== 'csrf' || header !== 'csrf') throw new IdentityError('invalid', 'CSRF ausente.') }),
  }
  const tenancy = { authorizationFor: vi.fn((userId: string, orgId: string, tenantId: string) => ({ userId, orgId, tenantId, role: 'admin' })) }
  const allowedHosts: string[] = []; const allowedOrigins: string[] = []
  const server = createServer(createHubHttpHandler({
    service, identity: identity as unknown as StudioIdentityService, tenancy: tenancy as unknown as StudioTenancyService, allowedHosts, allowedOrigins,
  }))
  servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port; const host = `127.0.0.1:${port}`; const origin = `http://${host}`
  allowedHosts.push(host); allowedOrigins.push(origin)
  const headers = { host, origin, 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=session; ${CSRF_COOKIE}=csrf`, 'x-dz23-csrf': 'csrf' }
  const request = (path: string, init: RequestInit = {}) => fetch(`${origin}/api/studio/hub${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } })
  const catalog = async (query = ''): Promise<CatalogAnswer> => await (await request(`/integrations${query}`)).json() as CatalogAnswer
  return { request, catalog, service, repository }
}

describe('catálogo pela borda HTTP', () => {
  it('busca, filtra e pagina no servidor: o cliente recebe uma página, nunca o escopo inteiro', async () => {
    const { request, catalog } = await fixture()
    for (const value of [
      manifest({ id: 'agenda', name: 'Agenda' }),
      manifest({ id: 'boleto', name: 'Boleto', kind: 'webhook' }),
      manifest({ id: 'salao', name: 'Salão de beleza' }),
    ]) await request('/integrations', { method: 'POST', body: JSON.stringify(value) })

    const first = await catalog('?limit=2')
    expect(first.integrations.map(row => row.name)).toEqual(['Agenda', 'Boleto'])
    expect(first.total).toBe(3)
    expect(first.matched).toBe(3)
    expect(first.next_cursor).not.toBeNull()
    const second = await catalog(`?limit=2&cursor=${encodeURIComponent(first.next_cursor!)}`)
    expect(second.integrations.map(row => row.name)).toEqual(['Salão de beleza'])
    expect(second.next_cursor).toBeNull()

    // Quem digita sem acento acha assim mesmo.
    expect((await catalog('?q=salao')).integrations.map(row => row.name)).toEqual(['Salão de beleza'])
    expect((await catalog('?kind=webhook')).integrations.map(row => row.name)).toEqual(['Boleto'])
    expect((await catalog('?status=enabled')).matched).toBe(0)
  })

  it('separa "nada encontrado" de "você ainda não tem integração"', async () => {
    const { request, catalog } = await fixture()
    const empty = await catalog()
    // Catálogo vazio: nada a procurar.
    expect(empty).toMatchObject({ total: 0, matched: 0 })
    await request('/integrations', { method: 'POST', body: JSON.stringify(manifest()) })
    const nothingFound = await catalog('?q=inexistente')
    // Lista vazia, mas o catálogo tem uma: a tela precisa poder dizer qual das duas é.
    expect(nothingFound).toMatchObject({ total: 1, matched: 0 })
    expect(nothingFound.integrations).toEqual([])
  })

  it('publica a saúde de cada integração, e nunca OK sem nunca ter sido chamada', async () => {
    const { request, catalog, service } = await fixture()
    const registered = await (await request('/integrations', { method: 'POST', body: JSON.stringify(manifest()) })).json() as { integration: { integration_id: string } }
    const id = registered.integration.integration_id
    expect((await catalog()).integrations[0]!.health).toMatchObject({ state: 'NOT_EXECUTED', calls: 0, cost_state: 'UNKNOWN' })
    await request(`/integrations/${id}/enabled`, { method: 'POST', body: '{"enabled":true}' })
    await service.callIntegration({ userId: 'u1', orgId: 'org-a', tenantId: 'ws-a', role: 'admin' }, id, { operation: 'ler', idempotent: true }, async () => 1)
    expect((await catalog()).integrations[0]!.health).toMatchObject({ state: 'OK', calls: 1, cost_state: 'UNKNOWN' })
  })

  it('recusa um filtro que não existe em vez de ignorá-lo, e recusa um cursor ilegível', async () => {
    const { request } = await fixture()
    // Um filtro descartado calado devolveria uma lista MAIOR do que a pedida, e
    // quem lê a tela acreditaria que aquilo é o resultado do filtro.
    expect((await request('/integrations?kind=inventado')).status).toBe(400)
    expect((await request('/integrations?verification=talvez')).status).toBe(400)
    expect((await request('/integrations?limit=0')).status).toBe(400)
    expect((await request('/integrations?limit=101')).status).toBe(400)
    expect((await request('/integrations?ordenar=nome')).status).toBe(400)
    expect((await request('/integrations?cursor=lixo')).status).toBe(400)
  })

  it('lê a pergunta da barra de endereço, e uma lista vazia quer dizer sem filtro', () => {
    expect(catalogQuery(new URLSearchParams('q=agenda&kind=skill,webhook&status=enabled&verification=verified&limit=5'))).toEqual({
      search: 'agenda', kinds: ['skill', 'webhook'], status: 'enabled', verifications: ['verified'], limit: 5, cursor: undefined,
    })
    // Limpar a caixa na tela manda `kind=`: isso é "sem filtro", não "filtro que
    // nada satisfaz" — senão limpar devolveria zero resultados.
    expect(catalogQuery(new URLSearchParams('kind=')).kinds).toEqual([])
    expect(catalogQuery(new URLSearchParams()).kinds).toBeUndefined()
  })
})
