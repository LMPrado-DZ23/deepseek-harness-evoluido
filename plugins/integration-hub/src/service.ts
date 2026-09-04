import { randomUUID } from 'node:crypto'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { roleAllows, type PolicyTier, type StudioPermission, type StudioRole } from '@dz23-studio/policy'
import { z } from 'zod'
import { ExportError, packagePrototype } from './export.js'
import { t } from './i18n.js'
import { evaluateManifest, type PublisherKeys } from './manifest.js'
import { secretRefSchema, type HubEvent, type StudioExport, type StudioIntegration } from './model.js'

export interface HubActor {
  readonly userId: string
  readonly orgId: string
  readonly tenantId: string
  readonly role: StudioRole
  readonly sessionId?: string
}

export interface HubRepository {
  integrations(): readonly StudioIntegration[]
  putIntegration(value: StudioIntegration): Promise<void>
  exports(): readonly StudioExport[]
  putExport(value: StudioExport): Promise<void>
  events(): readonly HubEvent[]
  putEvent(value: HubEvent): Promise<void>
}

/** Existence and shape of a credential in the vault; the value never crosses this port. */
export interface SecretInspector {
  inspect(ref: string): Promise<{ present: boolean; shapeOk: boolean }>
}

export interface EmailTestPort {
  /** Sends one test message through the referenced credential; only wired when the operator enabled it. */
  sendTest(ref: string, to: string): Promise<void>
}

export interface ProjectsPort {
  project(actor: HubActor, projectId: string): { readonly project_id: string; readonly name: string; readonly state: string }
  runs(actor: HubActor, projectId: string): readonly { readonly run_id: string; readonly state: string; readonly started_at: string; readonly attempt: number; readonly run_directory: string }[]
}

export interface HubServiceOptions {
  repository: HubRepository
  secrets: SecretInspector
  projects: ProjectsPort
  exportsRoot: string
  publisherKeys: PublisherKeys
  channel: 'stable' | 'dev'
  emailTest?: EmailTestPort | undefined
  now?: () => Date
  createId?: () => string
}

export class HubError extends Error {
  constructor(readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID' | 'CONFLICT' | 'NOT_EXECUTED', message: string) { super(message) }
}

/** SMTP for generated apps talks to an external provider: T2 by the D16 floor. */
export const SMTP_TIER: PolicyTier = 'T2'

const smtpSecretShape = z.object({ host: z.string().min(1), port: z.number().int(), secure: z.boolean(), user: z.string().min(1), pass: z.string().min(1), from: z.string().min(1) }).strict()
export { smtpSecretShape }

export class IntegrationHubService {
  readonly #now: () => Date
  readonly #createId: () => string

  constructor(private readonly options: HubServiceOptions) {
    this.#now = options.now ?? (() => new Date())
    this.#createId = options.createId ?? randomUUID
  }

  // ---- registry -------------------------------------------------------------

