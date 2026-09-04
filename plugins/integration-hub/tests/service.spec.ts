import { generateKeyPairSync, sign } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalManifestBytes } from '../src/manifest.ts'
import type { HubEvent, IntegrationManifest, StudioExport, StudioIntegration } from '../src/model.ts'
import { canonicalSecretRef, EVENTS_RETAINED_PER_TENANT, HubError, IntegrationHubService, MAX_EXPORTS_PER_WINDOW, MAX_LIVE_APPROVALS, minimizeRecipient, minimizeSecretRef, safeSegment, securityFingerprint, strongIdentityFresh, type HubActor, type HubRepository } from '../src/service.ts'
import { readZip } from '../src/zip.ts'

class MemoryRepository implements HubRepository {
  rows: StudioIntegration[] = []; exportRows: StudioExport[] = []; eventRows: HubEvent[] = []
  integrations = () => this.rows; exports = () => this.exportRows; events = () => this.eventRows
  putIntegration = async (value: StudioIntegration) => { this.rows = [...this.rows.filter(row => row.integration_id !== value.integration_id), value] }
  putExport = async (value: StudioExport) => { this.exportRows = [...this.exportRows, value] }
  putEvent = async (value: HubEvent) => { this.eventRows = [...this.eventRows, value] }
  deleteEvent = async (eventId: string) => { this.eventRows = this.eventRows.filter(row => row.event_id !== eventId) }
}

const owner: HubActor = { userId: 'u-owner', orgId: 'org-a', tenantId: 'ws-a', role: 'owner' }
const admin: HubActor = { ...owner, userId: 'u-admin', role: 'admin' }
const builder: HubActor = { ...owner, userId: 'u-builder', role: 'builder' }
const viewer: HubActor = { ...owner, userId: 'u-viewer', role: 'viewer' }
const otherTenant: HubActor = { ...owner, tenantId: 'ws-b' }
/**
 * The confirmation as it really travels: the server issues a ticket for one
 * action and one subject, and the client presents its id. `ok(...)` asks for it
 * the way the panel does.
 */
const ok = async (service: IntegrationHubService, actor: HubActor, action: 'integration.enabled' | 'smtp.configured' | 'smtp.tested', subjectId: string, payload?: string) =>
  ({ approvalId: (await service.requestApproval(actor, action, subjectId, payload)).approval_id })
