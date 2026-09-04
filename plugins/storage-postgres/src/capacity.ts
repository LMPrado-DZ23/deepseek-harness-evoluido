import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient, type PoolConfig } from 'pg'
import {
  CAPACITY_RESOURCES,
  CapacityGovernorError,
  DEFAULT_CAPACITY_LIMITS,
  DEFAULT_LEASE_TTL_MS,
  MAX_LEASE_TTL_MS,
  MIN_LEASE_TTL_MS,
  type AcquireBundleRequest,
  type DistributedCapacityGovernor,
  type CapacityLease,
  type CapacityLimit,
  type CapacityLimitLevel,
  type CapacityLimits,
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
} from '@dz23-studio/runtime-governor'
import {
  assertSchemaProtected,
  capacityLeasesTable,
  capacityMetaTable,
  ensureCapacitySchema,
} from './capacity-schema.js'
import { assertConfiguredSchemaName } from './schema.js'

const MAX_IDENTIFIER_LENGTH = 256
const MAX_BUNDLE_REQUESTS = 32
const MAX_FENCING_TOKEN = Number.MAX_SAFE_INTEGER

type AllocationMap = Record<CapacityResource, number>

interface CapacityLeaseRow {
  lease_id: string
  fencing_token: string
  holder_id: string
  owner_id: string
  org_id: string
  tenant_id: string
  project_id: string
  prompt_job_units: number
  build_units: number
  preview_units: number
  acquired_at_ms: string
  expires_at_ms: string
}

export interface PostgresCapacityGovernorOptions {
  readonly connectionString: string
  readonly schema: string
  readonly ssl: false | { readonly rejectUnauthorized: boolean }
  readonly poolMax?: number
  readonly limits?: CapacityLimits
  readonly defaultTtlMs?: number
  readonly lockTimeoutMs?: number
  readonly statementTimeoutMs?: number
  readonly createId?: () => string
  readonly holderId?: string
}

/** PostgreSQL-backed capacity authority. Every admission is serialized by capacity_meta. */
export class PostgresCapacityGovernor implements DistributedCapacityGovernor {
  readonly #pool: Pool
  readonly #schema: string
  readonly #limits: CapacityLimits
  readonly #defaultTtlMs: number
  readonly #lockTimeoutMs: number
  readonly #statementTimeoutMs: number
  readonly #createId: () => string
  readonly #holderId: string
  readonly #ready: Promise<void>
  #closing: Promise<void> | undefined

  constructor(options: PostgresCapacityGovernorOptions) {
    assertConfiguredSchemaName(options.schema)
    this.#schema = options.schema
    this.#limits = validateLimits(options.limits ?? DEFAULT_CAPACITY_LIMITS)
    this.#defaultTtlMs = options.defaultTtlMs ?? DEFAULT_LEASE_TTL_MS
    validateTtl(this.#defaultTtlMs)
    this.#lockTimeoutMs = validateTimeout('lockTimeoutMs', options.lockTimeoutMs ?? 2_000)
    this.#statementTimeoutMs = validateTimeout('statementTimeoutMs', options.statementTimeoutMs ?? 5_000)
    this.#createId = options.createId ?? randomUUID
    this.#holderId = options.holderId ?? randomUUID()
    assertIdentifier('holderId', this.#holderId)
    const config: PoolConfig = {
      connectionString: options.connectionString,
      ssl: options.ssl,
      max: options.poolMax ?? 2,
      application_name: `dz23-capacity:${options.schema}`,
    }
    this.#pool = new Pool(config)
    this.#ready = ensureCapacitySchema(this.#pool, this.#schema, this.#limits)
    this.#ready.catch(() => undefined)
  }

  waitUntilReady(): Promise<void> {
    return this.#ready
  }

  async acquireBundle(request: AcquireBundleRequest): Promise<CapacityLease> {
    const scope = validateScope(request.scope)
    assertIdentifier('ownerId', request.ownerId)
    const ttlMs = request.ttlMs ?? this.#defaultTtlMs
    validateTtl(ttlMs)
    const allocations = normalizedAllocations(request.requests)
    return this.#transaction(async client => {
      await this.#lockAuthority(client)
      const now = await dbNow(client)
      await this.#deleteExpired(client, now)
      const existingOwner = await client.query(
        `SELECT 1 FROM ${capacityLeasesTable(this.#schema)} WHERE owner_id = $1`,
        [request.ownerId],
      )
      if (existingOwner.rowCount !== 0) {
        throw new CapacityGovernorError('LEASE_ID_COLLISION', 'The capacity owner already has an active lease.', { ownerId: request.ownerId })
      }
      const active = await this.#leaseRows(client)
      this.#assertCapacity(scope, allocations, active.map(rowToLease))
      const leaseId = await this.#availableLeaseId(client)
      const fencingToken = await this.#nextFence(client)
      const result = await client.query<CapacityLeaseRow>(`
        INSERT INTO ${capacityLeasesTable(this.#schema)} (
          lease_id, fencing_token, holder_id, owner_id, org_id, tenant_id, project_id,
          prompt_job_units, build_units, preview_units, acquired_at, expires_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          to_timestamp($11::double precision / 1000),
          to_timestamp(($11::double precision + $12::double precision) / 1000)
        )
        RETURNING ${leaseColumns()}
      `, [
        leaseId, fencingToken, this.#holderId, request.ownerId,
        scope.orgId, scope.tenantId, scope.projectId,
        allocations['prompt-job'], allocations.build, allocations.preview,
        now, ttlMs,
      ])
      return rowToLease(result.rows[0]!)
    })
  }