  list(actor: HubActor): readonly StudioIntegration[] {
    this.#authorize(actor, 'workspace.read')
    return this.options.repository.integrations().filter(value => this.#sameScope(actor, value))
  }

  /** Whether the interface may offer "enable" for this record: decided here, the same place that enforces it. */
  canEnable(integration: Pick<StudioIntegration, 'verification' | 'enabled'>): boolean {
    return !integration.enabled && (integration.verification === 'verified' || this.options.channel === 'dev')
  }

  get channel(): 'stable' | 'dev' { return this.options.channel }

  async register(actor: HubActor, manifestInput: unknown): Promise<{ integration: StudioIntegration; reasons: readonly string[] }> {
    this.#authorize(actor, 'integrations.manage')
    const evaluation = evaluateManifest(manifestInput, this.options.publisherKeys)
    const subject = evaluation.manifest?.id ?? '-'
    if (evaluation.manifest === null) {
      await this.#audit(actor, 'integration.registered', subject, 'failure', `manifest-invalid ${evaluation.reasons.join('; ')}`)
      throw new HubError('INVALID', t('errors.manifestInvalid', { detail: evaluation.reasons.join(' ') }))
    }
    if (evaluation.manifest.kind === 'smtp') {
      await this.#audit(actor, 'integration.registered', subject, 'failure', 'smtp-kind-reserved')
      throw new HubError('INVALID', t('errors.smtpKindReserved'))
    }
    if (evaluation.verification === 'invalid') {
      await this.#audit(actor, 'integration.registered', subject, 'failure', 'signature-invalid')
      throw new HubError('INVALID', t('errors.manifestSignatureInvalid'))
    }
    const now = this.#now().toISOString()
    const existing = this.list(actor).find(value => value.manifest?.id === evaluation.manifest!.id && value.kind === evaluation.manifest!.kind)
    const integration: StudioIntegration = {
      integration_id: existing?.integration_id ?? this.#createId(), org_id: actor.orgId, tenant_id: actor.tenantId,
      kind: evaluation.manifest.kind, name: evaluation.manifest.name, manifest: evaluation.manifest,
      effective_tier: evaluation.effectiveTier, verification: evaluation.verification,
      enabled: false, secret_ref: existing?.secret_ref ?? null,
      created_by: existing?.created_by ?? actor.userId, created_at: existing?.created_at ?? now, updated_at: now,
    }
    await this.options.repository.putIntegration(integration)
    await this.#audit(actor, 'integration.registered', integration.integration_id, 'success', `${integration.verification} ${integration.effective_tier}`)
    return { integration, reasons: evaluation.reasons }
  }

  async setEnabled(actor: HubActor, integrationId: string, enabled: boolean): Promise<StudioIntegration> {
    this.#authorize(actor, 'integrations.manage')
    const current = this.#integration(actor, integrationId)
    if (enabled && current.verification !== 'verified' && this.options.channel === 'stable') {
      await this.#audit(actor, 'integration.enabled', integrationId, 'failure', t('errors.manifestUnverified'))
      throw new HubError('FORBIDDEN', t('errors.manifestUnverified'))
    }
    const updated = { ...current, enabled, updated_at: this.#now().toISOString() }
    await this.options.repository.putIntegration(updated)
    await this.#audit(actor, enabled ? 'integration.enabled' : 'integration.disabled', integrationId, 'success', updated.effective_tier)
    return updated
  }

  // ---- smtp for generated apps ---------------------------------------------

  smtp(actor: HubActor): { configured: boolean; secret_ref: string | null; tier: PolicyTier } {
    this.#authorize(actor, 'workspace.read')
    const record = this.#smtpRecord(actor)
    const configured = record !== undefined && record.enabled && record.secret_ref !== null
    return { configured, secret_ref: configured ? record.secret_ref : null, tier: SMTP_TIER }
  }

  async configureSmtp(actor: HubActor, secretRefInput: unknown): Promise<StudioIntegration> {
    this.#authorize(actor, 'integrations.manage')
    const parsed = secretRefSchema.safeParse(secretRefInput)
    if (!parsed.success) throw new HubError('INVALID', t('errors.secretRefInvalid'))
    const inspection = await this.options.secrets.inspect(parsed.data)
    if (!inspection.present) throw new HubError('INVALID', t('errors.secretRefMissing'))
    if (!inspection.shapeOk) throw new HubError('INVALID', t('errors.secretShapeInvalid'))
    const now = this.#now().toISOString()
    const existing = this.#smtpRecord(actor)
    const record: StudioIntegration = {
      integration_id: existing?.integration_id ?? this.#createId(), org_id: actor.orgId, tenant_id: actor.tenantId,
      kind: 'smtp', name: t('smtp.integrationName'), manifest: null, effective_tier: SMTP_TIER, verification: 'verified',
      enabled: true, secret_ref: parsed.data, created_by: existing?.created_by ?? actor.userId, created_at: existing?.created_at ?? now, updated_at: now,
    }
    await this.options.repository.putIntegration(record)
    await this.#audit(actor, 'smtp.configured', record.integration_id, 'success', parsed.data)
    return record
  }

  async testSmtp(actor: HubActor, to: string): Promise<{ result: 'SENT' | 'NOT_EXECUTED'; message: string }> {
    this.#authorize(actor, 'integrations.manage')
    const record = this.#smtpRecord(actor)
    if (record === undefined || record.secret_ref === null || !record.enabled) throw new HubError('NOT_FOUND', t('errors.smtpNotConfigured'))
    if (this.options.emailTest === undefined) {
      await this.#audit(actor, 'smtp.tested', record.integration_id, 'not-executed', t('errors.smtpTestDisabled'))
      return { result: 'NOT_EXECUTED', message: t('errors.smtpTestDisabled') }
    }
    const recipient = z.string().email().safeParse(to)
    if (!recipient.success) throw new HubError('INVALID', t('errors.invalidRequest'))
    try {
      await this.options.emailTest.sendTest(record.secret_ref, recipient.data)
    } catch (error) {
      // Provider messages can carry hostnames, banners or fragments of the secret: only the error class is kept.
      await this.#audit(actor, 'smtp.tested', record.integration_id, 'failure', error instanceof Error ? error.name : 'Error')
      throw new HubError('INVALID', t('errors.smtpTestFailed'))
    }
    await this.#audit(actor, 'smtp.tested', record.integration_id, 'success', recipient.data)
    return { result: 'SENT', message: t('audit.smtpTested') }
  }

  // ---- exports ---------------------------------------------------------------

  listExports(actor: HubActor, projectId: string): readonly StudioExport[] {
    this.#authorize(actor, 'project.read')
    this.options.projects.project(actor, projectId)
    return this.options.repository.exports().filter(value => value.project_id === projectId && this.#sameScope(actor, value))
  }

  async createExport(actor: HubActor, projectId: string): Promise<StudioExport> {
    this.#authorize(actor, 'project.write')
    const project = this.options.projects.project(actor, projectId)
    const refuse = async (detail: string, error: HubError): Promise<never> => {
      await this.#audit(actor, 'export.created', projectId, 'failure', detail)
      throw error
    }
    if (project.state !== 'VERIFIED_PROTOTYPE') return refuse(`state ${project.state}`, new HubError('INVALID', t('errors.exportNotVerified')))
    const run = [...this.options.projects.runs(actor, projectId)].filter(value => value.state === 'PASSED')
      .sort((left, right) => (right.started_at < left.started_at ? -1 : right.started_at > left.started_at ? 1 : 0) || right.attempt - left.attempt)[0]
    if (run === undefined) return refuse('no PASSED run', new HubError('INVALID', t('errors.exportNotVerified')))
    let built
    try {
      built = await packagePrototype({ runDirectory: run.run_directory, projectName: project.name, runId: run.run_id })
    } catch (error) {
      if (error instanceof ExportError) return refuse(error.code, new HubError(error.code === 'RUN_MISSING' ? 'CONFLICT' : 'INVALID', error.code === 'INVALID_PATH' ? t('errors.internal') : error.message))
      throw error
    }
    // Same run, same bytes: hand back the existing package instead of writing a twin file on every click.
    const existing = this.listExports(actor, projectId).find(value => value.run_id === run.run_id && value.sha256 === built.sha256)
    if (existing !== undefined && await exists(existing.path)) return existing
    const exportId = this.#createId()
    const directory = resolve(this.options.exportsRoot, actor.orgId, actor.tenantId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = resolve(directory, `${exportId}.zip`)
    await writeFile(path, built.archive, { flag: 'wx', mode: 0o600 })
    const record: StudioExport = {
      export_id: exportId, org_id: actor.orgId, tenant_id: actor.tenantId, project_id: projectId, run_id: run.run_id,
      file_name: built.fileName, path, sha256: built.sha256, size_bytes: built.archive.length, entries: built.entries,
      created_by: actor.userId, created_at: this.#now().toISOString(),
    }
    await this.options.repository.putExport(record)
    await this.#audit(actor, 'export.created', exportId, 'success', `${built.fileName} ${built.sha256}`)
    return record
  }

  exportRecord(actor: HubActor, projectId: string, exportId: string): StudioExport {
    const record = this.listExports(actor, projectId).find(value => value.export_id === exportId)
    if (record === undefined) throw new HubError('NOT_FOUND', t('errors.exportNotFound'))
    return record
  }

  events(actor: HubActor): readonly HubEvent[] {
    this.#authorize(actor, 'audit.read')
    return this.options.repository.events().filter(value => this.#sameScope(actor, value))
  }

  // ---- internals -----------------------------------------------------------

  #smtpRecord(actor: HubActor): StudioIntegration | undefined {
    return this.options.repository.integrations().find(value => value.kind === 'smtp' && value.manifest === null && this.#sameScope(actor, value))
  }

  #integration(actor: HubActor, integrationId: string): StudioIntegration {
    const value = this.options.repository.integrations().find(candidate => candidate.integration_id === integrationId && this.#sameScope(actor, candidate))
    if (value === undefined) throw new HubError('NOT_FOUND', t('errors.integrationNotFound'))
    return value
  }

  #authorize(actor: HubActor, permission: StudioPermission): void {
    if (!roleAllows(actor.role, permission)) throw new HubError('FORBIDDEN', t('errors.forbidden'))
  }

  #sameScope(actor: HubActor, value: { readonly org_id: string; readonly tenant_id: string }): boolean {
    return value.org_id === actor.orgId && value.tenant_id === actor.tenantId
  }

  async #audit(actor: HubActor, action: HubEvent['action'], subjectId: string, outcome: HubEvent['outcome'], detail: string): Promise<void> {
    await this.options.repository.putEvent({
      event_id: this.#createId(), org_id: actor.orgId, tenant_id: actor.tenantId, actor_user_id: actor.userId,
      action, subject_id: subjectId, outcome, detail: detail.slice(0, 500), created_at: this.#now().toISOString(),
    })
  }
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}
