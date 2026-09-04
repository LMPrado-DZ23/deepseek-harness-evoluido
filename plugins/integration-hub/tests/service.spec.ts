import { generateKeyPairSync, sign } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalManifestBytes } from '../src/manifest.ts'
import type { HubEvent, IntegrationManifest, StudioExport, StudioIntegration } from '../src/model.ts'
import { canonicalSecretRef, HubError, IntegrationHubService, minimizeRecipient, safeSegment, strongIdentityFresh, type HubActor, type HubRepository } from '../src/service.ts'
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
/** The confirmation the person gives on screen, for exactly one tier. */
const ok = (tier: 'T2' | 'T3') => ({ approved: true, tier } as const)
const strongAdmin: HubActor = { ...admin, sessionId: 's-admin', strongIdentityVerified: true }
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publisherKeys = { dz23: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }
const scratch: string[] = []
afterEach(async () => { for (const directory of scratch.splice(0)) await rm(directory, { recursive: true, force: true }) })

function manifest(overrides: Partial<IntegrationManifest> = {}): IntegrationManifest {
  return { schema_version: 1, id: 'agenda', name: 'Agenda', version: '1.0.0', kind: 'skill', publisher: { id: 'dz23', name: 'DZ23' }, permissions: [], tier: 'T0', ...overrides } as IntegrationManifest
}
function signed(value: IntegrationManifest): IntegrationManifest { return { ...value, signature: sign(null, canonicalManifestBytes(value), privateKey).toString('base64') } }