  async heartbeat(reference: LeaseReference, ttlMs = this.#defaultTtlMs): Promise<CapacityLease> {
    validateReference(reference)
    validateTtl(ttlMs)
    const outcome = await this.#transaction(async client => {
      const row = await this.#lockedLease(client, reference.leaseId)
      const now = await dbNow(client)
      this.#assertOwned(row, reference)
      if (leaseExpired(row, now)) {
        await this.#deleteLease(client, reference.leaseId)
        return { expired: true } as const
      }
      const result = await client.query<CapacityLeaseRow>(`
        UPDATE ${capacityLeasesTable(this.#schema)}
        SET expires_at = to_timestamp(($2::double precision + $3::double precision) / 1000)
        WHERE lease_id = $1
        RETURNING ${leaseColumns()}
      `, [reference.leaseId, now, ttlMs])
      return { expired: false, lease: rowToLease(result.rows[0]!) } as const
    })
    if (outcome.expired) throw leaseNotFound(reference.leaseId)
    return outcome.lease
  }

  async release(reference: LeaseReference): Promise<void> {
    validateReference(reference)
    const expired = await this.#transaction(async client => {
      const row = await this.#lockedLease(client, reference.leaseId)
      const now = await dbNow(client)
      this.#assertOwned(row, reference)
      await this.#deleteLease(client, reference.leaseId)
      return leaseExpired(row, now)
    })
    if (expired) throw leaseNotFound(reference.leaseId)
  }

  async takeover(request: CapacityTakeoverRequest): Promise<CapacityLease> {
    validateReference(request.reference)
    const scope = validateScope(request.scope)
    assertIdentifier('ownerId', request.ownerId)
    const allocations = normalizedAllocations(request.requests)
    const ttlMs = request.ttlMs ?? this.#defaultTtlMs
    validateTtl(ttlMs)
    const outcome = await this.#transaction(async client => {
      await this.#lockAuthority(client)
      const now = await dbNow(client)
      const row = await this.#lockedLease(client, request.reference.leaseId)
      if (leaseExpired(row, now)) {
        await this.#deleteLease(client, request.reference.leaseId)
        return { expired: true } as const
      }
      await this.#deleteExpired(client, now)
      if (toSafeInteger('fencingToken', row.fencing_token) !== request.reference.fencingToken) {
        throw staleFence(row, request.reference)
      }
      const lease = rowToLease(row)
      if (lease.ownerId !== request.ownerId || !sameScope(lease.scope, scope) || !sameAllocations(lease.allocations, allocations)) {
        throw new CapacityGovernorError('INVALID_CAPACITY_REQUEST', 'The takeover request does not match the active lease.', { leaseId: request.reference.leaseId })
      }
      const fencingToken = await this.#nextFence(client)
      const result = await client.query<CapacityLeaseRow>(`
        UPDATE ${capacityLeasesTable(this.#schema)}
        SET fencing_token = $2, holder_id = $3,
            expires_at = to_timestamp(($4::double precision + $5::double precision) / 1000)
        WHERE lease_id = $1 AND fencing_token = $6
        RETURNING ${leaseColumns()}
      `, [request.reference.leaseId, fencingToken, this.#holderId, now, ttlMs, request.reference.fencingToken])
      if (result.rowCount !== 1) throw staleFence(row, request.reference)
      return { expired: false, lease: rowToLease(result.rows[0]!) } as const
    })
    if (outcome.expired) throw leaseNotFound(request.reference.leaseId)
    return outcome.lease
  }

  async reconcile(): Promise<ReconcileResult> {
    return this.#transaction(async client => {
      await this.#lockAuthority(client)
      const now = await dbNow(client)
      const expired = await client.query<{ lease_id: string; fencing_token: string }>(
        `DELETE FROM ${capacityLeasesTable(this.#schema)}
         WHERE expires_at <= to_timestamp($1::double precision / 1000)
         RETURNING lease_id, fencing_token`,
        [now],
      )
      const count = await client.query<{ count: string }>(`SELECT count(*)::bigint AS count FROM ${capacityLeasesTable(this.#schema)}`)
      return Object.freeze({
        reconciledAt: now,
        expired: Object.freeze(expired.rows
          .map(row => Object.freeze({ leaseId: row.lease_id, fencingToken: toSafeInteger('fencingToken', row.fencing_token) }))
          .sort((left, right) => left.fencingToken - right.fencingToken)),
        activeLeaseCount: toSafeInteger('activeLeaseCount', count.rows[0]!.count),
      })
    })
  }

  async snapshot(): Promise<CapacitySnapshot> {
    return this.#transaction(async client => {
      await this.#lockAuthority(client)
      const now = await dbNow(client)
      await this.#deleteExpired(client, now)
      const leases = (await this.#leaseRows(client)).map(rowToLease)
      return Object.freeze({
        capturedAt: now,
        limits: this.#limits,
        leases: Object.freeze(leases),
        usage: Object.freeze(CAPACITY_RESOURCES.map(resource => capacityUsage(resource, leases))),
      })
    })
  }

  close(): Promise<void> {
    this.#closing ??= this.#ready.catch(() => undefined).then(() => this.#pool.end())
    return this.#closing
  }

  async #transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    if (this.#closing !== undefined) throw new Error('postgres capacity governor is closed')
    await this.#ready
    const client = await this.#pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SET LOCAL lock_timeout = '${this.#lockTimeoutMs}ms'`)
      await client.query(`SET LOCAL statement_timeout = '${this.#statementTimeoutMs}ms'`)
      await assertSchemaProtected(client, this.#schema)
      const result = await operation(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async #lockAuthority(client: PoolClient): Promise<void> {
    const result = await client.query<{ limits: CapacityLimits }>(
      `SELECT limits FROM ${capacityMetaTable(this.#schema)} WHERE singleton = TRUE FOR UPDATE`,
    )
    if (result.rows[0] === undefined) throw new Error('capacity postgres authority row is missing')
    if (JSON.stringify(validateLimits(result.rows[0].limits)) !== JSON.stringify(this.#limits)) {
      throw new Error('capacity postgres limits changed while the governor was running')
    }
  }

  async #nextFence(client: PoolClient): Promise<number> {
    const result = await client.query<{ fencing_token: string }>(`
      UPDATE ${capacityMetaTable(this.#schema)}
      SET next_fencing_token = next_fencing_token + 1
      WHERE singleton = TRUE AND next_fencing_token < 9007199254740991
      RETURNING next_fencing_token AS fencing_token
    `)
    const value = result.rows[0]?.fencing_token
    if (value === undefined) {
      throw new CapacityGovernorError('INVALID_CAPACITY_REQUEST', 'The fencing token space is exhausted.', { field: 'fencingToken' })
    }
    return toSafeInteger('fencingToken', value)
  }

  async #availableLeaseId(client: PoolClient): Promise<string> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const leaseId = this.#createId()
      assertIdentifier('leaseId', leaseId)
      const found = await client.query(`SELECT 1 FROM ${capacityLeasesTable(this.#schema)} WHERE lease_id = $1`, [leaseId])
      if (found.rowCount === 0) return leaseId
    }
    throw new CapacityGovernorError('LEASE_ID_COLLISION', 'Unable to allocate a unique lease identifier.', { attempts: 16 })
  }

  async #lockedLease(client: PoolClient, leaseId: string): Promise<CapacityLeaseRow> {
    const result = await client.query<CapacityLeaseRow>(
      `SELECT ${leaseColumns()} FROM ${capacityLeasesTable(this.#schema)} WHERE lease_id = $1 FOR UPDATE`,
      [leaseId],
    )
    const row = result.rows[0]
    if (row === undefined) throw leaseNotFound(leaseId)
    return row
  }

  #assertOwned(row: CapacityLeaseRow, reference: LeaseReference): void {
    if (toSafeInteger('fencingToken', row.fencing_token) !== reference.fencingToken || row.holder_id !== this.#holderId) {
      throw staleFence(row, reference)
    }
  }

  async #deleteExpired(client: PoolClient, now: number): Promise<void> {
    await client.query(
      `DELETE FROM ${capacityLeasesTable(this.#schema)} WHERE expires_at <= to_timestamp($1::double precision / 1000)`,
      [now],
    )
  }

  async #deleteLease(client: PoolClient, leaseId: string): Promise<void> {
    await client.query(`DELETE FROM ${capacityLeasesTable(this.#schema)} WHERE lease_id = $1`, [leaseId])
  }

  async #leaseRows(client: PoolClient): Promise<CapacityLeaseRow[]> {
    const result = await client.query<CapacityLeaseRow>(
      `SELECT ${leaseColumns()} FROM ${capacityLeasesTable(this.#schema)} ORDER BY fencing_token`,
    )
    return result.rows
  }

  #assertCapacity(scope: CapacityScope, requested: AllocationMap, leases: readonly CapacityLease[]): void {
    for (const resource of CAPACITY_RESOURCES) {
      const units = requested[resource]
      if (units === 0) continue
      const usage = usageTotals(resource, scope, leases)
      const limit = this.#limits[resource]
      assertLimit(resource, 'global', usage.global, units, limit.global)
      assertLimit(resource, 'tenant', usage.tenant, units, limit.perTenant)
      assertLimit(resource, 'project', usage.project, units, limit.perProject)
    }
  }
}

