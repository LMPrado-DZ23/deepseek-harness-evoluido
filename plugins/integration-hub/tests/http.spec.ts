import { execFileSync } from 'node:child_process'
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CSRF_COOKIE, IdentityError, SESSION_COOKIE, type SessionRecord, type StudioIdentityService } from '@dz23-studio/identity'
import { TenancyError, type StudioTenancyService } from '@dz23-studio/tenancy'
import { EXPORT_LIMIT_BYTES, ExportError } from '../src/export.ts'
import { createHubHttpHandler, HUB_ROUTE_CONTRACTS, safeFileName } from '../src/http.ts'
import { canonicalManifestBytes } from '../src/manifest.ts'
import type { HubEvent, IntegrationKillSwitch, IntegrationManifest, StudioExport, StudioIntegration } from '../src/model.ts'
import { HubError, IntegrationHubService, securityFingerprint, type HubActor, type HubRepository } from '../src/service.ts'
import { readZip } from '../src/zip.ts'

/**
 * The ceiling is a ceiling on PACKAGING, so that is where a test makes a build outlive it. By
 * default this is the real packager with nothing added. The previous version of the 504 test stubbed
 * `putExport` with a promise that never settles and left it dangling for the rest of the process:
 * it produced the status, but the abandoned build was never allowed to land, so what the build did
 * AFTER the person was answered — the file, the row, the second audit line — was never exercised.
 */
const packaging = vi.hoisted(() => ({ hold: undefined as Promise<void> | undefined, calls: [] as Promise<unknown>[] }))
vi.mock('../src/export.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/export.ts')>()
  return {
    ...actual,
    packagePrototype: (input: Parameters<typeof actual.packagePrototype>[0]) => {
      const call = (async () => {
        if (packaging.hold !== undefined) await packaging.hold
        return actual.packagePrototype(input)
      })()
      packaging.calls.push(call)
      return call
    },
  }
})

class MemoryRepository implements HubRepository {
  rows: StudioIntegration[] = []; exportRows: StudioExport[] = []; eventRows: HubEvent[] = []
  integrations = async (scope: HubActor) => this.rows.filter(row => sameScope(scope, row))
  integration = async (scope: HubActor, integrationId: string) => this.rows.find(row => sameScope(scope, row) && row.integration_id === integrationId)
  deleteIntegration = async (scope: HubActor, integrationId: string) => { this.rows = this.rows.filter(row => !(row.integration_id === integrationId && row.org_id === scope.orgId && row.tenant_id === scope.tenantId)) }
  putIntegration = async (value: StudioIntegration) => { this.rows = [...this.rows.filter(row => row.integration_id !== value.integration_id || row.org_id !== value.org_id || row.tenant_id !== value.tenant_id), value] }
  compareAndSwapIntegration = async (scope: HubActor, integrationId: string, expected: string, value: StudioIntegration) => {
    const current = await this.integration(scope, integrationId)
    if (current === undefined || securityFingerprint(current) !== expected) return false
    await this.putIntegration(value); return true
  }
  exports = async (scope: HubActor, projectId: string) => this.exportRows.filter(row => sameScope(scope, row) && row.project_id === projectId)
  export = async (scope: HubActor, projectId: string, exportId: string) => this.exportRows.find(row => sameScope(scope, row) && row.project_id === projectId && row.export_id === exportId)
  putExport = async (value: StudioExport) => { this.exportRows = [...this.exportRows, value] }
  eventPage = async (scope: HubActor, after: Pick<HubEvent, 'created_at' | 'event_id'> | undefined, limit: number) => {
    const rows = this.eventRows.filter(row => sameScope(scope, row)).sort(newestFirst)
    const start = after === undefined ? 0 : rows.findIndex(row => newestFirst(row, after) > 0)
    return start < 0 ? [] : rows.slice(start, start + limit)
  }
  eventCount = async (scope: HubActor) => this.eventRows.filter(row => sameScope(scope, row)).length
  putEvent = async (value: HubEvent) => { this.eventRows = [...this.eventRows, value] }
  pruneEvents = async (scope: HubActor, keep: number) => {
    const retained = this.eventRows.filter(row => sameScope(scope, row)).sort(newestFirst).slice(0, keep)
    const ids = new Set(retained.map(row => row.event_id))
    const before = await this.eventCount(scope)
    this.eventRows = this.eventRows.filter(row => !sameScope(scope, row) || ids.has(row.event_id))
    return before - retained.length
  }
  readonly switches = new Map<string, IntegrationKillSwitch>()
  killSwitch = (switchId: string) => this.switches.get(switchId)
  putKillSwitch = async (value: IntegrationKillSwitch) => { this.switches.set(value.switch_id, value) }
  killSwitches = (orgId: string) => [...this.switches.values()].filter(record => record.org_id === orgId)
}

