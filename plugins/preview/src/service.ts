import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { roleAllows, type StudioRole } from '@dz23-studio/policy'
import {
  CapacityGovernorError,
  isDistributedCapacityGovernor,
  MAX_LEASE_TTL_MS,
  MIN_LEASE_TTL_MS,
  MemoryCapacityGovernor,
  type CapacityGovernor,
  type CapacityLease,
  type DistributedCapacityGovernor,
  type LeaseReference,
} from '@dz23-studio/runtime-governor'
import { z } from 'zod'
import { previewAdmissionSchema, previewRecordSchema, type PreviewAdmission, type PreviewRecord } from './model.js'
import { KeyedMutex } from './mutex.js'
import { Semaphore, SemaphoreFullError } from './semaphore.js'
import { t } from './i18n.js'

const DEFAULT_TTL_SECONDS = 30 * 60
const MAX_TTL_SECONDS = 2 * 60 * 60
const TICKET_TTL_SECONDS = 2 * 60
const CAPACITY_RELEASE_PENDING = 'CAPACITY_RELEASE_PENDING'
const ACTIVE_STATES = new Set<PreviewRecord['state']>(['REQUESTED', 'STARTING', 'READY', 'STOPPING'])

/**
 * Quantas verificações de artefato podem correr ao mesmo tempo, e quantas podem
 * esperar.
 *
 * A verificação lê e resume a árvore inteira do artefato — até 160 MiB — e
 * acontece ANTES de qualquer reserva de capacidade. O mutex que serializa o
 * início é POR PROJETO, então projetos diferentes não se seguram: sem este
 * teto, uma conta com muitos projetos produz leituras e hashes simultâneos sem
 * limite, e satura a máquina sem estourar cota nenhuma.
 *
 * Quatro é o valor padrão porque o trabalho é de disco e CPU ao mesmo tempo;
 * a fila curta existe para recusar rápido em vez de acumular espera que já não
 * serve a ninguém.
 */
const ARTIFACT_VERIFICATION_LIMIT = 4
const ARTIFACT_VERIFICATION_QUEUE_LIMIT = 32

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
  readonly ownerEmail: string
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
    readonly ownerEmail: string
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
  readonly onCleanupFailure?: (previewId: string) => void
  readonly capacity?: CapacityGovernor
  /** single-process is development-only; team and edge require an injected distributed governor. */
  readonly capacityMode?: 'single-process' | 'team' | 'edge'
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
  constructor(readonly code: 'NOT_FOUND' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'INVALID' | 'CONFLICT' | 'UNAVAILABLE' | 'CAPACITY_EXCEEDED', message: string) { super(message) }
}

export class StudioPreviewService {
  readonly #now: () => Date
  readonly #createId: () => string
  readonly #createSecret: () => string
  readonly #ttlSeconds: number
  readonly #publicPort: number
  readonly #runtimeTimeoutMs: number
  readonly #capacity: CapacityGovernor
  readonly #distributedCapacity: DistributedCapacityGovernor | undefined
  readonly #capacityLeases = new Map<string, LeaseReference>()
  readonly #capacityReleasePending = new Set<string>()
  readonly #mutex = new KeyedMutex()
  readonly #artifactVerification = new Semaphore(ARTIFACT_VERIFICATION_LIMIT, ARTIFACT_VERIFICATION_QUEUE_LIMIT)

