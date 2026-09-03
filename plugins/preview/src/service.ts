import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { roleAllows, type StudioRole } from '@dz23-studio/policy'
import { z } from 'zod'
import { previewAdmissionSchema, previewRecordSchema, type PreviewAdmission, type PreviewRecord } from './model.js'
import { KeyedMutex } from './mutex.js'

const DEFAULT_TTL_SECONDS = 30 * 60
const MAX_TTL_SECONDS = 2 * 60 * 60
const ACTIVE_STATES = new Set<PreviewRecord['state']>(['REQUESTED', 'STARTING', 'READY', 'STOPPING'])

export interface PreviewActor {
  readonly userId: string
  readonly orgId: string
  readonly tenantId: string
  readonly role: StudioRole
  readonly sessionId: string
}

export interface VerifiedPreviewArtifact {
  readonly projectId: string
  readonly runId: string
  readonly artifactPath: string
  readonly artifactSha256: string
}

export interface PreviewSourcePort {
  verifiedArtifact(actor: PreviewActor, projectId: string, runId?: string): Promise<VerifiedPreviewArtifact>
}

export interface PreviewRuntimePort {
  /** The supervisor must atomically copy the artifact and verify artifactSha256 before execution. */
  start(input: {
    readonly previewId: string
    readonly artifactPath: string
    readonly artifactSha256: string
    readonly labels: Readonly<Record<string, string>>
    readonly environment: Readonly<Record<string, string>>
  }, signal: AbortSignal): Promise<{ readonly runtimeRef: string }>
  stop(runtimeRef: string, signal: AbortSignal): Promise<void>
  health(runtimeRef: string, signal: AbortSignal): Promise<'OK' | 'DOWN'>
  logs(runtimeRef: string, limit: number, signal: AbortSignal): Promise<readonly unknown[]>
  verificationMessages(runtimeRef: string, signal: AbortSignal): Promise<readonly unknown[]>
  listManaged(signal: AbortSignal): Promise<readonly { readonly runtimeRef: string; readonly previewId: string }[]>
}

export const previewLogEventSchema = z.object({
  at: z.iso.datetime(),
  level: z.enum(['info', 'warn', 'error']),
  event: z.enum([
    'ARTIFACT_VERIFIED', 'HEALTH_DOWN', 'HEALTH_OK', 'NETWORK_EGRESS_BLOCKED',
    'PREVIEW_STARTED', 'PREVIEW_STOPPED', 'PROCESS_EXITED', 'RUNTIME_RESTARTED',
  ]),
}).strict()
export type PreviewLogEvent = z.infer<typeof previewLogEventSchema>

export const previewVerificationMessageSchema = z.object({
  kind: z.literal('code'),
  email: z.email(),
  code: z.string().regex(/^\d{6}$/u),
  expiresAt: z.iso.datetime(),
}).strict()
export type PreviewVerificationMessage = z.infer<typeof previewVerificationMessageSchema>

export interface PreviewSessionPort {
  isActive(input: { readonly sessionId: string; readonly userId: string; readonly orgId: string; readonly tenantId: string }): boolean
  canRead(input: { readonly userId: string; readonly orgId: string; readonly tenantId: string }): boolean
}

export interface PreviewRepository {
  previews(): readonly PreviewRecord[]
  putPreview(record: PreviewRecord): Promise<void>
  admissions(): readonly PreviewAdmission[]
  putAdmission(record: PreviewAdmission): Promise<void>
}

export interface PreviewServiceOptions {
  readonly repository: PreviewRepository
  readonly source: PreviewSourcePort
  readonly runtime: PreviewRuntimePort
  readonly sessions: PreviewSessionPort
  readonly now?: () => Date
  readonly createId?: () => string
  readonly createSecret?: () => string
  readonly ttlSeconds?: number
  readonly publicPort?: number
  readonly runtimeTimeoutMs?: number
}

export interface PublicPreview {
  readonly preview_id: string
  readonly project_id: string
  readonly run_id: string
  readonly artifact_sha256: string
  readonly state: PreviewRecord['state']
  readonly health: PreviewRecord['health']
  readonly url: string
  readonly created_at: string
  readonly ready_at: string | null
  readonly expires_at: string
  readonly stopped_at: string | null
  readonly stop_reason: PreviewRecord['stop_reason']
  readonly failure_code: string | null
}