async function build(options: { channel?: 'stable' | 'dev'; emailTest?: boolean; secrets?: Record<string, { present: boolean; shapeOk: boolean }>; runDirectory?: string; projectState?: string; runsRoot?: string } = {}) {
  const exportsRoot = await mkdtemp(join(tmpdir(), 'dz23-hub-exports-'))
  scratch.push(exportsRoot)
  const repository = new MemoryRepository()
  const sent: Array<[string, string]> = []
  let sequence = 0
  const service = new IntegrationHubService({
    repository, exportsRoot, publisherKeys, channel: options.channel ?? 'stable', runsRoot: options.runsRoot,
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
    // Unverified means T2: even on the dev channel it takes the person's confirmation.
    await expect(service.setEnabled(owner, unsigned.integration.integration_id, true)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await service.setEnabled(owner, unsigned.integration.integration_id, true, ok('T2'))).enabled).toBe(true)
    // Turning it off never needs a confirmation: less exposure is always allowed.
    expect((await service.setEnabled(owner, unsigned.integration.integration_id, false)).enabled).toBe(false)
  })

  it('never enables a manifest whose signature does not check out, on any channel', async () => {
    for (const channel of ['stable', 'dev'] as const) {
      const { service, repository } = await build({ channel })
      // Registration already refuses a tampered manifest; this covers a record that turned `invalid` later
      // (the publisher's key was replaced), which the dev channel must not wave through either.
      await expect(service.register(owner, { ...signed(manifest()), name: 'alterado' })).rejects.toThrow('assinatura')
      const registered = await service.register(owner, signed(manifest()))
      const row = { ...registered.integration, verification: 'invalid' as const }
      await repository.putIntegration(row)
      expect(service.canEnable(row)).toBe(false)
      await expect(service.setEnabled(owner, row.integration_id, true, ok('T2'))).rejects.toThrow('não confere')
      expect(repository.rows.find(value => value.integration_id === row.integration_id)!.enabled).toBe(false)
    }
  })

  it('asks for a confirmation at T2 and for a recent passkey at T3, and records the confirmation it accepted', async () => {
    const { service, repository } = await build()
    // `secrets.read` is T3 by the D16 floor, whatever the manifest declares.
    const sensitive = await service.register(admin, signed(manifest({ id: 'cofre', tier: 'T0', permissions: ['secrets.read'] })))
    expect(sensitive.integration.effective_tier).toBe('T3')
    expect(service.requiredApprovalTier(sensitive.integration)).toBe('T3')
    const id = sensitive.integration.integration_id
    // no confirmation at all
    await expect(service.setEnabled(admin, id, true)).rejects.toThrow('confirmação')
    // a confirmation for the WRONG tier is not a confirmation for this one
    await expect(service.setEnabled(admin, id, true, ok('T2'))).rejects.toThrow('confirmação')
    // right confirmation, but no recent passkey on this session
    await expect(service.setEnabled(admin, id, true, ok('T3'))).rejects.toThrow('passkey')
    const enabled = await service.setEnabled(strongAdmin, id, true, ok('T3'))
    expect(enabled.enabled).toBe(true)
    const actions = repository.eventRows.map(event => `${event.action}:${event.outcome}`)
    expect(actions).toContain('integration.enabled:failure')
    expect(actions).toContain('approval.recorded:success')
    expect(repository.eventRows.find(event => event.action === 'approval.recorded')).toMatchObject({ detail: 'integration.enabled T3' })
    // A T0 integration is enabled with no confirmation at all.
    const plain = await service.register(admin, signed(manifest({ id: 'agenda' })))
    expect(service.requiredApprovalTier(plain.integration)).toBeNull()
    expect((await service.setEnabled(admin, plain.integration.integration_id, true)).enabled).toBe(true)
  })

  it('accepts a passkey confirmation only inside its window, and fails closed on anything missing', async () => {
    const now = new Date('2026-09-04T00:05:00.000Z')
    expect(strongIdentityFresh({ last_strong_auth_method: 'passkey', last_strong_auth_at: '2026-09-04T00:01:00.000Z' }, now)).toBe(true)
    // Older than the window, another method, missing, unparseable, or dated in the future: all refused.
    expect(strongIdentityFresh({ last_strong_auth_method: 'passkey', last_strong_auth_at: '2026-09-03T23:58:00.000Z' }, now)).toBe(false)
    expect(strongIdentityFresh({ last_strong_auth_method: 'email-code', last_strong_auth_at: '2026-09-04T00:04:00.000Z' }, now)).toBe(false)
    expect(strongIdentityFresh({ last_strong_auth_method: 'passkey', last_strong_auth_at: null }, now)).toBe(false)
    expect(strongIdentityFresh({}, now)).toBe(false)
    expect(strongIdentityFresh({ last_strong_auth_method: 'passkey', last_strong_auth_at: 'ontem' }, now)).toBe(false)
    expect(strongIdentityFresh({ last_strong_auth_method: 'passkey', last_strong_auth_at: '2026-09-04T00:06:00.000Z' }, now)).toBe(false)
    expect(canonicalSecretRef('  secret://DZ23_APP_SMTP ')).toBe('DZ23_APP_SMTP')
    expect(canonicalSecretRef('SECRET://DZ23_APP_SMTP')).toBe('DZ23_APP_SMTP')
    expect(canonicalSecretRef('dz23_app_smtp')).toBe('dz23_app_smtp') // the case is never invented; the schema refuses it
    expect(minimizeRecipient('Pessoa@Example.Test')).toMatch(/^\*\*\*@Example\.Test sha256:[a-f0-9]{12}$/u)
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
    await expect(service.configureSmtp(admin, 'smtp://user:pass@host', ok('T2'))).rejects.toThrow('identificador')
    // Configuring the app's e-mail is T2: without the confirmation the vault is never even touched.
    await expect(service.configureSmtp(admin, 'DZ23_APP_SMTP')).rejects.toThrow('confirmação')
    await expect(service.configureSmtp(admin, 'DZ23_MISSING', ok('T2'))).rejects.toThrow('não existe no cofre')
    await expect(service.configureSmtp(admin, 'DZ23_BROKEN', ok('T2'))).rejects.toThrow('formato esperado')
    // `secret://NAME` and `NAME` are the same name; the case is never invented.
    const record = await service.configureSmtp(admin, '  secret://DZ23_APP_SMTP  ', ok('T2'))
    expect(record).toMatchObject({ kind: 'smtp', secret_ref: 'DZ23_APP_SMTP', enabled: true, effective_tier: 'T2' })
    expect(JSON.stringify(repository.rows)).not.toContain('pass')
    expect(service.smtp(viewer)).toEqual({ configured: true, secret_ref: 'DZ23_APP_SMTP', tier: 'T2' })
    const test = await service.testSmtp(admin, 'pessoa@example.test', ok('T2'))
    expect(test.result).toBe('NOT_EXECUTED')
    expect(repository.eventRows.at(-1)).toMatchObject({ action: 'smtp.tested', outcome: 'not-executed' })
    const second = await service.configureSmtp(admin, 'DZ23_APP_SMTP', ok('T2'))
    expect(second.integration_id).toBe(record.integration_id)
  })

  it('sends the SMTP test only when the operator enabled it, and records failures', async () => {
    const { service, sent, repository } = await build({ emailTest: true, secrets: { DZ23_APP_SMTP: { present: true, shapeOk: true } } })
    await expect(service.testSmtp(admin, 'pessoa@example.test', ok('T2'))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await service.configureSmtp(admin, 'DZ23_APP_SMTP', ok('T2'))
    await expect(service.testSmtp(admin, 'not-an-email', ok('T2'))).rejects.toMatchObject({ code: 'INVALID' })
    await expect(service.testSmtp(admin, 'pessoa@example.test')).rejects.toThrow('confirmação')
    expect(await service.testSmtp(admin, 'pessoa@example.test', ok('T2'))).toMatchObject({ result: 'SENT' })
    expect(sent).toEqual([['DZ23_APP_SMTP', 'pessoa@example.test']])
    // The audit proves the test happened without keeping the address in the clear.
    expect(repository.eventRows.at(-1)).toMatchObject({ action: 'smtp.tested', outcome: 'success' })
    expect(repository.eventRows.at(-1)!.detail).toMatch(/^\*\*\*@example\.test sha256:[a-f0-9]{12}$/u)
    expect(JSON.stringify(repository.eventRows)).not.toContain('pessoa@example.test')
    // Disabling the SMTP record makes it "not configured" again; the record itself stays for the audit trail.
    const smtpRecord = repository.rows.find(row => row.kind === 'smtp')!
    await service.setEnabled(admin, smtpRecord.integration_id, false)
    expect(service.smtp(viewer)).toMatchObject({ configured: false, secret_ref: null })
    await expect(service.testSmtp(admin, 'pessoa@example.test', ok('T2'))).rejects.toMatchObject({ code: 'NOT_FOUND' })
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

  it('refuses a run directory that is not inside the runs root, following symlinks, before reading anything', async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), 'dz23-hub-runs-'))
    scratch.push(runsRoot)
    // A well-behaved run: directly under the runs root.
    const inside = join(runsRoot, 'run-new')
    await mkdir(join(inside, '.next', 'standalone'), { recursive: true })
    await writeFile(join(inside, '.next', 'standalone', 'server.js'), 'ok')
    const good = await build({ runDirectory: inside, runsRoot })
    expect(await good.service.createExport(builder, 'p1')).toMatchObject({ run_id: 'run-new' })

    // Somewhere else on disk entirely.
    const outsideRun = await fakeRun()
    const outside = await build({ runDirectory: outsideRun, runsRoot })
    await expect(outside.service.createExport(builder, 'p1')).rejects.toMatchObject({ code: 'INVALID', message: expect.stringContaining('pasta de execuções') })

    // A symlink planted inside the runs root that points out of it: the real path is what counts.
    const link = join(runsRoot, 'run-link')
    await symlink(outsideRun, link)
    const linked = await build({ runDirectory: link, runsRoot })
    await expect(linked.service.createExport(builder, 'p1')).rejects.toMatchObject({ code: 'INVALID' })
    // `..` climbing out is refused as well, and nothing was packaged in either case.
    const climbing = await build({ runDirectory: join(runsRoot, '..', 'etc'), runsRoot })
    await expect(climbing.service.createExport(builder, 'p1')).rejects.toMatchObject({ code: expect.stringMatching(/INVALID|CONFLICT/u) })
    for (const built of [outside, linked, climbing]) {
      expect(built.repository.exportRows).toEqual([])
      expect(built.repository.eventRows.at(-1)).toMatchObject({ action: 'export.created', outcome: 'failure' })
    }
  })

  it('refuses an id or scope name that would escape the exports folder', async () => {
    const { service } = await build({ runDirectory: await fakeRun() })
    const sneaky: HubActor = { ...builder, tenantId: '../../etc' }
    // The tenant is scoped out first (no membership in `../../etc`), and a name like this never reaches `resolve`.
    await expect(service.createExport(sneaky, 'p1')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(() => safeSegment('../../etc')).toThrow(HubError)
    expect(() => safeSegment('a/b')).toThrow(HubError)
    expect(() => safeSegment('id-1')).not.toThrow()
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