  constructor(private readonly options: PreviewServiceOptions) {
    this.#now = options.now ?? (() => new Date())
    this.#createId = options.createId ?? randomUUID
    this.#createSecret = options.createSecret ?? (() => randomBytes(32).toString('base64url'))
    this.#ttlSeconds = Math.min(MAX_TTL_SECONDS, Math.max(60, options.ttlSeconds ?? DEFAULT_TTL_SECONDS))
    this.#publicPort = validPort(options.publicPort ?? 80)
    this.#runtimeTimeoutMs = Math.min(30_000, Math.max(10, options.runtimeTimeoutMs ?? 10_000))
    const capacityMode = options.capacityMode ?? 'single-process'
    if (capacityMode !== 'single-process' && options.capacity === undefined) {
      throw new Error(t('service.distributedCapacityRequired'))
    }
    if (capacityMode !== 'single-process' && options.capacity instanceof MemoryCapacityGovernor) {
      throw new Error(t('service.memoryCapacitySingleProcessOnly'))
    }
    this.#capacity = options.capacity ?? new MemoryCapacityGovernor()
    this.#distributedCapacity = isDistributedCapacityGovernor(this.#capacity) ? this.#capacity : undefined
    if (capacityMode !== 'single-process' && this.#distributedCapacity === undefined) {
      throw new Error(t('service.distributedCapacityRequired'))
    }
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
      await this.#assertQuarantineCapacity(actor)
      const artifact = await this.#artifactVerification.run(
        () => this.options.source.verifiedArtifact(actor, projectId, runId),
      ).catch((error: unknown) => {
        if (error instanceof SemaphoreFullError) throw new PreviewError('UNAVAILABLE', t('service.verificationBusy'))
        throw error
      })
      if (!/^[a-f0-9]{64}$/u.test(artifact.artifactSha256)) throw new PreviewError('INVALID', t('service.invalidArtifactHash'))
      const existing = this.options.repository.previews().find(item => sameScope(item, actor)
        && item.project_id === projectId && item.run_id === artifact.runId
        && item.artifact_sha256 === artifact.artifactSha256 && item.state === 'READY'
        && item.runtime_ref !== null && Date.parse(item.expires_at) > this.#now().getTime())
      if (existing !== undefined) {
        const reusable = await this.#mutex.run(`preview:${existing.preview_id}`, async () => {
          const current = this.options.repository.previews().find(item => item.preview_id === existing.preview_id)
          if (current === undefined || current.state !== 'READY' || current.runtime_ref === null || Date.parse(current.expires_at) <= this.#now().getTime()) return undefined
          try {
            await this.#ensureCapacity(current)
          } catch (error) {
            await this.#failClosedForCapacity(current, failureCode(error))
            throw error
          }
          const health = await this.#runtimeCall('RUNTIME_HEALTH_TIMEOUT', signal => this.options.runtime.health(current.runtime_ref!, signal)).catch(() => 'DOWN' as const)
          if (health === 'OK') {
            const refreshed = previewRecordSchema.parse({ ...current, health: 'OK' })
            await this.options.repository.putPreview(refreshed)
            return refreshed
          }
          let cleanupIncomplete = false
          try { await this.#runtimeCall('RUNTIME_STOP_TIMEOUT', signal => this.options.runtime.stop(current.runtime_ref!, signal)) }
          catch { cleanupIncomplete = true; this.options.onCleanupFailure?.(current.preview_id) }
          const failedBase = previewRecordSchema.parse({
            ...current,
            state: 'STOPPING', health: 'DOWN', stopped_at: null, stop_reason: 'failed',
            failure_code: cleanupIncomplete ? 'RUNTIME_CLEANUP_INCOMPLETE' : 'RUNTIME_DOWN',
          })
          if (cleanupIncomplete) {
            await this.options.repository.putPreview(failedBase)
            await this.#revokeAdmissions(current.preview_id)
            await this.#retainCleanupCapacity(failedBase)
            throw new PreviewError('UNAVAILABLE', t('service.previousStopFailed'))
          }
          const failed = await this.#settleRuntimeAbsent(failedBase, 'FAILED', 'RUNTIME_DOWN')
          if (failed.state === 'STOPPING') throw new PreviewError('UNAVAILABLE', t('service.previousStopFailed'))
          return undefined
        })
        if (reusable !== undefined) {
          const ticket = await this.#issueAdmission(actor, reusable)
          return { preview: this.public(reusable), admissionTicket: ticket }
        }
      }

      const prior = this.options.repository.previews().filter(item => sameScope(item, actor)
        && item.project_id === projectId && ACTIVE_STATES.has(item.state))
      for (const candidate of prior) await this.#retireForReplacement(candidate)

      const now = this.#now()
      const previewId = this.#createId()
      const hostname = `p-${randomBytes(12).toString('hex')}.dz23.localhost`
      const initial = previewRecordSchema.parse({
        preview_id: previewId, org_id: actor.orgId, tenant_id: actor.tenantId,
        project_id: projectId, run_id: artifact.runId, artifact_sha256: artifact.artifactSha256,
        created_by: actor.userId, source_session_id: actor.sessionId, hostname,
        state: 'REQUESTED', created_at: now.toISOString(), ready_at: null,
        expires_at: new Date(now.getTime() + this.#ttlSeconds * 1000).toISOString(),
        stopped_at: null, stop_reason: null, failure_code: null, runtime_ref: null, health: 'PENDING',
      })
      await this.#acquireCapacity(initial)
      try {
        await this.options.repository.putPreview(initial)
      } catch (error) {
        if (!await this.#releaseCapacity(previewId)) {
          throw new PreviewError('UNAVAILABLE', t('service.capacityUnavailable'))
        }
        throw error
      }
      return this.#mutex.run(`preview:${previewId}`, async () => {
        let record = previewRecordSchema.parse({ ...initial, state: 'STARTING' })
        let startedRuntimeRef: string | undefined
        try {
          await this.options.repository.putPreview(record)
          const started = await this.#runtimeCall('RUNTIME_START_TIMEOUT', signal => this.options.runtime.start({
            previewId, artifactPath: artifact.artifactPath, artifactSha256: artifact.artifactSha256,
            ownerEmail: artifact.ownerEmail,
            labels: { 'dz23.managed': 'preview', 'dz23.preview_id': previewId },
            environment: { APP_EMAIL_MODE: 'studio-preview', APP_OWNER_EMAIL: artifact.ownerEmail, DZ23_PREVIEW_ID: previewId, DATA_DIR: '/preview-storage/data' },
          }, signal))
          startedRuntimeRef = started.runtimeRef
          if (!/^[a-zA-Z0-9_.:-]{1,200}$/u.test(started.runtimeRef)) throw new PreviewError('UNAVAILABLE', t('service.invalidRuntimeRef'))
          const readiness = await this.#runtimeCall('RUNTIME_HEALTH_TIMEOUT', signal => this.options.runtime.health(started.runtimeRef, signal))
          if (readiness !== 'OK') throw new PreviewError('UNAVAILABLE', t('service.readinessFailed'))
          if (Date.parse(record.expires_at) - this.#now().getTime() < MIN_LEASE_TTL_MS) {
            throw new PreviewError('UNAVAILABLE', t('service.readinessFailed'))
          }
          record = previewRecordSchema.parse({ ...record, state: 'READY', ready_at: this.#now().toISOString(), runtime_ref: started.runtimeRef, health: 'OK' })
          await this.#ensureCapacity(record)
          await this.options.repository.putPreview(record)
          const ticket = await this.#issueAdmission(actor, record)
          return { preview: this.public(record), admissionTicket: ticket }
        } catch (error) {
          let cleanupIncomplete = false
          if (startedRuntimeRef !== undefined) {
            try { await this.#runtimeCall('RUNTIME_STOP_TIMEOUT', signal => this.options.runtime.stop(startedRuntimeRef!, signal)) }
            catch { cleanupIncomplete = true; this.options.onCleanupFailure?.(previewId) }
          } else {
            const managed = await this.#runtimeInventory()
            const ambiguousRuntime = managed?.find(item => item.previewId === previewId)
            // A failed/aborted start can materialize after the first inventory
            // response. Keep the admission lease quarantined until a later
            // reconciliation cycle proves the runtime is absent.
            cleanupIncomplete = true
            this.options.onCleanupFailure?.(previewId)
            if (ambiguousRuntime !== undefined) {
              startedRuntimeRef = ambiguousRuntime.runtimeRef
              try {
                await this.#runtimeCall('RUNTIME_STOP_TIMEOUT', signal => this.options.runtime.stop(ambiguousRuntime.runtimeRef, signal))
                const afterStop = await this.#runtimeInventory()
                cleanupIncomplete = afterStop === undefined || afterStop.some(item => item.previewId === previewId)
                if (cleanupIncomplete) this.options.onCleanupFailure?.(previewId)
              } catch {
                cleanupIncomplete = true
                this.options.onCleanupFailure?.(previewId)
              }
            }
          }
          const failedBase = previewRecordSchema.parse({
            ...record,
            state: 'STOPPING', stopped_at: null,
            stop_reason: 'failed',
            failure_code: failureCode(error),
            runtime_ref: startedRuntimeRef ?? record.runtime_ref,
            health: 'DOWN',
          })
          if (cleanupIncomplete) {
            await this.options.repository.putPreview(failedBase)
            await this.#revokeAdmissions(previewId)
            await this.#retainCleanupCapacity(failedBase)
          } else {
            await this.#settleRuntimeAbsent(failedBase, 'FAILED', failureCode(error))
          }
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
          catch { cleanupIncomplete = true; this.options.onCleanupFailure?.(previewId) }
        }
        const stoppedBase = previewRecordSchema.parse({
          ...record,
          state: 'STOPPING', stopped_at: null,
          stop_reason: 'user', health: 'DOWN',
          failure_code: cleanupIncomplete ? 'RUNTIME_CLEANUP_INCOMPLETE' : record.failure_code,
        })
        if (cleanupIncomplete) {
          await this.options.repository.putPreview(stoppedBase)
          await this.#revokeAdmissions(stoppedBase.preview_id)
          await this.#retainCleanupCapacity(stoppedBase)
          return this.public(stoppedBase)
        }
        return this.public(await this.#settleRuntimeAbsent(stoppedBase, 'STOPPED', record.failure_code))
      })
    })
  }

  async heartbeat(actor: PreviewActor, projectId: string, previewId: string): Promise<PublicPreview> {
    this.#authorize(actor, 'project.write')
    return this.#mutex.run(`${actor.orgId}:${actor.tenantId}:${projectId}`, async () => {
      return this.#mutex.run(`preview:${previewId}`, async () => {
        const record = this.#preview(actor, projectId, previewId)
        const now = this.#now()
        if (record.state !== 'READY' || record.runtime_ref === null || Date.parse(record.expires_at) <= now.getTime()) {
          throw new PreviewError('CONFLICT', t('service.alreadyStopped'))
        }
        const health = await this.#runtimeCall('RUNTIME_HEALTH_TIMEOUT', signal => this.options.runtime.health(record.runtime_ref!, signal))
        if (health !== 'OK') throw new PreviewError('UNAVAILABLE', t('service.unhealthy'))
        const absoluteExpiry = Date.parse(record.created_at) + MAX_TTL_SECONDS * 1000
        const renewedExpiry = Math.min(absoluteExpiry, Math.max(Date.parse(record.expires_at), now.getTime() + this.#ttlSeconds * 1000))
        const updated = previewRecordSchema.parse({ ...record, health: 'OK', expires_at: new Date(renewedExpiry).toISOString() })
        try {
          await this.#ensureCapacity(updated)
        } catch (error) {
          await this.#failClosedForCapacity(record, failureCode(error))
          throw error
        }
        await this.options.repository.putPreview(updated)
        await this.#mutex.run(`admissions:${previewId}`, async () => {
          await Promise.all(this.options.repository.admissions()
            .filter(item => item.preview_id === previewId && item.revoked_at === null && item.exchanged_at !== null)
            .map(item => this.options.repository.putAdmission(previewAdmissionSchema.parse({ ...item, expires_at: updated.expires_at }))))
        })
        return this.public(updated)
      })
    })
  }

  async exchange(hostname: string, ticket: string): Promise<{ readonly cookie: string; readonly maxAge: number }> {
    const ticketHash = hashSecret(ticket)
    return this.#mutex.run(`admission:${ticketHash}`, async () => {
      const snapshot = this.options.repository.admissions().find(item => item.ticket_hash === ticketHash)
      if (snapshot === undefined) throw new PreviewError('NOT_FOUND', t('service.invalidOrExpiredTicket'))
      return this.#mutex.run(`admissions:${snapshot.preview_id}`, async () => {
        const now = this.#now()
        const preview = this.options.repository.previews().find(item => item.preview_id === snapshot.preview_id && item.hostname === normalizeHost(hostname))
        if (preview === undefined || preview.state !== 'READY' || Date.parse(preview.expires_at) <= now.getTime()) throw new PreviewError('NOT_FOUND', t('service.unavailable'))
        const admission = this.options.repository.admissions().find(item => item.preview_id === preview.preview_id
          && item.ticket_hash === ticketHash && item.exchanged_at === null && item.revoked_at === null)
        if (admission === undefined || Date.parse(admission.expires_at) <= now.getTime()) throw new PreviewError('NOT_FOUND', t('service.invalidOrExpiredTicket'))
        if (!this.options.sessions.isActive({ sessionId: admission.source_session_id, userId: admission.user_id, orgId: admission.org_id, tenantId: admission.tenant_id })) {
          throw new PreviewError('FORBIDDEN', t('service.sessionInactive'))
        }
        const cookie = this.#createSecret()
        await this.options.repository.putAdmission(previewAdmissionSchema.parse({
          ...admission,
          ticket_hash: hashSecret(this.#createSecret()),
          cookie_hash: hashSecret(cookie),
          exchanged_at: now.toISOString(),
          expires_at: preview.expires_at,
        }))
        return { cookie, maxAge: Math.max(0, Math.floor((Date.parse(preview.expires_at) - now.getTime()) / 1000)) }
      })
    })
  }

  authorize(hostname: string, cookie: string): { readonly previewId: string; readonly runtimeRef: string; readonly maxAge: number } {
    const now = this.#now()
    const preview = this.options.repository.previews().find(item => item.hostname === normalizeHost(hostname))
    if (preview === undefined) throw new PreviewError('NOT_FOUND', t('service.unavailable'))
    if (preview.state !== 'READY' || preview.runtime_ref === null || Date.parse(preview.expires_at) <= now.getTime()) {
      throw new PreviewError('UNAUTHENTICATED', t('service.accessExpired'))
    }
    const admission = this.options.repository.admissions().find(item => item.preview_id === preview.preview_id
      && item.cookie_hash === hashSecret(cookie))
    if (admission === undefined || admission.revoked_at !== null || Date.parse(admission.expires_at) <= now.getTime()) {
      throw new PreviewError('UNAUTHENTICATED', t('service.accessExpired'))
    }
    const active = this.options.sessions.isActive({ sessionId: admission.source_session_id, userId: admission.user_id, orgId: admission.org_id, tenantId: admission.tenant_id })
    if (!active || !this.options.sessions.canRead({ userId: admission.user_id, orgId: admission.org_id, tenantId: admission.tenant_id })) {
      throw new PreviewError('UNAUTHENTICATED', t('service.accessExpired'))
    }
    return {
      previewId: preview.preview_id,
      runtimeRef: preview.runtime_ref,
      maxAge: Math.max(0, Math.floor((Date.parse(admission.expires_at) - now.getTime()) / 1000)),
    }
  }

  async reap(): Promise<number> {
    return this.#mutex.run('maintenance', () => this.#reap())
  }

  async #reap(): Promise<number> {
    await this.#maintainActiveCapacity()
    const managed = await this.#runtimeCall('RUNTIME_LIST_TIMEOUT', signal => this.options.runtime.listManaged(signal))
    await this.#capacity.reconcile()
    const now = this.#now().getTime()
    let reaped = 0

    const stopping = this.options.repository.previews().filter(item => item.state === 'STOPPING')
    for (const candidate of stopping) {
      await this.#mutex.run(scopeProjectKey(candidate), async () => {
        await this.#mutex.run(`preview:${candidate.preview_id}`, async () => {
          let current = this.options.repository.previews().find(item => item.preview_id === candidate.preview_id)
          if (current === undefined || current.state !== 'STOPPING') return
          // Runtime references may change while a supervisor reconciles or
          // replaces a container. The preview id is the stable ownership key:
          // any managed runtime for this preview keeps the capacity lease in
          // quarantine until its absence is observed.
          const live = managed.find(item => item.previewId === current!.preview_id)
          if (live !== undefined) {
            if (current.runtime_ref === null) {
              current = previewRecordSchema.parse({ ...current, runtime_ref: live.runtimeRef })
              await this.options.repository.putPreview(current)
            }
            try {
              await this.#runtimeCall('RUNTIME_STOP_TIMEOUT', signal => this.options.runtime.stop(live.runtimeRef, signal))
            } catch {
              await this.#retainCleanupCapacity(current)
              this.options.onCleanupFailure?.(current.preview_id)
              return
            }
          }
          if (current.failure_code === 'CAPACITY_RECOVERY_QUARANTINE') {
            await this.#retainCleanupCapacity(current)
            return
          }
          const terminalState = terminalStateFor(current)
          const settled = await this.#settleRuntimeAbsent(current, terminalState, current.failure_code)
          if (settled.state === 'EXPIRED') reaped++
        })
      })
    }

    const expired = this.options.repository.previews().filter(item => item.state !== 'STOPPING'
      && ACTIVE_STATES.has(item.state) && Date.parse(item.expires_at) <= now)
    for (const candidate of expired) {
      await this.#mutex.run(scopeProjectKey(candidate), async () => {
        await this.#mutex.run(`preview:${candidate.preview_id}`, async () => {
          const current = this.options.repository.previews().find(item => item.preview_id === candidate.preview_id)
          if (current === undefined || !ACTIVE_STATES.has(current.state) || Date.parse(current.expires_at) > this.#now().getTime()) return
          let cleanupIncomplete = false
          if (current.runtime_ref !== null) {
            try { await this.#runtimeCall('RUNTIME_STOP_TIMEOUT', signal => this.options.runtime.stop(current.runtime_ref!, signal)) }
            catch { cleanupIncomplete = true; this.options.onCleanupFailure?.(current.preview_id) }
          }
          const expiredBase = previewRecordSchema.parse({
            ...current,
            state: 'STOPPING', stopped_at: null,
            stop_reason: 'expired', health: 'DOWN',
            failure_code: cleanupIncomplete ? 'RUNTIME_CLEANUP_INCOMPLETE' : current.failure_code,
          })
          if (cleanupIncomplete) {
            await this.options.repository.putPreview(expiredBase)
            await this.#revokeAdmissions(current.preview_id)
            await this.#retainCleanupCapacity(expiredBase)
            return
          }
          const settled = await this.#settleRuntimeAbsent(expiredBase, 'EXPIRED', current.failure_code)
          if (settled.state === 'EXPIRED') reaped++
        })
      })
    }
    return reaped
  }

  async reconcile(): Promise<{ readonly stoppedOrphans: number; readonly failedRecords: number }> {
    return this.#mutex.run('maintenance', () => this.#reconcile())
  }

  async #reconcile(): Promise<{ readonly stoppedOrphans: number; readonly failedRecords: number }> {
    const managed = await this.#runtimeCall('RUNTIME_LIST_TIMEOUT', signal => this.options.runtime.listManaged(signal))
    await this.#capacity.reconcile()
    const records = this.options.repository.previews()
    let stoppedOrphans = 0
    for (const runtime of managed) {
      const record = records.find(candidate => candidate.preview_id === runtime.previewId && candidate.runtime_ref === runtime.runtimeRef)
      if (record === undefined || ['STOPPED', 'FAILED', 'EXPIRED'].includes(record.state)) {
        try {
          await this.#runtimeCall('RUNTIME_STOP_TIMEOUT', signal => this.options.runtime.stop(runtime.runtimeRef, signal))
          if (!await this.#runtimeAbsent(runtime.previewId)) {
            throw new PreviewError('UNAVAILABLE', t('service.previousStopFailed'))
          }
          // A runtime de uma instância anterior pode materializar tarde. Sem
          // fencing aplicado pelo supervisor, liberar a lease aqui permitiria
          // um processo vivo sem contabilização. A etapa seguinte mantém a
          // capacidade em quarentena fail-closed.
          stoppedOrphans++
        } catch {
          this.options.onCleanupFailure?.(runtime.previewId)
          /* O próximo ciclo tenta novamente sem impedir os demais runtimes. */
        }
      }
    }
    await this.#quarantineDetachedCapacity(managed)
    let failedRecords = 0
    for (const snapshot of records.filter(item => !['STOPPED', 'FAILED', 'EXPIRED'].includes(item.state))) {
      await this.#mutex.run(scopeProjectKey(snapshot), async () => {
        await this.#mutex.run(`preview:${snapshot.preview_id}`, async () => {
          const record = this.options.repository.previews().find(item => item.preview_id === snapshot.preview_id)
          if (record === undefined || ['STOPPED', 'FAILED', 'EXPIRED'].includes(record.state)) return
          try {
            await this.#recoverCapacity(record)
          } catch (error) {
            if (!(error instanceof PreviewError) || error.code !== 'CAPACITY_EXCEEDED') throw error
            await this.#failClosedForCapacity(record, error.code)
            failedRecords++
            return
          }
          const runtime = record.runtime_ref === null ? undefined : managed.find(item => item.previewId === record.preview_id && item.runtimeRef === record.runtime_ref)
          if (record.state === 'STOPPING' && record.failure_code === 'CAPACITY_RECOVERY_QUARANTINE') {
            const quarantinedRuntime = managed.find(item => item.previewId === record.preview_id)
            if (quarantinedRuntime !== undefined) {
              try { await this.#runtimeCall('RUNTIME_STOP_TIMEOUT', signal => this.options.runtime.stop(quarantinedRuntime.runtimeRef, signal)) }
              catch { this.options.onCleanupFailure?.(record.preview_id) }
            }
            await this.#revokeAdmissions(record.preview_id)
            await this.#retainCleanupCapacity(record)
            return
          }
          if (Date.parse(record.expires_at) <= this.#now().getTime()) {
            let cleanupIncomplete = false
            if (runtime !== undefined) {
              try { await this.#runtimeCall('RUNTIME_STOP_TIMEOUT', signal => this.options.runtime.stop(runtime.runtimeRef, signal)) }
              catch { cleanupIncomplete = true; this.options.onCleanupFailure?.(record.preview_id) }
            }
            const expiredBase = previewRecordSchema.parse({
              ...record,
              state: 'STOPPING', health: 'DOWN', stopped_at: null,
              stop_reason: 'expired',
              failure_code: cleanupIncomplete ? 'RUNTIME_CLEANUP_INCOMPLETE' : record.failure_code,
            })
            if (cleanupIncomplete) {
              await this.options.repository.putPreview(expiredBase)
              await this.#revokeAdmissions(record.preview_id)
              await this.#retainCleanupCapacity(expiredBase)
            } else {
              await this.#settleRuntimeAbsent(expiredBase, 'EXPIRED', record.failure_code)
            }
            return
          }
          if (record.state === 'STOPPING') {
            let cleanupIncomplete = false
            if (runtime !== undefined) {
              try { await this.#runtimeCall('RUNTIME_STOP_TIMEOUT', signal => this.options.runtime.stop(runtime.runtimeRef, signal)) }
              catch { cleanupIncomplete = true; this.options.onCleanupFailure?.(record.preview_id) }
            }
            const stoppedBase = previewRecordSchema.parse({
              ...record,
              state: 'STOPPING', health: 'DOWN', stopped_at: null,
              stop_reason: record.stop_reason ?? 'reconciled',
              failure_code: cleanupIncomplete ? 'RUNTIME_CLEANUP_INCOMPLETE' : record.failure_code,
            })
            if (cleanupIncomplete) {
              await this.options.repository.putPreview(stoppedBase)
              await this.#revokeAdmissions(record.preview_id)
              await this.#retainCleanupCapacity(stoppedBase)
            } else {
              await this.#settleRuntimeAbsent(stoppedBase, terminalStateFor(stoppedBase), stoppedBase.failure_code)
            }
            return
          }
          if (record.state === 'READY' && runtime !== undefined) return
          if (record.state !== 'READY' || runtime === undefined) {
            const failedBase = previewRecordSchema.parse({ ...record, state: 'STOPPING', health: 'DOWN', stopped_at: null, stop_reason: 'reconciled', failure_code: record.state === 'READY' ? 'RUNTIME_MISSING' : 'RESTART_DURING_START' })
            await this.#settleRuntimeAbsent(failedBase, 'FAILED', failedBase.failure_code)
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
    const now = this.#now().getTime()
    const admission = this.options.repository.admissions().find(item => item.preview_id === previewId
      && item.org_id === actor.orgId && item.tenant_id === actor.tenantId
      && item.user_id === actor.userId && item.source_session_id === actor.sessionId
      && item.exchanged_at !== null && item.revoked_at === null && Date.parse(item.expires_at) > now)
    if (admission === undefined) {
      throw new PreviewError('FORBIDDEN', t('service.openBeforeCodes'))
    }
    const session = { sessionId: actor.sessionId, userId: actor.userId, orgId: actor.orgId, tenantId: actor.tenantId }
    if (!this.options.sessions.isActive(session) || !this.options.sessions.canRead({ userId: actor.userId, orgId: actor.orgId, tenantId: actor.tenantId })) {
      throw new PreviewError('FORBIDDEN', t('service.signInBeforeCodes'))
    }
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
    if (value === undefined) throw new PreviewError('NOT_FOUND', t('service.notFound'))
    return value
  }

  #authorize(actor: PreviewActor, permission: 'project.read' | 'project.write'): void {
    if (!roleAllows(actor.role, permission)) throw new PreviewError('FORBIDDEN', t('service.roleDenied'))
  }

  async #issueAdmission(actor: PreviewActor, preview: PreviewRecord): Promise<string> {
    const ticket = this.#createSecret()
    const now = this.#now()
    const ticketExpiry = Math.min(Date.parse(preview.expires_at), now.getTime() + TICKET_TTL_SECONDS * 1000)
    const admission = previewAdmissionSchema.parse({
      admission_id: this.#createId(), preview_id: preview.preview_id,
      org_id: actor.orgId, tenant_id: actor.tenantId, user_id: actor.userId, source_session_id: actor.sessionId,
      ticket_hash: hashSecret(ticket), cookie_hash: null, created_at: now.toISOString(),
      expires_at: new Date(ticketExpiry).toISOString(), exchanged_at: null, revoked_at: null,
    })
    await this.#mutex.run(`admissions:${preview.preview_id}`, () => this.options.repository.putAdmission(admission))
    return ticket
  }

  async #retireForReplacement(candidate: PreviewRecord): Promise<void> {
    await this.#mutex.run(`preview:${candidate.preview_id}`, async () => {
      let current = this.options.repository.previews().find(item => item.preview_id === candidate.preview_id)
      if (current === undefined || !ACTIVE_STATES.has(current.state)) return
      current = previewRecordSchema.parse({ ...current, state: 'STOPPING' })
      await this.options.repository.putPreview(current)
      let cleanupIncomplete = false
      if (current.runtime_ref !== null) {
        const runtimeRef = current.runtime_ref
        try { await this.#runtimeCall('RUNTIME_STOP_TIMEOUT', signal => this.options.runtime.stop(runtimeRef, signal)) }
        catch { cleanupIncomplete = true; this.options.onCleanupFailure?.(current.preview_id) }
      }
      const stoppedBase = previewRecordSchema.parse({
        ...current,
        state: 'STOPPING', stopped_at: null,
        stop_reason: 'replaced', health: 'DOWN',
        failure_code: cleanupIncomplete ? 'RUNTIME_CLEANUP_INCOMPLETE' : current.failure_code,
      })
      if (cleanupIncomplete) {
        await this.options.repository.putPreview(stoppedBase)
        await this.#revokeAdmissions(stoppedBase.preview_id)
        await this.#retainCleanupCapacity(stoppedBase)
        throw new PreviewError('UNAVAILABLE', t('service.previousStopFailed'))
      }
      const settled = await this.#settleRuntimeAbsent(stoppedBase, 'STOPPED', current.failure_code)
      if (settled.state === 'STOPPING') throw new PreviewError('UNAVAILABLE', t('service.previousStopFailed'))
    })
  }

  async #maintainActiveCapacity(): Promise<void> {
    const candidates = this.options.repository.previews()
      .filter(record => (record.state === 'READY' && record.runtime_ref !== null && Date.parse(record.expires_at) > this.#now().getTime())
        || record.state === 'STOPPING')
      .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.preview_id.localeCompare(right.preview_id))
    for (const candidate of candidates) {
      await this.#mutex.run(scopeProjectKey(candidate), async () => {
        await this.#mutex.run(`preview:${candidate.preview_id}`, async () => {
          const current = this.options.repository.previews().find(record => record.preview_id === candidate.preview_id)
          if (current === undefined || (current.state !== 'READY' && current.state !== 'STOPPING')) return
          if (current.state === 'READY' && current.runtime_ref === null) return
          try {
            if (this.#distributedCapacity !== undefined && !this.#capacityLeases.has(current.preview_id)) {
              await this.#recoverCapacity(current)
            } else {
              await this.#ensureCapacity(current, current.state === 'STOPPING')
            }
          } catch (error) {
            await this.#failClosedForCapacity(current, failureCode(error))
          }
        })
      })
    }
  }

  async #ensureCapacity(record: PreviewRecord, quarantine = false): Promise<void> {
    const ttlMs = this.#capacityTtlMs(record, quarantine)
    const reference = this.#capacityLeases.get(record.preview_id)
    if (reference !== undefined) {
      try {
        const renewed = await this.#capacity.heartbeat(reference, ttlMs)
        this.#capacityLeases.set(record.preview_id, renewed)
        return
      } catch (error) {
        if (!(error instanceof CapacityGovernorError) || (error.code !== 'LEASE_NOT_FOUND' && error.code !== 'STALE_FENCING_TOKEN')) {
          throw capacityError(error)
        }
        this.#capacityLeases.delete(record.preview_id)
      }
    }
    await this.#acquireCapacity(record, ttlMs)
  }

  async #acquireCapacity(record: PreviewRecord, ttlMs = this.#capacityTtlMs(record)): Promise<void> {
    try {
      const lease = await this.#capacity.acquireBundle({
        ownerId: capacityOwnerId(record.preview_id),
        scope: { orgId: record.org_id, tenantId: record.tenant_id, projectId: record.project_id },
        requests: [{ resource: 'preview' }],
        ttlMs,
      })
      this.#capacityLeases.set(record.preview_id, lease)
    } catch (error) {
      throw capacityError(error)
    }
  }

  async #recoverCapacity(record: PreviewRecord): Promise<void> {
    if (this.#capacityLeases.has(record.preview_id)) {
      await this.#ensureCapacity(record, record.state === 'STOPPING')
      return
    }
    const ttlMs = this.#capacityTtlMs(record, record.state === 'STOPPING')
    let leases: readonly CapacityLease[]
    try {
      leases = (await this.#capacity.snapshot()).leases.filter(lease => lease.ownerId === capacityOwnerId(record.preview_id))
    } catch (error) {
      throw capacityError(error)
    }
    if (leases.length === 0) {
      await this.#acquireCapacity(record, ttlMs)
      return
    }
    assertCompatibleOwnerLeases(record, leases)
    if (leases.length !== 1) throw new PreviewError('UNAVAILABLE', t('service.capacityUnavailable'))
    const canonical = leases[0]!
    try {
      const recovered = this.#distributedCapacity === undefined
        ? await this.#capacity.heartbeat(canonical, ttlMs)
        : await this.#distributedCapacity.takeover({
            reference: canonical,
            ownerId: capacityOwnerId(record.preview_id),
            scope: { orgId: record.org_id, tenantId: record.tenant_id, projectId: record.project_id },
            requests: [{ resource: 'preview' }],
            ttlMs,
          })
      this.#capacityLeases.set(record.preview_id, recovered)
      this.#capacityReleasePending.delete(record.preview_id)
    } catch (error) {
      throw capacityError(error)
    }
  }

  async #releaseCapacity(previewId: string): Promise<boolean> {
    let leases: readonly CapacityLease[]
    try {
      leases = (await this.#capacity.snapshot()).leases.filter(lease => lease.ownerId === capacityOwnerId(previewId))
      if (leases.length > 1) throw new PreviewError('UNAVAILABLE', t('service.capacityUnavailable'))
      for (const lease of leases) {
        try {
          let reference: LeaseReference = lease
          const local = this.#capacityLeases.get(previewId)
          if (this.#distributedCapacity !== undefined
            && (local?.leaseId !== lease.leaseId || local.fencingToken !== lease.fencingToken)) {
            if (!isPreviewCapacityLease(previewId, lease)) throw new PreviewError('UNAVAILABLE', t('service.capacityUnavailable'))
            reference = await this.#distributedCapacity.takeover({
              reference: lease,
              ownerId: lease.ownerId,
              scope: lease.scope,
              requests: [{ resource: 'preview', units: lease.allocations.preview }],
              ttlMs: MIN_LEASE_TTL_MS,
            })
            this.#capacityLeases.set(previewId, reference)
          }
          await this.#capacity.release(reference)
        } catch (error) {
          if (!(error instanceof CapacityGovernorError) || error.code !== 'LEASE_NOT_FOUND') throw error
        }
      }
      this.#capacityLeases.delete(previewId)
      this.#capacityReleasePending.delete(previewId)
      return true
    } catch (error) {
      this.#capacityReleasePending.add(previewId)
      this.options.onCleanupFailure?.(previewId)
      return false
    }
  }

  async #settleRuntimeAbsent(
    record: PreviewRecord,
    terminalState: 'STOPPED' | 'FAILED' | 'EXPIRED',
    failureCode: string | null,
  ): Promise<PreviewRecord> {
    if (!await this.#runtimeAbsent(record.preview_id)) {
      const quarantined = previewRecordSchema.parse({
        ...record,
        state: 'STOPPING',
        stopped_at: null,
        health: 'DOWN',
        failure_code: failureCode ?? record.failure_code ?? 'RUNTIME_CLEANUP_INCOMPLETE',
      })
      await this.options.repository.putPreview(quarantined)
      await this.#revokeAdmissions(record.preview_id)
      await this.#retainCleanupCapacity(quarantined)
      this.options.onCleanupFailure?.(record.preview_id)
      return quarantined
    }
    const released = await this.#releaseCapacity(record.preview_id)
    const settled = previewRecordSchema.parse({
      ...record,
      state: released ? terminalState : 'STOPPING',
      stopped_at: released ? this.#now().toISOString() : null,
      health: 'DOWN',
      failure_code: released ? originalFailureCode(failureCode) : pendingReleaseCode(failureCode),
    })
    await this.options.repository.putPreview(settled)
    await this.#revokeAdmissions(record.preview_id)
    return settled
  }

  async #retainCleanupCapacity(record: PreviewRecord): Promise<void> {
    try {
      await this.#ensureCapacity(record, true)
    } catch {
      this.options.onCleanupFailure?.(record.preview_id)
    }
  }

  /**
   * Renova a capacidade retida por prévias em quarentena antes de conceder mais.
   *
   * A retenção é de TODAS as quarentenas, e continua sendo: capacidade é um
   * recurso compartilhado, e uma quarentena de outro inquilino que perdesse a
   * reserva deixaria um runtime rodando sem ninguém contabilizando.
   *
   * O que mudou é QUEM é reprovado quando essa renovação falha. Antes, qualquer
   * quarentena travada — de qualquer organização ou inquilino — fazia `start`
   * falhar para todo mundo: um inquilino com uma quarentena presa derrubava a
   * prévia de todos os outros, sem tocar em nada que fosse deles. E não havia
   * ganho de segurança nisso: quem impede alocar além do que existe é o próprio
   * governador de capacidade, que já conta a reserva presa. Então agora só o
   * dono da quarentena é reprovado.
   * @param actor - quem está pedindo a prévia.
   */
  async #assertQuarantineCapacity(actor: PreviewActor): Promise<void> {
    const quarantines = this.options.repository.previews().filter(record => record.state === 'STOPPING')
    let own: unknown
    for (const quarantine of quarantines) {
      try {
        await this.#ensureCapacity(quarantine, true)
      } catch (error) {
        if (sameScope(quarantine, actor)) own ??= error
        else this.options.onCleanupFailure?.(quarantine.preview_id)
      }
    }
    if (own !== undefined) throw capacityError(own)
  }

  async #quarantineDetachedCapacity(
    managed: readonly { readonly runtimeRef: string; readonly previewId: string }[],
  ): Promise<void> {
    let leases: readonly CapacityLease[]
    try {
      leases = (await this.#capacity.snapshot()).leases
    } catch (error) {
      throw capacityError(error)
    }
    for (const lease of leases) {
      const previewId = capacityPreviewId(lease.ownerId)
      if (previewId === undefined || this.#capacityLeases.has(previewId)) continue
      const record = this.options.repository.previews().find(candidate => candidate.preview_id === previewId)
      if (record === undefined || !['STOPPED', 'FAILED', 'EXPIRED'].includes(record.state)) continue
      const quarantined = previewRecordSchema.parse({
        ...record,
        state: 'STOPPING', stopped_at: null, health: 'DOWN',
        stop_reason: record.stop_reason ?? 'reconciled',
        failure_code: 'CAPACITY_RECOVERY_QUARANTINE',
      })
      await this.#recoverCapacity(quarantined)
      await this.#ensureCapacity(quarantined, true)
      await this.options.repository.putPreview(quarantined)
      await this.#revokeAdmissions(previewId)
      // Mesmo que o inventário inicial esteja vazio, a instância anterior pode
      // concluir um start depois desta leitura. O supervisor atual ainda não
      // aplica o fencing token em cada operação; portanto não existe prova
      // linearizável de ausência e a lease não pode ser liberada automaticamente.
      if (managed.some(runtime => runtime.previewId === previewId)) this.options.onCleanupFailure?.(previewId)
    }
  }

  async #runtimeInventory(): Promise<readonly { readonly runtimeRef: string; readonly previewId: string }[] | undefined> {
    try {
      return await this.#runtimeCall('RUNTIME_LIST_TIMEOUT', signal => this.options.runtime.listManaged(signal))
    } catch {
      return undefined
    }
  }

  async #runtimeAbsent(previewId: string): Promise<boolean> {
    const managed = await this.#runtimeInventory()
    if (managed === undefined) return false
    return !managed.some(runtime => runtime.previewId === previewId)
  }

  #capacityTtlMs(record: PreviewRecord, quarantine = false): number {
    if (quarantine) return MAX_LEASE_TTL_MS
    const remaining = Date.parse(record.expires_at) - this.#now().getTime()
    return Math.min(MAX_LEASE_TTL_MS, Math.max(MIN_LEASE_TTL_MS, remaining))
  }

  async #failClosedForCapacity(record: PreviewRecord, code: string): Promise<void> {
    let cleanupIncomplete = false
    if (record.state === 'STOPPING' && record.runtime_ref === null) {
      await this.options.repository.putPreview(previewRecordSchema.parse({
        ...record, stopped_at: null, health: 'DOWN', failure_code: 'RUNTIME_CLEANUP_INCOMPLETE',
      }))
      await this.#revokeAdmissions(record.preview_id)
      this.options.onCleanupFailure?.(record.preview_id)
      return
    }
    if (record.runtime_ref !== null) {
      try {
        await this.#runtimeCall('RUNTIME_STOP_TIMEOUT', signal => this.options.runtime.stop(record.runtime_ref!, signal))
      } catch {
        cleanupIncomplete = true
        this.options.onCleanupFailure?.(record.preview_id)
      }
    }
    const failedBase = previewRecordSchema.parse({
      ...record,
      state: 'STOPPING', stopped_at: null,
      stop_reason: 'failed',
      failure_code: code,
      health: 'DOWN',
    })
    if (cleanupIncomplete) {
      await this.options.repository.putPreview(failedBase)
      await this.#revokeAdmissions(record.preview_id)
      await this.#retainCleanupCapacity(failedBase)
      return
    }
    await this.#settleRuntimeAbsent(failedBase, 'FAILED', code)
  }

  async #revokeAdmissions(previewId: string): Promise<void> {
    await this.#mutex.run(`admissions:${previewId}`, async () => {
      const now = this.#now().toISOString()
      await Promise.all(this.options.repository.admissions().filter(item => item.preview_id === previewId && item.revoked_at === null)
        .map(item => this.options.repository.putAdmission(previewAdmissionSchema.parse({ ...item, revoked_at: now }))))
    })
  }

  async #runtimeCall<T>(code: string, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error(code))
        reject(new PreviewError('UNAVAILABLE', t('service.supervisorTimeout')))
      }, this.#runtimeTimeoutMs)
      timer.unref?.()
    })
    try { return await Promise.race([call(controller.signal), timeout]) }
    finally { if (timer !== undefined) clearTimeout(timer) }
  }
}

function validPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(t('plugin.invalidPublicPort'))
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

function capacityError(error: unknown): PreviewError {
  if (error instanceof CapacityGovernorError && error.code === 'CAPACITY_EXCEEDED') {
    return new PreviewError('CAPACITY_EXCEEDED', t('service.capacityExceeded'))
  }
  return new PreviewError('UNAVAILABLE', t('service.capacityUnavailable'))
}

function capacityOwnerId(previewId: string): string {
  return `preview:${previewId}`
}

function capacityPreviewId(ownerId: string): string | undefined {
  return ownerId.startsWith('preview:') && ownerId.length > 'preview:'.length
    ? ownerId.slice('preview:'.length)
    : undefined
}

function assertCompatibleOwnerLeases(record: PreviewRecord, leases: readonly CapacityLease[]): void {
  const compatible = leases.every(lease => lease.scope.orgId === record.org_id
    && lease.scope.tenantId === record.tenant_id
    && lease.scope.projectId === record.project_id
    && lease.allocations.preview === 1
    && lease.allocations['prompt-job'] === 0
    && lease.allocations.build === 0)
  if (!compatible) throw new PreviewError('UNAVAILABLE', t('service.capacityUnavailable'))
}

function isPreviewCapacityLease(previewId: string, lease: CapacityLease): boolean {
  return lease.ownerId === capacityOwnerId(previewId)
    && lease.allocations.preview === 1
    && lease.allocations['prompt-job'] === 0
    && lease.allocations.build === 0
}

function pendingReleaseCode(failureCode: string | null): string {
  if (failureCode?.startsWith(`${CAPACITY_RELEASE_PENDING}:`) === true || failureCode === CAPACITY_RELEASE_PENDING) return failureCode
  return failureCode === null ? CAPACITY_RELEASE_PENDING : `${CAPACITY_RELEASE_PENDING}:${failureCode}`
}

function originalFailureCode(failureCode: string | null): string | null {
  if (failureCode === CAPACITY_RELEASE_PENDING) return null
  const prefix = `${CAPACITY_RELEASE_PENDING}:`
  return failureCode?.startsWith(prefix) === true ? failureCode.slice(prefix.length) : failureCode
}

function terminalStateFor(record: Pick<PreviewRecord, 'stop_reason'>): 'STOPPED' | 'FAILED' | 'EXPIRED' {
  if (record.stop_reason === 'expired') return 'EXPIRED'
  if (record.stop_reason === 'failed') return 'FAILED'
  return 'STOPPED'
}