export class PreviewError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'INVALID' | 'CONFLICT' | 'UNAVAILABLE', message: string) { super(message) }
}

export class StudioPreviewService {
  readonly #now: () => Date
  readonly #createId: () => string
  readonly #createSecret: () => string
  readonly #ttlSeconds: number
  readonly #publicPort: number
  readonly #runtimeTimeoutMs: number
  readonly #mutex = new KeyedMutex()

  constructor(private readonly options: PreviewServiceOptions) {
    this.#now = options.now ?? (() => new Date())
    this.#createId = options.createId ?? randomUUID
    this.#createSecret = options.createSecret ?? (() => randomBytes(32).toString('base64url'))
    this.#ttlSeconds = Math.min(MAX_TTL_SECONDS, Math.max(60, options.ttlSeconds ?? DEFAULT_TTL_SECONDS))
    this.#publicPort = validPort(options.publicPort ?? 80)
    this.#runtimeTimeoutMs = Math.min(30_000, Math.max(10, options.runtimeTimeoutMs ?? 10_000))
  }

  list(actor: PreviewActor, projectId: string): readonly PublicPreview[] {
    this.#authorize(actor, 'project.read')
    return this.options.repository.previews()
      .filter(item => sameScope(item, actor) && item.project_id === projectId)
      .map(item => this.public(item))
  }