function leaseColumns(): string {
  return `lease_id, fencing_token::text, holder_id, owner_id, org_id, tenant_id, project_id,
    prompt_job_units, build_units, preview_units,
    floor(extract(epoch FROM acquired_at) * 1000)::bigint::text AS acquired_at_ms,
    floor(extract(epoch FROM expires_at) * 1000)::bigint::text AS expires_at_ms`
}

async function dbNow(client: PoolClient): Promise<number> {
  const result = await client.query<{ now_ms: string }>(
    'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS now_ms',
  )
  return toSafeInteger('database clock', result.rows[0]!.now_ms)
}

function rowToLease(row: CapacityLeaseRow): CapacityLease {
  return Object.freeze({
    leaseId: row.lease_id,
    fencingToken: toSafeInteger('fencingToken', row.fencing_token),
    ownerId: row.owner_id,
    scope: Object.freeze({ orgId: row.org_id, tenantId: row.tenant_id, projectId: row.project_id }),
    allocations: Object.freeze({
      'prompt-job': row.prompt_job_units,
      build: row.build_units,
      preview: row.preview_units,
    }),
    acquiredAt: toSafeInteger('acquiredAt', row.acquired_at_ms),
    expiresAt: toSafeInteger('expiresAt', row.expires_at_ms),
  })
}

