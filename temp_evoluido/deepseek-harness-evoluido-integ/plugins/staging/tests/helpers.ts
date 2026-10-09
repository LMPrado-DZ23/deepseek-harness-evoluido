import { vi } from 'vitest'
import type {
  StagingActor,
  StagingApprovalPort,
  StagingProviderPort,
  StagingRepository,
} from '../src/service.js'
import { stagingReleaseSchema, type StagingArtifact, type StagingRelease } from '../src/model.js'

export const fixedNow = '2026-09-07T12:00:00.000Z'
export const digest = (value: string): string => value.repeat(64).slice(0, 64)

export const owner: StagingActor = {
  userId: 'user-owner', orgId: 'org-a', tenantId: 'tenant-a', role: 'owner', sessionId: 'session-a',
}

export function artifact(runId = 'run-1', marker = 'a'): StagingArtifact {
  return {
    project_id: 'project-1', run_id: runId,
    artifact_ref: `dz23-artifact:sha256-${marker}`,
    artifact_sha256: digest(marker), manifest_sha256: digest('b'), acceptance_sha256: digest('c'),
    sbom_sha256: digest('d'), provenance_sha256: digest('e'),
    builder_image_digest: `sha256:${digest('f')}`, policy_sha256: digest('1'),
  }
}

function scope(actor: StagingActor, projectId: string): string {
  return JSON.stringify([actor.orgId, actor.tenantId, projectId])
}

function recordScope(record: StagingRelease): string {
  return JSON.stringify([record.org_id, record.tenant_id, record.project_id])
}