  get(actor: PreviewActor, projectId: string, previewId: string): PublicPreview {
    this.#authorize(actor, 'project.read')
    return this.public(this.#preview(actor, projectId, previewId))
  }

  async start(actor: PreviewActor, projectId: string, runId?: string): Promise<{ readonly preview: PublicPreview; readonly admissionTicket: string }> {
    this.#authorize(actor, 'project.write')
    return this.#mutex.run(`${actor.orgId}:${actor.tenantId}:${projectId}`, async () => {
      const artifact = await this.options.source.verifiedArtifact(actor, projectId, runId)
      if (!/^[a-f0-9]{64}$/u.test(artifact.artifactSha256)) throw new PreviewError('INVALID', 'O artefato verificado não possui hash SHA-256 válido.')
      const existing = this.options.repository.previews().find(item => sameScope(item, actor)
        && item.project_id === projectId && item.run_id === artifact.runId
        && item.artifact_sha256 === artifact.artifactSha256 && item.state === 'READY'
        && item.runtime_ref !== null && Date.parse(item.expires_at) > this.#now().getTime())
      if (existing !== undefined) {
        const reusable = await this.#mutex.run(`preview:${existing.preview_id}`, async () => {
          const current = this.options.repository.previews().find(item => item.preview_id === existing.preview_id)
          if (current === undefined || current.state !== 'READY' || current.runtime_ref === null || Date.parse(current.expires_at) <= this.#now().getTime()) return undefined
          const health = await this.#runtimeCall('RUNTIME_HEALTH_TIMEOUT', signal => this.options.runtime.health(current.runtime_ref!, signal)).catch(() => 'DOWN' as const)
          if (health === 'OK') {
            const refreshed = previewRecordSchema.parse({ ...current, health: 'OK' })
            await this.options.repository.putPreview(refreshed)
            return refreshed
          }
          await this.#runtimeCall('RUNTIME_STOP_TIMEOUT', signal => this.options.runtime.stop(current.runtime_ref!, signal)).catch(() => undefined)
          const failed = previewRecordSchema.parse({ ...current, state: 'FAILED', health: 'DOWN', stopped_at: this.#now().toISOString(), stop_reason: 'failed', failure_code: 'RUNTIME_DOWN' })
          await this.options.repository.putPreview(failed)
          await this.#revokeAdmissions(current.preview_id)
          return undefined
        })
        if (reusable !== undefined) {
          const ticket = await this.#issueAdmission(actor, reusable)
          return { preview: this.public(reusable), admissionTicket: ticket }
        }
      }

      const now = this.#now()
      const previewId = this.#createId()
      const hostname = `p-${randomBytes(12).toString('hex')}.localhost`
      const initial = previewRecordSchema.parse({
        preview_id: previewId, org_id: actor.orgId, tenant_id: actor.tenantId,
        project_id: projectId, run_id: artifact.runId, artifact_sha256: artifact.artifactSha256,
        created_by: actor.userId, source_session_id: actor.sessionId, hostname,
        state: 'REQUESTED', created_at: now.toISOString(), ready_at: null,
        expires_at: new Date(now.getTime() + this.#ttlSeconds * 1000).toISOString(),
        stopped_at: null, stop_reason: null, failure_code: null, runtime_ref: null, health: 'PENDING',
      })
      await this.options.repository.putPreview(initial)
      return this.#mutex.run(`preview:${previewId}`, async () => {
        let record = previewRecordSchema.parse({ ...initial, state: 'STARTING' })
        await this.options.repository.putPreview(record)
        let startedRuntimeRef: string | undefined
        try {
          const started = await this.#runtimeCall('RUNTIME_START_TIMEOUT', signal => this.options.runtime.start({
            previewId, artifactPath: artifact.artifactPath, artifactSha256: artifact.artifactSha256,
            labels: { 'dz23.managed': 'preview', 'dz23.preview_id': previewId },
            environment: { APP_EMAIL_MODE: 'studio-preview', DZ23_PREVIEW_ID: previewId, DATA_DIR: '/data' },
          }, signal))
          startedRuntimeRef = started.runtimeRef
          if (!/^[a-zA-Z0-9_.:-]{1,200}$/u.test(started.runtimeRef)) throw new PreviewError('UNAVAILABLE', 'O supervisor retornou uma referência de runtime inválida.')
          record = previewRecordSchema.parse({ ...record, state: 'READY', ready_at: this.#now().toISOString(), runtime_ref: started.runtimeRef, health: 'OK' })
          await this.options.repository.putPreview(record)
          const ticket = await this.#issueAdmission(actor, record)
          return { preview: this.public(record), admissionTicket: ticket }
        } catch (error) {
          if (startedRuntimeRef !== undefined) await this.#runtimeCall('RUNTIME_STOP_TIMEOUT', signal => this.options.runtime.stop(startedRuntimeRef!, signal)).catch(() => undefined)
          record = previewRecordSchema.parse({ ...record, state: 'FAILED', stopped_at: this.#now().toISOString(), stop_reason: 'failed', failure_code: failureCode(error), health: 'DOWN' })
          await this.options.repository.putPreview(record)
          throw error
        }
      })
    })
  }

  async stop(actor: PreviewActor, projectId: string, previewId: string): Promise<PublicPreview> {
    this.#authorize(actor, 'project.write')
    return this.#mutex.run(`${actor.orgId}:${actor.tenantId}:${projectId}`, async () => {
      return this.#mutex.run(`preview:${previewId}`, async () => {
        let record = this.#preview(actor, projectId, previewId)
        if (['STOPPED', 'FAILED', 'EXPIRED'].includes(record.state)) return this.public(record)
        record = previewRecordSchema.parse({ ...record, state: 'STOPPING' })
        await this.options.repository.putPreview(record)
        let cleanupIncomplete = false
        if (record.runtime_ref !== null) {
          try { await this.#runtimeCall('RUNTIME_STOP_TIMEOUT', signal => this.options.runtime.stop(record.runtime_ref!, signal)) }
          catch { cleanupIncomplete = true }
        }
        record = previewRecordSchema.parse({ ...record, state: 'STOPPED', stopped_at: this.#now().toISOString(), stop_reason: 'user', health: 'DOWN', failure_code: cleanupIncomplete ? 'RUNTIME_CLEANUP_INCOMPLETE' : record.failure_code })
        await this.options.repository.putPreview(record)
        await this.#revokeAdmissions(record.preview_id)
        return this.public(record)
      })
    })
  }

