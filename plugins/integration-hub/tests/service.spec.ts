import { generateKeyPairSync, sign } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalManifestBytes } from '../src/manifest.ts'
import type { HubEvent, IntegrationManifest, StudioExport, StudioIntegration } from '../src/model.ts'
import { HubError, IntegrationHubService, type HubActor, type HubRepository } from '../src/service.ts'
import { readZip } from '../src/zip.ts'

class MemoryRepository implements HubRepository {
  rows: StudioIntegration[] = []; exportRows: StudioExport[] = []; eventRows: HubEvent[] = []
  integrations = () => this.rows; exports = () => this.exportRows; events = () => this.eventRows
  putIntegration = async (value: StudioIntegration) => { this.rows = [...this.rows.filter(row => row.integration_id !== value.integration_id), value] }
  putExport = async (value: StudioExport) => { this.exportRows = [...this.exportRows, value] }
  putEvent = async (value: HubEvent) => { this.eventRows = [...this.eventRows, value] }
}

const owner: HubActor = { userId: 'u-owner', orgId: 'org-a', tenantId: 'ws-a', role: 'owner' }
const admin: HubActor = { ...owner, userId: 'u-admin', role: 'admin' }
const builder: HubActor = { ...owner, userId: 'u-builder', role: 'builder' }
const viewer: HubActor = { ...owner, userId: 'u-viewer', role: 'viewer' }
const otherTenant: HubActor = { ...owner, tenantId: 'ws-b' }
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publisherKeys = { dz23: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }
const scratch: string[] = []
afterEach(async () => { for (const directory of scratch.splice(0)) await rm(directory, { recursive: true, force: true }) })

function manifest(overrides: Partial<IntegrationManifest> = {}): IntegrationManifest {
  return { schema_version: 1, id: 'agenda', name: 'Agenda', version: '1.0.0', kind: 'skill', publisher: { id: 'dz23', name: 'DZ23' }, permissions: [], tier: 'T0', ...overrides } as IntegrationManifest
}
function signed(value: IntegrationManifest): IntegrationManifest { return { ...value, signature: sign(null, canonicalManifestBytes(value), privateKey).toString('base64') } }

async function build(options: { channel?: 'stable' | 'dev'; emailTest?: boolean; secrets?: Record<string, { present: boolean; shapeOk: boolean }>; runDirectory?: string; projectState?: string } = {}) {
  const exportsRoot = await mkdtemp(join(tmpdir(), 'dz23-hub-exports-'))
  scratch.push(exportsRoot)
  const repository = new MemoryRepository()
  const sent: Array<[string, string]> = []
  let sequence = 0
  const service = new IntegrationHubService({
    repository, exportsRoot, publisherKeys, channel: options.channel ?? 'stable',
    secrets: { inspect: async ref => options.secrets?.[ref] ?? { present: false, shapeOk: false } },
    projects: {
      project: (actor, projectId) => {
        if (projectId !== 'p1' || actor.tenantId !== 'ws-a') throw Object.assign(new Error('nope'), { code: 'NOT_FOUND' })
        return { project_id: 'p1', name: 'Agenda do Salão', state: options.projectState ?? 'VERIFIED_PROTOTYPE' }
      },
      runs: () => options.runDirectory === undefined ? [] : [
        { run_id: 'run-old', state: 'FAILED', started_at: '2026-09-03T10:00:00.000Z', attempt: 1, run_directory: '/nowhere' },
        { run_id: 'run-new', state: 'PASSED', started_at: '2026-09-03T11:00:00.000Z', attempt: 1, run_directory: options.runDirectory },
      ],
    },
    emailTest: options.emailTest === true ? { sendTest: async (ref, to) => { sent.push([ref, to]) } } : undefined,
    now: () => new Date('2026-09-04T00:00:00.000Z'), createId: () => `id-${++sequence}`,
  })
  return { service, repository, sent, exportsRoot }
}

async function fakeRun(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dz23-hub-run-'))
  scratch.push(root)
  await mkdir(join(root, '.next', 'standalone'), { recursive: true })
  await writeFile(join(root, '.next', 'standalone', 'server.js'), 'ok')
  await chmod(join(root, '.next', 'standalone', 'server.js'), 0o755)
  return root
}

