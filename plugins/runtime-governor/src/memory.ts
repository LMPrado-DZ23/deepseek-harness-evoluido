import { randomUUID } from 'node:crypto'
import {
  CAPACITY_RESOURCES,
  CapacityGovernorError,
  DEFAULT_CAPACITY_LIMITS,
  DEFAULT_LEASE_TTL_MS,
  MAX_LEASE_TTL_MS,
  MIN_LEASE_TTL_MS,
  type AcquireBundleRequest,
  type CapacityGovernor,
  type CapacityLease,
  type CapacityLimits,
  type CapacityLimitLevel,
  type CapacityRequest,
  type CapacityResource,
  type CapacityScope,
  type CapacitySnapshot,
  type CapacityTakeoverRequest,
  type LeaseReference,
  type ProjectCapacityUsage,
  type ReconcileResult,
  type ResourceCapacityUsage,
  type TenantCapacityUsage,
} from './model.js'

export type MemoryCapacityGovernorOptions = Readonly<{
  limits?: CapacityLimits
  defaultTtlMs?: number
  now?: () => number
  createId?: () => string
  initialFencingToken?: number
}>

const MAX_IDENTIFIER_LENGTH = 256
const MAX_BUNDLE_REQUESTS = 32

type MutableLease = {
  leaseId: string
  fencingToken: number
  ownerId: string
  scope: CapacityScope
  allocations: Record<CapacityResource, number>
  acquiredAt: number
  expiresAt: number
}

class AsyncMutex {
  #tail: Promise<void> = Promise.resolve()

  async runExclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    let release!: () => void
    const previous = this.#tail
    this.#tail = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

function emptyAllocations(): Record<CapacityResource, number> {
  return { 'prompt-job': 0, build: 0, preview: 0 }
}

function assertIdentifier(name: string, value: string): void {
  if (
    value.length === 0
    || value.length > MAX_IDENTIFIER_LENGTH
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new CapacityGovernorError(
      'INVALID_CAPACITY_REQUEST',
      `${name} must be a non-empty identifier without surrounding whitespace or control characters.`,
      { field: name },
    )
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CapacityGovernorError(
      'INVALID_CAPACITY_REQUEST',
      `${name} must be a positive safe integer.`,
      { field: name, value },
    )
  }
}

function validateLimits(limits: CapacityLimits): CapacityLimits {
  const validated = {} as Record<CapacityResource, CapacityLimit>
  for (const resource of CAPACITY_RESOURCES) {
    const limit = limits[resource]
    assertPositiveInteger(`${resource}.global`, limit.global)
    assertPositiveInteger(`${resource}.perTenant`, limit.perTenant)
    assertPositiveInteger(`${resource}.perProject`, limit.perProject)
    if (limit.perTenant > limit.global || limit.perProject > limit.perTenant) {
      throw new CapacityGovernorError(
        'INVALID_CAPACITY_REQUEST',
        `Limits for ${resource} must satisfy perProject <= perTenant <= global.`,
        { resource },
      )
    }
    validated[resource] = Object.freeze({ ...limit })
  }
  return Object.freeze(validated)
}

type CapacityLimit = CapacityLimits[CapacityResource]

function cloneLease(lease: MutableLease): CapacityLease {
  return Object.freeze({
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    ownerId: lease.ownerId,
    scope: Object.freeze({ ...lease.scope }),
    allocations: Object.freeze({ ...lease.allocations }),
    acquiredAt: lease.acquiredAt,
    expiresAt: lease.expiresAt,
  })
}

function tenantKey(scope: CapacityScope): string {
  return `${scope.orgId.length}:${scope.orgId}${scope.tenantId.length}:${scope.tenantId}`
}

function projectKey(scope: CapacityScope): string {
  return `${tenantKey(scope)}${scope.projectId.length}:${scope.projectId}`
}

function normalizedAllocations(requests: readonly CapacityRequest[]): Record<CapacityResource, number> {
  if (requests.length === 0 || requests.length > MAX_BUNDLE_REQUESTS) {
    throw new CapacityGovernorError(
      'INVALID_CAPACITY_REQUEST',
      `A bundle must contain between 1 and ${MAX_BUNDLE_REQUESTS} capacity requests.`,
      { field: 'requests', count: requests.length },
    )
  }
  const allocations = emptyAllocations()
  for (const request of requests) {
    if (!CAPACITY_RESOURCES.includes(request.resource)) {
      throw new CapacityGovernorError(
        'INVALID_CAPACITY_REQUEST',
        'Unknown capacity resource.',
        { field: 'resource', resource: String(request.resource) },
      )
    }
    const units = request.units ?? 1
    assertPositiveInteger(`${request.resource}.units`, units)
    const total = allocations[request.resource] + units
    assertPositiveInteger(`${request.resource}.units`, total)
    allocations[request.resource] = total
  }
  return allocations
}

export class MemoryCapacityGovernor implements CapacityGovernor {
  readonly #limits: CapacityLimits
  readonly #defaultTtlMs: number
  readonly #now: () => number
  readonly #createId: () => string
  readonly #leases = new Map<string, MutableLease>()
  readonly #mutex = new AsyncMutex()
  #fencingToken: number