const SMTP = 'smtp'
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
    repository, exportsRoot, publisherKeys, channel: options.channel ?? 'stable',
    // The boundary is always on; a test that wants a run outside it says so with its own root.
    runsRoot: options.runsRoot ?? (options.runDirectory === undefined ? exportsRoot : dirname(options.runDirectory)),
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
    expect((await service.setEnabled(owner, unsigned.integration.integration_id, true, await ok(service, owner, 'integration.enabled', unsigned.integration.integration_id))).enabled).toBe(true)
    // Turning it off never needs a confirmation: less exposure is always allowed.
    expect((await service.setEnabled(owner, unsigned.integration.integration_id, false)).enabled).toBe(false)
    // But the dev channel is not a hole: an UNSIGNED manifest that asks for the network, e-mail or
    // the vault is refused there too — trying something locally is not the same as granting it.
    for (const asking of [
      manifest({ id: 'com-rede', permissions: ['network.outbound'] }),
      manifest({ id: 'com-email', permissions: ['email.send'] }),
      manifest({ id: 'com-cofre', permissions: ['secrets.read'] }),
      manifest({ id: 'mcp-externo', kind: 'mcp', endpoint: 'https://mcp.example.com' }),
    ]) {
      const risky = await service.register(owner, asking)
      expect(service.canEnable(risky.integration)).toBe(false)
      await expect(service.setEnabled(owner, risky.integration.integration_id, true, await ok(service, owner, 'integration.enabled', risky.integration.integration_id)))
        .rejects.toThrow('sem assinatura não pode pedir')
    }
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
      await expect(service.setEnabled(owner, row.integration_id, true, await ok(service, owner, 'integration.enabled', row.integration_id))).rejects.toThrow('não confere')
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
    await expect(service.setEnabled(admin, id, true, { approvalId: 'inventado' })).rejects.toThrow('confirmação')
    // right confirmation, but no recent passkey on this session
    await expect(service.setEnabled(admin, id, true, await ok(service, admin, 'integration.enabled', id))).rejects.toThrow('passkey')
    const enabled = await service.setEnabled(strongAdmin, id, true, await ok(service, strongAdmin, 'integration.enabled', id))
    expect(enabled.enabled).toBe(true)
    const actions = repository.eventRows.map(event => `${event.action}:${event.outcome}`)
    expect(actions).toContain('integration.enabled:failure')
    expect(actions).toContain('approval.recorded:success')
    expect(repository.eventRows.find(event => event.action === 'approval.recorded')).toMatchObject({ detail: 'integration.enabled' })
    // The server issued the decision before the action, and it is single use: presenting it twice fails.
    const reused = await ok(service, strongAdmin, 'integration.enabled', id)
    await service.setEnabled(strongAdmin, id, false)
    expect((await service.setEnabled(strongAdmin, id, true, reused)).enabled).toBe(true)
    await service.setEnabled(strongAdmin, id, false)
    await expect(service.setEnabled(strongAdmin, id, true, reused)).rejects.toThrow('passkey')
    // An approval issued for another subject, another person or another action is not this one.
    const other = await service.register(admin, signed(manifest({ id: 'outra', permissions: ['secrets.read'] })))
    const foreign = await ok(service, strongAdmin, 'integration.enabled', other.integration.integration_id)
    await expect(service.setEnabled(strongAdmin, id, true, foreign)).rejects.toThrow('passkey')
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

  it('enforces the tier the kind demands, never a lower one stored in the row', async () => {
    const { service, repository, sent } = await build({ emailTest: true, secrets: { DZ23_APP_SMTP: { present: true, shapeOk: true } } })
    await service.configureSmtp(admin, 'DZ23_APP_SMTP', await ok(service, admin, 'smtp.configured', SMTP, 'DZ23_APP_SMTP'))
    // A row written with a lower tier — an older build, a migration, any other writer of the table —
    // must not buy a free pass: e-mail talks to an external provider, so T2 is the floor.
    const smtpRow = repository.rows.find(row => row.kind === 'smtp')!
    await repository.putIntegration({ ...smtpRow, effective_tier: 'T0' })
    expect(service.requiredApprovalTier({ ...smtpRow, effective_tier: 'T0' })).toBe('T2')
    await expect(service.testSmtp(admin, 'pessoa@example.test')).rejects.toThrow('confirmação')
    expect(sent).toEqual([])
    await expect(service.setEnabled(admin, smtpRow.integration_id, true)).rejects.toThrow('confirmação')
    // The same for a manifest whose stored tier was lowered but whose permissions demand T3.
    const sensitive = await service.register(admin, signed(manifest({ id: 'cofre', permissions: ['secrets.read'] })))
    await repository.putIntegration({ ...sensitive.integration, effective_tier: 'T0' })
    expect(service.requiredApprovalTier({ ...sensitive.integration, effective_tier: 'T0' })).toBe('T3')
    await expect(service.setEnabled(strongAdmin, sensitive.integration.integration_id, true, { approvalId: 'inventado' })).rejects.toThrow('confirmação')
  })

  it('refuses to enable on a record that changed while the person was confirming', async () => {
    const { service, repository } = await build()
    const registered = await service.register(admin, signed(manifest({ id: 'agenda' })))
    const id = registered.integration.integration_id
    // Between the read that decides the tier and the write, the integration is re-registered with
    // permissions that raise it to T3. Writing back the old snapshot would silently undo that and
    // leave it enabled at T0.
    const readRows = repository.integrations.bind(repository)
    let reads = 0
    repository.integrations = () => {
      reads += 1
      if (reads === 2) {
        repository.rows = repository.rows.map(row => (row.integration_id === id
          ? { ...row, effective_tier: 'T3' as const, updated_at: '2026-09-05T00:00:00.000Z' }
          : row))
      }
      return readRows()
    }
    await expect(service.setEnabled(admin, id, true)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(repository.rows.find(row => row.integration_id === id)).toMatchObject({ enabled: false, effective_tier: 'T3' })
  })

  it('records a confirmation only when the action really happened, and audits the refusals', async () => {
    const { service, repository } = await build({ secrets: { DZ23_BROKEN: { present: true, shapeOk: false } } })
    await expect(service.configureSmtp(admin, 'DZ23_MISSING', await ok(service, admin, 'smtp.configured', SMTP, 'DZ23_MISSING'))).rejects.toThrow('cofre')
    await expect(service.configureSmtp(admin, 'DZ23_BROKEN', await ok(service, admin, 'smtp.configured', SMTP, 'DZ23_BROKEN'))).rejects.toThrow('formato')
    const actions = repository.eventRows.map(event => `${event.action}:${event.outcome}`)
    // No "confirmation recorded" for something that did not happen, and the refusals are visible.
    expect(actions).not.toContain('approval.recorded:success')
    expect(actions).toEqual(['approval.requested:success', 'smtp.configured:failure', 'approval.requested:success', 'smtp.configured:failure'])
  })

  it('keeps the approvals bounded and pins the subject the SMTP actions can be issued for', async () => {
    const { service, repository } = await build()
    // The SMTP actions have one subject; a free string there made the number of live tickets unbounded.
    await expect(service.requestApproval(admin, 'smtp.configured', 'qualquer-coisa', 'DZ23_APP_SMTP')).rejects.toMatchObject({ code: 'INVALID' })
    // A decision about nothing is not issued at all: the SMTP actions must name what they are for.
    await expect(service.requestApproval(admin, 'smtp.configured', 'smtp')).rejects.toMatchObject({ code: 'INVALID' })
    const first = await service.requestApproval(admin, 'smtp.configured', 'smtp', 'DZ23_APP_SMTP')
    // Far more tickets than a person could ever confirm: the oldest are dropped instead of piling up.
    for (let index = 0; index < MAX_LIVE_APPROVALS + 10; index += 1) await service.requestApproval(admin, 'smtp.tested', 'smtp', 'pessoa@example.test')
    const last = await service.requestApproval(admin, 'smtp.tested', 'smtp', 'pessoa@example.test')
    // The evicted one is simply gone — the person confirms again, nothing is granted by accident.
    await expect(service.configureSmtp(admin, 'DZ23_APP_SMTP', { approvalId: first.approval_id })).rejects.toThrow('confirmação')
    expect(last.approval_id).not.toBe(first.approval_id)
    expect(repository.eventRows.filter(event => event.action === 'approval.requested').every(event => event.subject_id === 'smtp')).toBe(true)
  })

  it('binds the confirmation to the workspace, the action and a fingerprint of what was confirmed', async () => {
    const secrets = { DZ23_APP_SMTP: { present: true, shapeOk: true }, DZ23_OUTRO_COFRE: { present: true, shapeOk: true } }
    const { service } = await build({ emailTest: true, secrets })
    const ticket = await service.requestApproval(admin, 'smtp.configured', SMTP, 'DZ23_APP_SMTP')
    // The ticket says which workspace it belongs to, which action it is for and — as a digest, never
    // as a name — exactly what was confirmed.
    expect(ticket).toMatchObject({ org_id: 'org-a', tenant_id: 'ws-a', action: 'smtp.configured', subject_id: SMTP, tier: 'T2' })
    expect(ticket.fingerprint).toMatch(/^[a-f0-9]{64}$/u)
    expect(JSON.stringify(ticket)).not.toContain('DZ23_APP_SMTP')
    // A decision taken for ONE credential cannot be spent on another: the subject is the same string
    // for both, so without the fingerprint this went through.
    await expect(service.configureSmtp(admin, 'DZ23_OUTRO_COFRE', { approvalId: ticket.approval_id })).rejects.toThrow('confirmação')
    // And it is spent by that attempt: a presented ticket never gets a second chance.
    await expect(service.configureSmtp(admin, 'DZ23_APP_SMTP', { approvalId: ticket.approval_id })).rejects.toThrow('confirmação')
    await service.configureSmtp(admin, 'DZ23_APP_SMTP', await ok(service, admin, 'smtp.configured', SMTP, 'DZ23_APP_SMTP'))
    // The same for the test message: confirmed for one address, refused for another.
    const forOne = await ok(service, admin, 'smtp.tested', SMTP, 'dona@example.test')
    await expect(service.testSmtp(admin, 'outra.pessoa@example.test', forOne)).rejects.toThrow('confirmação')
    expect((await service.testSmtp(admin, 'DONA@example.test', await ok(service, admin, 'smtp.tested', SMTP, 'dona@example.test'))).result).toBe('SENT')
    // An id issued inside another workspace is not even visible here.
    const theirs = await service.requestApproval(otherTenant, 'smtp.configured', SMTP, 'DZ23_APP_SMTP')
    await expect(service.configureSmtp(admin, 'DZ23_APP_SMTP', { approvalId: theirs.approval_id })).rejects.toThrow('confirmação')
  })

  it('a flood of confirmations in one workspace never throws away another workspace\'s', async () => {
    const { service } = await build({ secrets: { DZ23_APP_SMTP: { present: true, shapeOk: true } } })
    // Somebody in ws-b is in the middle of confirming…
    const theirs = await service.requestApproval(otherTenant, 'smtp.configured', SMTP, 'DZ23_APP_SMTP')
    // …while ws-a asks for far more confirmations than the ceiling. The map used to be GLOBAL, so
    // this evicted the other workspace's ticket and that person was told to confirm again.
    for (let index = 0; index < MAX_LIVE_APPROVALS + 50; index += 1) await service.requestApproval(admin, 'smtp.tested', SMTP, 'pessoa@example.test')
    const record = await service.configureSmtp(otherTenant, 'DZ23_APP_SMTP', { approvalId: theirs.approval_id })
    expect(record).toMatchObject({ tenant_id: 'ws-b', secret_ref: 'DZ23_APP_SMTP' })
  })

  it('never writes the credential alias into the history, in success or in refusal', async () => {
    const { service, repository } = await build({ secrets: { DZ23_APP_SMTP: { present: true, shapeOk: true } } })
    await service.configureSmtp(admin, 'DZ23_APP_SMTP', await ok(service, admin, 'smtp.configured', SMTP, 'DZ23_APP_SMTP'))
    await expect(service.configureSmtp(admin, 'DZ23_SEGREDO_AUSENTE', await ok(service, admin, 'smtp.configured', SMTP, 'DZ23_SEGREDO_AUSENTE'))).rejects.toThrow('cofre')
    const history = JSON.stringify(repository.eventRows)
    // The audit proves a reference was configured; it never names the credential nor lists the vault.
    expect(history).not.toContain('DZ23_APP_SMTP')
    expect(history).not.toContain('DZ23_SEGREDO_AUSENTE')
    expect(repository.eventRows.filter(event => event.action === 'smtp.configured').map(event => event.subject_id)).not.toContain('DZ23_APP_SMTP')
    const configured = repository.eventRows.find(event => event.action === 'smtp.configured' && event.outcome === 'success')!
    expect(configured.detail).toBe(minimizeSecretRef('DZ23_APP_SMTP'))
    expect(configured.detail).toMatch(/^ref sha256:[a-f0-9]{12}$/u)
    // …and the row itself still keeps the name, which is where it belongs.
    expect(repository.rows.find(row => row.kind === 'smtp')!.secret_ref).toBe('DZ23_APP_SMTP')
  })

  it('refuses an enable when the record changed under it, even when both writes land in the same millisecond', async () => {
    const { service, repository } = await build()
    const registered = await service.register(admin, signed(manifest({ id: 'agenda', tier: 'T0' })))
    const id = registered.integration.integration_id
    const before = securityFingerprint(registered.integration)
    // The clock of this service is fixed: `updated_at` is byte for byte the same on both versions,
    // so comparing timestamps declared "nothing changed" and enabled the NEW manifest with the old
    // decision. What changes here is the manifest and its signature, not the tier.
    const readRows = repository.integrations.bind(repository)
    let reads = 0
    repository.integrations = () => {
      reads += 1
      if (reads === 2) repository.rows = repository.rows.map(row => (row.integration_id === id ? { ...row, manifest: signed(manifest({ id: 'agenda', tier: 'T0', version: '9.9.9' })) } : row))
      return readRows()
    }
    await expect(service.setEnabled(admin, id, true)).rejects.toMatchObject({ code: 'CONFLICT' })
    const stored = repository.rows.find(row => row.integration_id === id)!
    expect(stored.enabled).toBe(false)
    expect(stored.updated_at).toBe(registered.integration.updated_at)
    expect(securityFingerprint(stored)).not.toBe(before)
  })

  it('pages the history newest first and keeps only what the workspace is entitled to', async () => {
    const { service, repository } = await build()
    for (let index = 0; index < 5; index += 1) await service.register(admin, signed(manifest({ id: `app-${index}` })))
    const first = service.events(owner, { limit: 2 })
    expect(first.events).toHaveLength(2)
    expect(first.next_cursor).not.toBeNull()
    // Newest first, and one page never repeats a row of the previous one.
    expect(first.events[0]!.created_at >= first.events[1]!.created_at).toBe(true)
    const second = service.events(owner, { limit: 2, cursor: first.next_cursor! })
    expect(second.events).toHaveLength(2)
    expect(second.events.map(event => event.event_id)).not.toEqual(expect.arrayContaining(first.events.map(event => event.event_id)))
    const third = service.events(owner, { limit: 2, cursor: second.next_cursor! })
    expect(third.events).toHaveLength(1)
    expect(third.next_cursor).toBeNull()
    // The whole table is never handed over in one answer, whatever the client asks for.
    expect(service.events(owner, { limit: 10_000 }).events).toHaveLength(5)
    expect(() => service.events(owner, { cursor: 'não é um cursor' })).toThrow(HubError)
    // Another workspace's history is not paged into this one.
    expect(service.events({ ...owner, tenantId: 'ws-b' }).events).toEqual([])
  })

  it('keeps the history bounded per workspace instead of growing for as long as the Studio runs', async () => {
    const { service, repository } = await build()
    const filler = (index: number, tenant: string) => ({
      event_id: `seed-${tenant}-${String(index).padStart(5, '0')}`, org_id: 'org-a', tenant_id: tenant, actor_user_id: 'u-owner',
      action: 'approval.requested' as const, subject_id: 'smtp', outcome: 'success' as const, detail: 'seed',
      created_at: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
    })
    repository.eventRows = [
      ...Array.from({ length: EVENTS_RETAINED_PER_TENANT + 200 }, (_value, index) => filler(index, 'ws-a')),
      ...Array.from({ length: 5 }, (_value, index) => filler(index, 'ws-b')),
    ]
    await service.register(admin, signed(manifest({ id: 'agenda' })))
    const mine = repository.eventRows.filter(row => row.tenant_id === 'ws-a')
    expect(mine).toHaveLength(EVENTS_RETAINED_PER_TENANT)
    // What leaves is the oldest, and the newest event — the one just written — is still there.
    expect(mine.some(row => row.event_id === 'seed-ws-a-00000')).toBe(false)
    expect(mine.some(row => row.action === 'integration.registered')).toBe(true)
    // One workspace's ceiling never touches another's rows.
    expect(repository.eventRows.filter(row => row.tenant_id === 'ws-b')).toHaveLength(5)
  })

  it('builds one package at a time per project and refuses a flood of export requests', async () => {
    const runDirectory = await fakeRun()
    const { service, repository } = await build({ runDirectory })
    // Ten clicks (or ten tabs) on the same project join the same build instead of starting ten of them.
    const together = await Promise.all(Array.from({ length: 10 }, () => service.createExport(builder, 'p1')))
    expect(new Set(together.map(record => record.export_id)).size).toBe(1)
    expect(repository.exportRows).toHaveLength(1)
    expect(repository.eventRows.filter(event => event.action === 'export.created' && event.outcome === 'success')).toHaveLength(1)
    // And a workspace cannot ask for an unbounded number of them inside the window.
    for (let index = 1; index < MAX_EXPORTS_PER_WINDOW; index += 1) await service.createExport(builder, 'p1')
    await expect(service.createExport(builder, 'p1')).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    expect(repository.eventRows.at(-1)).toMatchObject({ action: 'export.created', outcome: 'failure', detail: 'rate-limited' })
    // The refusal belongs to the workspace that flooded: another one is untouched.
    expect(service.listExports(viewer, 'p1')).toHaveLength(1)
  })

  it('does not spend the confirmation when it is the passkey that is missing', async () => {
    const { service } = await build()
    const sensitive = await service.register(admin, signed(manifest({ id: 'cofre', permissions: ['secrets.read'] })))
    const id = sensitive.integration.integration_id
    // Same session throughout: what changes between the two attempts is only the passkey.
    const weakAdmin: HubActor = { ...admin, sessionId: 's-admin' }
    const ticket = await ok(service, weakAdmin, 'integration.enabled', id)
    // First refusal is about the passkey…
    await expect(service.setEnabled(weakAdmin, id, true, ticket)).rejects.toThrow('passkey')
    // …so after confirming with the passkey, the SAME confirmation still works. Burning it here
    // would greet the person with "confirm again" for something they had just confirmed.
    expect((await service.setEnabled(strongAdmin, id, true, ticket)).enabled).toBe(true)
    // And now it is spent.
    await service.setEnabled(strongAdmin, id, false)
    await expect(service.setEnabled(strongAdmin, id, true, ticket)).rejects.toThrow('confirmação')
  })

  it('enforces roles and tenant scope', async () => {
    const { service } = await build()
    await expect(service.register(builder, signed(manifest()))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(service.configureSmtp(viewer, 'DZ23_APP_SMTP')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(() => service.events(builder)).toThrow(HubError)
    const registered = await service.register(owner, signed(manifest()))
    await expect(service.setEnabled(otherTenant, registered.integration.integration_id, true)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(service.createExport(viewer, 'p1')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(service.events(owner).events).toHaveLength(1)
  })

  it('stores only the SMTP credential reference after checking presence and shape, and reports the test as NOT_EXECUTED until enabled', async () => {
    const { service, repository } = await build({ secrets: { DZ23_APP_SMTP: { present: true, shapeOk: true }, DZ23_BROKEN: { present: true, shapeOk: false } } })
    expect(service.smtp(viewer)).toEqual({ configured: false, secret_ref: null, tier: 'T2' })
    await expect(service.configureSmtp(admin, 'smtp://user:pass@host', await ok(service, admin, 'smtp.configured', SMTP, 'smtp://user:pass@host'))).rejects.toThrow('identificador')
    // Configuring the app's e-mail is T2: without the confirmation the vault is never even touched.
    await expect(service.configureSmtp(admin, 'DZ23_APP_SMTP')).rejects.toThrow('confirmação')
    await expect(service.configureSmtp(admin, 'DZ23_MISSING', await ok(service, admin, 'smtp.configured', SMTP, 'DZ23_MISSING'))).rejects.toThrow('não existe no cofre')
    await expect(service.configureSmtp(admin, 'DZ23_BROKEN', await ok(service, admin, 'smtp.configured', SMTP, 'DZ23_BROKEN'))).rejects.toThrow('formato esperado')
    // `secret://NAME` and `NAME` are the same name; the case is never invented.
    const record = await service.configureSmtp(admin, '  secret://DZ23_APP_SMTP  ', await ok(service, admin, 'smtp.configured', SMTP, '  secret://DZ23_APP_SMTP  '))
    expect(record).toMatchObject({ kind: 'smtp', secret_ref: 'DZ23_APP_SMTP', enabled: true, effective_tier: 'T2' })
    expect(JSON.stringify(repository.rows)).not.toContain('pass')
    expect(service.smtp(viewer)).toEqual({ configured: true, secret_ref: 'DZ23_APP_SMTP', tier: 'T2' })
    const test = await service.testSmtp(admin, 'pessoa@example.test', await ok(service, admin, 'smtp.tested', SMTP, 'pessoa@example.test'))
    expect(test.result).toBe('NOT_EXECUTED')
    expect(repository.eventRows.at(-1)).toMatchObject({ action: 'smtp.tested', outcome: 'not-executed' })
    const second = await service.configureSmtp(admin, 'DZ23_APP_SMTP', await ok(service, admin, 'smtp.configured', SMTP, 'DZ23_APP_SMTP'))
    expect(second.integration_id).toBe(record.integration_id)
  })

  it('sends the SMTP test only when the operator enabled it, and records failures', async () => {
    const { service, sent, repository } = await build({ emailTest: true, secrets: { DZ23_APP_SMTP: { present: true, shapeOk: true } } })
    await expect(service.testSmtp(admin, 'pessoa@example.test', await ok(service, admin, 'smtp.tested', SMTP, 'pessoa@example.test'))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await service.configureSmtp(admin, 'DZ23_APP_SMTP', await ok(service, admin, 'smtp.configured', SMTP, 'DZ23_APP_SMTP'))
    await expect(service.testSmtp(admin, 'not-an-email', await ok(service, admin, 'smtp.tested', SMTP, 'not-an-email'))).rejects.toMatchObject({ code: 'INVALID' })
    await expect(service.testSmtp(admin, 'pessoa@example.test')).rejects.toThrow('confirmação')
    expect(await service.testSmtp(admin, 'pessoa@example.test', await ok(service, admin, 'smtp.tested', SMTP, 'pessoa@example.test'))).toMatchObject({ result: 'SENT' })
    expect(sent).toEqual([['DZ23_APP_SMTP', 'pessoa@example.test']])
    // The audit proves the test happened without keeping the address in the clear.
    expect(repository.eventRows.at(-1)).toMatchObject({ action: 'smtp.tested', outcome: 'success' })
    expect(repository.eventRows.at(-1)!.detail).toMatch(/^\*\*\*@example\.test sha256:[a-f0-9]{12}$/u)
    expect(JSON.stringify(repository.eventRows)).not.toContain('pessoa@example.test')
    // Disabling the SMTP record makes it "not configured" again; the record itself stays for the audit trail.
    const smtpRecord = repository.rows.find(row => row.kind === 'smtp')!
    await service.setEnabled(admin, smtpRecord.integration_id, false)
    expect(service.smtp(viewer)).toMatchObject({ configured: false, secret_ref: null })
    await expect(service.testSmtp(admin, 'pessoa@example.test', await ok(service, admin, 'smtp.tested', SMTP, 'pessoa@example.test'))).rejects.toMatchObject({ code: 'NOT_FOUND' })
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
