import { randomUUID } from 'node:crypto'
import { Client, Pool } from 'pg'
import type { ClientConfig, PoolConfig } from 'pg'
import { StorageError, UNIT_NAME_RE } from '@deepseek-ai/dsh-storage'
import type { KvFacet, KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'
import { StudioStorageError } from './errors.js'
import { ensureSchema, leasesTable, storageUnitLockName, unitsTable } from './schema.js'
import { PostgresKvUnit } from './unit.js'

export interface PostgresStorageBackendConfig {
  connectionString: string
  schema: string
  ssl: false | { rejectUnauthorized: boolean }
  poolMax: number
  heartbeatMs?: number
}

/** PostgreSQL KV backend with one dedicated, locked connection per open unit. */
export class PostgresStorageBackend implements StorageBackend {
  readonly kv: KvFacet = { open: descriptor => this.openUnit(descriptor) }

  private readonly pool: Pool
  private readonly ready: Promise<void>
  private readonly units = new Map<string, Promise<PostgresKvUnit>>()
  private closing: Promise<void> | undefined

  constructor(private readonly config: PostgresStorageBackendConfig) {
    this.pool = new Pool(this.connectionConfig(config.poolMax))
    this.ready = ensureSchema(this.pool, config.schema)
    this.ready.catch(() => undefined)
  }

  /** Resolve only after the schema and database connection are usable. */
  waitUntilReady(): Promise<void> {
    return this.ready
  }

  private openUnit(descriptor: KvUnitDescriptor): Promise<KvUnit> {
    if (this.closing !== undefined) return Promise.reject(new StorageError('closed', 'postgres storage backend is closed'))
    try {
      assertDescriptor(descriptor)
    } catch (error) {
      return Promise.reject(error)
    }
    if (this.units.has(descriptor.name)) {
      return Promise.reject(new Error(`kv unit '${descriptor.name}' is already open (double-open is a caller bug)`))
    }
    const pending = this.materializeUnit(descriptor)
    this.units.set(descriptor.name, pending)
    pending.catch(() => this.units.delete(descriptor.name))
    return pending
  }

  private async materializeUnit(descriptor: KvUnitDescriptor): Promise<PostgresKvUnit> {
    await this.ready
    const holder = randomUUID()
    const client = new Client({ ...this.connectionConfig(), application_name: `dz23-storage:${descriptor.name}` })
    try {
      await client.connect()
      const lockName = storageUnitLockName(this.config.schema, descriptor.name)
      const lock = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
        [lockName],
      )
      if (lock.rows[0]?.acquired !== true) {
        throw new StudioStorageError(`kv unit '${descriptor.name}' already has an active writer`)
      }
      const stamped = await client.query<{ version: number }>(`
        WITH inserted AS (
          INSERT INTO ${unitsTable(this.config.schema)} (name, version) VALUES ($1, $2)
          ON CONFLICT (name) DO NOTHING
          RETURNING version
        )
        SELECT version FROM inserted
        UNION ALL
        SELECT version FROM ${unitsTable(this.config.schema)} WHERE name = $1
        LIMIT 1
      `, [descriptor.name, descriptor.version])
      const onDisk = stamped.rows[0]?.version
      if (onDisk !== descriptor.version) {
        throw new StorageError(
          'version-mismatch',
          `kv unit '${descriptor.name}' is stamped version ${String(onDisk)} on the medium, incompatible with descriptor version ${String(descriptor.version)}`,
        )
      }
      await client.query(
        `INSERT INTO ${leasesTable(this.config.schema)} (unit, holder, acquired_at, heartbeat_at)
         VALUES ($1, $2, clock_timestamp(), clock_timestamp())
         ON CONFLICT (unit) DO UPDATE SET
           holder = EXCLUDED.holder,
           acquired_at = EXCLUDED.acquired_at,
           heartbeat_at = EXCLUDED.heartbeat_at`,
        [descriptor.name, holder],
      )
      return new PostgresKvUnit({
        client,
        descriptor,
        schema: this.config.schema,
        holder,
        heartbeatMs: this.config.heartbeatMs ?? 15_000,
        onClose: () => this.units.delete(descriptor.name),
      })
    } catch (error) {
      /* v8 ignore next -- pg Client.end rejection is best-effort cleanup after the primary open failure. */
      await client.end().catch(() => undefined)
      throw error
    }
  }

  close(): Promise<void> {
    this.closing ??= this.doClose()
    return this.closing
  }

  private async doClose(): Promise<void> {
    for (const pending of [...this.units.values()]) {
      /* v8 ignore next -- a rejected pending open already released its client in materializeUnit. */
      const unit = await pending.catch(() => undefined)
      await unit?.close()
    }
    await this.pool.end()
  }

  private connectionConfig(max?: number): PoolConfig & ClientConfig {
    return {
      connectionString: this.config.connectionString,
      ssl: this.config.ssl,
      ...(max === undefined ? {} : { max }),
    }
  }
}

function assertDescriptor(descriptor: KvUnitDescriptor): void {
  if (!UNIT_NAME_RE.test(descriptor.name)) {
    throw new Error(`kv unit name '${descriptor.name}' violates ${UNIT_NAME_RE}`)
  }
  if (!Number.isInteger(descriptor.version) || descriptor.version < 0) {
    throw new Error(`kv unit '${descriptor.name}' version must be a non-negative integer`)
  }
  for (const table of descriptor.tables) {
    if (!UNIT_NAME_RE.test(table)) {
      throw new Error(`kv table name '${table}' in unit '${descriptor.name}' violates ${UNIT_NAME_RE}`)
    }
  }
}