  constructor(options: MemoryCapacityGovernorOptions = {}) {
    this.#limits = validateLimits(options.limits ?? DEFAULT_CAPACITY_LIMITS)
    this.#defaultTtlMs = options.defaultTtlMs ?? DEFAULT_LEASE_TTL_MS
    this.#validateTtl(this.#defaultTtlMs)
    this.#now = options.now ?? Date.now
    this.#createId = options.createId ?? randomUUID
    this.#fencingToken = options.initialFencingToken ?? 0
    if (!Number.isSafeInteger(this.#fencingToken) || this.#fencingToken < 0) {
      throw new CapacityGovernorError(
        'INVALID_CAPACITY_REQUEST',
        'initialFencingToken must be a non-negative safe integer.',
        { field: 'initialFencingToken', value: this.#fencingToken },
      )
    }
  }

  acquireBundle(request: AcquireBundleRequest): Promise<CapacityLease> {
    return this.#mutex.runExclusive(() => {
      this.#validateScope(request.scope)
      assertIdentifier('ownerId', request.ownerId)
      const ttlMs = request.ttlMs ?? this.#defaultTtlMs
      this.#validateTtl(ttlMs)
      const allocations = normalizedAllocations(request.requests)
      const now = this.#readNow()
      this.#expire(now)
      this.#assertCapacity(request.scope, allocations)

      const leaseId = this.#availableLeaseId()
      if (this.#fencingToken >= Number.MAX_SAFE_INTEGER) {
        throw new CapacityGovernorError(
          'INVALID_CAPACITY_REQUEST',
          'The fencing token space is exhausted.',
          { field: 'fencingToken' },
        )
      }
      this.#fencingToken += 1
      const lease: MutableLease = {
        leaseId,
        fencingToken: this.#fencingToken,
        ownerId: request.ownerId,
        scope: Object.freeze({ ...request.scope }),
        allocations,
        acquiredAt: now,
        expiresAt: this.#expirationFor(now, ttlMs),
      }
      this.#leases.set(leaseId, lease)
      return cloneLease(lease)
    })
  }

