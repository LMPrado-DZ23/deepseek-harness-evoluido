import { describe, expect, it } from 'vitest'
import { exportedDomain, sealBundle } from '../src/bundle.ts'
import { postgresDumpInvocation, postgresStorageStatus, restorePostgresStorage } from '../src/restore.ts'

const domain = exportedDomain(
  { name: 'studio_test', version: 1, tables: ['records'], hasGlobal: false },
  { tables: { records: { first: { value: 1 } } }, global: null },
)
const bundle = sealBundle({ kind: 'postgres', sha256: 'a'.repeat(64) }, [domain], '2026-09-04T00:00:00.000Z')
const connection = { connectionString: 'postgres://redacted@localhost/studio', ssl: false as const }

class ScriptClient {
  readonly sql: string[] = []
  async connect(): Promise<void> { this.sql.push('CONNECT') }
  async end(): Promise<void> { this.sql.push('END') }
  async query<T>(sql: string): Promise<{ rows: T[] }> {
    this.sql.push(sql)
    if (sql === 'SHOW server_version') return { rows: [{ server_version: '16.4' } as T] }
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true } as T] }
    if (sql.includes('pg_catalog.pg_namespace WHERE nspname')) return { rows: [{ present: false } as T] }
    if (sql.includes("tablename = 'units'")) return { rows: [{ count: '0' } as T] }
    if (sql.includes('LIKE $1')) return { rows: [] }
    if (sql.includes('pg_catalog.pg_attribute a')) {
      const shape = {
        storage_meta: ['key', 'value'], units: ['name', 'version'], records: ['unit', 'table_name', 'key', 'value'],
        unit_globals: ['unit', 'value'], unit_leases: ['unit', 'holder', 'acquired_at', 'heartbeat_at'],
      }
      return { rows: Object.entries(shape).flatMap(([relname, columns]) => columns.map(attname => ({ relname, attname }) as T)) }
    }
    if (sql.includes('pg_catalog.pg_class c') && sql.includes('c.relname = ANY')) {
      return { rows: ['storage_meta', 'units', 'records', 'unit_globals', 'unit_leases'].map(relname => ({ relname }) as T) }
    }
    if (sql.includes('storage_meta') && sql.includes('layout_version')) return { rows: [{ value: 1 } as T] }
    if (sql.includes('SELECT name FROM') && sql.includes('ORDER BY')) return { rows: [{ name: 'studio_test' } as T] }
    if (sql.includes('SELECT count(*) FROM') && sql.includes('"units"')) return { rows: [{ count: '1' } as T] }
    return { rows: [] }
  }
}

class ExistingClient extends ScriptClient {
  override async query<T>(sql: string): Promise<{ rows: T[] }> {
    if (sql.includes('pg_catalog.pg_namespace WHERE nspname')) {
      this.sql.push(sql)
      return { rows: [{ present: true } as T] }
    }
    if (sql.includes("a.attname LIKE '%namespace'")) {
      this.sql.push(sql)
      return { rows: [{ relname: 'pg_class', attname: 'relnamespace' } as T] }
    }
    if (sql.includes('SELECT COALESCE')) {
      this.sql.push(sql)
      return { rows: [{ present: true } as T] }
    }
    return super.query<T>(sql)
  }
}

function fakeBackend() {
  let snapshot = { tables: { records: {} as Record<string, unknown> }, global: null }
  return {
    kv: { open: async () => ({
      loadAll: async () => snapshot,
      putRecord: async (_table: string, key: string, value: unknown) => { snapshot = { ...snapshot, tables: { records: { ...snapshot.tables.records, [key]: value } } } },
      setGlobal: async () => undefined,
      close: async () => undefined,
    }) },
    waitUntilReady: async () => undefined,
    close: async () => undefined,
  }
}