  async exchange(hostname: string, ticket: string): Promise<{ readonly cookie: string; readonly maxAge: number }> {
    const ticketHash = hashSecret(ticket)
    return this.#mutex.run(`admission:${ticketHash}`, async () => {
      const now = this.#now()
      const preview = this.options.repository.previews().find(item => item.hostname === normalizeHost(hostname))
      if (preview === undefined || preview.state !== 'READY' || Date.parse(preview.expires_at) <= now.getTime()) throw new PreviewError('NOT_FOUND', 'Prévia indisponível.')
      const admission = this.options.repository.admissions().find(item => item.preview_id === preview.preview_id
        && item.ticket_hash === ticketHash && item.exchanged_at === null && item.revoked_at === null)
      if (admission === undefined || Date.parse(admission.expires_at) <= now.getTime()) throw new PreviewError('NOT_FOUND', 'Convite de prévia inválido ou expirado.')
      if (!this.options.sessions.isActive({ sessionId: admission.source_session_id, userId: admission.user_id, orgId: admission.org_id, tenantId: admission.tenant_id })) {
        throw new PreviewError('FORBIDDEN', 'Sua sessão do DZ23 STUDIO não está mais ativa.')
      }
      const cookie = this.#createSecret()
      await this.options.repository.putAdmission(previewAdmissionSchema.parse({
        ...admission, ticket_hash: hashSecret(this.#createSecret()), cookie_hash: hashSecret(cookie), exchanged_at: now.toISOString(),
      }))
      return { cookie, maxAge: Math.max(0, Math.floor((Date.parse(preview.expires_at) - now.getTime()) / 1000)) }
    })
  }

  authorize(hostname: string, cookie: string): { readonly previewId: string; readonly runtimeRef: string } {
    const now = this.#now()
    const preview = this.options.repository.previews().find(item => item.hostname === normalizeHost(hostname))
    if (preview === undefined || preview.state !== 'READY' || preview.runtime_ref === null || Date.parse(preview.expires_at) <= now.getTime()) throw new PreviewError('NOT_FOUND', 'Prévia indisponível.')
    const admission = this.options.repository.admissions().find(item => item.preview_id === preview.preview_id
      && item.cookie_hash === hashSecret(cookie) && item.revoked_at === null && Date.parse(item.expires_at) > now.getTime())
    if (admission === undefined) throw new PreviewError('NOT_FOUND', 'Prévia indisponível.')
    const active = this.options.sessions.isActive({ sessionId: admission.source_session_id, userId: admission.user_id, orgId: admission.org_id, tenantId: admission.tenant_id })
    if (!active || !this.options.sessions.canRead({ userId: admission.user_id, orgId: admission.org_id, tenantId: admission.tenant_id })) {
      throw new PreviewError('FORBIDDEN', 'Seu acesso a esta prévia foi encerrado.')
    }
    return { previewId: preview.preview_id, runtimeRef: preview.runtime_ref }
  }

  async reap(): Promise<number> {
    const now = this.#now().getTime()
    const expired = this.options.repository.previews().filter(item => ACTIVE_STATES.has(item.state) && Date.parse(item.expires_at) <= now)
    let reaped = 0
    for (const candidate of expired) {
      await this.#mutex.run(scopeProjectKey(candidate), async () => {
        await this.#mutex.run(`preview:${candidate.preview_id}`, async () => {
          const current = this.options.repository.previews().find(item => item.preview_id === candidate.preview_id)
          if (current === undefined || !ACTIVE_STATES.has(current.state) || Date.parse(current.expires_at) > this.#now().getTime()) return
          if (current.runtime_ref !== null) await this.#runtimeCall('RUNTIME_STOP_TIMEOUT', signal => this.options.runtime.stop(current.runtime_ref!, signal)).catch(() => undefined)
          await this.options.repository.putPreview(previewRecordSchema.parse({ ...current, state: 'EXPIRED', stopped_at: this.#now().toISOString(), stop_reason: 'expired', health: 'DOWN' }))
          await this.#revokeAdmissions(current.preview_id)
          reaped++
        })
      })
    }
    return reaped
  }

  async reconcile(): Promise<{ readonly stoppedOrphans: number; readonly failedRecords: number }> {
    const managed = await this.#runtimeCall('RUNTIME_LIST_TIMEOUT', signal => this.options.runtime.listManaged(signal))
    const records = this.options.repository.previews()
    let stoppedOrphans = 0
    for (const runtime of managed) {
      const record = records.find(candidate => candidate.preview_id === runtime.previewId && candidate.runtime_ref === runtime.runtimeRef)
      if (record === undefined || ['STOPPED', 'FAILED', 'EXPIRED'].includes(record.state)) {
        try {
          await this.#runtimeCall('RUNTIME_STOP_TIMEOUT', signal => this.options.runtime.stop(runtime.runtimeRef, signal))
          stoppedOrphans++
        } catch { /* O próximo ciclo tenta novamente sem impedir os demais runtimes. */ }
      }
    }
    let failedRecords = 0
    for (const snapshot of records.filter(item => !['STOPPED', 'FAILED', 'EXPIRED'].includes(item.state))) {
      await this.#mutex.run(scopeProjectKey(snapshot), async () => {
        await this.#mutex.run(`preview:${snapshot.preview_id}`, async () => {
          const record = this.options.repository.previews().find(item => item.preview_id === snapshot.preview_id)
          if (record === undefined || ['STOPPED', 'FAILED', 'EXPIRED'].includes(record.state)) return
          const runtime = record.runtime_ref === null ? undefined : managed.find(item => item.previewId === record.preview_id && item.runtimeRef === record.runtime_ref)
          if (Date.parse(record.expires_at) <= this.#now().getTime()) {
            if (runtime !== undefined) await this.#runtimeCall('RUNTIME_STOP_TIMEOUT', signal => this.options.runtime.stop(runtime.runtimeRef, signal)).catch(() => undefined)
            await this.options.repository.putPreview(previewRecordSchema.parse({ ...record, state: 'EXPIRED', health: 'DOWN', stopped_at: this.#now().toISOString(), stop_reason: 'expired' }))
            await this.#revokeAdmissions(record.preview_id)
            return
          }
          if (record.state === 'STOPPING') {
            if (runtime !== undefined) await this.#runtimeCall('RUNTIME_STOP_TIMEOUT', signal => this.options.runtime.stop(runtime.runtimeRef, signal)).catch(() => undefined)
            await this.options.repository.putPreview(previewRecordSchema.parse({ ...record, state: 'STOPPED', health: 'DOWN', stopped_at: this.#now().toISOString(), stop_reason: 'reconciled' }))
            await this.#revokeAdmissions(record.preview_id)
            return
          }
          if (record.state !== 'READY' || runtime === undefined) {
            await this.options.repository.putPreview(previewRecordSchema.parse({ ...record, state: 'FAILED', health: 'DOWN', stopped_at: this.#now().toISOString(), stop_reason: 'reconciled', failure_code: record.state === 'READY' ? 'RUNTIME_MISSING' : 'RESTART_DURING_START' }))
            await this.#revokeAdmissions(record.preview_id)
            failedRecords++
          }
        })
      })
    }
    return { stoppedOrphans, failedRecords }
  }

  async health(actor: PreviewActor, projectId: string, previewId: string): Promise<PublicPreview> {
    this.#authorize(actor, 'project.read')
    return this.#mutex.run(`${actor.orgId}:${actor.tenantId}:${projectId}`, async () => {
      return this.#mutex.run(`preview:${previewId}`, async () => {
        let record = this.#preview(actor, projectId, previewId)
        if (record.state === 'READY' && record.runtime_ref !== null) {
          const health = await this.#runtimeCall('RUNTIME_HEALTH_TIMEOUT', signal => this.options.runtime.health(record.runtime_ref!, signal)).catch(() => 'DOWN' as const)
          record = this.#preview(actor, projectId, previewId)
          if (record.state === 'READY' && record.runtime_ref !== null) {
            record = previewRecordSchema.parse({ ...record, health })
            await this.options.repository.putPreview(record)
          }
        }
        return this.public(record)
      })
    })
  }

  async logs(actor: PreviewActor, projectId: string, previewId: string, limit = 100): Promise<readonly PreviewLogEvent[]> {
    this.#authorize(actor, 'project.read')
    const record = this.#preview(actor, projectId, previewId)
    if (record.runtime_ref === null) return []
    const events = await this.#runtimeCall('RUNTIME_LOGS_TIMEOUT', signal => this.options.runtime.logs(record.runtime_ref!, Math.min(200, Math.max(1, limit)), signal))
    return events.flatMap(event => {
      const parsed = previewLogEventSchema.safeParse(event)
      return parsed.success ? [parsed.data] : []
    })
  }

  async verificationMessages(actor: PreviewActor, projectId: string, previewId: string): Promise<readonly PreviewVerificationMessage[]> {
    this.#authorize(actor, 'project.write')
    const record = this.#preview(actor, projectId, previewId)
    if (record.state !== 'READY' || record.runtime_ref === null) return []
    const messages = await this.#runtimeCall('RUNTIME_MESSAGES_TIMEOUT', signal => this.options.runtime.verificationMessages(record.runtime_ref!, signal))
    return messages.slice(-20).flatMap(message => {
      const parsed = previewVerificationMessageSchema.safeParse(message)
      return parsed.success ? [parsed.data] : []
    })
  }

  public(record: PreviewRecord): PublicPreview {
    return {
      preview_id: record.preview_id, project_id: record.project_id, run_id: record.run_id,
      artifact_sha256: record.artifact_sha256, state: record.state, health: record.health,
      url: `http://${record.hostname}${this.#publicPort === 80 ? '' : `:${this.#publicPort}`}`, created_at: record.created_at, ready_at: record.ready_at,
      expires_at: record.expires_at, stopped_at: record.stopped_at,
      stop_reason: record.stop_reason, failure_code: record.failure_code,
    }
  }

  #preview(actor: PreviewActor, projectId: string, previewId: string): PreviewRecord {
    const value = this.options.repository.previews().find(item => item.preview_id === previewId && item.project_id === projectId && sameScope(item, actor))
    if (value === undefined) throw new PreviewError('NOT_FOUND', 'Prévia não encontrada.')
    return value
  }

  #authorize(actor: PreviewActor, permission: 'project.read' | 'project.write'): void {
    if (!roleAllows(actor.role, permission)) throw new PreviewError('FORBIDDEN', 'Seu papel neste espaço não permite esta ação.')
  }

  async #issueAdmission(actor: PreviewActor, preview: PreviewRecord): Promise<string> {
    const ticket = this.#createSecret()
    const admission = previewAdmissionSchema.parse({
      admission_id: this.#createId(), preview_id: preview.preview_id,
      org_id: actor.orgId, tenant_id: actor.tenantId, user_id: actor.userId, source_session_id: actor.sessionId,
      ticket_hash: hashSecret(ticket), cookie_hash: null, created_at: this.#now().toISOString(),
      expires_at: preview.expires_at, exchanged_at: null, revoked_at: null,
    })
    await this.options.repository.putAdmission(admission)
    return ticket
  }

  async #revokeAdmissions(previewId: string): Promise<void> {
    const now = this.#now().toISOString()
    await Promise.all(this.options.repository.admissions().filter(item => item.preview_id === previewId && item.revoked_at === null)
      .map(item => this.options.repository.putAdmission(previewAdmissionSchema.parse({ ...item, revoked_at: now }))))
  }

  async #runtimeCall<T>(code: string, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error(code))
        reject(new PreviewError('UNAVAILABLE', 'O supervisor da prévia não respondeu dentro do prazo seguro.'))
      }, this.#runtimeTimeoutMs)
      timer.unref?.()
    })
    try { return await Promise.race([call(controller.signal), timeout]) }
    finally { if (timer !== undefined) clearTimeout(timer) }
  }
}

function validPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('publicPort deve ser uma porta TCP válida.')
  return port
}

function sameScope(record: Pick<PreviewRecord, 'org_id' | 'tenant_id'>, actor: PreviewActor): boolean {
  return record.org_id === actor.orgId && record.tenant_id === actor.tenantId
}

function scopeProjectKey(record: Pick<PreviewRecord, 'org_id' | 'tenant_id' | 'project_id'>): string {
  return `${record.org_id}:${record.tenant_id}:${record.project_id}`
}

function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/:\d+$/u, '')
}

function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function failureCode(error: unknown): string {
  if (error instanceof PreviewError) return error.code
  return 'RUNTIME_START_FAILED'
}