describe('integration hub service', () => {
  it('registers signed manifests, keeps unsigned ones disabled on the stable channel and audits everything', async () => {
    const { service, repository } = await build()
    const registered = await service.register(admin, signed(manifest()))
    expect(registered.integration).toMatchObject({ kind: 'skill', effective_tier: 'T0', verification: 'verified', enabled: false, org_id: 'org-a', tenant_id: 'ws-a' })
    const enabled = await service.setEnabled(admin, registered.integration.integration_id, true)
    expect(enabled.enabled).toBe(true)
    const unsigned = await service.register(admin, manifest({ id: 'outra', tier: undefined }))
    expect(unsigned.integration).toMatchObject({ verification: 'unverified', effective_tier: 'T2' })
    await expect(service.setEnabled(admin, unsigned.integration.integration_id, true)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(service.register(admin, { ...signed(manifest()), name: 'alterado' })).rejects.toThrow('assinatura')
    await expect(service.register(admin, { nope: true })).rejects.toThrow('formato esperado')
    await expect(service.register(admin, signed(manifest({ kind: 'smtp', id: 'fake-smtp' })))).rejects.toThrow('seção própria')
    // Refusals are audited too: tampering, malformed input and the reserved kind all leave a failure event.
    expect(repository.eventRows.map(event => `${event.action}:${event.outcome}`)).toEqual([
      'integration.registered:success', 'integration.enabled:success', 'integration.registered:success', 'integration.enabled:failure',
      'integration.registered:failure', 'integration.registered:failure', 'integration.registered:failure',
    ])
    expect(service.canEnable(registered.integration)).toBe(true)
    expect(service.canEnable(unsigned.integration)).toBe(false)
    expect(service.canEnable(enabled)).toBe(false)
    // re-registering the same id updates in place
    const again = await service.register(admin, signed(manifest({ version: '1.1.0' })))
    expect(again.integration.integration_id).toBe(registered.integration.integration_id)
    expect(service.list(viewer)).toHaveLength(2)
    expect(service.list(otherTenant)).toEqual([])
  })

  it('allows unsigned integrations only on the dev channel', async () => {
    const { service } = await build({ channel: 'dev' })
    const unsigned = await service.register(owner, manifest({ tier: undefined }))
    expect(service.canEnable(unsigned.integration)).toBe(true)
    expect((await service.setEnabled(owner, unsigned.integration.integration_id, true)).enabled).toBe(true)
    expect((await service.setEnabled(owner, unsigned.integration.integration_id, false)).enabled).toBe(false)
  })

  it('enforces roles and tenant scope', async () => {
    const { service } = await build()
    await expect(service.register(builder, signed(manifest()))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(service.configureSmtp(viewer, 'DZ23_APP_SMTP')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(() => service.events(builder)).toThrow(HubError)
    const registered = await service.register(owner, signed(manifest()))
    await expect(service.setEnabled(otherTenant, registered.integration.integration_id, true)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(service.createExport(viewer, 'p1')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(service.events(owner)).toHaveLength(1)
  })

  it('stores only the SMTP credential reference after checking presence and shape, and reports the test as NOT_EXECUTED until enabled', async () => {
    const { service, repository } = await build({ secrets: { DZ23_APP_SMTP: { present: true, shapeOk: true }, DZ23_BROKEN: { present: true, shapeOk: false } } })
    expect(service.smtp(viewer)).toEqual({ configured: false, secret_ref: null, tier: 'T2' })
    await expect(service.configureSmtp(admin, 'smtp://user:pass@host')).rejects.toThrow('identificador')
    await expect(service.configureSmtp(admin, 'DZ23_MISSING')).rejects.toThrow('não existe no cofre')
    await expect(service.configureSmtp(admin, 'DZ23_BROKEN')).rejects.toThrow('formato esperado')
    const record = await service.configureSmtp(admin, 'DZ23_APP_SMTP')
    expect(record).toMatchObject({ kind: 'smtp', secret_ref: 'DZ23_APP_SMTP', enabled: true, effective_tier: 'T2' })
    expect(JSON.stringify(repository.rows)).not.toContain('pass')
    expect(service.smtp(viewer)).toEqual({ configured: true, secret_ref: 'DZ23_APP_SMTP', tier: 'T2' })
    const test = await service.testSmtp(admin, 'pessoa@example.test')
    expect(test.result).toBe('NOT_EXECUTED')
    expect(repository.eventRows.at(-1)).toMatchObject({ action: 'smtp.tested', outcome: 'not-executed' })
    const second = await service.configureSmtp(admin, 'DZ23_APP_SMTP')
    expect(second.integration_id).toBe(record.integration_id)
  })

  it('sends the SMTP test only when the operator enabled it, and records failures', async () => {
    const { service, sent, repository } = await build({ emailTest: true, secrets: { DZ23_APP_SMTP: { present: true, shapeOk: true } } })
    await expect(service.testSmtp(admin, 'pessoa@example.test')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await service.configureSmtp(admin, 'DZ23_APP_SMTP')
    await expect(service.testSmtp(admin, 'not-an-email')).rejects.toMatchObject({ code: 'INVALID' })
    expect(await service.testSmtp(admin, 'pessoa@example.test')).toMatchObject({ result: 'SENT' })
    expect(sent).toEqual([['DZ23_APP_SMTP', 'pessoa@example.test']])
    expect(repository.eventRows.at(-1)).toMatchObject({ action: 'smtp.tested', outcome: 'success' })
    // Disabling the SMTP record makes it "not configured" again; the record itself stays for the audit trail.
    const smtpRecord = repository.rows.find(row => row.kind === 'smtp')!
    await service.setEnabled(admin, smtpRecord.integration_id, false)
    expect(service.smtp(viewer)).toMatchObject({ configured: false, secret_ref: null })
    await expect(service.testSmtp(admin, 'pessoa@example.test')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('exports only a verified project from its latest PASSED run, with private files and a digest', async () => {
    const runDirectory = await fakeRun()
    const { service, exportsRoot, repository } = await build({ runDirectory })
    const record = await service.createExport(builder, 'p1')
    expect(record).toMatchObject({ project_id: 'p1', run_id: 'run-new', file_name: 'agenda-do-salao-run-new.zip', entries: 3, org_id: 'org-a', tenant_id: 'ws-a' })
    expect(record.path.startsWith(join(exportsRoot, 'org-a', 'ws-a'))).toBe(true)
    expect((await stat(record.path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(exportsRoot, 'org-a', 'ws-a'))).mode & 0o777).toBe(0o700)
    const archive = await readFile(record.path)
    expect(readZip(archive).map(entry => entry.name)).toEqual(['.env.example', 'README.md', 'app/server.js'])
    expect(service.listExports(viewer, 'p1')).toEqual([record])
    expect(service.exportRecord(viewer, 'p1', record.export_id)).toEqual(record)
    expect(() => service.exportRecord(viewer, 'p1', 'missing')).toThrow(HubError)
    expect(() => service.listExports(otherTenant, 'p1')).toThrow()
    expect(repository.eventRows.at(-1)).toMatchObject({ action: 'export.created', outcome: 'success', subject_id: record.export_id })
    // Same run, same bytes → the same package; no twin file per click.
    const again = await service.createExport(builder, 'p1')
    expect(again).toEqual(record)
    expect(service.listExports(viewer, 'p1')).toHaveLength(1)
  })

  it('refuses to export an unverified project or a project whose run files are gone', async () => {
    const draft = await build({ projectState: 'PLAN_APPROVED', runDirectory: await fakeRun() })
    await expect(draft.service.createExport(owner, 'p1')).rejects.toThrow('protótipo verificado')
    const noRun = await build()
    await expect(noRun.service.createExport(owner, 'p1')).rejects.toThrow('protótipo verificado')
    const gone = await build({ runDirectory: '/definitely/not/here' })
    await expect(gone.service.createExport(owner, 'p1')).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('não estão mais neste computador') })
    for (const built of [draft, noRun, gone]) expect(built.repository.eventRows.at(-1)).toMatchObject({ action: 'export.created', outcome: 'failure' })
  })
})
