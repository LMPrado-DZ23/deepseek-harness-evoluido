import { describe, expect, it } from 'vitest'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { canonicalJson, exportedDomain, sealBundle, sha256 } from '../src/bundle.ts'
import { postgresDumpInvocation, postgresStorageStatus, restorePostgresStorage } from '../src/restore.ts'

const domain = exportedDomain(
  { name: 'studio_test', version: 1, tables: ['records'], hasGlobal: false },
  { tables: { records: { first: { value: 1 } } }, global: null },
)
const bundle = sealBundle({ kind: 'postgres', sha256: 'a'.repeat(64) }, [domain], '2026-09-04T00:00:00.000Z')
const verifiedInput = { bundle, inputSha256: 'f'.repeat(64), bytes: 100, file: 'unused' }
const targetFingerprint = sha256(canonicalJson({ databaseName: 'studio', databaseOid: '16384', schema: 'dz23_storage', systemIdentifier: '7413371234567890123' }))
const restoreBase = { verifiedInput, attemptId: 'attempt-0001', dsn: 'secret', stateDirectory: 'unused-state' }
const connection = { connectionString: 'postgres://redacted@localhost/studio', ssl: false as const }

class ScriptClient {
  readonly sql: string[] = []
  receiptInput: string | undefined
  receiptTarget: string | undefined
  receiptSafety: string | null | undefined
  async connect(): Promise<void> { this.sql.push('CONNECT') }
  async end(): Promise<void> { this.sql.push('END') }
  async query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> {
    this.sql.push(sql)
    if (sql.includes(`INSERT INTO`) && sql.includes('dz23_restore_receipt')) { this.receiptTarget = String(values?.[1]); this.receiptInput = String(values?.[2]); this.receiptSafety = values?.[3] === null ? null : String(values?.[3]); return { rows: [] } }
    if (sql.includes('to_regclass')) return { rows: [{ present: this.receiptInput !== undefined } as T] }
    if (sql.includes('dz23_restore_receipt') && sql.includes('SELECT target_fingerprint')) return { rows: this.receiptInput === undefined ? [] : [{ target_fingerprint: this.receiptTarget, input_sha256: this.receiptInput, safety_sha256: this.receiptSafety } as T] }
    if (sql.includes('pg_control_system')) return { rows: [{ system_identifier: '7413371234567890123', database_oid: '16384', database_name: 'studio' } as T] }
    if (sql === 'SHOW server_version') return { rows: [{ server_version: '16.4' } as T] }
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true } as T] }
    if (sql.includes('pg_catalog.pg_namespace WHERE nspname')) return { rows: [{ present: this.receiptInput !== undefined } as T] }
    if (sql.includes("tablename = 'units'")) return { rows: [{ count: '0' } as T] }
    if (sql.includes('LIKE $1')) return { rows: [] }
    if (sql.includes('c.relkind NOT IN')) return { rows: [] }
    if (sql.includes('SELECT c.relname AS catalog')) {
      return { rows: [{ catalog: 'pg_class', nsattr: 'relnamespace', nameattr: 'relname' } as T] }
    }
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
    if (sql.includes('SELECT c.relname, a.attname') && sql.includes("a.attname LIKE '%namespace'")) {
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
  let snapshot: { tables: { records: Record<string, unknown> }; global: unknown | null } = { tables: { records: {} }, global: null }
  return {
    kv: { open: async () => ({
      loadAll: async () => snapshot,
      putRecord: async (_table: string, key: string, value: unknown) => { snapshot = { ...snapshot, tables: { records: { ...snapshot.tables.records, [key]: value } } } },
      setGlobal: async (value: unknown) => { snapshot = { ...snapshot, global: value } },
      close: async () => undefined,
    }) },
    waitUntilReady: async () => undefined,
    close: async () => undefined,
  }
}