  heartbeat(reference: LeaseReference, ttlMs = this.#defaultTtlMs): Promise<CapacityLease> {
    return this.#mutex.runExclusive(() => {
      this.#validateReference(reference)
      this.#validateTtl(ttlMs)
      const now = this.#readNow()
      this.#expire(now, reference.leaseId)
      const lease = this.#leaseFor(reference, now)
      lease.expiresAt = this.#expirationFor(now, ttlMs)
      return cloneLease(lease)
    })
  }

  release(reference: LeaseReference): Promise<void> {
    return this.#mutex.runExclusive(() => {
      this.#validateReference(reference)
      const now = this.#readNow()
      const lease = this.#leases.get(reference.leaseId)
      if (lease === undefined) {
        throw new CapacityGovernorError(
          'LEASE_NOT_FOUND',
          'The capacity lease is not active.',
          { leaseId: reference.leaseId },
        )
      }
      this.#assertFence(lease, reference)
      if (lease.expiresAt <= now) {
        this.#leases.delete(reference.leaseId)
        throw new CapacityGovernorError(
          'LEASE_NOT_FOUND',
          'The capacity lease has expired.',
          { leaseId: reference.leaseId },
        )
      }
      this.#leases.delete(reference.leaseId)
    })
  }

  takeover(request: CapacityTakeoverRequest): Promise<CapacityLease> {
    return this.#mutex.runExclusive(() => {
      this.#validateReference(request.reference)
      this.#validateScope(request.scope)
      assertIdentifier('ownerId', request.ownerId)
      const ttlMs = request.ttlMs ?? this.#defaultTtlMs
      this.#validateTtl(ttlMs)
      const allocations = normalizedAllocations(request.requests)
      const now = this.#readNow()
      const lease = this.#leaseFor(request.reference, now)
      if (lease.ownerId !== request.ownerId
        || projectKey(lease.scope) !== projectKey(request.scope)
        || !CAPACITY_RESOURCES.every(resource => lease.allocations[resource] === allocations[resource])) {
        throw new CapacityGovernorError(
          'INVALID_CAPACITY_REQUEST',
          'The takeover request does not match the active lease.',
          { leaseId: request.reference.leaseId },
        )
      }
      if (this.#fencingToken >= Number.MAX_SAFE_INTEGER) {
        throw new CapacityGovernorError(
          'INVALID_CAPACITY_REQUEST',
          'The fencing token space is exhausted.',
          { field: 'fencingToken' },
        )
      }
      this.#fencingToken += 1
      lease.fencingToken = this.#fencingToken
      lease.expiresAt = this.#expirationFor(now, ttlMs)
      return cloneLease(lease)
    })
  }

  reconcile(): Promise<ReconcileResult> {
    return this.#mutex.runExclusive(() => {
      const now = this.#readNow()
      const expired = this.#expire(now)
      return Object.freeze({
        reconciledAt: now,
        expired: Object.freeze(expired.map(reference => Object.freeze(reference))),
        activeLeaseCount: this.#leases.size,
      })
    })
  }

  snapshot(): Promise<CapacitySnapshot> {
    return this.#mutex.runExclusive(() => {
      const now = this.#readNow()
      this.#expire(now)
      const leases = [...this.#leases.values()]
        .sort((left, right) => left.fencingToken - right.fencingToken)
        .map(cloneLease)
      return Object.freeze({
        capturedAt: now,
        limits: this.#limits,
        leases: Object.freeze(leases),
        usage: Object.freeze(CAPACITY_RESOURCES.map(resource => this.#usage(resource))),
      })
    })
  }

  #validateScope(scope: CapacityScope): void {
    assertIdentifier('orgId', scope.orgId)
    assertIdentifier('tenantId', scope.tenantId)
    assertIdentifier('projectId', scope.projectId)
  }

  #validateReference(reference: LeaseReference): void {
    assertIdentifier('leaseId', reference.leaseId)
    assertPositiveInteger('fencingToken', reference.fencingToken)
  }

  #validateTtl(ttlMs: number): void {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_LEASE_TTL_MS || ttlMs > MAX_LEASE_TTL_MS) {
      throw new CapacityGovernorError(
        'INVALID_CAPACITY_REQUEST',
        `ttlMs must be an integer between ${MIN_LEASE_TTL_MS} and ${MAX_LEASE_TTL_MS}.`,
        { field: 'ttlMs', value: ttlMs },
      )
    }
  }

  #readNow(): number {
    const now = this.#now()
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new CapacityGovernorError(
        'INVALID_CAPACITY_REQUEST',
        'The injected clock must return a non-negative integer timestamp.',
        { field: 'now', value: now },
      )
    }
    return now
  }

  #expirationFor(now: number, ttlMs: number): number {
    const expiresAt = now + ttlMs
    if (!Number.isSafeInteger(expiresAt)) {
      throw new CapacityGovernorError(
        'INVALID_CAPACITY_REQUEST',
        'The lease expiration timestamp exceeds the safe integer range.',
        { field: 'expiresAt' },
      )
    }
    return expiresAt
  }

  #availableLeaseId(): string {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const leaseId = this.#createId()
      assertIdentifier('leaseId', leaseId)
      if (!this.#leases.has(leaseId)) return leaseId
    }
    throw new CapacityGovernorError(
      'LEASE_ID_COLLISION',
      'Unable to allocate a unique lease identifier.',
      { attempts: 16 },
    )
  }

  #expire(now: number, preservedLeaseId?: string): LeaseReference[] {
    const expired: LeaseReference[] = []
    for (const lease of this.#leases.values()) {
      if (lease.expiresAt > now || lease.leaseId === preservedLeaseId) continue
      this.#leases.delete(lease.leaseId)
      expired.push({ leaseId: lease.leaseId, fencingToken: lease.fencingToken })
    }
    return expired
  }

  #leaseFor(reference: LeaseReference, now: number): MutableLease {
    const lease = this.#leases.get(reference.leaseId)
    if (lease === undefined) {
      throw new CapacityGovernorError(
        'LEASE_NOT_FOUND',
        'The capacity lease is not active.',
        { leaseId: reference.leaseId },
      )
    }
    this.#assertFence(lease, reference)
    if (lease.expiresAt <= now) {
      this.#leases.delete(lease.leaseId)
      throw new CapacityGovernorError(
        'LEASE_NOT_FOUND',
        'The capacity lease has expired.',
        { leaseId: reference.leaseId },
      )
    }
    return lease
  }

  #assertFence(lease: MutableLease, reference: LeaseReference): void {
    if (lease.fencingToken !== reference.fencingToken) {
      throw new CapacityGovernorError(
        'STALE_FENCING_TOKEN',
        'The fencing token does not own the current lease generation.',
        {
          leaseId: reference.leaseId,
          expectedFencingToken: lease.fencingToken,
          receivedFencingToken: reference.fencingToken,
        },
      )
    }
  }

  #assertCapacity(scope: CapacityScope, requested: Record<CapacityResource, number>): void {
    for (const resource of CAPACITY_RESOURCES) {
      const units = requested[resource]
      if (units === 0) continue
      const usage = this.#usageTotals(resource, scope)
      const limit = this.#limits[resource]
      this.#assertLimit(resource, 'global', usage.global, units, limit.global)
      this.#assertLimit(resource, 'tenant', usage.tenant, units, limit.perTenant)
      this.#assertLimit(resource, 'project', usage.project, units, limit.perProject)
    }
  }

  #assertLimit(
    resource: CapacityResource,
    level: CapacityLimitLevel,
    current: number,
    requested: number,
    limit: number,
  ): void {
    if (current + requested <= limit) return
    throw new CapacityGovernorError(
      'CAPACITY_EXCEEDED',
      `Capacity exceeded for ${resource} at ${level} level.`,
      { resource, level, current, requested, limit },
    )
  }

  #usageTotals(resource: CapacityResource, scope: CapacityScope): {
    global: number
    tenant: number
    project: number
  } {
    let global = 0
    let tenant = 0
    let project = 0
    const expectedTenant = tenantKey(scope)
    const expectedProject = projectKey(scope)
    for (const lease of this.#leases.values()) {
      const units = lease.allocations[resource]
      global += units
      if (tenantKey(lease.scope) === expectedTenant) tenant += units
      if (projectKey(lease.scope) === expectedProject) project += units
    }
    return { global, tenant, project }
  }

  #usage(resource: CapacityResource): ResourceCapacityUsage {
    let global = 0
    const tenants = new Map<string, TenantCapacityUsage>()
    const projects = new Map<string, ProjectCapacityUsage>()
    for (const lease of this.#leases.values()) {
      const units = lease.allocations[resource]
      if (units === 0) continue
      global += units
      const tenant = tenantKey(lease.scope)
      const tenantUsage = tenants.get(tenant)
      tenants.set(tenant, {
        orgId: lease.scope.orgId,
        tenantId: lease.scope.tenantId,
        units: (tenantUsage?.units ?? 0) + units,
      })
      const project = projectKey(lease.scope)
      const projectUsage = projects.get(project)
      projects.set(project, {
        ...lease.scope,
        units: (projectUsage?.units ?? 0) + units,
      })
    }
    return Object.freeze({
      resource,
      global,
      tenants: Object.freeze([...tenants.values()].sort((a, b) =>
        `${a.orgId}\u0000${a.tenantId}`.localeCompare(`${b.orgId}\u0000${b.tenantId}`))),
      projects: Object.freeze([...projects.values()].sort((a, b) =>
        `${a.orgId}\u0000${a.tenantId}\u0000${a.projectId}`.localeCompare(
          `${b.orgId}\u0000${b.tenantId}\u0000${b.projectId}`,
        ))),
    })
  }
}
