import { describe, expect, it, vi } from 'vitest'
import {
  StagingError,
  StagingService,
  type StagingActor,
  type StagingProviderResult,
} from '../src/service.js'
import { stagingReleaseSchema, type StagingArtifact } from '../src/model.js'
import { stagingRequestFingerprint, stagingReleaseId } from '../src/artifact.js'
import { approvalPort, artifact, digest, fixedNow, MemoryStagingRepository, owner, providerPort } from './helpers.js'

function harness(options: {
  source?: StagingArtifact | (() => StagingArtifact)
  provider?: ReturnType<typeof providerPort>
  approvals?: ReturnType<typeof approvalPort>
  repository?: MemoryStagingRepository
  now?: (() => Date) | null
  effectLeaseMs?: number
} = {}) {
  const repository = options.repository ?? new MemoryStagingRepository()
  const provider = options.provider ?? providerPort()
  const approvals = options.approvals ?? approvalPort()
  const source = options.source ?? artifact()
  const sourcePort = { verifiedArtifact: vi.fn(async () => typeof source === 'function' ? source() : source) }
  const authorization = {
    allows: (role: StagingActor['role'], permission: 'project.read' | 'project.publish_staging') => permission === 'project.read'
      ? role === 'owner' || role === 'admin' || role === 'builder' || role === 'viewer'
      : role === 'owner' || role === 'admin' || role === 'builder',
  }
  const time = options.now === null ? {} : { now: options.now ?? (() => new Date(fixedNow)) }
  const lease = options.effectLeaseMs === undefined ? {} : { effectLeaseMs: options.effectLeaseMs }
  const service = new StagingService({ repository, provider, approvals, source: sourcePort, authorization, ...time, ...lease })
  return { service, repository, provider, approvals, source: sourcePort }
}

const request = { projectId: 'project-1', operationId: 'op-1', approvalId: 'approval-1', runId: 'run-1' }

