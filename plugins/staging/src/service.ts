import { randomUUID } from 'node:crypto'
import type { StudioRole } from '@dz23-studio/policy'
import { z } from 'zod'
import { matchesProviderReceipt, stagingReleaseId, stagingRequestFingerprint, stagingTargetKey } from './artifact.js'
import {
  stagingApprovalReceiptSchema,
  stagingArtifactSchema,
  stagingProviderReceiptSchema,
  stagingProviderConfigSchema,
  stagingReleaseSchema,
  type StagingAction,
  type StagingApprovalReceipt,
  type StagingArtifact,
  type StagingProviderReceipt,
  type StagingRelease,
  type StagingReleaseState,
} from './model.js'
import { t } from './i18n.js'
import { isStagingAuthorized, type StagingAuthorizationPort } from './security.js'

const requestSchema = z.object({
  projectId: z.string().min(1).max(160),
  operationId: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  approvalId: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  runId: z.string().min(1).max(160).optional(),
}).strict()

const rollbackSchema = z.object({
  projectId: z.string().min(1).max(160),
  operationId: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  approvalId: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  targetReleaseId: z.string().regex(/^stg-[a-f0-9]{64}$/u),
}).strict()

export interface StagingActor {
  readonly userId: string
  readonly orgId: string
  readonly tenantId: string
  readonly role: StudioRole
  readonly sessionId: string
}

export interface StagingSourcePort {
  verifiedArtifact(actor: StagingActor, projectId: string, runId?: string): Promise<StagingArtifact>
}

export interface StagingApprovalPort {
  /**
   * Claims an approval idempotently by releaseId + fingerprint. Repeating the
   * exact claim MUST return the same receipt; a conflicting claim MUST fail.
   */
  consume(input: {
    readonly actor: StagingActor
    readonly approvalId: string
    readonly tier: 'T2'
    readonly action: StagingAction
    readonly subjectId: string
    readonly fingerprint: string
    readonly releaseId: string
  }): Promise<
    | { readonly kind: 'approved'; readonly receipt: StagingApprovalReceipt }
    | { readonly kind: 'definitive-denied' }
  >
}

export type StagingProviderStatus =
  | { readonly state: 'READY'; readonly receipt: StagingProviderReceipt }
  | { readonly state: 'UNKNOWN' }

export type StagingProviderResult =
  | { readonly kind: 'accepted'; readonly receipt: StagingProviderReceipt }
  | { readonly kind: 'definitive-no-effect'; readonly failureCode: string }

export interface StagingProviderPort {
  readonly providerId: string
  readonly targetRef: string
  stage(input: {
    readonly environment: 'staging'
    readonly operationId: string
    readonly idempotencyKey: string
    readonly targetGeneration: number
    readonly artifact: StagingArtifact
  }, signal: AbortSignal): Promise<StagingProviderResult>
  rollback(input: {
    readonly environment: 'staging'
    readonly operationId: string
    readonly idempotencyKey: string
    readonly targetGeneration: number
    readonly fromReceiptRef: string
    readonly artifact: StagingArtifact
  }, signal: AbortSignal): Promise<StagingProviderResult>
  status(input: {
    readonly environment: 'staging'
    readonly operationId: string
    readonly idempotencyKey: string
    readonly targetGeneration: number
    readonly artifactSha256: string
  }, signal: AbortSignal): Promise<StagingProviderStatus>
}