type Scope = { readonly orgId: string; readonly tenantId: string }
function sameScope(scope: Scope, value: { org_id: string; tenant_id: string }): boolean { return scope.orgId === value.org_id && scope.tenantId === value.tenant_id }
function newestFirst(left: Pick<HubEvent, 'created_at' | 'event_id'>, right: Pick<HubEvent, 'created_at' | 'event_id'>): number {
  if (left.created_at !== right.created_at) return left.created_at < right.created_at ? 1 : -1
  return left.event_id < right.event_id ? 1 : left.event_id > right.event_id ? -1 : 0
}

const session = { session_id: 's1', user_id: 'u1', org_id: 'org-a', tenant_id: 'ws-a' } as SessionRecord
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publisherKeys = { dz23: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }
const servers: ReturnType<typeof createServer>[] = []
const roots: string[] = []
afterEach(async () => {
  packaging.hold = undefined
  await Promise.allSettled(packaging.calls.splice(0))
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function manifest(): IntegrationManifest {
  const value = { schema_version: 1, id: 'agenda', name: 'Agenda', version: '1.0.0', kind: 'skill', publisher: { id: 'dz23', name: 'DZ23' }, permissions: [], tier: 'T0' } as IntegrationManifest
  return { ...value, signature: sign(null, canonicalManifestBytes(value), privateKey).toString('base64') }
}

interface FixtureOptions {
  /** Thrown by the projects port of ANOTHER plugin, exactly as that plugin throws it. */
  readonly projectError?: unknown
  readonly packagingTimeoutMs?: number
  /** Thrown by the identity plugin when the session is authenticated. */
  readonly identityError?: unknown
  /** Thrown by the tenancy plugin when the membership is looked up. */
  readonly tenancyError?: unknown
  /** The session is valid, but it has no membership in this workspace. */
  readonly noMembership?: boolean
}

async function fixture(role: 'owner' | 'admin' | 'builder' | 'viewer' = 'owner', options: FixtureOptions = {}) {
  const exportsRoot = await mkdtemp(join(tmpdir(), 'dz23-hub-http-'))
  roots.push(exportsRoot)
  const runDirectory = join(exportsRoot, 'run')
  await mkdir(join(runDirectory, '.next', 'standalone'), { recursive: true })
  await writeFile(join(runDirectory, '.next', 'standalone', 'server.js'), 'ok')
  await chmod(join(runDirectory, '.next', 'standalone', 'server.js'), 0o755)
  const repository = new MemoryRepository(); let id = 0
  const service = new IntegrationHubService({
    repository, exportsRoot, publisherKeys, channel: 'stable', runsRoot: exportsRoot,
    secrets: { inspect: async ref => ({ present: ref === 'DZ23_APP_SMTP', shapeOk: ref === 'DZ23_APP_SMTP' }) },
    projects: {
      project: (actor, projectId) => {
        if (options.projectError !== undefined) throw options.projectError
        if (projectId !== 'p1' || actor.tenantId !== 'ws-a') throw Object.assign(new Error('nope'), { code: 'NOT_FOUND' })
        return { project_id: 'p1', name: 'Agenda', state: 'VERIFIED_PROTOTYPE' }
      },
      runs: () => [{ run_id: 'run-1', state: 'PASSED', started_at: '2026-09-03T11:00:00.000Z', attempt: 1, run_directory: runDirectory }],
    },
    ...(options.packagingTimeoutMs === undefined ? {} : { packagingTimeoutMs: options.packagingTimeoutMs }),
    now: () => new Date('2026-09-04T00:00:00.000Z'), createId: () => `id-${++id}`,
  })
  const identity = { authenticate: vi.fn((token: string) => { if (options.identityError !== undefined) return Promise.reject(options.identityError); return token === 'session' ? Promise.resolve(session) : Promise.reject(new IdentityError('invalid', 'Sessão inválida.')) }), validateCsrfToken: vi.fn((_s: unknown, header?: string) => { if (header !== 'csrf') throw new IdentityError('invalid', 'CSRF ausente.') }), cookiesAreSecure: false,
    assertRequestTrust: vi.fn(),
  }
  const tenancy = { authorizationFor: vi.fn((userId: string, orgId: string, tenantId: string) => { if (options.tenancyError !== undefined) throw options.tenancyError; return options.noMembership === true ? undefined : { userId, orgId, tenantId, role } }) }
  const allowedHosts: string[] = []; const allowedOrigins: string[] = []
  const server = createServer(createHubHttpHandler({ service, identity: identity as unknown as StudioIdentityService, tenancy: tenancy as unknown as StudioTenancyService, allowedHosts, allowedOrigins }))
  servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port; const host = `127.0.0.1:${port}`; const origin = `http://${host}`
  allowedHosts.push(host); allowedOrigins.push(origin)
  const headers = { host, origin, 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=session; ${CSRF_COOKIE}=csrf`, 'x-dz23-csrf': 'csrf' }
  const request = (path: string, init: RequestInit = {}) => fetch(`${origin}/api/studio/hub${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } })
  return { request, repository, host, origin, standalone: join(runDirectory, '.next', 'standalone') }
}

async function getWithInjectedFailure(error: unknown, source: 'identity' | 'tenancy' | 'service' = 'service'): Promise<Response> {
  const allowedHosts: string[] = []; const allowedOrigins: string[] = []
  const identity = {
    authenticate: vi.fn(() => source === 'identity' ? Promise.reject(error) : Promise.resolve(session)),
    assertRequestTrust: vi.fn(),
  }
  const tenancy = {
    authorizationFor: vi.fn(() => {
      if (source === 'tenancy') throw error
      return { userId: 'u1', orgId: 'org-a', tenantId: 'ws-a', role: 'owner' }
    }),
  }
  const service = {
    channel: 'stable',
    list: vi.fn(() => { if (source === 'service') throw error; return [] }),
    // A rota do catálogo passou a perguntar por PÁGINA (X-01): o dublê precisa
    // oferecer o mesmo ponto, senão a falha que este teste injeta nunca chega a
    // ser lançada e o 500 medido seria o do dublê, não o do limite testado.
    searchIntegrations: vi.fn(() => { if (source === 'service') throw error; return { integrations: [], next_cursor: null, total: 0, matched: 0 } }),
  }
  const server = createServer(createHubHttpHandler({
    service: service as unknown as IntegrationHubService,
    identity: identity as unknown as StudioIdentityService,
    tenancy: tenancy as unknown as StudioTenancyService,
    allowedHosts, allowedOrigins,
  }))
  servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port; const host = `127.0.0.1:${port}`; const origin = `http://${host}`
  allowedHosts.push(host); allowedOrigins.push(origin)
  return fetch(`${origin}/api/studio/hub/integrations`, { headers: { host, origin, cookie: `${SESSION_COOKIE}=session` } })
}

describe('integration hub HTTP boundary', () => {
  it('declares every route authorized with a permission and a server-owned scope', () => {
    for (const contract of HUB_ROUTE_CONTRACTS) {
      expect(contract.access).toBe('authorized')
      expect(contract.permission).not.toBeNull()
      expect(['workspace', 'project']).toContain(contract.scope)
    }
  })

  it('refuses missing session, wrong host, missing CSRF and unknown routes', async () => {
    const { request, host } = await fixture()
    expect((await request('/integrations', { headers: { cookie: '' } })).status).toBe(401)
    // fetch() never lets a caller spoof Host; a raw request does.
    const spoofed = await new Promise<number>(resolvePromise => {
      const [hostname, port] = host.split(':')
      httpRequest({ hostname, port: Number(port), path: '/api/studio/hub/integrations', headers: { host: 'evil.example', cookie: `${SESSION_COOKIE}=session` } }, response => { response.resume(); resolvePromise(response.statusCode ?? 0) }).end()
    })
    expect(spoofed).toBe(401)
    expect((await request('/smtp', { method: 'POST', body: '{"secret_ref":"DZ23_APP_SMTP"}', headers: { 'x-dz23-csrf': 'wrong' } })).status).toBe(401)
    // ACHADO: a conferencia era de DUPLO ENVIO e exigia o cookie
    // `dz23_studio_csrf`, que o Studio parou de emitir — `serializeSessionCookies`
    // o EXPIRA. Em producao o cookie nunca chegava e TODA mutacao do hub
    // respondia 401; o teste passava porque mandava cookie E cabecalho.
    // Sem o cookie, e com o cabecalho certo, a mutacao TEM de funcionar.
    expect((await request('/smtp', {
      method: 'POST', body: '{"secret_ref":"DZ23_APP_SMTP"}',
      headers: { cookie: `${SESSION_COOKIE}=session`, 'x-dz23-csrf': 'csrf' },
    })).status).not.toBe(401)
    // E sem o cabecalho continua recusando: o conserto nao pode ter sido
    // simplesmente desligar a conferencia.
    expect((await request('/smtp', {
      method: 'POST', body: '{"secret_ref":"DZ23_APP_SMTP"}',
      headers: { cookie: `${SESSION_COOKIE}=session`, 'x-dz23-csrf': '' },
    })).status).toBe(401)
    expect((await request('/nope')).status).toBe(404)
    expect((await request('/smtp', { method: 'POST', body: 'not json' })).status).toBe(400)
    expect((await request('/smtp', { method: 'POST', body: '{}', headers: { 'content-type': 'text/plain' } })).status).toBe(400)
    expect((await request('/smtp', { method: 'POST', body: JSON.stringify({ secret_ref: 'A'.repeat(70_000) }) })).status).toBe(400)
    expect((await request('/smtp', { method: 'PUT', body: '{}' })).status).toBe(404)
    expect(host).toContain('127.0.0.1')
  })

  it('maps every owned failure class without exposing foreign messages', async () => {
    expect((await getWithInjectedFailure(new IdentityError('locked', 'bloqueada'), 'identity')).status).toBe(429)
    expect((await getWithInjectedFailure(new IdentityError('expired', 'expirada'), 'identity')).status).toBe(401)
    for (const [error, expected] of [
      [new TenancyError('not-found', 'ausente'), 404],
      [new TenancyError('forbidden', 'negada'), 403],
      [new TenancyError('invalid', 'inválida'), 400],
      [new HubError('NOT_FOUND', 'ausente'), 404],
      [new HubError('FORBIDDEN', 'negada'), 403],
      [new HubError('CONFLICT', 'conflito'), 409],
      [new HubError('SECRET_DETECTED', 'segredo'), 409],
      [new HubError('TOO_LARGE', 'grande'), 413],
      [new HubError('RATE_LIMITED', 'limite'), 429],
      [new HubError('TIMEOUT', 'tempo'), 504],
      [new HubError('NOT_EXECUTED', 'não executado'), 200],
      [new HubError('INVALID', 'inválido'), 400],
      [new ExportError('RUN_MISSING', 'interno'), 409],
      [new ExportError('TOO_LARGE', 'interno'), 413],
      [new ExportError('SECRET_DETECTED', 'interno'), 409],
      [new ExportError('INVALID_PATH', '/segredo/do/host'), 500],
      [Object.assign(new Error('/segredo/do/projeto'), { code: 'NOT_FOUND' }), 404],
      [Object.assign(new Error('/segredo/proibido'), { code: 'FORBIDDEN' }), 403],
      [new Error('/segredo/interno'), 500],
    ] as const) {
      const response = await getWithInjectedFailure(error)
      expect(response.status).toBe(expected)
      const body = await response.json() as { error: string }
      if (!(error instanceof HubError || error instanceof IdentityError || error instanceof TenancyError)) expect(body.error).not.toContain('/segredo')
    }
    expect(safeFileName('///')).toBe('prototipo.zip')
    expect(safeFileName('meu protótipo.zip')).toBe('meu_prot_tipo.zip')
  })

  it('walks the registry, SMTP and export flows through real HTTP', async () => {
    const { request, repository } = await fixture('admin')
    const registered = await request('/integrations', { method: 'POST', body: JSON.stringify(manifest()) })
    expect(registered.status).toBe(201)
    const { integration } = await registered.json() as { integration: StudioIntegration }
    expect(integration).toMatchObject({ verification: 'verified', effective_tier: 'T0', enabled: false })
    const enabled = await request(`/integrations/${integration.integration_id}/enabled`, { method: 'POST', body: '{"enabled":true}' })
    // T0: no confirmation needed, and the interface is told so by the server.
    expect(await enabled.json()).toMatchObject({ integration: { enabled: true, requires_approval_tier: null } })
    expect((await (await request('/integrations')).json() as { integrations: unknown[] }).integrations).toHaveLength(1)

    // X-04 pelo HTTP de verdade: testar e remover.
    const tested = await request(`/integrations/${integration.integration_id}/test`, { method: 'POST', body: '{}' })
    expect(tested.status).toBe(200)
    // Uma habilidade nao tem com quem conectar, e a resposta diz isso.
    expect(await tested.json()).toMatchObject({ result: 'NOT_APPLICABLE' })
    // Remover algo LIGADO e 409, e nada e apagado.
    const refused = await request(`/integrations/${integration.integration_id}`, { method: 'DELETE' })
    expect(refused.status).toBe(409)
    expect((await (await request('/integrations')).json() as { integrations: unknown[] }).integrations).toHaveLength(1)
    await request(`/integrations/${integration.integration_id}/enabled`, { method: 'POST', body: '{"enabled":false}' })
    // Sem corpo: um DELETE de integracao T0 nao precisa de cerimonia.
    const deleted = await request(`/integrations/${integration.integration_id}`, { method: 'DELETE' })
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toMatchObject({ removed: { integration_id: integration.integration_id } })
    expect((await (await request('/integrations')).json() as { integrations: unknown[] }).integrations).toHaveLength(0)
    // E os eventos continuam la depois de remover.
    expect(repository.eventRows.some(row => row.action === 'integration.removed')).toBe(true)
    // Registrar de novo, para o resto do teste seguir com uma integracao viva.
    const reregistered = await request('/integrations', { method: 'POST', body: JSON.stringify(manifest()) })
    expect(reregistered.status).toBe(201)

    expect(await (await request('/smtp')).json()).toEqual({ configured: false, secret_ref: null, tier: 'T2' })
    expect((await request('/smtp', { method: 'POST', body: '{"secret_ref":"smtp://user:pass@host","approval":{"approval_id":"x"}}' })).status).toBe(400)
    // T2 over HTTP: without an approval the request is refused with 403, and the vault is never touched.
    const unconfirmed = await request('/smtp', { method: 'POST', body: '{"secret_ref":"DZ23_APP_SMTP"}' })
    expect(unconfirmed.status).toBe(403)
    // An id the client invented is worth nothing: the server only honours what it issued itself.
    expect((await request('/smtp', { method: 'POST', body: '{"secret_ref":"DZ23_APP_SMTP","approval":{"approval_id":"inventado"}}' })).status).toBe(403)
    const issue = async (action: string, subject: string, payload: string) => {
      const ticket = await (await request('/approvals', { method: 'POST', body: JSON.stringify({ action, subject_id: subject, payload }) })).json() as { approval_id: string; tier: string; fingerprint?: string }
      expect(ticket.tier).toBe('T2')
      // The digest of what the person is confirming stays on the server: the client gets an id, not a hash of the alias.
      expect(ticket.fingerprint).toBeUndefined()
      return `"approval":{"approval_id":${JSON.stringify(ticket.approval_id)}}`
    }
    const configured = await request('/smtp', { method: 'POST', body: `{"secret_ref":"DZ23_APP_SMTP",${await issue('smtp.configured', 'smtp', 'DZ23_APP_SMTP')}}` })
    expect(await configured.json()).toEqual({ configured: true, secret_ref: 'DZ23_APP_SMTP', tier: 'T2' })
    const test = await request('/smtp/test', { method: 'POST', body: `{"to":"pessoa@example.test",${await issue('smtp.tested', 'smtp', 'pessoa@example.test')}}` })
    expect(test.status).toBe(200)
    expect(await test.json()).toMatchObject({ result: 'NOT_EXECUTED' })

    const created = await request('/projects/p1/exports', { method: 'POST', body: '{}' })
    expect(created.status).toBe(201)
    const { export: record } = await created.json() as { export: Record<string, unknown> }
    expect(record).toMatchObject({ project_id: 'p1', run_id: 'run-1', entries: 3 })
    expect(record).not.toHaveProperty('path')
    const listed = await (await request('/projects/p1/exports')).json() as { exports: Array<{ export_id: string; sha256: string }> }
    expect(listed.exports).toHaveLength(1)
    const download = await request(`/projects/p1/exports/${listed.exports[0]!.export_id}/download`)
    expect(download.status).toBe(200)
    expect(download.headers.get('content-type')).toBe('application/zip')
    expect(download.headers.get('content-disposition')).toContain('agenda-run-1.zip')
    expect(download.headers.get('x-dz23-sha256')).toBe(listed.exports[0]!.sha256)
    const archive = Buffer.from(await download.arrayBuffer())
    expect(readZip(archive).map(entry => entry.name)).toEqual(['.env.example', 'README.md', 'app/server.js'])
    expect((await request('/projects/p1/exports/missing/download')).status).toBe(404)
    expect((await request('/projects/other/exports')).status).toBe(404)
    const events = await (await request('/events')).json() as { events: unknown[] }
    expect(events.events.length).toBeGreaterThanOrEqual(5)
    expect(repository.eventRows.every(event => event.org_id === 'org-a' && event.tenant_id === 'ws-a')).toBe(true)
  })

  it('never leaks server paths or library messages: missing file → 404 in words, bad percent-encoding → 400, bad body → 400 in words', async () => {
    const { request, repository } = await fixture('admin')
    const created = await request('/projects/p1/exports', { method: 'POST', body: '{}' })
    const { export: record } = await created.json() as { export: { export_id: string } }
    const stored = repository.exportRows.find(row => row.export_id === record.export_id)!
    await rm(stored.path, { force: true })
    const gone = await request(`/projects/p1/exports/${record.export_id}/download`)
    expect(gone.status).toBe(404)
    const goneBody = await gone.json() as { error: string }
    expect(goneBody.error).not.toContain('/')
    expect(goneBody.error).not.toMatch(/ENOENT/u)
    const malformed = await request('/integrations/%E0%A4%A/enabled', { method: 'POST', body: '{"enabled":true}' })
    expect(malformed.status).toBe(400)
    expect(((await malformed.json()) as { error: string }).error).not.toMatch(/URI/u)
    const badBody = await request('/smtp', { method: 'POST', body: '{"secret_ref":123}' })
    expect(badBody.status).toBe(400)
    expect(((await badBody.json()) as { error: string }).error).not.toMatch(/expected|received|string/iu)
    const list = await (await request('/integrations')).json() as { channel: string; integrations: unknown[] }
    expect(list.channel).toBe('stable')
  })

  it('gives the refused package its own status: secret found → 409, over the budget → 413', async () => {
    // The documents promise these two numbers to the person reading the panel. Before this, both
    // left as 400 "pedido inválido", which reads as "you typed something wrong" for a refusal that
    // is the Studio protecting them.
    const { request, repository, standalone } = await fixture('admin')
    await writeFile(join(standalone, 'chave.ts'), '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n')
    const secret = await request('/projects/p1/exports', { method: 'POST', body: '{}' })
    expect(secret.status).toBe(409)
    const secretBody = await secret.json() as { error: string }
    expect(secretBody.error).toContain('chave.ts')
    expect(secretBody.error).not.toContain('BEGIN PRIVATE KEY')
    await rm(join(standalone, 'chave.ts'))
    // A sparse file: the size is what the budget looks at, and the budget is checked before the read.
    const handle = await open(join(standalone, 'grande.js'), 'w')
    try { await handle.truncate(EXPORT_LIMIT_BYTES + 1) } finally { await handle.close() }
    const big = await request('/projects/p1/exports', { method: 'POST', body: '{}' })
    expect(big.status).toBe(413)
    expect(((await big.json()) as { error: string }).error).toContain('200')
    // Neither refusal wrote a package.
    expect(repository.exportRows).toHaveLength(0)
  }, 30_000)

  it('pages the history instead of handing over the whole table, and refuses a flood of packages with 429', async () => {
    const { request } = await fixture('admin')
    for (let index = 0; index < 4; index += 1) {
      await request('/integrations', { method: 'POST', body: JSON.stringify(manifest()) })
    }
    const page = await (await request('/events?limit=2')).json() as { events: Array<{ event_id: string }>; next_cursor: string | null }
    expect(page.events).toHaveLength(2)
    expect(page.next_cursor).not.toBeNull()
    const next = await (await request(`/events?limit=2&cursor=${encodeURIComponent(page.next_cursor!)}`)).json() as { events: Array<{ event_id: string }>; next_cursor: string | null }
    expect(next.events).toHaveLength(2)
    expect(next.events.map(event => event.event_id)).not.toEqual(page.events.map(event => event.event_id))
    // A cursor the client invented is a bad request, not a stack trace.
    expect((await request('/events?cursor=nao-e-cursor')).status).toBe(400)
    expect((await request('/events?limit=0')).status).toBe(400)
    expect((await request('/events?limit=9999')).status).toBe(400)
    // Packaging is the expensive call here; a workspace asking for it without end gets 429 in words.
    let last = 201
    for (let index = 0; index < 20 && last !== 429; index += 1) {
      last = (await request('/projects/p1/exports', { method: 'POST', body: '{}' })).status
    }
    expect(last).toBe(429)
  }, 30_000)

  /**
   * `stream.pipe(response)` does NOT destroy its source when the destination dies: closing the tab
   * in the middle of a download left the read stream — and the descriptor under it — alive until
   * the garbage collector happened to run. The existing download tests never saw it because a 22 KB
   * package fits in one write and the stream reaches EOF before anybody can abort. This one builds
   * a package that needs many writes, aborts the client on the first byte, and counts descriptors.
   */
  it.skipIf(!existsSync('/proc/self/fd'))('does not leak a descriptor when the client aborts a download mid-stream', async () => {
    const { request, standalone, origin } = await fixture()
    // Hex: it does not compress away (so the package really is megabytes) and its alphabet cannot
    // spell any of the shapes the secret scan refuses.
    await writeFile(join(standalone, 'bundle.js'), randomBytes(6 * 1024 * 1024).toString('hex'))
    const created = await request('/projects/p1/exports', { method: 'POST', body: '{}' })
    expect(created.status).toBe(201)
    const { export: record } = await created.json() as { export: { export_id: string; size_bytes: number } }
    expect(record.size_bytes).toBeGreaterThan(1024 * 1024)
    const path = `/api/studio/hub/projects/p1/exports/${record.export_id}/download`
    const [hostname, port] = origin.slice('http://'.length).split(':')
    const abortMidDownload = async (): Promise<void> => new Promise<void>(resolve => {
      const client = httpRequest({ hostname, port: Number(port), path, headers: { host: `${hostname!}:${port!}`, cookie: `${SESSION_COOKIE}=session` } }, response => {
        response.once('data', () => { client.destroy(); setTimeout(resolve, 5) })
      })
      client.on('error', () => resolve())
      client.end()
    })
    const openDescriptors = async (): Promise<number> => (await readdir('/proc/self/fd')).length
    // One download first, so anything opened lazily on the first request is already open.
    await abortMidDownload()
    const before = await openDescriptors()
    for (let attempt = 0; attempt < 20; attempt += 1) await abortMidDownload()
    await new Promise(resolve => setTimeout(resolve, 250))
    // Twenty aborted downloads used to mean twenty descriptors that nothing ever closed.
    expect(await openDescriptors() - before).toBeLessThanOrEqual(2)
  }, 60_000)


  /**
   * The projects port belongs to ANOTHER plugin. What it throws is that plugin's error class, with
   * that plugin's sentence in it — `PromptToAppError('FORBIDDEN', ...)` in production, and any
   * message a future version of it decides to put there, a server path included. This boundary is
   * the only thing between that sentence and the network, and until now nobody had ever run the
   * `FORBIDDEN` arm of it.
   */
  it('answers a foreign plugin refusal with its own sentence and status, never the other plugin’s message', async () => {
    const leak = '/srv/dz23/runs/org-a/ws-a/run-1: papel insuficiente'
    const forbidden = await fixture('admin', { projectError: Object.assign(new Error(leak), { code: 'FORBIDDEN' }) })
    for (const path of ['/projects/p1/exports', '/projects/p1/exports/e1/download']) {
      const answer = await forbidden.request(path)
      expect(answer.status, path).toBe(403)
      const body = await answer.json() as { error: string }
      expect(body.error, path).toBe('Seu papel não permite esta ação.')
      expect(body.error, path).not.toContain('/srv')
    }
    // The same discipline for the code that IS mapped today, with a path in the message.
    const missing = await fixture('admin', { projectError: Object.assign(new Error(leak), { code: 'NOT_FOUND' }) })
    const gone = await missing.request('/projects/p1/exports')
    expect(gone.status).toBe(404)
    expect(((await gone.json()) as { error: string }).error).toBe('Projeto não encontrado.')
    // And a code this module does not know is a 500 with the fixed sentence — not the plugin's text.
    const unknown = await fixture('admin', { projectError: Object.assign(new Error(leak), { code: 'BOOM' }) })
    const failed = await unknown.request('/projects/p1/exports')
    expect(failed.status).toBe(500)
    const failedBody = await failed.json() as { error: string }
    expect(failedBody.error).not.toContain('/srv')
    expect(failedBody.error).toContain('Algo deu errado')
  })

  /**
   * `readJson` is what stands between the network and `JSON.parse`. Neither of its two refusals —
   * a body that is not JSON at all, and a body past the 64 KB ceiling — had ever been executed:
   * a ceiling nobody has ever reached is a claim, not a ceiling.
   */
  it('refuses a body that is not JSON and one past the 64 KB ceiling, without touching the service', async () => {
    const { request, repository } = await fixture('admin')
    const wrongType = await request('/smtp', { method: 'POST', body: '{"secret_ref":"DZ23_APP_SMTP"}', headers: { 'content-type': 'text/plain' } })
    expect(wrongType.status).toBe(400)
    expect(((await wrongType.json()) as { error: string }).error).toBe('Solicitação inválida.')
    // Syntactically valid JSON, and small enough that the whole body is already in flight when the
    // ceiling refuses it: what is refused is the SIZE, not the shape.
    const huge = `{"secret_ref":"${'A'.repeat(80 * 1024)}"}`
    const tooBig = await request('/smtp', { method: 'POST', body: huge })
    expect(tooBig.status).toBe(400)
    expect(((await tooBig.json()) as { error: string }).error).toBe('Solicitação inválida.')
    // Nothing was configured and nothing was written: the refusal happened before the service.
    expect(await (await request('/smtp')).json()).toMatchObject({ configured: false })
    expect(repository.rows).toHaveLength(0)
  })

  /**
   * `file_name` is a column, and a column is data. It reaches the wire inside a header line, so a
   * row somebody edited (or an older build wrote) must not be able to put a quote, a CRLF or an
   * empty token there. Neither the sanitiser's fallback nor its effect on the header had a test.
   */
  it('builds the download header from a sanitised name, whatever the stored row says', async () => {
    const { request, repository } = await fixture('admin')
    const created = await request('/projects/p1/exports', { method: 'POST', body: '{}' })
    const { export: record } = await created.json() as { export: { export_id: string } }
    const row = repository.exportRows.find(value => value.export_id === record.export_id)!
    repository.exportRows = [{ ...row, file_name: 'a"\r\nx-injetado: sim' }]
    const injected = await request(`/projects/p1/exports/${record.export_id}/download`)
    expect(injected.status).toBe(200)
    expect(injected.headers.get('x-injetado')).toBeNull()
    expect(injected.headers.get('content-disposition')).toBe('attachment; filename="a_x-injetado_sim"')
    await injected.arrayBuffer()
    // A name that sanitises away to nothing still has to be a name.
    repository.exportRows = [{ ...row, file_name: '☠☠☠' }]
    const empty = await request(`/projects/p1/exports/${record.export_id}/download`)
    expect(empty.headers.get('content-disposition')).toBe('attachment; filename="prototipo.zip"')
    await empty.arrayBuffer()
  }, 20_000)

  /**
   * The download opens the file the row names. `export.ts` learned in D16 that `open()` on a FIFO
   * in `O_RDONLY` waits for a writer that may never come; this open did not. A named pipe left at
   * the package's path therefore hung the request AND one of the four threads libuv has for the
   * whole process — four of them and every file operation in the Studio stops — while the
   * "not a regular file" refusal right below it could never fire. The test fails by TIMING OUT if
   * the flag is taken away again.
   */
  it('refuses a named pipe left where the package should be, instead of waiting for it forever', async () => {
    const { request, repository } = await fixture('admin')
    const created = await request('/projects/p1/exports', { method: 'POST', body: '{}' })
    const { export: record } = await created.json() as { export: { export_id: string } }
    const row = repository.exportRows.find(value => value.export_id === record.export_id)!
    await rm(row.path)
    execFileSync('mkfifo', [row.path])
    const answer = await request(`/projects/p1/exports/${record.export_id}/download`)
    expect(answer.status).toBe(404)
    expect(((await answer.json()) as { error: string }).error).toContain('não está mais neste computador')
    // And the refusal is in the history, in words, like every other one.
    expect(repository.eventRows.at(-1)).toMatchObject({ action: 'export.downloadRefused', outcome: 'failure', detail: 'not-a-regular-file' })
  }, 15_000)

  /**
   * The Studio stopping its wait for a packaging call is a GATEWAY timeout: nothing the client sent
   * was wrong, and answering 400 would tell the person to fix something they did not break. The
   * number it becomes on the wire is only half of it, though: the abandoned build keeps running, and
   * what it does after the answer has already left is what a person actually sees in the history.
   * So the build here is really let go, and the route is asked again afterwards.
   */
  it('answers 504 when the Studio stops waiting for a package, and the abandoned build adds nothing after it', async () => {
    const { request, repository } = await fixture('admin', { packagingTimeoutMs: 60 })
    let release: () => void = () => undefined
    packaging.hold = new Promise<void>(resolve => { release = resolve })
    const answer = await request('/projects/p1/exports', { method: 'POST', body: '{}' })
    expect(answer.status).toBe(504)
    expect(((await answer.json()) as { error: string }).error).toContain('parou de esperar')
    expect(repository.eventRows.at(-1)).toMatchObject({ action: 'export.created', outcome: 'failure', detail: 'packaging-timeout' })
    // A second click while that build is still running is told the same thing, not given a twin.
    expect((await request('/projects/p1/exports', { method: 'POST', body: '{}' })).status).toBe(504)

    // The abandoned build is now let go — and lands.
    packaging.hold = undefined
    release()
    await Promise.allSettled(packaging.calls.splice(0))
    await new Promise<void>(resolve => { setTimeout(resolve, 25) })
    // One click, one story: no export row, and no `success` line contradicting the 504.
    expect(repository.exportRows).toEqual([])
    expect(repository.eventRows.map(event => [event.action, event.outcome, event.detail])).toEqual([['export.created', 'failure', 'packaging-timeout']])

    // And the route still works once that build is really over: 201, exactly one package.
    let created = await request('/projects/p1/exports', { method: 'POST', body: '{}' })
    for (let tries = 0; tries < 200 && created.status !== 201; tries += 1) {
      await created.arrayBuffer()
      await new Promise<void>(resolve => { setTimeout(resolve, 10) })
      created = await request('/projects/p1/exports', { method: 'POST', body: '{}' })
    }
    expect(created.status).toBe(201)
    expect(repository.exportRows).toHaveLength(1)
    expect(repository.eventRows.filter(event => event.outcome === 'success')).toHaveLength(1)
  }, 20_000)


  /**
   * Identity and tenancy are other plugins too, and their refusals are the ones every request goes
   * through. Three of the four numbers this boundary owes them had never been produced: a locked
   * account is 429 and not 401 (a person told "wrong password" while the account is locked tries
   * again, which is what locked it), a workspace that does not exist is 404, and a session with no
   * membership at all is 403 in this plugin's own words.
   */
  it('gives identity and tenancy refusals their own status, and never their internals', async () => {
    const locked = await fixture('admin', { identityError: new IdentityError('locked', 'Conta bloqueada. Tente mais tarde.') })
    expect((await locked.request('/integrations')).status).toBe(429)
    const invalid = await fixture('admin', { identityError: new IdentityError('invalid', 'Sessão inválida.') })
    expect((await invalid.request('/integrations')).status).toBe(401)
    for (const [code, status] of [['not-found', 404], ['forbidden', 403], ['invalid', 400]] as const) {
      const tenancy = await fixture('admin', { tenancyError: new TenancyError(code, `tenancy: ${code}`) })
      expect((await tenancy.request('/integrations')).status, code).toBe(status)
    }
    // Authenticated, but not a member of this workspace: this plugin's own sentence, not a 500.
    const stranger = await fixture('admin', { noMembership: true })
    const answer = await stranger.request('/integrations')
    expect(answer.status).toBe(403)
    expect(((await answer.json()) as { error: string }).error).toBe('Você precisa fazer parte deste espaço de trabalho.')
  })

  it('answers a path outside its own prefix as a route it does not have', async () => {
    const { origin, host } = await fixture('admin')
    // The handler may be mounted with or without its prefix, so a path that does not carry it is
    // matched as the bare route — and a bare route it does not have is a 404 in words, never a
    // library error from the matching itself.
    const answer = await fetch(`${origin}/nao-existe-em-lugar-nenhum`, { headers: { host, origin, cookie: `${SESSION_COOKIE}=session` } })
    expect(answer.status).toBe(404)
    expect(((await answer.json()) as { error: string }).error).toBe('Rota não encontrada.')
  })

  it('maps role errors to 403 for viewers and builders', async () => {
    const viewer = await fixture('viewer')
    expect((await viewer.request('/integrations', { method: 'POST', body: JSON.stringify(manifest()) })).status).toBe(403)
    expect((await viewer.request('/projects/p1/exports', { method: 'POST', body: '{}' })).status).toBe(403)
    expect((await viewer.request('/events')).status).toBe(403)
    expect((await viewer.request('/integrations')).status).toBe(200)
    const builder = await fixture('builder')
    expect((await builder.request('/smtp', { method: 'POST', body: '{"secret_ref":"DZ23_APP_SMTP"}' })).status).toBe(403)
    expect((await builder.request('/projects/p1/exports', { method: 'POST', body: '{}' })).status).toBe(201)
  })
})