export class MemoryStagingRepository implements StagingRepository {
  readonly #records = new Map<string, StagingRelease>()
  readonly #targets = new Map<string, {
    lastGeneration: number
    activeReleaseId?: string
    activeGeneration?: number
    busyReleaseId?: string
    ownerScope?: string
    quarantined: boolean
  }>()
  #tail: Promise<void> = Promise.resolve()

  releases(actor: StagingActor, projectId: string): readonly StagingRelease[] {
    const key = scope(actor, projectId)
    return [...this.#records.values()].filter(record => recordScope(record) === key)
  }

  release(actor: StagingActor, projectId: string, releaseId: string): StagingRelease | undefined {
    return this.releases(actor, projectId).find(record => record.release_id === releaseId)
  }

  releaseByOperation(actor: StagingActor, projectId: string, operationId: string): StagingRelease | undefined {
    return this.releases(actor, projectId).find(record => record.operation_id === operationId)
  }

  reserveRelease(record: StagingRelease): Promise<
    | { readonly kind: 'reserved'; readonly release: StagingRelease }
    | { readonly kind: 'replay'; readonly release: StagingRelease }
    | { readonly kind: 'target-busy' }
    | { readonly kind: 'active-conflict' }
  > {
    return this.#exclusive(async () => {
      const replay = [...this.#records.values()].find(candidate => recordScope(candidate) === recordScope(record)
        && (candidate.release_id === record.release_id || candidate.operation_id === record.operation_id))
      if (replay !== undefined) return { kind: 'replay', release: structuredClone(replay) }
      const target = this.#targets.get(record.target_key) ?? { lastGeneration: 0, quarantined: false }
      if (target.quarantined || target.busyReleaseId !== undefined) return { kind: 'target-busy' }
      if (target.ownerScope !== undefined && target.ownerScope !== recordScope(record)) return { kind: 'active-conflict' }
      if (record.kind === 'ROLLBACK' && (target.activeReleaseId !== record.rollback_from_release_id
        || target.activeGeneration !== record.rollback_from_generation)) return { kind: 'active-conflict' }
      const release = stagingReleaseSchema.parse({ ...record, target_generation: target.lastGeneration + 1 })
      this.#records.set(release.release_id, structuredClone(release))
      this.#targets.set(record.target_key, {
        ...target,
        lastGeneration: release.target_generation,
        busyReleaseId: release.release_id,
        ownerScope: target.ownerScope ?? recordScope(record),
      })
      return { kind: 'reserved', release: structuredClone(release) }
    })
  }

  claimExpiredLease(actor: StagingActor, projectId: string, releaseId: string, expectedVersion: number, leaseId: string, leaseExpiresAt: string, now: string): Promise<StagingRelease | undefined> {
    return this.#exclusive(async () => {
      const current = this.release(actor, projectId, releaseId)
      const target = current === undefined ? undefined : this.#targets.get(current.target_key)
      if (current === undefined || current.version !== expectedVersion || current.state !== 'APPROVAL_PENDING'
        || current.effect_lease_expires_at > now || target?.busyReleaseId !== releaseId || target.quarantined) return undefined
      const claimed = stagingReleaseSchema.parse({
        ...current,
        effect_lease_id: leaseId,
        effect_lease_expires_at: leaseExpiresAt,
        last_transition_at: now,
        version: current.version + 1,
      })
      this.#records.set(releaseId, structuredClone(claimed))
      return structuredClone(claimed)
    })
  }

  compareAndSwapRelease(actor: StagingActor, projectId: string, releaseId: string, expectedVersion: number, record: StagingRelease): Promise<boolean> {
    return this.#exclusive(async () => {
      const current = this.release(actor, projectId, releaseId)
      const target = current === undefined ? undefined : this.#targets.get(current.target_key)
      if (current === undefined || current.version !== expectedVersion || target?.busyReleaseId !== releaseId || target.quarantined
        || record.target_generation !== current.target_generation || record.effect_lease_id !== current.effect_lease_id) return false
      this.#records.set(releaseId, structuredClone(record))
      if (record.state === 'FAILED' && target !== undefined) {
        const { busyReleaseId: _busyReleaseId, ...idleTarget } = target
        this.#targets.set(record.target_key, idleTarget)
      }
      return true
    })
  }

  finalizeAccepted(actor: StagingActor, projectId: string, releaseId: string, expectedVersion: number, record: StagingRelease): Promise<boolean> {
    return this.#exclusive(async () => {
      const current = this.release(actor, projectId, releaseId)
      const target = current === undefined ? undefined : this.#targets.get(current.target_key)
      // A MESMA regra de `DomainStagingRepository.finalizeAccepted`: a
      // reconciliação que traz o recibo do provedor tira o destino da
      // quarentena. Este dublê é uma SEGUNDA implementação do repositório, e
      // divergir dela é como uma prova passa a cobrir um comportamento que a
      // produção não tem — foi exatamente o que aconteceu aqui antes.
      const resolvingQuarantine = target?.quarantined === true
        && target.busyReleaseId === releaseId && record.reconciled_at !== null
      if (current === undefined || current.version !== expectedVersion || target?.busyReleaseId !== releaseId
        || (target.quarantined && !resolvingQuarantine) || target.lastGeneration !== current.target_generation || record.target_generation !== current.target_generation
        || record.effect_lease_id !== current.effect_lease_id
        || (record.state !== 'STAGING_OK' && record.state !== 'ROLLED_BACK')) return false
      this.#records.set(releaseId, structuredClone(record))
      const { busyReleaseId: _busyReleaseId, ...idleTarget } = target
      this.#targets.set(record.target_key, {
        ...idleTarget,
        quarantined: false,
        activeReleaseId: releaseId,
        activeGeneration: record.target_generation,
      })
      return true
    })
  }

  quarantineTarget(
    actor: StagingActor,
    projectId: string,
    releaseId: string,
    expectedVersion: number,
    expectedTargetGeneration: number,
    expectedLeaseId: string,
    record: StagingRelease,
  ): Promise<StagingRelease> {
    return this.#exclusive(async () => {
      const current = this.release(actor, projectId, releaseId)
      if (current === undefined) throw new Error('missing release')
      const target = this.#targets.get(current.target_key) ?? { lastGeneration: current.target_generation, quarantined: false }
      if (current.version < expectedVersion || current.target_generation !== expectedTargetGeneration
        || current.effect_lease_id !== expectedLeaseId || record.target_generation !== expectedTargetGeneration
        || record.effect_lease_id !== expectedLeaseId) throw new Error('stale quarantine fence')
      const transitionAt = new Date(Math.max(
        Date.parse(record.last_transition_at),
        Date.parse(current.last_transition_at),
      )).toISOString()
      const incident = stagingReleaseSchema.parse({
        ...current,
        state: 'RECONCILIATION_REQUIRED',
        version: current.version + 1,
        last_transition_at: transitionAt,
        finished_at: null,
        provider_receipt: record.provider_receipt,
        failure_code: 'CONFLICTING_EXTERNAL_EFFECT',
      })
      this.#records.set(releaseId, structuredClone(incident))
      const busyReleaseId = target.busyReleaseId
      if (busyReleaseId !== undefined && busyReleaseId !== releaseId) {
        const busy = this.#records.get(busyReleaseId)
        if (busy !== undefined && busy.target_generation > expectedTargetGeneration
          && busy.state !== 'FAILED' && busy.state !== 'STAGING_OK' && busy.state !== 'ROLLED_BACK') {
          const busyTransitionAt = new Date(Math.max(
            Date.parse(transitionAt),
            Date.parse(busy.last_transition_at),
            busy.started_at === null ? 0 : Date.parse(busy.started_at),
          )).toISOString()
          const fenced = busy.started_at === null
            ? stagingReleaseSchema.parse({
              ...busy,
              state: 'FAILED',
              version: busy.version + 1,
              last_transition_at: busyTransitionAt,
              finished_at: busyTransitionAt,
              failure_code: 'TARGET_QUARANTINED_BEFORE_EFFECT',
            })
            : stagingReleaseSchema.parse({
              ...busy,
              state: 'RECONCILIATION_REQUIRED',
              version: busy.version + 1,
              last_transition_at: busyTransitionAt,
              finished_at: null,
              failure_code: 'TARGET_FENCED_BY_LATE_EFFECT',
            })
          this.#records.set(busyReleaseId, structuredClone(fenced))
        }
      }
      this.#targets.set(current.target_key, {
        ...target,
        busyReleaseId: busyReleaseId ?? releaseId,
        quarantined: true,
      })
      return structuredClone(incident)
    })
  }

  async insert(record: StagingRelease): Promise<void> {
    this.#records.set(record.release_id, structuredClone(record))
    const terminal = record.state === 'FAILED' || record.state === 'STAGING_OK' || record.state === 'ROLLED_BACK'
    this.#targets.set(record.target_key, {
      lastGeneration: record.target_generation,
      ownerScope: recordScope(record),
      ...(record.state === 'STAGING_OK' || record.state === 'ROLLED_BACK'
        ? { activeReleaseId: record.release_id, activeGeneration: record.target_generation }
        : {}),
      ...(terminal ? {} : { busyReleaseId: record.release_id }),
      quarantined: record.state === 'RECONCILIATION_REQUIRED',
    })
  }

  #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work, work)
    this.#tail = result.then(() => undefined, () => undefined)
    return result
  }
}