function emptyAllocations(): AllocationMap {
  return { 'prompt-job': 0, build: 0, preview: 0 }
}

function normalizedAllocations(requests: readonly CapacityRequest[]): AllocationMap {
  if (requests.length === 0 || requests.length > MAX_BUNDLE_REQUESTS) {
    throw new CapacityGovernorError('INVALID_CAPACITY_REQUEST', `A bundle must contain between 1 and ${MAX_BUNDLE_REQUESTS} capacity requests.`, { field: 'requests', count: requests.length })
  }
  const result = emptyAllocations()
  for (const request of requests) {
    if (!CAPACITY_RESOURCES.includes(request.resource)) {
      throw new CapacityGovernorError('INVALID_CAPACITY_REQUEST', 'Unknown capacity resource.', { field: 'resource', resource: String(request.resource) })
    }
    const units = request.units ?? 1
    assertPositiveInteger(`${request.resource}.units`, units)
    const total = result[request.resource] + units
    assertPositiveInteger(`${request.resource}.units`, total)
    result[request.resource] = total
  }
  return result
}

function validateLimits(limits: CapacityLimits): CapacityLimits {
  const result = {} as Record<CapacityResource, CapacityLimit>
  for (const resource of CAPACITY_RESOURCES) {
    const limit = limits[resource]
    assertPositiveInteger(`${resource}.global`, limit.global)
    assertPositiveInteger(`${resource}.perTenant`, limit.perTenant)
    assertPositiveInteger(`${resource}.perProject`, limit.perProject)
    if (limit.perTenant > limit.global || limit.perProject > limit.perTenant) {
      throw new CapacityGovernorError('INVALID_CAPACITY_REQUEST', `Limits for ${resource} must satisfy perProject <= perTenant <= global.`, { resource })
    }
    result[resource] = Object.freeze({ ...limit })
  }
  return Object.freeze(result)
}

function validateScope(scope: CapacityScope): CapacityScope {
  assertIdentifier('orgId', scope.orgId)
  assertIdentifier('tenantId', scope.tenantId)
  assertIdentifier('projectId', scope.projectId)
  return Object.freeze({ ...scope })
}