export interface StagingRepository {
  releases(actor: StagingActor, projectId: string): readonly StagingRelease[]
  release(actor: StagingActor, projectId: string, releaseId: string): StagingRelease | undefined
  releaseByOperation(actor: StagingActor, projectId: string, operationId: string): StagingRelease | undefined
  /**
   * Atomically reserves the operation and its target. Implementations MUST
   * serialize by the global physical target_key, bind that target permanently
   * to one org/tenant/project scope, allocate a strictly increasing
   * target_generation, and reject a different operation while any non-terminal
   * release owns the target. A replay never creates a second record.
   */
  reserveRelease(record: StagingRelease): Promise<
    | { readonly kind: 'reserved'; readonly release: StagingRelease }
    | { readonly kind: 'replay'; readonly release: StagingRelease }
    | { readonly kind: 'target-busy' }
    | { readonly kind: 'active-conflict' }
  >
  /** Claims an expired lease with a new fencing token; never starts an effect. */
  claimExpiredLease(actor: StagingActor, projectId: string, releaseId: string, expectedVersion: number, leaseId: string, leaseExpiresAt: string, now: string): Promise<StagingRelease | undefined>
  compareAndSwapRelease(actor: StagingActor, projectId: string, releaseId: string, expectedVersion: number, record: StagingRelease): Promise<boolean>
  /** Atomically persists success, moves the target active pointer and releases its busy lease. */
  finalizeAccepted(actor: StagingActor, projectId: string, releaseId: string, expectedVersion: number, record: StagingRelease): Promise<boolean>
  /**
   * Atomically quarantines the physical target after a late or conflicting
   * external effect. The implementation MUST validate the release fence and
   * preserve a newer busy generation instead of replacing its owner. Any newer
   * non-terminal release on the target must be fenced in the same transaction.
   */
  quarantineTarget(
    actor: StagingActor,
    projectId: string,
    releaseId: string,
    expectedVersion: number,
    expectedTargetGeneration: number,
    expectedLeaseId: string,
    record: StagingRelease,
  ): Promise<StagingRelease>
}

export class StagingError extends Error {
  constructor(readonly code: 'FORBIDDEN' | 'INVALID' | 'CONFLICT' | 'NOT_FOUND', message: string) { super(message) }
}

export interface StagingServiceOptions {
  readonly repository: StagingRepository
  readonly source: StagingSourcePort
  readonly approvals: StagingApprovalPort
  readonly provider: StagingProviderPort
  readonly authorization: StagingAuthorizationPort
  readonly now?: () => Date
  readonly leaseId?: () => string
  readonly effectLeaseMs?: number
}

export class StagingService {
  readonly #now: () => Date
  readonly #providerId: string
  readonly #targetRef: string
  readonly #leaseId: () => string
  readonly #effectLeaseMs: number