export function approvalPort(overrides: Partial<StagingApprovalPort> = {}): StagingApprovalPort & { consume: ReturnType<typeof vi.fn> } {
  const consume = vi.fn(async input => ({
    kind: 'approved' as const,
    receipt: {
      approval_id: input.approvalId,
      action: input.action,
      subject_id: input.subjectId,
      fingerprint: input.fingerprint,
      user_id: input.actor.userId,
      session_id: input.actor.sessionId,
      org_id: input.actor.orgId,
      tenant_id: input.actor.tenantId,
      approved_at: fixedNow,
    },
  }))
  return { consume, ...overrides } as StagingApprovalPort & { consume: ReturnType<typeof vi.fn> }
}

export function providerPort(overrides: Partial<StagingProviderPort> = {}): StagingProviderPort {
  const receipt = (input: { operationId: string; targetGeneration: number; artifact: StagingArtifact }, kind: 'PUBLISH' | 'ROLLBACK') => ({
    provider_id: 'local-staging', environment: 'staging' as const, target_ref: 'dz23-target:staging-main',
    operation_id: input.operationId, kind, target_generation: input.targetGeneration,
    artifact_sha256: input.artifact.artifact_sha256,
    receipt_ref: `dz23-receipt:${input.operationId}`, observed_at: fixedNow,
  })
  return {
    providerId: 'local-staging', targetRef: 'dz23-target:staging-main',
    stage: vi.fn(async input => ({ kind: 'accepted' as const, receipt: receipt(input, 'PUBLISH') })),
    rollback: vi.fn(async input => ({ kind: 'accepted' as const, receipt: receipt(input, 'ROLLBACK') })),
    status: vi.fn(async () => ({ state: 'UNKNOWN' as const })),
    ...overrides,
  }
}
