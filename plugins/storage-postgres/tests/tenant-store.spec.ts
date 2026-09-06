import { beforeEach, describe, expect, it, vi } from 'vitest'

interface RoleFixture {
  current_user: string
  rolsuper: boolean
  rolbypassrls: boolean
  rolcreaterole: boolean
  rolcreatedb: boolean
  database_name: string
}

const pgState = vi.hoisted(() => ({
  role: {
    current_user: 'dz23_runtime', rolsuper: false, rolbypassrls: false,
    rolcreaterole: false, rolcreatedb: false, database_name: 'dz23',
  },
  owner: { owns_table: false, member_of_owner: false, can_create_in_schema: false, extra_table_privileges: false },
  target: { database_name: 'dz23' },
  verifyRole: undefined as RoleFixture | undefined,
  roleQueries: 0,
  failOperation: false,
  failRollback: false,
  failPolicy: false,
  roleMissing: false,
  failDirectEnd: false,
  queries: [] as Array<{ connection: string; sql: string; parameters: readonly unknown[] }>,
  pools: [] as Array<{ options: { connectionString: string }; end: ReturnType<typeof vi.fn> }>,
  clients: [] as Array<{ options: { connectionString: string }; end: ReturnType<typeof vi.fn> }>,
}))

vi.mock('pg', () => {
  class Connection {
    readonly query = vi.fn(async (sqlValue: unknown, parameters: readonly unknown[] = []) => {
      const sql = String(sqlValue)
      pgState.queries.push({ connection: this.connection, sql, parameters })
      if (sql === 'ROLLBACK' && pgState.failRollback) throw new Error('rollback-failed')
      if (sql.includes('CREATE POLICY') && pgState.failPolicy) throw new Error('policy-failed')
      if (sql.includes('SELECT value FROM') && pgState.failOperation) throw new Error('primary-query-failed')
      if (sql.includes('owns_table')) return { rows: [pgState.owner], rowCount: 1 }
      if (sql.includes('pg_catalog.pg_roles')) {
        pgState.roleQueries += 1
        if (pgState.roleMissing) return { rows: [], rowCount: 0 }
        const role = this.phase === 'pool' && this.connection.includes('runtime') && pgState.verifyRole !== undefined
          ? pgState.verifyRole
          : pgState.role
        return { rows: [role], rowCount: 1 }
      }
      if (sql.includes('current_database() AS database_name')) return { rows: [pgState.target], rowCount: 1 }
      if (sql.includes('SELECT key, value')) return { rows: [{ key: 'a', value: { name: 'A' } }], rowCount: 1 }
      if (sql.includes('SELECT value FROM')) return { rows: [{ value: { name: 'A' } }], rowCount: 1 }
      if (sql.includes('DELETE FROM')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    constructor(readonly connection: string, readonly phase: 'direct' | 'pool') {}
  }
  class PoolClient extends Connection {
    readonly release = vi.fn()
    constructor(connection: string) { super(connection, 'pool') }
  }
  class Pool {
    readonly client: PoolClient
    readonly connect = vi.fn(async () => this.client)
    readonly end = vi.fn(async () => undefined)
    constructor(readonly options: { connectionString: string }) {
      this.client = new PoolClient(options.connectionString)
      pgState.pools.push(this)
    }
  }
  class Client extends Connection {
    readonly connect = vi.fn(async () => undefined)
    readonly end = vi.fn(async () => {
      if (pgState.failDirectEnd) throw new Error('end-failed')
    })
    constructor(readonly options: { connectionString: string }) {
      super(options.connectionString, 'direct')
      pgState.clients.push(this)
    }
  }
  return { Pool, Client }
})

import { PostgresTenantRecordStore } from '../src/tenant-store.ts'

const config = {
  adminConnectionString: 'postgresql://admin:secret@127.0.0.1/dz23?sslmode=disable',
  runtimeConnectionString: 'postgresql://runtime:secret@127.0.0.1/dz23?sslmode=disable',
  schema: 'dz23_storage', ssl: false as const, poolMax: 2,
}

beforeEach(() => {
  pgState.role = {
    current_user: 'dz23_runtime', rolsuper: false, rolbypassrls: false,
    rolcreaterole: false, rolcreatedb: false, database_name: 'dz23',
  }
  pgState.owner = { owns_table: false, member_of_owner: false, can_create_in_schema: false, extra_table_privileges: false }
  pgState.target = { database_name: 'dz23' }
  pgState.verifyRole = undefined
  pgState.roleQueries = 0
  pgState.failOperation = false
  pgState.failRollback = false
  pgState.failPolicy = false
  pgState.roleMissing = false
  pgState.failDirectEnd = false
  pgState.queries.length = 0
  pgState.pools.length = 0
  pgState.clients.length = 0
})

describe('Postgres tenant record store RLS boundary', () => {
  it('creates a forced RLS table for a separate restricted runtime role', async () => {
    const store = await PostgresTenantRecordStore.create(config)
    const sql = pgState.queries.map(item => item.sql).join('\n')
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY')
    expect(sql).toContain('FORCE ROW LEVEL SECURITY')
    expect(sql).toContain('pg_advisory_xact_lock')
    expect(pgState.queries).toContainEqual(expect.objectContaining({
      parameters: ['dz23-storage-tenant-layout:dz23_storage'],
    }))
    expect(sql).toContain('AS PERMISSIVE FOR ALL TO "dz23_runtime"')
    expect(sql).toContain("current_setting('dz23.org_id', true)")
    expect(sql).toContain("current_setting('dz23.tenant_id', true)")
    expect(sql).toContain('REVOKE ALL')
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE')
    expect(pgState.pools.map(pool => pool.options.connectionString)).toEqual([
      'postgresql://admin:secret@127.0.0.1/dz23',
      'postgresql://runtime:secret@127.0.0.1/dz23',
    ])
    await store.close()
  })

  it('sets a transaction-local scope before every read and write', async () => {
    const store = await PostgresTenantRecordStore.create(config)
    const scope = { orgId: 'org-a', tenantId: 'tenant-a' }
    await expect(store.put(scope, 'studio_projects', 'projects', 'p1', { name: 'A' })).resolves.toBeUndefined()
    await expect(store.get(scope, 'studio_projects', 'projects', 'p1')).resolves.toEqual({ name: 'A' })
    await expect(store.list(scope, 'studio_projects', 'projects')).resolves.toEqual([{ key: 'a', value: { name: 'A' } }])
    await expect(store.delete(scope, 'studio_projects', 'projects', 'p1')).resolves.toBe(true)
    const runtimeQueries = pgState.queries.filter(item => item.connection.includes('runtime'))
    expect(runtimeQueries.filter(item => item.sql.includes('set_config'))).toHaveLength(4)
    for (const scoped of runtimeQueries.filter(item => item.sql.includes('set_config'))) {
      expect(scoped.parameters).toEqual(['dz23.org_id', 'org-a', 'dz23.tenant_id', 'tenant-a'])
    }
    expect(runtimeQueries.filter(item => item.sql === 'COMMIT')).toHaveLength(4)
    await store.close()
    await expect(store.get(scope, 'studio_projects', 'projects', 'p1')).rejects.toThrow('closed')
  })

  it('refuses privileged, owner-related or wrong-database runtime credentials', async () => {
    pgState.role.rolbypassrls = true
    await expect(PostgresTenantRecordStore.create(config)).rejects.toThrow('NOBYPASSRLS')

    pgState.role.rolbypassrls = false
    pgState.owner.member_of_owner = true
    await expect(PostgresTenantRecordStore.create(config)).rejects.toThrow('must not own, inherit, create or access')

    pgState.owner.member_of_owner = false
    await expect(PostgresTenantRecordStore.create({ ...config, runtimeConnectionString: 'postgresql://runtime:secret@other.example/dz23' }))
      .rejects.toThrow('same PostgreSQL database')

    pgState.role.database_name = 'other'
    await expect(PostgresTenantRecordStore.create(config)).rejects.toThrow('same PostgreSQL database')
    pgState.role.database_name = 'dz23'
    pgState.verifyRole = { ...pgState.role, current_user: 'unexpected_runtime' }
    await expect(PostgresTenantRecordStore.create(config)).rejects.toThrow('expected restricted role')

    pgState.verifyRole = undefined
    pgState.roleMissing = true
    await expect(PostgresTenantRecordStore.create(config)).rejects.toThrow('runtime role was not found')
  })

  it('rolls back, releases the connection and preserves the primary operation error', async () => {
    const store = await PostgresTenantRecordStore.create(config)
    pgState.failOperation = true
    pgState.failRollback = true
    const runtimePool = pgState.pools.find(pool => pool.options.connectionString.includes('runtime'))!
    const release = (runtimePool as unknown as { client: { release: ReturnType<typeof vi.fn> } }).client.release
    const beforeReleases = release.mock.calls.length
    await expect(store.get({ orgId: 'org', tenantId: 'tenant' }, 'unit', 'records', 'key'))
      .rejects.toThrow('primary-query-failed')
    expect(release).toHaveBeenCalledTimes(beforeReleases + 1)
    await store.close()

    pgState.failOperation = false
    pgState.failRollback = true
    pgState.failPolicy = true
    await expect(PostgresTenantRecordStore.create(config)).rejects.toThrow('policy-failed')

    pgState.failRollback = false
    pgState.failPolicy = false
    pgState.failDirectEnd = true
    const storeWithFailedProbeCleanup = await PostgresTenantRecordStore.create(config)
    await storeWithFailedProbeCleanup.close()
  })

  it('rejects unsafe scope, names, keys and non-JSON values before SQL', async () => {
    const store = await PostgresTenantRecordStore.create(config)
    const before = pgState.queries.length
    await expect(store.put({ orgId: ' org', tenantId: 'tenant' }, 'unit', 'records', 'key', {})).rejects.toThrow('orgId')
    expect(() => store.put({ orgId: 'org', tenantId: 'tenant' }, 'bad-unit', 'records', 'key', {})).toThrow('tenant unit')
    expect(() => store.put({ orgId: 'org', tenantId: 'tenant' }, 'unit', 'records', '', {})).toThrow('key')
    expect(() => store.put({ orgId: 'org', tenantId: 'tenant' }, 'unit', 'records', 'key', undefined)).toThrow('JSON-serializable')
    expect(pgState.queries).toHaveLength(before)
    await store.close()
  })

  it('validates URL targets without rejecting explicit ports or Unix sockets', async () => {
    for (const invalid of [
      'not-a-url',
      'https://127.0.0.1/dz23',
      'postgresql:///dz23',
      'postgresql://127.0.0.1',
    ]) {
      await expect(PostgresTenantRecordStore.create({ ...config, runtimeConnectionString: invalid }))
        .rejects.toThrow(/postgresql:\/\/ URL|no host or database/u)
    }
    for (const pair of [
      ['postgres://admin:secret@127.0.0.1:5544/dz23', 'postgres://runtime:secret@127.0.0.1:5544/dz23'],
      ['postgresql:///dz23?host=%2Fvar%2Frun%2Fpostgresql', 'postgresql:///dz23?host=%2Fvar%2Frun%2Fpostgresql'],
    ] as const) {
      const store = await PostgresTenantRecordStore.create({
        ...config, adminConnectionString: pair[0], runtimeConnectionString: pair[1],
      })
      await store.close()
    }
  })
})
