import { generateKeyPairSync, sign } from 'node:crypto'
import { chmod, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CSRF_COOKIE, IdentityError, SESSION_COOKIE, type SessionRecord, type StudioIdentityService } from '@dz23-studio/identity'
import type { StudioTenancyService } from '@dz23-studio/tenancy'
import { EXPORT_LIMIT_BYTES } from '../src/export.ts'
import { createHubHttpHandler, HUB_ROUTE_CONTRACTS } from '../src/http.ts'
import { canonicalManifestBytes } from '../src/manifest.ts'
import type { HubEvent, IntegrationManifest, StudioExport, StudioIntegration } from '../src/model.ts'
import { IntegrationHubService, type HubRepository } from '../src/service.ts'
import { readZip } from '../src/zip.ts'

class MemoryRepository implements HubRepository {
  rows: StudioIntegration[] = []; exportRows: StudioExport[] = []; eventRows: HubEvent[] = []
  integrations = () => this.rows; exports = () => this.exportRows; events = () => this.eventRows
  putIntegration = async (value: StudioIntegration) => { this.rows = [...this.rows.filter(row => row.integration_id !== value.integration_id), value] }
  putExport = async (value: StudioExport) => { this.exportRows = [...this.exportRows, value] }
  putEvent = async (value: HubEvent) => { this.eventRows = [...this.eventRows, value] }
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

function manifest(): IntegrationManifest {
  const value = { schema_version: 1, id: 'agenda', name: 'Agenda', version: '1.0.0', kind: 'skill', publisher: { id: 'dz23', name: 'DZ23' }, permissions: [], tier: 'T0' } as IntegrationManifest
  return { ...value, signature: sign(null, canonicalManifestBytes(value), privateKey).toString('base64') }
}

async function fixture(role: 'owner' | 'admin' | 'builder' | 'viewer' = 'owner') {
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
      project: (actor, projectId) => { if (projectId !== 'p1' || actor.tenantId !== 'ws-a') throw Object.assign(new Error('nope'), { code: 'NOT_FOUND' }); return { project_id: 'p1', name: 'Agenda', state: 'VERIFIED_PROTOTYPE' } },
      runs: () => [{ run_id: 'run-1', state: 'PASSED', started_at: '2026-09-03T11:00:00.000Z', attempt: 1, run_directory: runDirectory }],
    },
    now: () => new Date('2026-09-04T00:00:00.000Z'), createId: () => `id-${++id}`,
  })
  const identity = { authenticate: vi.fn((token: string) => token === 'session' ? Promise.resolve(session) : Promise.reject(new IdentityError('invalid', 'Sessão inválida.'))), validateCsrf: vi.fn((_s: unknown, cookie?: string, header?: string) => { if (cookie !== 'csrf' || header !== 'csrf') throw new IdentityError('invalid', 'CSRF ausente.') }) }
  const tenancy = { authorizationFor: vi.fn((userId: string, orgId: string, tenantId: string) => ({ userId, orgId, tenantId, role })) }
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
    expect((await request('/nope')).status).toBe(404)
    expect((await request('/smtp', { method: 'POST', body: 'not json' })).status).toBe(400)
    expect(host).toContain('127.0.0.1')
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

    expect(await (await request('/smtp')).json()).toEqual({ configured: false, secret_ref: null, tier: 'T2' })
    expect((await request('/smtp', { method: 'POST', body: '{"secret_ref":"smtp://user:pass@host","approval":{"approval_id":"x"}}' })).status).toBe(400)
    // T2 over HTTP: without an approval the request is refused with 403, and the vault is never touched.
    const unconfirmed = await request('/smtp', { method: 'POST', body: '{"secret_ref":"DZ23_APP_SMTP"}' })
    expect(unconfirmed.status).toBe(403)
    // An id the client invented is worth nothing: the server only honours what it issued itself.
    expect((await request('/smtp', { method: 'POST', body: '{"secret_ref":"DZ23_APP_SMTP","approval":{"approval_id":"inventado"}}' })).status).toBe(403)
    const issue = async (action: string, subject: string) => {
      const ticket = await (await request('/approvals', { method: 'POST', body: JSON.stringify({ action, subject_id: subject }) })).json() as { approval_id: string; tier: string }
      expect(ticket.tier).toBe('T2')
      return `"approval":{"approval_id":${JSON.stringify(ticket.approval_id)}}`
    }
    const configured = await request('/smtp', { method: 'POST', body: `{"secret_ref":"DZ23_APP_SMTP",${await issue('smtp.configured', 'smtp')}}` })
    expect(await configured.json()).toEqual({ configured: true, secret_ref: 'DZ23_APP_SMTP', tier: 'T2' })
    const test = await request('/smtp/test', { method: 'POST', body: `{"to":"pessoa@example.test",${await issue('smtp.tested', 'smtp')}}` })
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
    const handle = await open(join(standalone, 'grande.wasm'), 'w')
    try { await handle.truncate(EXPORT_LIMIT_BYTES + 1) } finally { await handle.close() }
    const big = await request('/projects/p1/exports', { method: 'POST', body: '{}' })
    expect(big.status).toBe(413)
    expect(((await big.json()) as { error: string }).error).toContain('200')
    // Neither refusal wrote a package.
    expect(repository.exportRows).toHaveLength(0)
  }, 30_000)

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