describe('restore core without Docker', () => {
  it('keeps the complete DSN and password out of pg_dump argv', () => {
    const password = 'secret-value'
    const invocation = postgresDumpInvocation(`postgres://operator:${password}@database/studio?sslmode=disable`, 'dz23_storage', 'require', {})
    expect(invocation.args.join(' ')).not.toContain('postgres://')
    expect(invocation.args.join(' ')).not.toContain(password)
    expect(invocation.args.some(value => /ssl/iu.test(value))).toBe(false)
    expect(invocation.environment.PGDATABASE).not.toContain(password)
    expect(invocation.environment.PGPASSWORD).toBe(password)
    expect(invocation.environment.PGSSLMODE).toBe('require')
  })

  it('rejects cancellation and empty bundles before opening PostgreSQL', async () => {
    let resolved = 0
    const aborted = new AbortController()
    aborted.abort(new Error('stop'))
    await expect(restorePostgresStorage({ input: 'unused', dsn: 'secret', signal: aborted.signal }, {
      readBundle: async () => bundle, resolveConnection: async () => { resolved += 1; return connection },
    })).rejects.toThrow('stop')
    await expect(restorePostgresStorage({ input: 'unused', dsn: 'secret' }, {
      readBundle: async () => ({ ...bundle, domains: [] }), resolveConnection: async () => { resolved += 1; return connection },
    })).rejects.toThrow('nenhum domínio')
    expect(resolved).toBe(0)
  })

  it('stages, checks readiness inside the swap transaction, then commits', async () => {
    const client = new ScriptClient()
    const report = await restorePostgresStorage({ input: 'unused', dsn: 'secret', ssl: 'off', write: true, safetyBackup: 'unused.dump' }, {
      readBundle: async () => bundle, resolveConnection: async () => connection,
      createClient: () => client as never, createBackend: () => fakeBackend() as never,
      now: () => 1, suffix: () => 'abcd',
    })
    expect(report).toMatchObject({ mode: 'write', readyToStart: true, safetyBackupStatus: 'not-needed-empty-target' })
    const rename = client.sql.findIndex(sql => sql.includes('ALTER SCHEMA'))
    const readiness = client.sql.findIndex((sql, index) => index > rename && sql.includes('pg_catalog.pg_class c'))
    const commit = client.sql.findIndex((sql, index) => index > readiness && sql === 'COMMIT')
    expect(rename).toBeGreaterThan(-1)
    expect(readiness).toBeGreaterThan(rename)
    expect(commit).toBeGreaterThan(readiness)
  })

  it('holds the exclusive lock and completes the safety backup before creating staging', async () => {
    const client = new ExistingClient()
    let backedUp = false
    await expect(restorePostgresStorage({
      input: 'unused', dsn: 'secret', ssl: 'off', write: true, safetyBackup: 'safety.dump',
      force: true, confirmation: 'REPLACE_DZ23_STORAGE', allowDomainLoss: true,
    }, {
      readBundle: async () => bundle, resolveConnection: async () => connection, createClient: () => client as never,
      createSafetyBackup: async () => { backedUp = true; throw new Error('backup failed') },
    })).rejects.toThrow('backup failed')
    expect(backedUp).toBe(true)
    expect(client.sql.some(sql => sql.includes('pg_try_advisory_lock'))).toBe(true)
    expect(client.sql.some(sql => sql.startsWith('CREATE SCHEMA'))).toBe(false)
  })

  it('rolls back the atomic swap when readiness fails', async () => {
    const client = new ScriptClient()
    let renamed = false
    const base = client.query.bind(client)
    client.query = async function <T>(sql: string): Promise<{ rows: T[] }> {
      if (sql.includes('ALTER SCHEMA')) renamed = true
      if (renamed && sql.includes('pg_catalog.pg_class c') && sql.includes('c.relname = ANY')) {
        this.sql.push(sql)
        return { rows: [] }
      }
      return base<T>(sql)
    }
    await expect(restorePostgresStorage({ input: 'unused', dsn: 'secret', ssl: 'off', write: true, safetyBackup: 'unused.dump' }, {
      readBundle: async () => bundle, resolveConnection: async () => connection,
      createClient: () => client as never, createBackend: () => fakeBackend() as never,
      now: () => 1, suffix: () => 'abcd',
    })).rejects.toThrow('não tem a estrutura')
    const rename = client.sql.findIndex(sql => sql.includes('ALTER SCHEMA'))
    expect(client.sql.slice(rename).includes('ROLLBACK')).toBe(true)
    expect(client.sql.slice(rename).includes('COMMIT')).toBe(false)
  })

  it('reports status without returning connection material', async () => {
    const client = new ScriptClient()
    const status = await postgresStorageStatus({ dsn: 'postgres://user:secret@host/db', ssl: 'off' }, {
      resolveConnection: async () => connection, createClient: () => client as never,
    })
    expect(status).toEqual({ reachable: true, serverVersion: '16.4', schema: 'dz23_storage', schemaExists: false, ready: false, layoutVersion: null, domains: 0 })
    expect(JSON.stringify(status)).not.toContain('secret')
  })
})
