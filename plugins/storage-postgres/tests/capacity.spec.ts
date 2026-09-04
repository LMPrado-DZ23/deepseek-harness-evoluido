import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CapacityGovernorError,
  DEFAULT_CAPACITY_LIMITS,
  type CapacityLimits,
  type CapacityScope,
} from '@dz23-studio/runtime-governor'
import { PostgresCapacityGovernor } from '../src/capacity.ts'
import { capacityLeasesTable, storageMaintenanceLockName } from '../src/capacity-schema.ts'
import { quoteIdentifier } from '../src/schema.ts'

const dsn = process.env.DZ23_POSTGRES_TEST_DSN
const describePostgres = dsn === undefined ? describe.skip : describe
const schemas = new Set<string>()
const governors: PostgresCapacityGovernor[] = []
const scope: CapacityScope = { orgId: 'org-1', tenantId: 'tenant-1', projectId: 'project-1' }

function schemaName(label: string): string {
  const schema = `capacity_${label}_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  schemas.add(schema)
  return schema
}

function limits(overrides: Partial<CapacityLimits> = {}): CapacityLimits {
  return { ...DEFAULT_CAPACITY_LIMITS, ...overrides }
}

function governor(schema: string, options: Partial<ConstructorParameters<typeof PostgresCapacityGovernor>[0]> = {}): PostgresCapacityGovernor {
  const instance = new PostgresCapacityGovernor({
    connectionString: dsn!, schema, ssl: false, poolMax: 2,
    ...options,
  })
  governors.push(instance)
  return instance
}

afterEach(async () => {
  await Promise.all(governors.splice(0).map(instance => instance.close().catch(() => undefined)))
  if (dsn === undefined) return
  const admin = new Client({ connectionString: dsn, ssl: false })
  await admin.connect()
  try {
    for (const schema of schemas) await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`)
  } finally {
    schemas.clear()
    await admin.end()
  }
})