  constructor(private readonly options: StagingServiceOptions) {
    this.#now = options.now ?? (() => new Date())
    this.#leaseId = options.leaseId ?? (() => randomUUID())
    this.#effectLeaseMs = options.effectLeaseMs ?? 5 * 60_000
    if (!Number.isSafeInteger(this.#effectLeaseMs) || this.#effectLeaseMs < 10_000 || this.#effectLeaseMs > 24 * 60 * 60_000) {
      throw new StagingError('INVALID', t('errors.invalidRequest'))
    }
    const provider = stagingProviderConfigSchema.safeParse({
      provider_id: options.provider.providerId,
      environment: 'staging',
      target_ref: options.provider.targetRef,
    })
    if (!provider.success) throw new StagingError('INVALID', t('errors.invalidRequest'))
    this.#providerId = provider.data.provider_id
    this.#targetRef = provider.data.target_ref
  }

  list(actor: StagingActor, projectId: string): readonly StagingRelease[] {
    this.#authorize(actor, 'project.read')
    return this.options.repository.releases(actor, projectId)
  }

  get(actor: StagingActor, projectId: string, releaseId: string): StagingRelease {
    this.#authorize(actor, 'project.read')
    const release = this.options.repository.release(actor, projectId, releaseId)
    if (release === undefined) throw new StagingError('NOT_FOUND', t('errors.notFound'))
    return release
  }

  async publish(actor: StagingActor, raw: z.input<typeof requestSchema>, signal: AbortSignal = new AbortController().signal): Promise<StagingRelease> {
    this.#authorize(actor, 'project.publish_staging')
    const request = this.#parseRequest(raw, requestSchema)
    this.#assertNotAborted(signal)
    const artifactValue = stagingArtifactSchema.safeParse(await this.options.source.verifiedArtifact(actor, request.projectId, request.runId))
    if (!artifactValue.success) throw new StagingError('INVALID', t('errors.invalidRequest'))
    const artifact = artifactValue.data
    if (artifact.project_id !== request.projectId || (request.runId !== undefined && artifact.run_id !== request.runId)) {
      throw new StagingError('INVALID', t('errors.sourceMismatch'))
    }
    const fingerprint = stagingRequestFingerprint({
      kind: 'PUBLISH', orgId: actor.orgId, tenantId: actor.tenantId,
      projectId: request.projectId, operationId: request.operationId,
      providerId: this.#providerId, targetRef: this.#targetRef, artifact,
    })
    const initial = this.#initial(actor, request.projectId, request.operationId, request.approvalId, fingerprint, artifact, 'PUBLISH', null, null, null)
    return this.#reserveApproveAndPublish(actor, initial, request.approvalId, 'staging.publish', signal)
  }

  async rollback(actor: StagingActor, raw: z.input<typeof rollbackSchema>, signal: AbortSignal = new AbortController().signal): Promise<StagingRelease> {
    this.#authorize(actor, 'project.publish_staging')
    const request = this.#parseRequest(raw, rollbackSchema)
    this.#assertNotAborted(signal)
    const priorOperation = this.options.repository.releaseByOperation(actor, request.projectId, request.operationId)
    if (priorOperation !== undefined) {
      if (priorOperation.kind !== 'ROLLBACK' || priorOperation.rollback_target_release_id !== request.targetReleaseId
        || priorOperation.provider_id !== this.#providerId || priorOperation.target_ref !== this.#targetRef
        || priorOperation.requested_approval_id !== request.approvalId) {
        throw new StagingError('CONFLICT', t('errors.operationConflict'))
      }
      if (priorOperation.state === 'APPROVAL_PENDING' && this.#leaseExpired(priorOperation)) {
        return this.#reserveApproveAndPublish(actor, priorOperation, request.approvalId, 'staging.rollback', signal)
      }
      return priorOperation
    }
    const target = this.options.repository.release(actor, request.projectId, request.targetReleaseId)
    if (target === undefined || (target.state !== 'STAGING_OK' && target.state !== 'ROLLED_BACK')) {
      throw new StagingError('NOT_FOUND', t('errors.rollbackTarget'))
    }
    const current = this.#active(actor, request.projectId)
    if (current === undefined || current.release_id === target.release_id || current.provider_receipt === null
      || current.artifact.artifact_sha256 === target.artifact.artifact_sha256) {
      throw new StagingError('CONFLICT', t('errors.nothingToRollback'))
    }
    const fingerprint = stagingRequestFingerprint({
      kind: 'ROLLBACK', orgId: actor.orgId, tenantId: actor.tenantId,
      projectId: request.projectId, operationId: request.operationId,
      providerId: this.#providerId, targetRef: this.#targetRef,
      artifact: target.artifact, rollbackFromReleaseId: current.release_id, rollbackTargetReleaseId: target.release_id,
    })
    const initial = this.#initial(actor, request.projectId, request.operationId, request.approvalId, fingerprint, target.artifact, 'ROLLBACK', current.release_id, current.target_generation, target.release_id)
    return this.#reserveApproveAndPublish(actor, initial, request.approvalId, 'staging.rollback', signal)
  }

  async reconcile(actor: StagingActor, projectId: string, releaseId: string, signal: AbortSignal = new AbortController().signal): Promise<StagingRelease> {
    this.#authorize(actor, 'project.publish_staging')
    const current = this.get(actor, projectId, releaseId)
    this.#assertNotAborted(signal)
    if (current.state === 'APPROVAL_PENDING') return current
    if (current.state === 'REQUESTED' || current.state === 'ROLLBACK_REQUESTED') {
      if (!this.#leaseExpired(current)) return current
      return this.#transition(actor, current, 'FAILED', {
        failure_code: 'INTERRUPTED_BEFORE_PROVIDER',
        finished_at: this.#nowIso(),
        reconciled_at: this.#nowIso(),
      }, [current.state])
    }
    if (current.state !== 'STAGING' && current.state !== 'ROLLING_BACK' && current.state !== 'RECONCILIATION_REQUIRED') return current
    let pending = current
    if (current.state !== 'RECONCILIATION_REQUIRED') {
      if (!this.#leaseExpired(current)) return current
      pending = await this.#ensureReconciliation(actor, current, 'EFFECT_LEASE_EXPIRED')
      if (pending.state !== 'RECONCILIATION_REQUIRED') return pending
    }
    let status: StagingProviderStatus
    try {
      status = await this.options.provider.status({
        environment: 'staging', operationId: pending.operation_id,
        idempotencyKey: pending.request_fingerprint, targetGeneration: pending.target_generation,
        artifactSha256: pending.artifact.artifact_sha256,
      }, signal)
    } catch {
      return this.#ensureReconciliation(actor, pending, 'PROVIDER_STATUS_UNKNOWN')
    }
    if (status.state === 'UNKNOWN') return this.#ensureReconciliation(actor, pending, 'PROVIDER_STATUS_UNKNOWN')
    return this.#finishWithReceipt(actor, pending, status.receipt, true)
  }

  async #reserveApproveAndPublish(actor: StagingActor, initial: StagingRelease, approvalId: string, action: StagingAction, signal: AbortSignal): Promise<StagingRelease> {
    const reservation = await this.options.repository.reserveRelease(initial)
    if (reservation.kind === 'target-busy' || reservation.kind === 'active-conflict') throw new StagingError('CONFLICT', t('errors.targetBusy'))
    let reserved: StagingRelease
    if (reservation.kind === 'replay') {
      if (reservation.release.request_fingerprint !== initial.request_fingerprint) throw new StagingError('CONFLICT', t('errors.operationConflict'))
      if (reservation.release.requested_approval_id !== approvalId) throw new StagingError('CONFLICT', t('errors.operationConflict'))
      if (reservation.release.state !== 'APPROVAL_PENDING' || !this.#leaseExpired(reservation.release)) return reservation.release
      const now = this.#nowIso()
      const claimed = await this.options.repository.claimExpiredLease(
        actor,
        reservation.release.project_id,
        reservation.release.release_id,
        reservation.release.version,
        this.#leaseId(),
        this.#leaseExpiresAt(now),
        now,
      )
      if (claimed === undefined) return this.get(actor, reservation.release.project_id, reservation.release.release_id)
      reserved = claimed
    } else {
      reserved = reservation.release
    }
    const approval = await this.#consumeApproval(actor, approvalId, action, reserved.operation_id, reserved.request_fingerprint, reserved.release_id)
    if (approval.kind === 'unknown') {
      return this.#transition(actor, reserved, 'APPROVAL_PENDING', {
        failure_code: 'APPROVAL_STATUS_UNKNOWN',
      }, ['APPROVAL_PENDING'])
    }
    if (approval.kind === 'definitive-denied') {
      await this.#transition(actor, reserved, 'FAILED', {
        failure_code: 'APPROVAL_REJECTED',
        finished_at: this.#nowIso(),
      }, ['APPROVAL_PENDING'])
      throw new StagingError('FORBIDDEN', t('errors.approvalMismatch'))
    }
    const approved = approval.receipt
    const requestedState: StagingReleaseState = reserved.kind === 'PUBLISH' ? 'REQUESTED' : 'ROLLBACK_REQUESTED'
    const requested = await this.#transition(actor, reserved, requestedState, {
      approval_id: approved.approval_id,
      approved_at: approved.approved_at,
      failure_code: null,
    }, ['APPROVAL_PENDING'])
    if (requested.state !== requestedState) return requested
    if (signal.aborted) {
      return this.#transition(actor, requested, 'FAILED', {
        failure_code: 'CANCELLED_BEFORE_PROVIDER',
        finished_at: this.#nowIso(),
      }, [requestedState])
    }
    const runningState: StagingReleaseState = initial.kind === 'PUBLISH' ? 'STAGING' : 'ROLLING_BACK'
    const running = await this.#transition(actor, requested, runningState, { started_at: this.#nowIso() }, [requestedState])
    if (running.state !== runningState) return running
    let result: StagingProviderResult
    try {
      result = running.kind === 'PUBLISH'
        ? await this.options.provider.stage({ environment: 'staging', operationId: running.operation_id, idempotencyKey: running.request_fingerprint, targetGeneration: running.target_generation, artifact: running.artifact }, signal)
        : await this.options.provider.rollback({ environment: 'staging', operationId: running.operation_id, idempotencyKey: running.request_fingerprint, targetGeneration: running.target_generation, fromReceiptRef: this.#rollbackReceipt(actor, running), artifact: running.artifact }, signal)
    } catch {
      return this.#ensureReconciliation(actor, running, 'PROVIDER_EFFECT_UNKNOWN')
    }
    if (result.kind === 'definitive-no-effect') {
      const failureCode = /^[A-Z][A-Z0-9_]{1,95}$/u.test(result.failureCode) ? result.failureCode : 'PROVIDER_REJECTED'
      return this.#transition(actor, running, 'FAILED', { failure_code: failureCode, finished_at: this.#nowIso() }, [running.state, 'RECONCILIATION_REQUIRED'])
    }
    return this.#finishWithReceipt(actor, running, result.receipt, false)
  }

  async #finishWithReceipt(actor: StagingActor, current: StagingRelease, receiptValue: unknown, reconciled: boolean): Promise<StagingRelease> {
    if (!matchesProviderReceipt({
      providerId: current.provider_id, targetRef: current.target_ref,
      operationId: current.operation_id, artifactSha256: current.artifact.artifact_sha256,
      kind: current.kind, targetGeneration: current.target_generation,
    }, receiptValue)) return this.#ensureReconciliation(actor, current, 'PROVIDER_RECEIPT_MISMATCH')
    const receipt = stagingProviderReceiptSchema.parse(receiptValue)
    const finalState: StagingReleaseState = current.kind === 'PUBLISH' ? 'STAGING_OK' : 'ROLLED_BACK'
    let candidate = current
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const now = this.#nowIso()
      const next = this.#next(candidate, finalState, {
        provider_receipt: receipt,
        failure_code: null,
        finished_at: now,
        ...(reconciled ? { reconciled_at: now } : {}),
      })
      if (await this.options.repository.finalizeAccepted(actor, candidate.project_id, candidate.release_id, candidate.version, next)) return next
      const latest = this.options.repository.release(actor, candidate.project_id, candidate.release_id)
      if (latest === undefined || latest.request_fingerprint !== current.request_fingerprint) break
      if ((latest.state === 'STAGING_OK' || latest.state === 'ROLLED_BACK')
        && JSON.stringify(latest.provider_receipt) === JSON.stringify(receipt)) return latest
      if (latest.state === 'STAGING' || latest.state === 'ROLLING_BACK' || latest.state === 'RECONCILIATION_REQUIRED') {
        candidate = latest
        continue
      }
      candidate = latest
      break
    }
    const incident = this.#next(candidate, 'RECONCILIATION_REQUIRED', {
      provider_receipt: receipt,
      failure_code: 'CONFLICTING_EXTERNAL_EFFECT',
      finished_at: null,
    })
    return this.options.repository.quarantineTarget(
      actor,
      candidate.project_id,
      candidate.release_id,
      candidate.version,
      candidate.target_generation,
      candidate.effect_lease_id,
      incident,
    )
  }

  async #ensureReconciliation(actor: StagingActor, current: StagingRelease, failureCode: string): Promise<StagingRelease> {
    if (current.state === 'RECONCILIATION_REQUIRED' && current.failure_code === failureCode) return current
    try {
      return await this.#transition(actor, current, 'RECONCILIATION_REQUIRED', {
        failure_code: failureCode,
        finished_at: null,
      }, ['STAGING', 'ROLLING_BACK', 'RECONCILIATION_REQUIRED'])
    } catch (error) {
      const latest = this.options.repository.release(actor, current.project_id, current.release_id)
      if (latest !== undefined && latest.request_fingerprint === current.request_fingerprint
        && (latest.state === 'STAGING_OK' || latest.state === 'ROLLED_BACK')) return latest
      throw error
    }
  }

  async #transition(actor: StagingActor, current: StagingRelease, state: StagingReleaseState, patch: Partial<StagingRelease>, allowedFrom: readonly StagingReleaseState[]): Promise<StagingRelease> {
    let candidate = current
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!allowedFrom.includes(candidate.state)) {
        if (candidate.state === state) return candidate
        throw new StagingError('CONFLICT', t('errors.invalidTransition'))
      }
      const next = this.#next(candidate, state, patch)
      if (await this.options.repository.compareAndSwapRelease(actor, candidate.project_id, candidate.release_id, candidate.version, next)) return next
      const latest = this.options.repository.release(actor, candidate.project_id, candidate.release_id)
      if (latest === undefined || latest.request_fingerprint !== current.request_fingerprint) break
      candidate = latest
    }
    throw new StagingError('CONFLICT', t('errors.invalidTransition'))
  }

  #next(current: StagingRelease, state: StagingReleaseState, patch: Partial<StagingRelease>): StagingRelease {
    return stagingReleaseSchema.parse({
      ...current,
      ...patch,
      state,
      version: current.version + 1,
      last_transition_at: this.#nowIso(),
    })
  }

  #initial(actor: StagingActor, projectId: string, operationId: string, requestedApprovalId: string, fingerprint: string, artifact: StagingArtifact, kind: StagingRelease['kind'], rollbackFrom: string | null, rollbackFromGeneration: number | null, rollbackTarget: string | null): StagingRelease {
    const now = this.#nowIso()
    return stagingReleaseSchema.parse({
      release_id: stagingReleaseId(fingerprint), operation_id: operationId, request_fingerprint: fingerprint,
      target_key: stagingTargetKey({ providerId: this.#providerId, targetRef: this.#targetRef }),
      target_generation: 1,
      effect_lease_id: this.#leaseId(), effect_lease_expires_at: this.#leaseExpiresAt(now), kind,
      org_id: actor.orgId, tenant_id: actor.tenantId, project_id: projectId, run_id: artifact.run_id, artifact,
      provider_id: this.#providerId, environment: 'staging', target_ref: this.#targetRef,
      state: 'APPROVAL_PENDING', version: 1,
      created_by: actor.userId, source_session_id: actor.sessionId,
      requested_approval_id: requestedApprovalId, approval_id: null, approved_at: null,
      created_at: now, last_transition_at: now, started_at: null, finished_at: null, reconciled_at: null,
      provider_receipt: null, failure_code: null,
      rollback_from_release_id: rollbackFrom, rollback_from_generation: rollbackFromGeneration,
      rollback_target_release_id: rollbackTarget,
    })
  }

  async #consumeApproval(actor: StagingActor, approvalId: string, action: StagingAction, subjectId: string, fingerprint: string, releaseId: string): Promise<
    | { readonly kind: 'approved'; readonly receipt: StagingApprovalReceipt }
    | { readonly kind: 'definitive-denied' }
    | { readonly kind: 'unknown' }
  > {
    let result: unknown
    try {
      result = await this.options.approvals.consume({ actor, approvalId, tier: 'T2', action, subjectId, fingerprint, releaseId })
    } catch {
      return { kind: 'unknown' }
    }
    if (typeof result === 'object' && result !== null && 'kind' in result && result.kind === 'definitive-denied') return { kind: 'definitive-denied' }
    if (typeof result !== 'object' || result === null || !('kind' in result) || result.kind !== 'approved' || !('receipt' in result)) return { kind: 'unknown' }
    const parsed = stagingApprovalReceiptSchema.safeParse(result.receipt)
    if (!parsed.success) return { kind: 'unknown' }
    const value = parsed.data
    const matches = value.approval_id === approvalId && value.action === action && value.subject_id === subjectId
      && value.fingerprint === fingerprint && value.user_id === actor.userId && value.session_id === actor.sessionId
      && value.org_id === actor.orgId && value.tenant_id === actor.tenantId
    if (!matches) return { kind: 'unknown' }
    return { kind: 'approved', receipt: value }
  }

  #active(actor: StagingActor, projectId: string): StagingRelease | undefined {
    return [...this.options.repository.releases(actor, projectId)]
      .filter(release => (release.state === 'STAGING_OK' || release.state === 'ROLLED_BACK')
        && release.provider_id === this.#providerId && release.target_ref === this.#targetRef)
      .sort((left, right) => right.target_generation - left.target_generation
        || right.release_id.localeCompare(left.release_id))[0]
  }

  #rollbackReceipt(actor: StagingActor, release: StagingRelease): string {
    if (release.rollback_from_release_id === null || release.rollback_from_generation === null) throw new StagingError('CONFLICT', t('errors.invalidTransition'))
    const source = this.options.repository.release(actor, release.project_id, release.rollback_from_release_id)
    if (source === undefined || source.target_generation !== release.rollback_from_generation || source.provider_receipt === null) {
      throw new StagingError('CONFLICT', t('errors.invalidTransition'))
    }
    return source.provider_receipt.receipt_ref
  }

  #nowIso(): string {
    return this.#now().toISOString()
  }

  #leaseExpiresAt(now: string): string {
    return new Date(Date.parse(now) + this.#effectLeaseMs).toISOString()
  }

  #leaseExpired(release: StagingRelease): boolean {
    return Date.parse(release.effect_lease_expires_at) <= this.#now().getTime()
  }

  #parseRequest<T extends z.ZodType>(value: unknown, schema: T): z.output<T> {
    const parsed = schema.safeParse(value)
    if (!parsed.success) throw new StagingError('INVALID', t('errors.invalidRequest'))
    return parsed.data
  }

  #authorize(actor: StagingActor, permission: 'project.read' | 'project.publish_staging'): void {
    if (!isStagingAuthorized(actor, permission, this.options.authorization)) throw new StagingError('FORBIDDEN', t('errors.forbidden'))
  }

  #assertNotAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new StagingError('INVALID', t('errors.cancelled'))
  }
}