function validateReference(reference: LeaseReference): void {
  assertIdentifier('leaseId', reference.leaseId)
  assertPositiveInteger('fencingToken', reference.fencingToken)
}

function validateTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_LEASE_TTL_MS || ttlMs > MAX_LEASE_TTL_MS) {
    throw new CapacityGovernorError('INVALID_CAPACITY_REQUEST', `ttlMs must be an integer between ${MIN_LEASE_TTL_MS} and ${MAX_LEASE_TTL_MS}.`, { field: 'ttlMs', value: ttlMs })
  }
}

function validateTimeout(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) throw new Error(`${name} must be between 1 and 60000 milliseconds`)
  return value
}

function assertIdentifier(name: string, value: string): void {
  if (value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new CapacityGovernorError('INVALID_CAPACITY_REQUEST', `${name} must be a non-empty identifier without surrounding whitespace or control characters.`, { field: name })
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CapacityGovernorError('INVALID_CAPACITY_REQUEST', `${name} must be a positive safe integer.`, { field: name, value })
  }
}

function assertLimit(resource: CapacityResource, level: CapacityLimitLevel, current: number, requested: number, limit: number): void {
  if (current + requested <= limit) return
  throw new CapacityGovernorError('CAPACITY_EXCEEDED', `Capacity exceeded for ${resource} at ${level} level.`, { resource, level, current, requested, limit })
}

function usageTotals(resource: CapacityResource, scope: CapacityScope, leases: readonly CapacityLease[]): { global: number; tenant: number; project: number } {
  let global = 0; let tenant = 0; let project = 0
  for (const lease of leases) {
    const units = lease.allocations[resource]
    global += units
    if (lease.scope.orgId === scope.orgId && lease.scope.tenantId === scope.tenantId) tenant += units
    if (sameScope(lease.scope, scope)) project += units
  }
  return { global, tenant, project }
}

function capacityUsage(resource: CapacityResource, leases: readonly CapacityLease[]): ResourceCapacityUsage {
  let global = 0
  const tenants = new Map<string, TenantCapacityUsage>()
  const projects = new Map<string, ProjectCapacityUsage>()
  for (const lease of leases) {
    const units = lease.allocations[resource]
    if (units === 0) continue
    global += units
    const tenantKey = `${lease.scope.orgId}\u0000${lease.scope.tenantId}`
    const projectKey = `${tenantKey}\u0000${lease.scope.projectId}`
    tenants.set(tenantKey, { orgId: lease.scope.orgId, tenantId: lease.scope.tenantId, units: (tenants.get(tenantKey)?.units ?? 0) + units })
    projects.set(projectKey, { ...lease.scope, units: (projects.get(projectKey)?.units ?? 0) + units })
  }
  return Object.freeze({
    resource,
    global,
    tenants: Object.freeze([...tenants.values()].sort((left, right) => `${left.orgId}\u0000${left.tenantId}`.localeCompare(`${right.orgId}\u0000${right.tenantId}`))),
    projects: Object.freeze([...projects.values()].sort((left, right) => `${left.orgId}\u0000${left.tenantId}\u0000${left.projectId}`.localeCompare(`${right.orgId}\u0000${right.tenantId}\u0000${right.projectId}`))),
  })
}

function sameScope(left: CapacityScope, right: CapacityScope): boolean {
  return left.orgId === right.orgId && left.tenantId === right.tenantId && left.projectId === right.projectId
}

function sameAllocations(left: Readonly<AllocationMap>, right: Readonly<AllocationMap>): boolean {
  return CAPACITY_RESOURCES.every(resource => left[resource] === right[resource])
}

function leaseExpired(row: CapacityLeaseRow, now: number): boolean {
  return toSafeInteger('expiresAt', row.expires_at_ms) <= now
}

function leaseNotFound(leaseId: string): CapacityGovernorError {
  return new CapacityGovernorError('LEASE_NOT_FOUND', 'The capacity lease is not active.', { leaseId })
}

function staleFence(row: CapacityLeaseRow, reference: LeaseReference): CapacityGovernorError {
  return new CapacityGovernorError('STALE_FENCING_TOKEN', 'The fencing token does not own the current lease generation.', {
    leaseId: reference.leaseId,
    expectedFencingToken: toSafeInteger('fencingToken', row.fencing_token),
    receivedFencingToken: reference.fencingToken,
  })
}

function toSafeInteger(label: string, value: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_FENCING_TOKEN) throw new Error(`${label} is outside the JavaScript safe integer range`)
  return parsed
}