describePostgres('PostgresCapacityGovernor against PostgreSQL 16', () => {
  it('confirms the integration server is PostgreSQL 16', async () => {
    const client = new Client({ connectionString: dsn!, ssl: false })
    await client.connect()
    try {
      const result = await client.query<{ server_version_num: string }>('SHOW server_version_num')
      expect(result.rows[0]?.server_version_num).toMatch(/^16\d{4}$/u)
    } finally {
      await client.end()
    }
  })

  it('acquires an atomic bundle, reports scoped usage, heartbeats and releases it', async () => {
    const instance = governor(schemaName('lifecycle'), {
      holderId: 'holder-one', createId: () => 'lease-one',
      limits: limits({ 'prompt-job': { global: 4, perTenant: 3, perProject: 2 } }),
    })
    const lease = await instance.acquireBundle({
      ownerId: 'run-1', scope,
      requests: [{ resource: 'prompt-job' }, { resource: 'prompt-job' }, { resource: 'build' }],
      ttlMs: 10_000,
    })
    expect(lease).toMatchObject({
      leaseId: 'lease-one', fencingToken: 1, ownerId: 'run-1',
      allocations: { 'prompt-job': 2, build: 1, preview: 0 },
    })
    const snapshot = await instance.snapshot()
    expect(snapshot.leases).toEqual([lease])
    expect(snapshot.usage.find(item => item.resource === 'prompt-job')).toMatchObject({
      global: 2,
      tenants: [{ orgId: 'org-1', tenantId: 'tenant-1', units: 2 }],
      projects: [{ ...scope, units: 2 }],
    })
    expect((await instance.heartbeat(lease, 20_000)).expiresAt).toBeGreaterThan(lease.expiresAt)
    await instance.release(lease)
    expect((await instance.snapshot()).leases).toEqual([])
  })

  it('serializes independent governors so only one global claimant wins', async () => {
    const schema = schemaName('concurrent')
    const constrained = limits({ preview: { global: 1, perTenant: 1, perProject: 1 } })
    const first = governor(schema, { limits: constrained, holderId: 'holder-a', createId: () => 'lease-a' })
    const second = governor(schema, { limits: constrained, holderId: 'holder-b', createId: () => 'lease-b' })
    await Promise.all([first.waitUntilReady(), second.waitUntilReady()])
    const attempts = await Promise.allSettled([
      first.acquireBundle({ ownerId: 'preview-a', scope, requests: [{ resource: 'preview' }] }),
      second.acquireBundle({ ownerId: 'preview-b', scope: { ...scope, tenantId: 'tenant-2', projectId: 'project-2' }, requests: [{ resource: 'preview' }] }),
    ])
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = attempts.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toBeInstanceOf(CapacityGovernorError)
    expect(rejected.reason).toMatchObject({ code: 'CAPACITY_EXCEEDED', details: { level: 'global' } })
    expect((await first.snapshot()).leases).toHaveLength(1)
  })

  it('leaves no partial allocation when one resource in a bundle exceeds its limit', async () => {
    const schema = schemaName('atomic')
    const instance = governor(schema, {
      limits: limits({
        'prompt-job': { global: 10, perTenant: 10, perProject: 10 },
        build: { global: 1, perTenant: 1, perProject: 1 },
      }),
      createId: (() => { let id = 0; return () => `lease-${++id}` })(),
    })
    await instance.acquireBundle({ ownerId: 'build-holder', scope, requests: [{ resource: 'build' }] })
    await expect(instance.acquireBundle({
      ownerId: 'blocked', scope: { ...scope, projectId: 'project-2' },
      requests: [{ resource: 'prompt-job', units: 3 }, { resource: 'build' }],
    })).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED' })
    expect((await instance.snapshot()).usage.find(item => item.resource === 'prompt-job')?.global).toBe(0)
  })

  it('rotates the fence on takeover and rejects the previous holder and concurrent stale claimant', async () => {
    const schema = schemaName('takeover')
    const original = governor(schema, { holderId: 'holder-old', createId: () => 'lease-shared' })
    const lease = await original.acquireBundle({ ownerId: 'preview:id-1', scope, requests: [{ resource: 'preview' }] })
    const winner = governor(schema, { holderId: 'holder-new' })
    const staleContender = governor(schema, { holderId: 'holder-other' })
    await Promise.all([winner.waitUntilReady(), staleContender.waitUntilReady()])

    const taken = await winner.takeover({ reference: lease, ownerId: lease.ownerId, scope, requests: [{ resource: 'preview' }] })
    expect(taken).toMatchObject({ leaseId: lease.leaseId, fencingToken: 2 })
    await expect(original.heartbeat(lease)).rejects.toMatchObject({ code: 'STALE_FENCING_TOKEN' })
    await expect(original.release(lease)).rejects.toMatchObject({ code: 'STALE_FENCING_TOKEN' })
    await expect(staleContender.takeover({ reference: lease, ownerId: lease.ownerId, scope, requests: [{ resource: 'preview' }] }))
      .rejects.toMatchObject({ code: 'STALE_FENCING_TOKEN' })
    await expect(winner.heartbeat(taken)).resolves.toMatchObject({ fencingToken: 2 })
  })

  it('rejects mismatched takeover identity without changing ownership', async () => {
    const schema = schemaName('identity')
    const original = governor(schema, { holderId: 'holder-old', createId: () => 'lease-identity' })
    const lease = await original.acquireBundle({ ownerId: 'preview:id-1', scope, requests: [{ resource: 'preview' }] })
    const claimant = governor(schema, { holderId: 'holder-new' })
    await claimant.waitUntilReady()
    await expect(claimant.takeover({
      reference: lease, ownerId: lease.ownerId,
      scope: { ...scope, tenantId: 'tenant-attacker' }, requests: [{ resource: 'preview' }],
    })).rejects.toMatchObject({ code: 'INVALID_CAPACITY_REQUEST' })
    await expect(original.heartbeat(lease)).resolves.toMatchObject({ fencingToken: 1 })
  })

  it('uses database expiry and reconciles an expired lease', async () => {
    const schema = schemaName('expiry')
    const instance = governor(schema, { holderId: 'holder-expiry', createId: () => 'lease-expiry' })
    const lease = await instance.acquireBundle({ ownerId: 'expiring', scope, requests: [{ resource: 'preview' }], ttlMs: 60_000 })
    const admin = new Client({ connectionString: dsn!, ssl: false })
    await admin.connect()
    try {
      await admin.query(`UPDATE ${capacityLeasesTable(schema)} SET expires_at = clock_timestamp() WHERE lease_id = $1`, [lease.leaseId])
      await expect(instance.heartbeat(lease)).rejects.toMatchObject({ code: 'LEASE_NOT_FOUND' })
      expect((await admin.query(`SELECT count(*)::int AS count FROM ${capacityLeasesTable(schema)}`)).rows[0]?.count).toBe(0)

      const replacement = await instance.acquireBundle({ ownerId: 'expiring', scope, requests: [{ resource: 'preview' }], ttlMs: 60_000 })
      await admin.query(`UPDATE ${capacityLeasesTable(schema)} SET expires_at = clock_timestamp() WHERE lease_id = $1`, [replacement.leaseId])
      await expect(instance.release(replacement)).rejects.toMatchObject({ code: 'LEASE_NOT_FOUND' })
      expect((await admin.query(`SELECT count(*)::int AS count FROM ${capacityLeasesTable(schema)}`)).rows[0]?.count).toBe(0)
    } finally {
      await admin.end()
    }
    expect(await instance.reconcile()).toMatchObject({ activeLeaseCount: 0 })
  })

  it('commits expiry cleanup before a takeover reports the lease as missing', async () => {
    const schema = schemaName('expired_takeover')
    const original = governor(schema, { holderId: 'holder-expiring', createId: () => 'lease-expired-takeover' })
    const lease = await original.acquireBundle({ ownerId: 'preview:expired', scope, requests: [{ resource: 'preview' }], ttlMs: 60_000 })
    const claimant = governor(schema, { holderId: 'holder-claimant' })
    await claimant.waitUntilReady()
    const admin = new Client({ connectionString: dsn!, ssl: false })
    await admin.connect()
    try {
      await admin.query(`UPDATE ${capacityLeasesTable(schema)} SET expires_at = clock_timestamp() WHERE lease_id = $1`, [lease.leaseId])
      await expect(claimant.takeover({ reference: lease, ownerId: lease.ownerId, scope, requests: [{ resource: 'preview' }] }))
        .rejects.toMatchObject({ code: 'LEASE_NOT_FOUND' })
      expect((await admin.query(`SELECT count(*)::int AS count FROM ${capacityLeasesTable(schema)}`)).rows[0]?.count).toBe(0)
    } finally {
      await admin.end()
    }
  })

  it('refuses a second configuration with different limits', async () => {
    const schema = schemaName('limits')
    const first = governor(schema)
    await first.waitUntilReady()
    const second = governor(schema, { limits: limits({ preview: { global: 1, perTenant: 1, perProject: 1 } }) })
    await expect(second.waitUntilReady()).rejects.toThrow('limits differ')
  })

  it('fails closed while an exclusive storage maintenance lock owns the schema', async () => {
    const schema = schemaName('maintenance')
    const instance = governor(schema)
    await instance.waitUntilReady()
    const maintenance = new Client({ connectionString: dsn!, ssl: false })
    await maintenance.connect()
    await maintenance.query('SELECT pg_advisory_lock(hashtext($1))', [storageMaintenanceLockName(schema)])
    try {
      await expect(instance.snapshot()).rejects.toThrow('exclusive maintenance')
    } finally {
      await maintenance.query('SELECT pg_advisory_unlock_all()')
      await maintenance.end()
    }
  })

  it('keeps SQL-looking logical identifiers as data', async () => {
    const schema = schemaName('parameters')
    const instance = governor(schema, { createId: () => 'lease-parameterized' })
    const hostile = `owner'); DROP SCHEMA public; --`
    const lease = await instance.acquireBundle({ ownerId: hostile, scope, requests: [{ resource: 'preview' }] })
    expect(lease.ownerId).toBe(hostile)
    expect((await instance.snapshot()).leases).toHaveLength(1)
  })
})