describe('staging publication core', () => {
  it('persists before the provider and accepts only the exact receipt', async () => {
    const h = harness()
    const statesAtApproval: string[][] = []
    const statesAtProvider: string[][] = []
    h.approvals.consume.mockImplementation(async input => {
      statesAtApproval.push(h.repository.releases(owner, 'project-1').map(record => record.state))
      return { kind: 'approved', receipt: {
        approval_id: input.approvalId, action: input.action, subject_id: input.subjectId,
        fingerprint: input.fingerprint, user_id: input.actor.userId, session_id: input.actor.sessionId,
        org_id: input.actor.orgId, tenant_id: input.actor.tenantId, approved_at: fixedNow,
      } }
    })
    h.provider.stage = vi.fn(async input => {
      statesAtProvider.push(h.repository.releases(owner, 'project-1').map(record => record.state))
      return { kind: 'accepted', receipt: {
        provider_id: h.provider.providerId, environment: 'staging', target_ref: h.provider.targetRef,
        operation_id: input.operationId, kind: 'PUBLISH', target_generation: input.targetGeneration,
        artifact_sha256: input.artifact.artifact_sha256,
        receipt_ref: 'dz23-receipt:release-1', observed_at: fixedNow,
      } } as const
    })
    const release = await h.service.publish(owner, request)
    expect(statesAtApproval).toEqual([['APPROVAL_PENDING']])
    expect(statesAtProvider).toEqual([['STAGING']])
    expect(release).toMatchObject({
      state: 'STAGING_OK', version: 4, environment: 'staging',
      provider_receipt: { receipt_ref: 'dz23-receipt:release-1', target_generation: 1 },
    })
    expect(h.approvals.consume).toHaveBeenCalledWith(expect.objectContaining({ tier: 'T2', action: 'staging.publish', subjectId: 'op-1', releaseId: release.release_id }))
    expect(stagingReleaseSchema.safeParse({ ...release, provider_receipt: null }).success).toBe(false)
    expect(stagingReleaseSchema.safeParse({ ...release, state: 'FAILED', failure_code: null }).success).toBe(false)
  })

  it('refuses viewers, unauditable sessions and malformed server provider configuration', async () => {
    const h = harness()
    const viewer = { ...owner, role: 'viewer' as const }
    await expect(h.service.publish(viewer, request)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(h.service.publish({ ...owner, sessionId: '' }, request)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(h.source.verifiedArtifact).not.toHaveBeenCalled()
    expect(() => harness({ provider: providerPort({ targetRef: 'production' }) })).toThrow(StagingError)
    expect(harness({ now: null }).service.list(owner, 'project-1')).toEqual([])
  })

  it('rejects malformed input and a request cancelled before reading its source', async () => {
    const h = harness()
    await expect(h.service.publish(owner, { ...request, operationId: '../bad' })).rejects.toMatchObject({ code: 'INVALID' })
    const controller = new AbortController(); controller.abort()
    await expect(h.service.publish(owner, request, controller.signal)).rejects.toMatchObject({ code: 'INVALID' })
    expect(h.source.verifiedArtifact).not.toHaveBeenCalled()
  })

  it('refuses a source for another project or requested run', async () => {
    await expect(harness({ source: { ...artifact(), project_id: 'project-2' } }).service.publish(owner, request)).rejects.toMatchObject({ code: 'INVALID' })
    await expect(harness({ source: artifact('run-2') }).service.publish(owner, request)).rejects.toMatchObject({ code: 'INVALID' })
    await expect(harness({ source: { ...artifact(), artifact_sha256: 'bad' } as StagingArtifact }).service.publish(owner, request)).rejects.toMatchObject({ code: 'INVALID' })
  })

  it('requires an approval receipt bound to user, session, scope, action and fingerprint', async () => {
    const approvals = approvalPort()
    approvals.consume.mockImplementation(async input => ({ kind: 'approved', receipt: {
      approval_id: input.approvalId, action: input.action, subject_id: input.subjectId, fingerprint: input.fingerprint,
      user_id: 'another-user', session_id: input.actor.sessionId, org_id: input.actor.orgId, tenant_id: input.actor.tenantId,
      approved_at: fixedNow,
    } }))
    const h = harness({ approvals })
    await expect(h.service.publish(owner, request)).resolves.toMatchObject({ state: 'APPROVAL_PENDING', failure_code: 'APPROVAL_STATUS_UNKNOWN' })
    expect(h.provider.stage).not.toHaveBeenCalled()

    const malformed = harness({ approvals: approvalPort({ consume: vi.fn(async () => ({ approval_id: 'incomplete' })) as never }) })
    await expect(malformed.service.publish(owner, request)).resolves.toMatchObject({ state: 'APPROVAL_PENDING', failure_code: 'APPROVAL_STATUS_UNKNOWN' })
  })

  it('keeps an ambiguous approval claim resumable and records only an explicit denial as rejected', async () => {
    let now = new Date('2026-09-07T12:00:00.000Z')
    const approvals = approvalPort()
    approvals.consume.mockRejectedValueOnce(new Error('response lost after claim'))
    const h = harness({ approvals, now: () => now, effectLeaseMs: 10_000 })
    await expect(h.service.publish(owner, request)).resolves.toMatchObject({
      state: 'APPROVAL_PENDING', failure_code: 'APPROVAL_STATUS_UNKNOWN', approval_id: null,
    })
    expect(h.provider.stage).not.toHaveBeenCalled()
    await expect(h.service.publish(owner, request)).resolves.toMatchObject({ state: 'APPROVAL_PENDING' })
    expect(approvals.consume).toHaveBeenCalledTimes(1)
    now = new Date('2026-09-07T12:00:11.000Z')
    await expect(h.service.publish(owner, request)).resolves.toMatchObject({ state: 'STAGING_OK', failure_code: null })
    expect(approvals.consume).toHaveBeenCalledTimes(2)
    expect(h.provider.stage).toHaveBeenCalledTimes(1)

    const denied = harness({ approvals: approvalPort({ consume: vi.fn(async () => ({ kind: 'definitive-denied' as const })) }) })
    await expect(denied.service.publish(owner, request)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(denied.repository.releases(owner, 'project-1')).toEqual([
      expect.objectContaining({ state: 'FAILED', failure_code: 'APPROVAL_REJECTED', approval_id: null }),
    ])
    expect(denied.provider.stage).not.toHaveBeenCalled()
  })

  it('allows the authoritative source to select the latest run when none was requested', async () => {
    const h = harness({ source: artifact('run-latest', '7') })
    await expect(h.service.publish(owner, { projectId: 'project-1', operationId: 'op-latest', approvalId: 'approval-latest' })).resolves.toMatchObject({ run_id: 'run-latest', state: 'STAGING_OK' })
  })

  it('replays the same operation without consuming another approval or calling the provider', async () => {
    const h = harness()
    const first = await h.service.publish(owner, request)
    const second = await h.service.publish(owner, request)
    expect(second).toEqual(first)
    expect(h.approvals.consume).toHaveBeenCalledTimes(1)
    expect(h.provider.stage).toHaveBeenCalledTimes(1)
  })

  it('detects reuse of an operation id for a different immutable request', async () => {
    let current = artifact()
    const h = harness({ source: () => current })
    await h.service.publish(owner, request)
    current = artifact('run-1', '9')
    await expect(h.service.publish(owner, request)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(h.provider.stage).toHaveBeenCalledTimes(1)
  })

  it('reserves concurrent replays atomically and invokes the provider once', async () => {
    const h = harness()
    const [left, right] = await Promise.all([h.service.publish(owner, request), h.service.publish(owner, request)])
    expect(left.release_id).toBe(right.release_id)
    expect(h.provider.stage).toHaveBeenCalledTimes(1)
    expect(h.approvals.consume).toHaveBeenCalledTimes(1)
  })

  it('reclaims an expired pre-provider lease with the same durable approval claim', async () => {
    let now = new Date('2026-09-07T12:00:00.000Z')
    let resolveFirst!: (value: unknown) => void
    let approvalCalls = 0
    const approvals = approvalPort()
    approvals.consume.mockImplementation(input => {
      approvalCalls += 1
      const receipt = { kind: 'approved' as const, receipt: {
        approval_id: input.approvalId, action: input.action, subject_id: input.subjectId,
        fingerprint: input.fingerprint, user_id: input.actor.userId, session_id: input.actor.sessionId,
        org_id: input.actor.orgId, tenant_id: input.actor.tenantId, approved_at: fixedNow,
      } }
      if (approvalCalls === 1) return new Promise(resolve => { resolveFirst = resolve })
      return Promise.resolve(receipt)
    })
    const h = harness({ approvals, now: () => now, effectLeaseMs: 10_000 })
    const first = h.service.publish(owner, request)
    await vi.waitFor(() => expect(approvals.consume).toHaveBeenCalledTimes(1))
    now = new Date('2026-09-07T12:00:11.000Z')
    const resumed = await h.service.publish(owner, request)
    expect(resumed.state).toBe('STAGING_OK')
    const [firstClaim, secondClaim] = approvals.consume.mock.calls.map(call => call[0])
    expect(secondClaim).toMatchObject({
      releaseId: firstClaim.releaseId,
      fingerprint: firstClaim.fingerprint,
      approvalId: firstClaim.approvalId,
    })
    resolveFirst({ kind: 'approved', receipt: {
      approval_id: firstClaim.approvalId, action: firstClaim.action, subject_id: firstClaim.subjectId,
      fingerprint: firstClaim.fingerprint, user_id: firstClaim.actor.userId, session_id: firstClaim.actor.sessionId,
      org_id: firstClaim.actor.orgId, tenant_id: firstClaim.actor.tenantId, approved_at: fixedNow,
    } })
    await expect(first).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(h.provider.stage).toHaveBeenCalledTimes(1)
  })

  it('serializes all mutations by canonical physical target and binds it to one scope', async () => {
    let releaseEffect!: (value: StagingProviderResult) => void
    const provider = providerPort({ stage: vi.fn(() => new Promise<StagingProviderResult>(resolve => { releaseEffect = resolve })) })
    const h = harness({ provider })
    const firstPromise = h.service.publish(owner, request)
    await vi.waitFor(() => expect(provider.stage).toHaveBeenCalledTimes(1))
    await expect(h.service.publish(owner, { ...request, operationId: 'op-2', approvalId: 'approval-2' }))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    const input = vi.mocked(provider.stage).mock.calls[0]![0]
    releaseEffect({ kind: 'accepted', receipt: {
      provider_id: provider.providerId, environment: 'staging', target_ref: provider.targetRef,
      operation_id: input.operationId, kind: 'PUBLISH', target_generation: input.targetGeneration,
      artifact_sha256: input.artifact.artifact_sha256, receipt_ref: 'dz23-receipt:op-1', observed_at: fixedNow,
    } })
    await expect(firstPromise).resolves.toMatchObject({ state: 'STAGING_OK' })
    const otherScope: StagingActor = { ...owner, orgId: 'org-b', tenantId: 'tenant-b', sessionId: 'session-b' }
    await expect(h.service.publish(otherScope, { ...request, operationId: 'op-b', approvalId: 'approval-b' }))
      .rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('does not reconcile an effect while its lease is live and accepts its later exact receipt', async () => {
    let releaseEffect!: (value: StagingProviderResult) => void
    const provider = providerPort({ stage: vi.fn(() => new Promise<StagingProviderResult>(resolve => { releaseEffect = resolve })) })
    const h = harness({ provider })
    const publishPromise = h.service.publish(owner, request)
    await vi.waitFor(() => expect(provider.stage).toHaveBeenCalledTimes(1))
    const running = h.repository.releases(owner, 'project-1')[0]!
    await expect(h.service.reconcile(owner, 'project-1', running.release_id)).resolves.toMatchObject({ state: 'STAGING' })
    expect(provider.status).not.toHaveBeenCalled()
    const input = vi.mocked(provider.stage).mock.calls[0]![0]
    releaseEffect({ kind: 'accepted', receipt: {
      provider_id: provider.providerId, environment: 'staging', target_ref: provider.targetRef,
      operation_id: input.operationId, kind: 'PUBLISH', target_generation: input.targetGeneration,
      artifact_sha256: input.artifact.artifact_sha256, receipt_ref: 'dz23-receipt:late', observed_at: fixedNow,
    } })
    await expect(publishPromise).resolves.toMatchObject({ state: 'STAGING_OK', failure_code: null })
  })

  it('keeps an expired unknown effect blocked and lets an exact late receipt resolve it', async () => {
    let now = new Date('2026-09-07T12:00:00.000Z')
    let releaseEffect!: (value: StagingProviderResult) => void
    const provider = providerPort({ stage: vi.fn(() => new Promise<StagingProviderResult>(resolve => { releaseEffect = resolve })) })
    const h = harness({ provider, now: () => now, effectLeaseMs: 10_000 })
    const publishPromise = h.service.publish(owner, request)
    await vi.waitFor(() => expect(provider.stage).toHaveBeenCalledTimes(1))
    const running = h.repository.releases(owner, 'project-1')[0]!
    now = new Date('2026-09-07T12:00:11.000Z')
    await expect(h.service.reconcile(owner, 'project-1', running.release_id)).resolves.toMatchObject({
      state: 'RECONCILIATION_REQUIRED', failure_code: 'PROVIDER_STATUS_UNKNOWN', finished_at: null,
    })
    await expect(h.service.publish(owner, { ...request, operationId: 'op-2', approvalId: 'approval-2' }))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    const input = vi.mocked(provider.stage).mock.calls[0]![0]
    releaseEffect({ kind: 'accepted', receipt: {
      provider_id: provider.providerId, environment: 'staging', target_ref: provider.targetRef,
      operation_id: input.operationId, kind: 'PUBLISH', target_generation: input.targetGeneration,
      artifact_sha256: input.artifact.artifact_sha256, receipt_ref: 'dz23-receipt:late-after-expiry', observed_at: fixedNow,
    } })
    await expect(publishPromise).resolves.toMatchObject({ state: 'STAGING_OK', failure_code: null })
  })

  it('quarantines the target instead of returning a divergent terminal state after an accepted effect', async () => {
    const repository = new MemoryStagingRepository()
    vi.spyOn(repository, 'finalizeAccepted').mockImplementationOnce(async (actor, projectId, releaseId, expectedVersion) => {
      const current = repository.release(actor, projectId, releaseId)!
      const failed = stagingReleaseSchema.parse({
        ...current,
        state: 'FAILED',
        version: current.version + 1,
        last_transition_at: fixedNow,
        finished_at: fixedNow,
        failure_code: 'RACING_TERMINAL_STATE',
      })
      expect(await repository.compareAndSwapRelease(actor, projectId, releaseId, expectedVersion, failed)).toBe(true)
      return false
    })
    const h = harness({ repository })
    await expect(h.service.publish(owner, request)).resolves.toMatchObject({
      state: 'RECONCILIATION_REQUIRED',
      failure_code: 'CONFLICTING_EXTERNAL_EFFECT',
      provider_receipt: { receipt_ref: 'dz23-receipt:op-1' },
    })
    await expect(h.service.publish(owner, { ...request, operationId: 'op-2', approvalId: 'approval-2' }))
      .rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('quarantines a late accepted effect without stealing a newer busy generation', async () => {
    const repository = new MemoryStagingRepository()
    let resolveSecond!: (value: StagingProviderResult) => void
    const provider = providerPort()
    provider.stage = vi.fn(async input => {
      if (input.operationId === 'op-2') return new Promise<StagingProviderResult>(resolve => { resolveSecond = resolve })
      return { kind: 'accepted', receipt: {
        provider_id: provider.providerId, environment: 'staging', target_ref: provider.targetRef,
        operation_id: input.operationId, kind: 'PUBLISH', target_generation: input.targetGeneration,
        artifact_sha256: input.artifact.artifact_sha256, receipt_ref: `dz23-receipt:${input.operationId}`,
        observed_at: fixedNow,
      } } as const
    })
    let h!: ReturnType<typeof harness>
    let second!: ReturnType<StagingService['publish']>
    vi.spyOn(repository, 'finalizeAccepted').mockImplementationOnce(async (actor, projectId, releaseId, expectedVersion) => {
      const current = repository.release(actor, projectId, releaseId)!
      const failed = stagingReleaseSchema.parse({
        ...current,
        state: 'FAILED',
        version: current.version + 1,
        last_transition_at: fixedNow,
        finished_at: fixedNow,
        failure_code: 'RACING_TERMINAL_STATE',
      })
      expect(await repository.compareAndSwapRelease(actor, projectId, releaseId, expectedVersion, failed)).toBe(true)
      second = h.service.publish(owner, { ...request, operationId: 'op-2', approvalId: 'approval-2' })
      await vi.waitFor(() => expect(provider.stage).toHaveBeenCalledTimes(2))
      return false
    })
    h = harness({ repository, provider })
    await expect(h.service.publish(owner, request)).resolves.toMatchObject({
      state: 'RECONCILIATION_REQUIRED', failure_code: 'CONFLICTING_EXTERNAL_EFFECT', target_generation: 1,
    })
    expect(repository.releaseByOperation(owner, 'project-1', 'op-2')).toMatchObject({
      state: 'RECONCILIATION_REQUIRED', failure_code: 'TARGET_FENCED_BY_LATE_EFFECT', target_generation: 2,
    })
    const secondInput = vi.mocked(provider.stage).mock.calls.find(call => call[0].operationId === 'op-2')![0]
    resolveSecond({ kind: 'accepted', receipt: {
      provider_id: provider.providerId, environment: 'staging', target_ref: provider.targetRef,
      operation_id: secondInput.operationId, kind: 'PUBLISH', target_generation: secondInput.targetGeneration,
      artifact_sha256: secondInput.artifact.artifact_sha256, receipt_ref: 'dz23-receipt:op-2', observed_at: fixedNow,
    } })
    await expect(second).resolves.toMatchObject({
      state: 'RECONCILIATION_REQUIRED', failure_code: 'CONFLICTING_EXTERNAL_EFFECT', target_generation: 2,
    })
    await expect(h.service.publish(owner, { ...request, operationId: 'op-3', approvalId: 'approval-3' }))
      .rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('records an explicit provider rejection as failed and an ambiguous effect as reconciliation required', async () => {
    const rejected = harness({ provider: providerPort({ stage: vi.fn(async () => ({ kind: 'definitive-no-effect', failureCode: 'QUOTA_EXCEEDED' } as const)) }) })
    await expect(rejected.service.publish(owner, request)).resolves.toMatchObject({ state: 'FAILED', failure_code: 'QUOTA_EXCEEDED' })
    const unknown = harness({ provider: providerPort({ stage: vi.fn(() => Promise.reject(new Error('socket closed'))) }) })
    await expect(unknown.service.publish(owner, request)).resolves.toMatchObject({ state: 'RECONCILIATION_REQUIRED', failure_code: 'PROVIDER_EFFECT_UNKNOWN' })
    const invalidCode = harness({ provider: providerPort({ stage: vi.fn(async () => ({ kind: 'definitive-no-effect', failureCode: 'bad code' } as const)) }) })
    await expect(invalidCode.service.publish(owner, request)).resolves.toMatchObject({ state: 'FAILED', failure_code: 'PROVIDER_REJECTED' })
  })

  it('never accepts a receipt for another digest or destination', async () => {
    const h = harness({ provider: providerPort({ stage: vi.fn(async input => ({ kind: 'accepted', receipt: {
      provider_id: 'local-staging', environment: 'staging', target_ref: 'dz23-target:other', operation_id: input.operationId,
      kind: 'PUBLISH', target_generation: input.targetGeneration,
      artifact_sha256: digest('9'), receipt_ref: 'dz23-receipt:wrong', observed_at: fixedNow,
    } } as const)) }) })
    await expect(h.service.publish(owner, request)).resolves.toMatchObject({ state: 'RECONCILIATION_REQUIRED', failure_code: 'PROVIDER_RECEIPT_MISMATCH' })
  })

  it('does not reveal cross-tenant releases', async () => {
    const h = harness()
    const release = await h.service.publish(owner, request)
    const other: StagingActor = { ...owner, orgId: 'org-b', tenantId: 'tenant-b', sessionId: 'session-b' }
    expect(h.service.list(other, 'project-1')).toEqual([])
    expect(() => h.service.get(other, 'project-1', release.release_id)).toThrowError(StagingError)
    await expect(h.service.rollback(other, { projectId: 'project-1', operationId: 'op-2', approvalId: 'approval-2', targetReleaseId: release.release_id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('staging reconciliation and logical rollback', () => {
  it('reconciles ready, missing and unknown provider state without replaying publish', async () => {
    const readyProvider = providerPort({ stage: vi.fn(() => Promise.reject(new Error('lost response'))) })
    const ready = harness({ provider: readyProvider })
    const pending = await ready.service.publish(owner, request)
    readyProvider.status = vi.fn(async input => ({ state: 'READY', receipt: {
      provider_id: readyProvider.providerId, environment: 'staging', target_ref: readyProvider.targetRef,
      operation_id: input.operationId, kind: 'PUBLISH', target_generation: input.targetGeneration,
      artifact_sha256: input.artifactSha256,
      receipt_ref: 'dz23-receipt:reconciled', observed_at: fixedNow,
    } } as const))
    await expect(ready.service.reconcile(owner, 'project-1', pending.release_id)).resolves.toMatchObject({
      state: 'STAGING_OK', provider_receipt: { receipt_ref: 'dz23-receipt:reconciled' }, reconciled_at: fixedNow,
    })
    expect(readyProvider.stage).toHaveBeenCalledTimes(1)

    const unknownProvider = providerPort({ stage: vi.fn(() => Promise.reject(new Error('lost response'))), status: vi.fn(async () => ({ state: 'UNKNOWN' } as const)) })
    const unknown = harness({ provider: unknownProvider })
    const unknownRelease = await unknown.service.publish(owner, request)
    await expect(unknown.service.reconcile(owner, 'project-1', unknownRelease.release_id)).resolves.toMatchObject({ state: 'RECONCILIATION_REQUIRED', failure_code: 'PROVIDER_STATUS_UNKNOWN' })
    await expect(unknown.service.reconcile(owner, 'project-1', unknownRelease.release_id)).resolves.toMatchObject({ state: 'RECONCILIATION_REQUIRED', failure_code: 'PROVIDER_STATUS_UNKNOWN' })

    const statusThrowsProvider = providerPort({ stage: vi.fn(() => Promise.reject(new Error('lost response'))), status: vi.fn(() => Promise.reject(new Error('status unavailable'))) })
    const statusThrows = harness({ provider: statusThrowsProvider })
    const statusThrowsRelease = await statusThrows.service.publish(owner, request)
    await expect(statusThrows.service.reconcile(owner, 'project-1', statusThrowsRelease.release_id)).resolves.toMatchObject({ state: 'RECONCILIATION_REQUIRED', failure_code: 'PROVIDER_STATUS_UNKNOWN' })

    const terminal = await ready.service.get(owner, 'project-1', pending.release_id)
    await expect(ready.service.reconcile(owner, 'project-1', terminal.release_id)).resolves.toEqual(terminal)
  })

  it('marks a persisted request interrupted before provider as failed during reconciliation', async () => {
    const h = harness()
    const art = artifact()
    const fingerprint = stagingRequestFingerprint({
      kind: 'PUBLISH', orgId: owner.orgId, tenantId: owner.tenantId, projectId: 'project-1', operationId: 'op-persisted',
      providerId: h.provider.providerId, targetRef: h.provider.targetRef, artifact: art,
    })
    const persisted = stagingReleaseSchema.parse({
      release_id: stagingReleaseId(fingerprint), operation_id: 'op-persisted', request_fingerprint: fingerprint, kind: 'PUBLISH',
      org_id: owner.orgId, tenant_id: owner.tenantId, project_id: 'project-1', run_id: art.run_id, artifact: art,
      provider_id: h.provider.providerId, environment: 'staging', target_ref: h.provider.targetRef,
      target_key: digest('2'), target_generation: 1, effect_lease_id: 'lease-persisted',
      effect_lease_expires_at: '2026-09-07T11:59:00.000Z', state: 'REQUESTED', version: 1,
      created_by: owner.userId, source_session_id: owner.sessionId, requested_approval_id: 'approval-persisted',
      approval_id: 'approval-persisted', approved_at: fixedNow, created_at: '2026-09-07T11:55:00.000Z',
      last_transition_at: fixedNow, started_at: null, finished_at: null, reconciled_at: null,
      provider_receipt: null, failure_code: null,
      rollback_from_release_id: null, rollback_from_generation: null, rollback_target_release_id: null,
    })
    await h.repository.insert(persisted)
    await expect(h.service.reconcile(owner, 'project-1', persisted.release_id)).resolves.toMatchObject({ state: 'FAILED', failure_code: 'INTERRUPTED_BEFORE_PROVIDER' })
    expect(h.provider.status).not.toHaveBeenCalled()
  })

  it('rolls back by publishing an earlier immutable artifact and preserves every release', async () => {
    let now = new Date('2026-09-07T12:00:00.000Z')
    let selected = artifact('run-1', 'a')
    const provider = providerPort()
    provider.stage = vi.fn(async input => ({ kind: 'accepted', receipt: {
      provider_id: provider.providerId, environment: 'staging', target_ref: provider.targetRef,
      operation_id: input.operationId, kind: 'PUBLISH', target_generation: input.targetGeneration,
      artifact_sha256: input.artifact.artifact_sha256, receipt_ref: `dz23-receipt:${input.operationId}`,
      observed_at: input.operationId === 'op-first' ? '2099-01-01T00:00:00.000Z' : fixedNow,
    } } as const))
    const h = harness({ source: () => selected, provider, now: () => now })
    const first = await h.service.publish(owner, { ...request, operationId: 'op-first' })
    await expect(h.service.rollback(owner, { projectId: 'project-1', operationId: 'op-noop', approvalId: 'approval-noop', targetReleaseId: first.release_id })).rejects.toMatchObject({ code: 'CONFLICT' })
    now = new Date('2026-09-07T12:01:00.000Z')
    selected = artifact('run-2', '9')
    const second = await h.service.publish(owner, { ...request, operationId: 'op-second', approvalId: 'approval-2', runId: 'run-2' })
    now = new Date('2026-09-07T12:02:00.000Z')
    const rolled = await h.service.rollback(owner, { projectId: 'project-1', operationId: 'op-rollback', approvalId: 'approval-3', targetReleaseId: first.release_id })
    expect(rolled).toMatchObject({
      state: 'ROLLED_BACK', artifact: { artifact_sha256: first.artifact.artifact_sha256 },
      rollback_from_release_id: second.release_id, rollback_target_release_id: first.release_id,
    })
    expect(provider.rollback).toHaveBeenCalledWith(expect.objectContaining({
      fromReceiptRef: second.provider_receipt?.receipt_ref, targetGeneration: 3, artifact: first.artifact,
    }), expect.any(AbortSignal))
    expect(h.repository.releases(owner, 'project-1')).toHaveLength(3)
    expect(h.repository.release(owner, 'project-1', first.release_id)).toEqual(first)
    expect(await h.service.rollback(owner, { projectId: 'project-1', operationId: 'op-rollback', approvalId: 'approval-3', targetReleaseId: first.release_id })).toEqual(rolled)
    expect(provider.rollback).toHaveBeenCalledTimes(1)
    await expect(h.service.rollback(owner, { projectId: 'project-1', operationId: 'op-rollback', approvalId: 'approval-3', targetReleaseId: second.release_id })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(h.service.rollback(owner, { projectId: 'project-1', operationId: 'op-roll-forward', approvalId: 'approval-4', targetReleaseId: second.release_id })).resolves.toMatchObject({ state: 'ROLLED_BACK', run_id: 'run-2' })
  })

  it('refuses rollback to a release that never reached staging', async () => {
    const provider = providerPort({ stage: vi.fn(async () => ({ kind: 'definitive-no-effect', failureCode: 'POLICY_REFUSED' } as const)) })
    const h = harness({ provider })
    const failed = await h.service.publish(owner, request)
    await expect(h.service.rollback(owner, { projectId: 'project-1', operationId: 'op-rollback-failed', approvalId: 'approval-2', targetReleaseId: failed.release_id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
