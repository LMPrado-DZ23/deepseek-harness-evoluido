import { describe, expect, it } from 'vitest'
import {
  CapacityGovernorError,
  DEFAULT_CAPACITY_LIMITS,
  MemoryCapacityGovernor,
  type CapacityLimits,
  type CapacityScope,
} from '../src/index.ts'

const scope: CapacityScope = {
  orgId: 'org-1',
  tenantId: 'tenant-1',
  projectId: 'project-1',
}

function manualClock(initial = 1_000) {
  let current = initial
  return {
    now: () => current,
    advance: (milliseconds: number) => { current += milliseconds },
    set: (milliseconds: number) => { current = milliseconds },
  }
}

function sequentialIds(...ids: string[]) {
  let index = 0
  return () => ids[index++] ?? `lease-${index}`
}

function limits(overrides: Partial<CapacityLimits> = {}): CapacityLimits {
  return {
    ...DEFAULT_CAPACITY_LIMITS,
    ...overrides,
  }
}

function expectGovernorError(error: unknown, code: CapacityGovernorError['code']) {
  expect(error).toBeInstanceOf(CapacityGovernorError)
  expect((error as CapacityGovernorError).code).toBe(code)
}

describe('MemoryCapacityGovernor', () => {
  it('uses the documented defaults and returns immutable snapshots', async () => {
    const clock = manualClock()
    const governor = new MemoryCapacityGovernor({ now: clock.now, createId: () => 'lease-1' })
    const lease = await governor.acquireBundle({
      ownerId: 'job-1',
      scope,
      requests: [{ resource: 'prompt-job' }],
    })
    const snapshot = await governor.snapshot()

    expect(lease).toMatchObject({
      leaseId: 'lease-1',
      fencingToken: 1,
      acquiredAt: 1_000,
      expiresAt: 121_000,
      allocations: { 'prompt-job': 1, build: 0, preview: 0 },
    })
    expect(snapshot.limits).toEqual(DEFAULT_CAPACITY_LIMITS)
    expect(snapshot.leases).toEqual([lease])
    expect(snapshot.usage.find(item => item.resource === 'prompt-job')).toEqual({
      resource: 'prompt-job',
      global: 1,
      tenants: [{ orgId: 'org-1', tenantId: 'tenant-1', units: 1 }],
      projects: [{ ...scope, units: 1 }],
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.leases)).toBe(true)
    expect(Object.isFrozen(lease.allocations)).toBe(true)
  })

  it('acquires a multi-resource bundle atomically and sums duplicate requests', async () => {
    const governor = new MemoryCapacityGovernor({
      createId: sequentialIds('build-holder', 'bundle'),
      limits: limits({
        'prompt-job': { global: 10, perTenant: 10, perProject: 10 },
        build: { global: 1, perTenant: 1, perProject: 1 },
      }),
    })
    await governor.acquireBundle({ ownerId: 'holder', scope, requests: [{ resource: 'build' }] })

    await expect(governor.acquireBundle({
      ownerId: 'blocked-bundle',
      scope: { ...scope, projectId: 'project-2' },
      requests: [
        { resource: 'prompt-job' },
        { resource: 'prompt-job', units: 2 },
        { resource: 'build' },
      ],
    })).rejects.toMatchObject({
      code: 'CAPACITY_EXCEEDED',
      details: { resource: 'build', level: 'global', current: 1, requested: 1, limit: 1 },
    })
    expect((await governor.snapshot()).usage.find(item => item.resource === 'prompt-job')?.global).toBe(0)

    await governor.release({ leaseId: 'build-holder', fencingToken: 1 })
    const bundle = await governor.acquireBundle({
      ownerId: 'accepted-bundle',
      scope,
      requests: [{ resource: 'prompt-job' }, { resource: 'prompt-job', units: 2 }, { resource: 'build' }],
    })
    expect(bundle.allocations).toEqual({ 'prompt-job': 3, build: 1, preview: 0 })
  })

  it('serializes concurrent acquisition so only one project-scoped claimant wins', async () => {
    const governor = new MemoryCapacityGovernor({ createId: sequentialIds('winner') })
    const attempts = await Promise.allSettled([
      governor.acquireBundle({ ownerId: 'one', scope, requests: [{ resource: 'build' }] }),
      governor.acquireBundle({ ownerId: 'two', scope, requests: [{ resource: 'build' }] }),
    ])

    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = attempts.find(result => result.status === 'rejected')
    expect(rejected?.status).toBe('rejected')
    if (rejected?.status === 'rejected') {
      expectGovernorError(rejected.reason, 'CAPACITY_EXCEEDED')
      expect(rejected.reason).toMatchObject({ details: { level: 'global' } })
    }
    expect((await governor.snapshot()).leases).toHaveLength(1)
  })

  it('isolates tenant and project quotas while preserving the global ceiling', async () => {
    const governor = new MemoryCapacityGovernor({
      createId: sequentialIds('a-1', 'b-1', 'a-2'),
      limits: limits({ preview: { global: 2, perTenant: 1, perProject: 1 } }),
    })
    const tenantA = scope
    const tenantB = { ...scope, tenantId: 'tenant-2' }
    await governor.acquireBundle({ ownerId: 'a', scope: tenantA, requests: [{ resource: 'preview' }] })
    await governor.acquireBundle({ ownerId: 'b', scope: tenantB, requests: [{ resource: 'preview' }] })

    await expect(governor.acquireBundle({
      ownerId: 'a-second',
      scope: { ...tenantA, projectId: 'project-2' },
      requests: [{ resource: 'preview' }],
    })).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED', details: { level: 'global' } })
    const previewUsage = (await governor.snapshot()).usage.find(item => item.resource === 'preview')
    expect(previewUsage?.tenants).toEqual([
      { orgId: 'org-1', tenantId: 'tenant-1', units: 1 },
      { orgId: 'org-1', tenantId: 'tenant-2', units: 1 },
    ])
  })

  it('renews live leases and reconciles expired leases deterministically', async () => {
    const clock = manualClock()
    const governor = new MemoryCapacityGovernor({ now: clock.now, createId: () => 'lease-1' })
    const lease = await governor.acquireBundle({
      ownerId: 'worker',
      scope,
      requests: [{ resource: 'build' }],
      ttlMs: 2_000,
    })
    clock.advance(1_500)
    const renewed = await governor.heartbeat(lease, 3_000)
    expect(renewed.expiresAt).toBe(5_500)
    clock.advance(2_999)
    expect((await governor.reconcile()).activeLeaseCount).toBe(1)
    clock.advance(1)
    expect(await governor.reconcile()).toEqual({
      reconciledAt: 5_500,
      expired: [{ leaseId: 'lease-1', fencingToken: 1 }],
      activeLeaseCount: 0,
    })
    await expect(governor.heartbeat(lease)).rejects.toMatchObject({ code: 'LEASE_NOT_FOUND' })
    await expect(governor.release(lease)).rejects.toMatchObject({ code: 'LEASE_NOT_FOUND' })
  })

  it('rejects stale workers when an expired lease identifier is reused', async () => {
    const clock = manualClock()
    const governor = new MemoryCapacityGovernor({ now: clock.now, createId: () => 'reused-id' })
    const stale = await governor.acquireBundle({
      ownerId: 'old-worker', scope, requests: [{ resource: 'build' }], ttlMs: 1_000,
    })
    clock.advance(1_000)
    const current = await governor.acquireBundle({
      ownerId: 'new-worker', scope, requests: [{ resource: 'build' }], ttlMs: 2_000,
    })
    expect(current).toMatchObject({ leaseId: 'reused-id', fencingToken: 2 })

    await expect(governor.heartbeat(stale)).rejects.toMatchObject({ code: 'STALE_FENCING_TOKEN' })
    await expect(governor.release(stale)).rejects.toMatchObject({ code: 'STALE_FENCING_TOKEN' })
    expect((await governor.snapshot()).leases).toEqual([current])
    await governor.release(current)
    expect((await governor.snapshot()).leases).toEqual([])
  })

  it('rotates the fencing token on a matching takeover and rejects the previous holder', async () => {
    const governor = new MemoryCapacityGovernor({ createId: () => 'lease-takeover', now: () => 1_000 })
    const original = await governor.acquireBundle({
      ownerId: 'preview:one',
      scope: { orgId: 'org-1', tenantId: 'tenant-1', projectId: 'project-1' },
      requests: [{ resource: 'preview' }],
    })
    const recovered = await governor.takeover({
      reference: original,
      ownerId: original.ownerId,
      scope: original.scope,
      requests: [{ resource: 'preview' }],
    })
    expect(recovered).toMatchObject({ leaseId: original.leaseId, fencingToken: original.fencingToken + 1 })
    await expect(governor.heartbeat(original)).rejects.toMatchObject({ code: 'STALE_FENCING_TOKEN' })
    await expect(governor.takeover({
      reference: recovered,
      ownerId: 'preview:other',
      scope: recovered.scope,
      requests: [{ resource: 'preview' }],
    })).rejects.toMatchObject({ code: 'INVALID_CAPACITY_REQUEST' })
  })

  it('fails closed on invalid limits, scopes, requests, TTLs, clocks and tokens', async () => {
    expect(() => new MemoryCapacityGovernor({
      limits: limits({ preview: { global: 1, perTenant: 2, perProject: 1 } }),
    })).toThrowError(/perProject <= perTenant <= global/u)
    expect(() => new MemoryCapacityGovernor({ defaultTtlMs: 999 })).toThrowError(/ttlMs/u)
    expect(() => new MemoryCapacityGovernor({ initialFencingToken: -1 })).toThrowError(/initialFencingToken/u)

    const governor = new MemoryCapacityGovernor({ createId: () => 'lease', now: () => 1_000 })
    await expect(governor.acquireBundle({ ownerId: ' worker', scope, requests: [{ resource: 'build' }] }))
      .rejects.toMatchObject({ code: 'INVALID_CAPACITY_REQUEST' })
    await expect(governor.acquireBundle({ ownerId: 'x'.repeat(257), scope, requests: [{ resource: 'build' }] }))
      .rejects.toMatchObject({ code: 'INVALID_CAPACITY_REQUEST' })
    await expect(governor.acquireBundle({ ownerId: 'worker', scope: { ...scope, tenantId: '' }, requests: [{ resource: 'build' }] }))
      .rejects.toMatchObject({ code: 'INVALID_CAPACITY_REQUEST' })
    await expect(governor.acquireBundle({ ownerId: 'worker', scope, requests: [] }))
      .rejects.toMatchObject({ code: 'INVALID_CAPACITY_REQUEST' })
    await expect(governor.acquireBundle({
      ownerId: 'worker', scope, requests: Array.from({ length: 33 }, () => ({ resource: 'build' as const })),
    })).rejects.toMatchObject({ code: 'INVALID_CAPACITY_REQUEST' })
    await expect(governor.acquireBundle({ ownerId: 'worker', scope, requests: [{ resource: 'build', units: 0 }] }))
      .rejects.toMatchObject({ code: 'INVALID_CAPACITY_REQUEST' })
    await expect(governor.acquireBundle({
      ownerId: 'worker', scope, requests: [{ resource: 'unknown' as 'build' }],
    })).rejects.toMatchObject({ code: 'INVALID_CAPACITY_REQUEST' })
    await expect(governor.acquireBundle({ ownerId: 'worker', scope, requests: [{ resource: 'build' }], ttlMs: 3_600_001 }))
      .rejects.toMatchObject({ code: 'INVALID_CAPACITY_REQUEST' })
    await expect(governor.heartbeat({ leaseId: '', fencingToken: 1 }))
      .rejects.toMatchObject({ code: 'INVALID_CAPACITY_REQUEST' })

    const badClock = new MemoryCapacityGovernor({ now: () => -1 })
    await expect(badClock.snapshot()).rejects.toMatchObject({ code: 'INVALID_CAPACITY_REQUEST' })
    const overflowingClock = new MemoryCapacityGovernor({ now: () => Number.MAX_SAFE_INTEGER })
    await expect(overflowingClock.acquireBundle({ ownerId: 'worker', scope, requests: [{ resource: 'build' }] }))
      .rejects.toMatchObject({ code: 'INVALID_CAPACITY_REQUEST' })
  })

  it('rejects heartbeat and release exactly at the expiration boundary', async () => {
    const heartbeatClock = manualClock()
    const heartbeatGovernor = new MemoryCapacityGovernor({
      now: heartbeatClock.now,
      createId: () => 'heartbeat-expired',
    })
    const heartbeatLease = await heartbeatGovernor.acquireBundle({
      ownerId: 'worker', scope, requests: [{ resource: 'build' }], ttlMs: 1_000,
    })
    heartbeatClock.advance(1_000)
    await expect(heartbeatGovernor.heartbeat(heartbeatLease))
      .rejects.toMatchObject({ code: 'LEASE_NOT_FOUND' })

    const releaseClock = manualClock()
    const releaseGovernor = new MemoryCapacityGovernor({
      now: releaseClock.now,
      createId: () => 'release-expired',
    })
    const releaseLease = await releaseGovernor.acquireBundle({
      ownerId: 'worker', scope, requests: [{ resource: 'build' }], ttlMs: 1_000,
    })
    releaseClock.advance(1_000)
    await expect(releaseGovernor.release(releaseLease))
      .rejects.toMatchObject({ code: 'LEASE_NOT_FOUND' })
    expect((await releaseGovernor.snapshot()).leases).toEqual([])
  })

  it('detects active ID collisions and fencing token exhaustion without reserving capacity', async () => {
    const collisions = new MemoryCapacityGovernor({ createId: () => 'same-id' })
    await collisions.acquireBundle({ ownerId: 'first', scope, requests: [{ resource: 'prompt-job' }] })
    await expect(collisions.acquireBundle({
      ownerId: 'second',
      scope: { ...scope, projectId: 'project-2' },
      requests: [{ resource: 'prompt-job' }],
    })).rejects.toMatchObject({ code: 'LEASE_ID_COLLISION', details: { attempts: 16 } })
    expect((await collisions.snapshot()).leases).toHaveLength(1)

    const exhausted = new MemoryCapacityGovernor({
      initialFencingToken: Number.MAX_SAFE_INTEGER,
      createId: () => 'never-created',
    })
    await expect(exhausted.acquireBundle({ ownerId: 'worker', scope, requests: [{ resource: 'build' }] }))
      .rejects.toMatchObject({ code: 'INVALID_CAPACITY_REQUEST' })
    expect((await exhausted.snapshot()).leases).toHaveLength(0)
  })
})