function journalMemory(initial?: import('../src/restore-journal.ts').RestoreJournal) {
  const memory = { value: initial }
  const paths: string[] = []
  return {
    memory, paths, platform: 'linux' as const,
    loadJournal: async (path: string) => { paths.push(path); return memory.value },
    reserveJournal: async (path: string, next: import('../src/restore-journal.ts').RestoreJournal) => {
      paths.push(path)
      if (memory.value !== undefined) return false
      memory.value = structuredClone(next)
      return true
    },
    writeJournal: async (path: string, next: import('../src/restore-journal.ts').RestoreJournal) => { paths.push(path); memory.value = structuredClone(next) },
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
    await expect(restorePostgresStorage({ ...restoreBase, signal: aborted.signal }, {
      resolveConnection: async () => { resolved += 1; return connection },
    })).rejects.toThrow('stop')
    await expect(restorePostgresStorage({ ...restoreBase, verifiedInput: { ...verifiedInput, bundle: { ...bundle, domains: [] } } }, {
      resolveConnection: async () => { resolved += 1; return connection },
    })).rejects.toThrow('nenhum domínio')
    expect(resolved).toBe(0)
  })

  it('rejects unsafe attempt ids and write without an instance state root before PostgreSQL', async () => {
    let resolved = 0
    const dependencies = { resolveConnection: async () => { resolved += 1; return connection } }
    await expect(restorePostgresStorage({ ...restoreBase, attemptId: 'bad' }, dependencies)).rejects.toThrow('attemptId')
    const { stateDirectory: _stateDirectory, ...withoutStateDirectory } = restoreBase
    await expect(restorePostgresStorage({ ...withoutStateDirectory, write: true, safetyBackup: 'unused.dump' }, dependencies)).rejects.toThrow('diretório de estado')
    expect(resolved).toBe(0)
  })

  it('blocks write restore outside Linux before opening PostgreSQL', async () => {
    let resolved = false
    await expect(restorePostgresStorage({ ...restoreBase, write: true, safetyBackup: 'unused.dump' }, {
      platform: 'win32', resolveConnection: async () => { resolved = true; return connection },
    })).rejects.toThrow('exige Linux')
    expect(resolved).toBe(false)
  })

  it('refuses an unprovable physical database identity before journal or safety artifacts', async () => {
    const client = new ScriptClient()
    const original = client.query.bind(client)
    client.query = async function <T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> {
      if (sql.includes('pg_control_system')) {
        this.sql.push(sql)
        return { rows: [{ system_identifier: '', database_oid: 'not-an-oid', database_name: '' } as T] }
      }
      return original<T>(sql, values)
    }
    let journalLoaded = false
    let safetyStarted = false
    await expect(restorePostgresStorage({ ...restoreBase, ssl: 'off', write: true, safetyBackup: 'unused.dump' }, {
      platform: 'linux',
      resolveConnection: async () => connection,
      createClient: () => client as never,
      loadJournal: async () => { journalLoaded = true; return undefined },
      reserveJournal: async () => { journalLoaded = true; return true },
      createSafetyBackup: async () => { safetyStarted = true; return { file: '', sha256: '', bytes: 0 } },
    })).rejects.toThrow('identidade física')
    expect(journalLoaded).toBe(false)
    expect(safetyStarted).toBe(false)
    expect(client.sql.some(sql => sql.startsWith('CREATE SCHEMA') || sql.startsWith('DROP SCHEMA'))).toBe(false)
  })

  it('fails closed if a concurrent journal reservation disappears before reload', async () => {
    const client = new ScriptClient()
    await expect(restorePostgresStorage({ ...restoreBase, ssl: 'off', write: true, safetyBackup: 'unused.dump' }, {
      platform: 'linux',
      resolveConnection: async () => connection,
      createClient: () => client as never,
      loadJournal: async () => undefined,
      reserveJournal: async () => false,
    })).rejects.toThrow('reserva da tentativa')
    expect(client.sql.some(sql => sql.startsWith('CREATE SCHEMA') || sql.startsWith('DROP SCHEMA'))).toBe(false)
  })

  it('reports an existing target accurately in dry-run without publishing artifacts', async () => {
    const client = new ExistingClient()
    const report = await restorePostgresStorage({
      ...restoreBase, ssl: 'off', force: true, confirmation: 'REPLACE_DZ23_STORAGE', allowDomainLoss: true,
    }, { resolveConnection: async () => connection, createClient: () => client as never })
    expect(report).toMatchObject({ mode: 'dry-run', targetSchemaExists: true, targetHasContent: true, existingUnits: 1, targetDomains: ['studio_test'] })
    expect(client.sql.some(sql => sql.startsWith('CREATE SCHEMA') || sql.startsWith('DROP SCHEMA'))).toBe(false)
  })

  it('stages, checks readiness inside the swap transaction, then commits', async () => {
    const client = new ScriptClient()
    const report = await restorePostgresStorage({ ...restoreBase, ssl: 'off', write: true, safetyBackup: 'unused.dump' }, {
      ...journalMemory(),
      resolveConnection: async () => connection,
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
      ...restoreBase, ssl: 'off', write: true, safetyBackup: 'safety.dump',
      force: true, confirmation: 'REPLACE_DZ23_STORAGE', allowDomainLoss: true,
    }, {
      ...journalMemory(),
      resolveConnection: async () => connection, createClient: () => client as never,
      createSafetyBackup: async () => { backedUp = true; throw new Error('backup failed') },
    })).rejects.toThrow('backup failed')
    expect(backedUp).toBe(true)
    expect(client.sql.some(sql => sql.includes('pg_try_advisory_lock'))).toBe(true)
    expect(client.sql.some(sql => sql.startsWith('CREATE SCHEMA'))).toBe(false)
  })

  it('records and returns one successful safety backup for an existing target', async () => {
    const client = new ExistingClient()
    const report = await restorePostgresStorage({
      ...restoreBase, ssl: 'off', write: true, safetyBackup: 'safety.dump', force: true, confirmation: 'REPLACE_DZ23_STORAGE',
    }, {
      ...journalMemory(), resolveConnection: async () => connection, createClient: () => client as never, createBackend: () => fakeBackend() as never,
      createSafetyBackup: async (_dsn, _schema, _path, _ssl, _environment, _signal, _resume, _maxBytes, ownership) => {
        expect(ownership).toEqual({ attemptId: 'attempt-0001', targetSchema: 'dz23_storage', targetFingerprint, inputSha256: verifiedInput.inputSha256 })
        return { file: resolve('safety.dump'), sha256: 'a'.repeat(64), bytes: 10 }
      },
    })
    expect(report).toMatchObject({ mode: 'write', safetyBackup: resolve('safety.dump'), safetyBackupStatus: 'created', safetyBackupSha256: 'a'.repeat(64) })
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
    await expect(restorePostgresStorage({ ...restoreBase, ssl: 'off', write: true, safetyBackup: 'unused.dump' }, {
      ...journalMemory(),
      resolveConnection: async () => connection,
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
    expect(status).toEqual({ reachable: true, serverVersion: '16.4', schema: 'dz23_storage', schemaExists: false, ready: false, layoutVersion: null, domains: 0, condition: 'not-initialized' })
    expect(JSON.stringify(status)).not.toContain('secret')
  })

  it('reports an existing malformed schema as unhealthy instead of ready', async () => {
    const client = new ScriptClient()
    const base = client.query.bind(client)
    client.query = async function <T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> {
      if (sql.includes('pg_catalog.pg_namespace WHERE nspname')) {
        this.sql.push(sql)
        return { rows: [{ present: true } as T] }
      }
      if (sql.includes('pg_catalog.pg_class c') && sql.includes('c.relname = ANY')) {
        this.sql.push(sql)
        return { rows: [] }
      }
      return base<T>(sql, values)
    }
    const status = await postgresStorageStatus({ dsn: 'secret', ssl: 'off' }, {
      resolveConnection: async () => connection, createClient: () => client as never,
    })
    expect(status).toMatchObject({ reachable: true, schemaExists: true, ready: false, condition: 'unhealthy' })
  })

  it('reports a valid initialized schema as ready', async () => {
    const client = new ScriptClient()
    client.receiptInput = verifiedInput.inputSha256
    client.receiptTarget = targetFingerprint
    const status = await postgresStorageStatus({ dsn: 'secret', ssl: 'off' }, {
      resolveConnection: async () => connection, createClient: () => client as never,
    })
    expect(status).toMatchObject({ reachable: true, schemaExists: true, ready: true, layoutVersion: 1, domains: 1, condition: 'ready' })
  })

  it('replays a committed attempt after the result journal write was interrupted', async () => {
    const client = new ScriptClient()
    const state = journalMemory()
    let failCommitted = true
    const dependencies = {
      ...state,
      writeJournal: async (path: string, next: import('../src/restore-journal.ts').RestoreJournal) => {
        if (next.state === 'committed' && failCommitted) throw new Error('simulated crash after commit')
        state.memory.value = structuredClone(next)
      },
      resolveConnection: async () => connection, createClient: () => client as never, createBackend: () => fakeBackend() as never,
    }
    const failure = await restorePostgresStorage({ ...restoreBase, ssl: 'off', write: true, safetyBackup: 'unused.dump' }, dependencies)
      .then(() => undefined, (error: unknown) => error as Error)
    expect(failure?.message).toContain('JÁ FOI CONCLUÍDA')
    expect(failure?.message).toContain(`mesmo attempt-id '${restoreBase.attemptId}'`)
    expect(client.sql.filter(sql => sql === 'ROLLBACK')).toEqual([])
    const swaps = client.sql.filter(sql => sql.includes('ALTER SCHEMA')).length
    const destructivePreflights = client.sql.filter(sql => sql.includes('pg_catalog.pg_namespace WHERE nspname')).length
    failCommitted = false
    await expect(restorePostgresStorage({ ...restoreBase, ssl: 'off', write: true, safetyBackup: 'unused.dump' }, dependencies))
      .resolves.toMatchObject({ mode: 'write', readyToStart: true })
    expect(client.sql.filter(sql => sql.includes('ALTER SCHEMA'))).toHaveLength(swaps)
    expect(client.sql.filter(sql => sql.includes('pg_catalog.pg_namespace WHERE nspname'))).toHaveLength(destructivePreflights)
    expect(state.memory.value?.state).toBe('cleanup_complete')
  })

  it('rebuilds staging after a crash before swap without regressing the journal', async () => {
    const client = new ScriptClient()
    const state = journalMemory()
    let failBeforeSwap = true
    const dependencies = {
      ...state,
      writeJournal: async (_path: string, next: import('../src/restore-journal.ts').RestoreJournal) => {
        if (next.state === 'swap_started' && failBeforeSwap) throw new Error('simulated crash before swap')
        state.memory.value = structuredClone(next)
      },
      resolveConnection: async () => connection, createClient: () => client as never, createBackend: () => fakeBackend() as never,
    }
    await expect(restorePostgresStorage({ ...restoreBase, ssl: 'off', write: true, safetyBackup: 'unused.dump' }, dependencies))
      .rejects.toThrow('simulated crash before swap')
    expect(client.sql.some(sql => sql.includes('ALTER SCHEMA'))).toBe(false)
    expect(state.memory.value?.state).toBe('staged_verified')

    failBeforeSwap = false
    await expect(restorePostgresStorage({ ...restoreBase, ssl: 'off', write: true, safetyBackup: 'unused.dump' }, dependencies))
      .resolves.toMatchObject({ mode: 'write', readyToStart: true })
    expect(client.sql.filter(sql => sql.includes('ALTER SCHEMA'))).toHaveLength(1)
    expect(state.memory.value?.state).toBe('cleanup_complete')
  })

  it('refuses reusing an attempt id with another verified input hash', async () => {
    const state = journalMemory({
      v: 1, attemptId: 'attempt-0001', targetSchema: 'dz23_storage', targetFingerprint, inputSha256: '0'.repeat(64), state: 'verified',
      safetyDestination: resolve('unused.dump'),
      stagingSchema: null, safety: null, result: null, updatedAt: '2026-09-04T00:00:00.000Z',
    })
    await expect(restorePostgresStorage({ ...restoreBase, ssl: 'off', write: true, safetyBackup: 'unused.dump' }, {
      ...state, resolveConnection: async () => connection, createClient: () => new ScriptClient() as never,
    })).rejects.toThrow('outra restauração')
  })

  it('binds one attempt id to one canonical safety destination before staging', async () => {
    const client = new ScriptClient()
    const state = journalMemory({
      v: 1, attemptId: 'attempt-0001', targetSchema: 'dz23_storage', targetFingerprint, inputSha256: verifiedInput.inputSha256,
      safetyDestination: resolve('unused.dump'), state: 'verified', stagingSchema: null, safety: null, result: null,
      updatedAt: '2026-09-04T00:00:00.000Z',
    })
    await expect(restorePostgresStorage({ ...restoreBase, ssl: 'off', write: true, safetyBackup: 'different.dump' }, {
      ...state, resolveConnection: async () => connection, createClient: () => client as never,
    })).rejects.toThrow('outra restauração')
    expect(client.sql.some(sql => sql.startsWith('CREATE SCHEMA'))).toBe(false)
    expect(state.paths[0]).toBe(resolve('unused-state', 'dz23_storage.attempt-0001.restore.json'))
  })

  it('serializes the same instance attempt across physical databases through one canonical ledger', async () => {
    const firstClient = new ScriptClient()
    const secondClient = new ScriptClient()
    const original = secondClient.query.bind(secondClient)
    secondClient.query = async function <T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> {
      if (sql.includes('pg_control_system')) {
        this.sql.push(sql)
        return { rows: [{ system_identifier: '7413371234567890123', database_oid: '16385', database_name: 'other' } as T] }
      }
      return original<T>(sql, values)
    }
    const state = journalMemory()
    await restorePostgresStorage({ ...restoreBase, ssl: 'off', write: true, safetyBackup: 'unused.dump' }, {
      ...state, resolveConnection: async () => connection, createClient: () => firstClient as never, createBackend: () => fakeBackend() as never,
    })
    const firstFingerprint = state.memory.value?.targetFingerprint
    await expect(restorePostgresStorage({ ...restoreBase, ssl: 'off', write: true, safetyBackup: 'unused.dump' }, {
      ...state, resolveConnection: async () => connection, createClient: () => secondClient as never, createBackend: () => fakeBackend() as never,
    })).rejects.toThrow('outra restauração')
    expect(firstFingerprint).toBe(targetFingerprint)
    expect(state.paths.every(path => path === resolve('unused-state', 'dz23_storage.attempt-0001.restore.json'))).toBe(true)
    expect(secondClient.sql.some(sql => sql.startsWith('CREATE SCHEMA') || sql.startsWith('DROP SCHEMA'))).toBe(false)
  })

  it('refuses a committed journal whose database receipt does not match', async () => {
    const client = new ScriptClient()
    client.receiptInput = '0'.repeat(64)
    client.receiptTarget = targetFingerprint
    client.receiptSafety = null
    const planned = {
      mode: 'write', domains: 1, safetyBackup: null, safetyBackupStatus: 'not-needed-empty-target' as const,
      safetyBackupSha256: null, replacedDomains: [], droppedDomains: [], reapedStaging: [], readyToStart: true as const,
    }
    const state = journalMemory({
      v: 1, attemptId: 'attempt-0001', targetSchema: 'dz23_storage', targetFingerprint, inputSha256: verifiedInput.inputSha256,
      safetyDestination: resolve('unused.dump'), state: 'committed', stagingSchema: 'dz23_storage_staging_abcd',
      safety: null, result: planned, updatedAt: '2026-09-04T00:00:00.000Z',
    })
    await expect(restorePostgresStorage({ ...restoreBase, ssl: 'off', write: true, safetyBackup: 'unused.dump' }, {
      ...state, resolveConnection: async () => connection, createClient: () => client as never,
    })).rejects.toThrow('recibo no PostgreSQL não corresponde')
    expect(client.sql.some(sql => sql.includes('ALTER SCHEMA') || sql.startsWith('DROP SCHEMA'))).toBe(false)
  })

  it('refuses an exact database receipt when the in-memory journal result is not recoverable', async () => {
    const client = new ScriptClient()
    client.receiptInput = verifiedInput.inputSha256
    client.receiptTarget = targetFingerprint
    client.receiptSafety = null
    const state = journalMemory({
      v: 1, attemptId: 'attempt-0001', targetSchema: 'dz23_storage', targetFingerprint, inputSha256: verifiedInput.inputSha256,
      safetyDestination: resolve('unused.dump'), state: 'swap_started', stagingSchema: 'dz23_storage_staging_abcd',
      safety: null, result: null, updatedAt: '2026-09-04T00:00:00.000Z',
    })
    await expect(restorePostgresStorage({ ...restoreBase, ssl: 'off', write: true, safetyBackup: 'unused.dump' }, {
      ...state, resolveConnection: async () => connection, createClient: () => client as never,
    })).rejects.toThrow('não contém um resultado recuperável')
    expect(client.sql.some(sql => sql.includes('ALTER SCHEMA'))).toBe(false)
  })

  it('rolls back when cancellation arrives after staged verification but before COMMIT', async () => {
    const client = new ScriptClient()
    const controller = new AbortController()
    const base = client.query.bind(client)
    client.query = async function <T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> {
      const result = await base<T>(sql, values)
      if (sql.includes('SELECT name FROM') && sql.includes('ORDER BY') && this.sql.some(item => item.includes('ALTER SCHEMA'))) {
        controller.abort(new Error('cancelled-before-commit'))
      }
      return result
    }
    await expect(restorePostgresStorage({ ...restoreBase, ssl: 'off', write: true, safetyBackup: 'unused.dump', signal: controller.signal }, {
      ...journalMemory(), resolveConnection: async () => connection, createClient: () => client as never, createBackend: () => fakeBackend() as never,
    })).rejects.toThrow('cancelled-before-commit')
    const swap = client.sql.findIndex(sql => sql.includes('ALTER SCHEMA'))
    expect(swap).toBeGreaterThan(-1)
    expect(client.sql.slice(swap)).toContain('ROLLBACK')
    expect(client.sql.slice(swap)).not.toContain('COMMIT')
  })

  it('fails closed on lock contention and rolls back staging creation errors', async () => {
    const locked = new ScriptClient()
    const lockedBase = locked.query.bind(locked)
    locked.query = async function <T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> {
      if (sql.includes('pg_try_advisory_lock')) { this.sql.push(sql); return { rows: [{ acquired: false } as T] } }
      return lockedBase<T>(sql, values)
    }
    await expect(restorePostgresStorage({ ...restoreBase, ssl: 'off', write: true, safetyBackup: 'unused.dump' }, {
      ...journalMemory(), resolveConnection: async () => connection, createClient: () => locked as never,
    })).rejects.toThrow('ainda está em execução')

    const broken = new ScriptClient()
    const brokenBase = broken.query.bind(broken)
    broken.query = async function <T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> {
      if (sql.startsWith('CREATE SCHEMA')) { this.sql.push(sql); throw new Error('create-staging-failed') }
      return brokenBase<T>(sql, values)
    }
    await expect(restorePostgresStorage({ ...restoreBase, ssl: 'off', write: true, safetyBackup: 'unused.dump' }, {
      ...journalMemory(), resolveConnection: async () => connection, createClient: () => broken as never,
    })).rejects.toThrow('create-staging-failed')
    expect(broken.sql).toContain('ROLLBACK')
  })

  it('refuses a contended legacy per-unit lock', async () => {
    const client = new ScriptClient()
    let lockCalls = 0
    const base = client.query.bind(client)
    client.query = async function <T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> {
      if (sql.includes('pg_try_advisory_lock')) { this.sql.push(sql); lockCalls += 1; return { rows: [{ acquired: lockCalls === 1 } as T] } }
      if (sql.includes("tablename = 'units'")) { this.sql.push(sql); return { rows: [{ count: '1' } as T] } }
      if (sql.includes('SELECT name FROM') && !sql.includes('ORDER BY')) { this.sql.push(sql); return { rows: [{ name: 'studio_test' } as T] } }
      return base<T>(sql, values)
    }
    await expect(restorePostgresStorage({ ...restoreBase, ssl: 'off', write: true, safetyBackup: 'unused.dump' }, {
      ...journalMemory(), resolveConnection: async () => connection, createClient: () => client as never,
    })).rejects.toThrow('ainda está em execução')
    expect(lockCalls).toBe(2)
  })

  it('refuses non-empty, unverifiable and facet-less staging backends', async () => {
    const cases = [
      { backend: { waitUntilReady: async () => undefined, close: async () => undefined }, message: 'no KV facet' },
      { backend: { kv: { open: async () => ({ loadAll: async () => ({ tables: { records: { occupied: true } }, global: null }), close: async () => undefined }) }, waitUntilReady: async () => undefined, close: async () => undefined }, message: 'is not empty' },
      { backend: { kv: { open: async () => ({ loadAll: async () => ({ tables: { records: {} }, global: null }), putRecord: async () => undefined, close: async () => undefined }) }, waitUntilReady: async () => undefined, close: async () => undefined }, message: 'checksum mismatch' },
    ]
    for (const item of cases) {
      const client = new ScriptClient()
      await expect(restorePostgresStorage({ ...restoreBase, ssl: 'off', write: true, safetyBackup: 'unused.dump' }, {
        ...journalMemory(), resolveConnection: async () => connection, createClient: () => client as never, createBackend: () => item.backend as never,
      })).rejects.toThrow(item.message)
      expect(client.sql.some(sql => sql.startsWith('DROP SCHEMA IF EXISTS') && sql.includes('_staging_'))).toBe(true)
    }
  })

  it('imports and verifies a domain global, and preserves checksum failure if unit close also fails', async () => {
    const global = exportedDomain(
      { name: 'studio_global', version: 1, tables: ['records'], hasGlobal: true },
      { tables: { records: {} }, global: { enabled: true } },
    )
    const globalBundle = sealBundle({ kind: 'postgres', sha256: 'a'.repeat(64) }, [global], '2026-09-04T00:00:00.000Z')
    const globalClient = new ScriptClient()
    const globalBase = globalClient.query.bind(globalClient)
    globalClient.query = async function <T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> {
      if (sql.includes('SELECT name FROM') && sql.includes('ORDER BY') && this.sql.some(item => item.includes('ALTER SCHEMA'))) {
        this.sql.push(sql); return { rows: [{ name: 'studio_global' } as T] }
      }
      return globalBase<T>(sql, values)
    }
    await expect(restorePostgresStorage({
      ...restoreBase, verifiedInput: { ...verifiedInput, bundle: globalBundle }, ssl: 'off', write: true, safetyBackup: 'unused.dump',
    }, {
      ...journalMemory(), resolveConnection: async () => connection, createClient: () => globalClient as never, createBackend: () => fakeBackend() as never,
    })).resolves.toMatchObject({ mode: 'write', readyToStart: true })

    const client = new ScriptClient()
    const backend = {
      waitUntilReady: async () => undefined,
      kv: { open: async () => ({
        loadAll: async () => ({ tables: { records: {} }, global: null }), putRecord: async () => undefined,
        close: async () => { throw new Error('unit-close-failed') },
      }) },
      close: async () => undefined,
    }
    await expect(restorePostgresStorage({ ...restoreBase, ssl: 'off', write: true, safetyBackup: 'unused.dump' }, {
      ...journalMemory(), resolveConnection: async () => connection, createClient: () => client as never, createBackend: () => backend as never,
    })).rejects.toThrow('checksum mismatch')
  })

  it('cancels if the AbortSignal carries no Error reason', async () => {
    const controller = new AbortController()
    controller.abort('plain-reason')
    await expect(restorePostgresStorage({ ...restoreBase, signal: controller.signal })).rejects.toThrow('Operação cancelada')
  })

  it('refuses incomplete or untrustworthy PostgreSQL catalog evidence', async () => {
    for (const catalogs of [[], [{ relname: 'pg_class;drop', attname: 'relnamespace' }]]) {
      const client = new ExistingClient()
      const base = client.query.bind(client)
      client.query = async function <T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> {
        if (sql.includes("a.attname LIKE '%namespace'")) { this.sql.push(sql); return { rows: catalogs as T[] } }
        return base<T>(sql)
      }
      await expect(restorePostgresStorage({ ...restoreBase, ssl: 'off', force: true, confirmation: 'REPLACE_DZ23_STORAGE' }, {
        resolveConnection: async () => connection, createClient: () => client as never,
      })).rejects.toThrow(catalogs.length === 0 ? 'Não foi possível inspecionar' : 'Nome inesperado')
    }
  })

  it('classifies missing columns, missing layout metadata and wrong layout versions as unhealthy', async () => {
    for (const mode of ['columns', 'missing-version', 'wrong-version'] as const) {
      const client = new ScriptClient()
      client.receiptInput = verifiedInput.inputSha256
      const base = client.query.bind(client)
      client.query = async function <T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> {
        if (mode === 'columns' && sql.includes('pg_catalog.pg_attribute a')) { this.sql.push(sql); return { rows: [] } }
        if (mode === 'missing-version' && sql.includes('storage_meta') && sql.includes('layout_version')) { this.sql.push(sql); return { rows: [] } }
        if (mode === 'wrong-version' && sql.includes('storage_meta') && sql.includes('layout_version')) { this.sql.push(sql); return { rows: [{ value: 999 } as T] } }
        return base<T>(sql, values)
      }
      await expect(postgresStorageStatus({ dsn: 'secret', ssl: 'off' }, {
        resolveConnection: async () => connection, createClient: () => client as never,
      })).resolves.toMatchObject({ condition: 'unhealthy', ready: false })
    }
  })

  it('refuses an existing safety destination before pg_dump or staging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-restore-existing-'))
    await chmod(root, 0o700)
    const output = join(root, 'safety.dump')
    await writeFile(output, 'do-not-overwrite', { mode: 0o600 })
    try {
      const client = new ExistingClient()
      await expect(restorePostgresStorage({
        ...restoreBase, ssl: 'off', write: true, safetyBackup: output, force: true, confirmation: 'REPLACE_DZ23_STORAGE',
      }, {
        ...journalMemory(), resolveConnection: async () => connection, createClient: () => client as never,
      })).rejects.toThrow('Já existe um arquivo')
      expect(client.sql.some(sql => sql.startsWith('CREATE SCHEMA'))).toBe(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('reaps only staging schemas with exact names and exact ownership markers', async () => {
    const client = new ScriptClient()
    const base = client.query.bind(client)
    client.query = async function <T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> {
      if (sql.includes('LIKE $1')) {
        this.sql.push(sql)
        return { rows: [
          { nspname: 'foreign_staging_old1' }, { nspname: 'dz23_storage_staging_old1' }, { nspname: 'dz23_storage_staging_old2' },
        ] as T[] }
      }
      if (sql.includes('dz23_import_staging') && sql.includes('SELECT m.tool')) {
        this.sql.push(sql)
        if (sql.includes('old2')) throw new Error('marker unreadable')
        return { rows: sql.includes('old1') ? [{ tool: 'dz23-studio/import-postgres-storage', target_schema: 'dz23_storage' } as T] : [] }
      }
      return base<T>(sql, values)
    }
    const report = await restorePostgresStorage({ ...restoreBase, ssl: 'off', write: true, safetyBackup: 'unused.dump' }, {
      ...journalMemory(), resolveConnection: async () => connection, createClient: () => client as never, createBackend: () => fakeBackend() as never,
    })
    expect(report).toMatchObject({ mode: 'write', reapedStaging: ['dz23_storage_staging_old1'] })
    expect(client.sql.some(sql => sql.includes('DROP SCHEMA IF EXISTS "foreign_staging_old1"'))).toBe(false)
    expect(client.sql.some(sql => sql.includes('DROP SCHEMA IF EXISTS "dz23_storage_staging_old2"'))).toBe(false)
  })

  it('refuses a safety artifact that diverges from the monotonic journal', async () => {
    const client = new ExistingClient()
    const state = journalMemory({
      v: 1, attemptId: 'attempt-0001', targetSchema: 'dz23_storage', targetFingerprint, inputSha256: verifiedInput.inputSha256,
      safetyDestination: resolve('safety.dump'), state: 'safety_published', stagingSchema: null,
      safety: { path: resolve('safety.dump'), sha256: 'a'.repeat(64), bytes: 10 }, result: null, updatedAt: '2026-09-04T00:00:00.000Z',
    })
    await expect(restorePostgresStorage({
      ...restoreBase, ssl: 'off', write: true, safetyBackup: 'safety.dump', force: true, confirmation: 'REPLACE_DZ23_STORAGE', allowDomainLoss: true,
    }, {
      ...state, resolveConnection: async () => connection, createClient: () => client as never,
      createSafetyBackup: async () => ({ file: resolve('safety.dump'), sha256: 'b'.repeat(64), bytes: 10 }),
    })).rejects.toThrow('diverge do journal')
    expect(client.sql.some(sql => sql.startsWith('CREATE SCHEMA'))).toBe(false)
  })

  it('rolls back when the staged domain inventory differs from the verified bundle', async () => {
    const client = new ScriptClient()
    let renamed = false
    const base = client.query.bind(client)
    client.query = async function <T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> {
      if (sql.includes('ALTER SCHEMA')) renamed = true
      if (renamed && sql.includes('SELECT name FROM') && sql.includes('ORDER BY')) { this.sql.push(sql); return { rows: [{ name: 'unexpected_domain' } as T] } }
      return base<T>(sql, values)
    }
    await expect(restorePostgresStorage({ ...restoreBase, ssl: 'off', write: true, safetyBackup: 'unused.dump' }, {
      ...journalMemory(), resolveConnection: async () => connection, createClient: () => client as never, createBackend: () => fakeBackend() as never,
    })).rejects.toThrow('não contém exatamente')
    expect(client.sql).toContain('ROLLBACK')
  })

  it('resumes swap_started without a receipt by rebuilding staging, without journal regression', async () => {
    const client = new ScriptClient()
    const planned = {
      mode: 'write', domains: 1, safetyBackup: null, safetyBackupStatus: 'not-needed-empty-target' as const,
      safetyBackupSha256: null, replacedDomains: [], droppedDomains: [], reapedStaging: [], readyToStart: true as const,
    }
    const state = journalMemory({
      v: 1, attemptId: 'attempt-0001', targetSchema: 'dz23_storage', targetFingerprint, inputSha256: verifiedInput.inputSha256,
      safetyDestination: resolve('unused.dump'), state: 'swap_started', stagingSchema: 'dz23_storage_staging_old',
      safety: null, result: planned, updatedAt: '2026-09-04T00:00:00.000Z',
    })
    await expect(restorePostgresStorage({ ...restoreBase, ssl: 'off', write: true, safetyBackup: 'unused.dump' }, {
      ...state, resolveConnection: async () => connection, createClient: () => client as never, createBackend: () => fakeBackend() as never,
    })).resolves.toMatchObject({ mode: 'write', readyToStart: true })
    expect(state.memory.value?.state).toBe('cleanup_complete')
  })

  it('keeps the primary import error when best-effort backend, staging and unlock cleanup also fail', async () => {
    const client = new ScriptClient()
    const base = client.query.bind(client)
    client.query = async function <T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> {
      if (sql.includes('DROP SCHEMA IF EXISTS') && sql.includes('_staging_')) { this.sql.push(sql); throw new Error('drop-cleanup-failed') }
      if (sql.includes('pg_advisory_unlock_all')) { this.sql.push(sql); throw new Error('unlock-cleanup-failed') }
      return base<T>(sql, values)
    }
    const backend = {
      waitUntilReady: async () => undefined,
      kv: { open: async () => { throw new Error('primary-import-failed') } },
      close: async () => { throw new Error('backend-close-failed') },
    }
    await expect(restorePostgresStorage({ ...restoreBase, ssl: 'off', write: true, safetyBackup: 'unused.dump' }, {
      ...journalMemory(), resolveConnection: async () => connection, createClient: () => client as never, createBackend: () => backend as never,
    })).rejects.toThrow('primary-import-failed')
    expect(client.sql.some(sql => sql.includes('pg_advisory_unlock_all'))).toBe(true)
  })
})
