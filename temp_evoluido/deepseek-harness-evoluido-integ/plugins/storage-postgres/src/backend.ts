import { randomUUID } from 'node:crypto'
import { Client, Pool } from 'pg'
import type { ClientConfig, PoolConfig } from 'pg'
import { StorageError, UNIT_NAME_RE } from '@deepseek-ai/dsh-storage'
import type { KvFacet, KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'
import { compareUtf8, descriptorFingerprint } from './bundle.js'
import { withoutTlsParams } from './dsn.js'
import { StudioStorageError } from './errors.js'
import { ensureSchema, leasesTable, storageMaintenanceLockName, storageUnitLockName, unitsTable } from './schema.js'
import { PostgresKvUnit } from './unit.js'

export interface PostgresStorageBackendConfig {
  connectionString: string
  schema: string
  ssl: false | { rejectUnauthorized: boolean }
  poolMax: number
  heartbeatMs?: number
  /** How long to wait before taking the maintenance lock again after losing its session. */
  maintenanceRetryMs?: number
}

/** PostgreSQL KV backend with one dedicated, locked connection per open unit. */
export class PostgresStorageBackend implements StorageBackend {
  readonly kv: KvFacet = { open: descriptor => this.openUnit(descriptor) }

  private readonly pool: Pool
  private readonly ready: Promise<void>
  private readonly units = new Map<string, Promise<PostgresKvUnit>>()
  private closing: Promise<void> | undefined
  /** Dedicated session holding the shared maintenance lock while this Studio is up. */
  private maintenance: Client | undefined
  private maintenanceHeld = false
  private maintenanceRetry: NodeJS.Timeout | undefined
  private readonly maintenanceRetryMs: number

  constructor(private readonly config: PostgresStorageBackendConfig) {
    this.maintenanceRetryMs = config.maintenanceRetryMs ?? 2_000
    this.pool = new Pool(this.connectionConfig(config.poolMax))
    this.ready = ensureSchema(this.pool, config.schema).then(() => this.holdMaintenanceLock())
    this.ready.catch(() => undefined)
  }

  /**
   * Announce "a Studio is using this schema" for as long as the process lives.
   * Shared, so several readers coexist; a restore that wants the schema takes
   * it exclusive and is refused while this session exists. Its own session is
   * what releases it, so a crashed Studio never leaves it stuck.
   *
   * The session is supervised: a dropped connection (failover, an idle reaper,
   * `pg_terminate_backend`, a network blip) would otherwise both crash the
   * process with an unhandled `error` event AND silently drop the guarantee,
   * leaving a live Studio that a restore is free to `DROP SCHEMA` under. On
   * loss it reconnects and takes the lock again; while it is not held, the
   * backend refuses to open new units instead of running unprotected.
   */
  private async holdMaintenanceLock(): Promise<void> {
    const client = new Client({ ...this.connectionConfig(), application_name: `dz23-storage:maintenance:${this.config.schema}` })
    // Attached BEFORE connect: an `error` event with no listener takes the whole process down.
    client.on('error', () => { this.onMaintenanceLost(client) })
    client.on('end', () => { this.onMaintenanceLost(client) })
    await client.connect()
    try {
      await client.query('SELECT pg_advisory_lock_shared(hashtext($1))', [storageMaintenanceLockName(this.config.schema)])
    } catch (error) {
      /* v8 ignore next -- cleanup after a failed lock cannot supersede the original error. */
      await client.end().catch(() => undefined)
      throw error
    }
    this.maintenance = client
    this.maintenanceHeld = true
  }

  /** The lock session died: stop claiming the guarantee, and try to take it again. */
  private onMaintenanceLost(client: Client): void {
    if (this.closing !== undefined || this.maintenance !== client) return
    this.maintenance = undefined
    this.maintenanceHeld = false
    /* v8 ignore next -- the retry timer is exercised by the reconnection test, not by unit coverage. */
    if (this.maintenanceRetry !== undefined) return
    const attempt = (): void => {
      this.maintenanceRetry = undefined
      if (this.closing !== undefined || this.maintenanceHeld) return
      this.holdMaintenanceLock().catch(() => {
        this.maintenanceRetry = setTimeout(attempt, this.maintenanceRetryMs)
        this.maintenanceRetry.unref()
      })
    }
    this.maintenanceRetry = setTimeout(attempt, this.maintenanceRetryMs)
    this.maintenanceRetry.unref()
  }

  /** Whether this Studio currently holds the shared maintenance lock on its schema. */
  get maintenanceLockHeld(): boolean { return this.maintenanceHeld }

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
    // Without the maintenance lock a restore could replace this schema underneath us: refuse to
    // start writing rather than write into something that may be dropped in the next second.
    if (!this.maintenanceHeld) {
      throw new StudioStorageError(`postgres storage schema '${this.config.schema}' is not protected by the maintenance lock right now`)
    }
    const holder = randomUUID()
    const client = new Client({ ...this.connectionConfig(), application_name: `dz23-storage:${descriptor.name}` })
    try {
      await client.connect()
      // The flag above is a cheap pre-check, not the authority: between reading it and taking the
      // unit lock a restore could have taken the maintenance lock EXCLUSIVE, listed the units it
      // knows about and dropped the schema under this writer. So this session takes the maintenance
      // lock SHARED itself, before anything else it does. Shared and exclusive are the same lock:
      // either this writer gets in first and the restore's `pg_try_advisory_lock` is refused, or the
      // restore is already in and this acquisition fails — there is no window between the two.
      const guarded = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock_shared(hashtext($1)) AS acquired',
        [storageMaintenanceLockName(this.config.schema)],
      )
      if (guarded.rows[0]?.acquired !== true) {
        throw new StudioStorageError(`postgres storage schema '${this.config.schema}' is not protected by the maintenance lock right now`)
      }
      const lockName = storageUnitLockName(this.config.schema, descriptor.name)
      const lock = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
        [lockName],
      )
      if (lock.rows[0]?.acquired !== true) {
        throw new StudioStorageError(`kv unit '${descriptor.name}' already has an active writer`)
      }
      // The DECLARED shape is stamped with the unit, not inferred later from the rows that happen to
      // exist: a table declared and never written, or a global slot never set, is part of the unit
      // and must survive a backup/restore round trip. The fingerprint travels with it so a
      // hand-edited row is caught instead of believed.
      const declaredTables = [...descriptor.tables].sort(compareUtf8)
      const declaredFingerprint = descriptorFingerprint(descriptor)
      // A descriptor is an immutable schema declaration, not last-writer-wins
      // configuration.  Updating the row on a same-version open allowed an old
      // process (or a stale plugin) to silently redefine tables/hasGlobal and to
      // bless the rewrite with a new fingerprint.  Insert once, then compare the
      // complete persisted declaration.  The unit advisory lock serializes the
      // INSERT/SELECT pair across processes.
      await client.query(`
        INSERT INTO ${unitsTable(this.config.schema)} (name, version, tables, has_global, descriptor_sha256)
        VALUES ($1, $2, $3::jsonb, $4, $5)
        ON CONFLICT (name) DO NOTHING
      `, [descriptor.name, descriptor.version, JSON.stringify(declaredTables), descriptor.hasGlobal, declaredFingerprint])
      // Layout v1 originally had only name+version. A completely unstamped
      // legacy row gets exactly one atomic initialization; a partially edited
      // row never qualifies and is rejected by the comparison below.
      await client.query(`
        UPDATE ${unitsTable(this.config.schema)}
        SET tables = $3::jsonb, has_global = $4, descriptor_sha256 = $5
        WHERE name = $1 AND version = $2
          AND tables IS NULL AND has_global IS NULL AND descriptor_sha256 IS NULL
      `, [descriptor.name, descriptor.version, JSON.stringify(declaredTables), descriptor.hasGlobal, declaredFingerprint])
      const stamped = await client.query<{
        version: number
        tables: string[] | null
        has_global: boolean | null
        descriptor_sha256: string | null
      }>(`
        SELECT version, tables, has_global, descriptor_sha256
        FROM ${unitsTable(this.config.schema)} WHERE name = $1
      `, [descriptor.name])
      const onDisk = stamped.rows[0]
      if (onDisk === undefined || onDisk.version !== descriptor.version) {
        throw new StorageError(
          'version-mismatch',
          `kv unit '${descriptor.name}' is stamped version ${String(onDisk?.version)} on the medium, incompatible with descriptor version ${String(descriptor.version)}`,
        )
      }
      const storedTables = Array.isArray(onDisk.tables) && onDisk.tables.every(table => typeof table === 'string')
        ? [...onDisk.tables].sort(compareUtf8)
        : undefined
      if (
        storedTables === undefined
        || JSON.stringify(storedTables) !== JSON.stringify(declaredTables)
        || onDisk.has_global !== descriptor.hasGlobal
        || onDisk.descriptor_sha256 !== declaredFingerprint
      ) {
        throw new StorageError(
          'malformed-medium',
          `kv unit '${descriptor.name}' already has a different immutable descriptor for version ${String(descriptor.version)}`,
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
    // The lock session is assigned after an await, so a close that races the opening would leak it
    // and leave the schema looking busy forever.
    await this.ready.catch(() => undefined)
    if (this.maintenanceRetry !== undefined) { clearTimeout(this.maintenanceRetry); this.maintenanceRetry = undefined }
    for (const pending of [...this.units.values()]) {
      /* v8 ignore next -- a rejected pending open already released its client in materializeUnit. */
      const unit = await pending.catch(() => undefined)
      await unit?.close()
    }
    await this.pool.end()
    const maintenance = this.maintenance
    this.maintenance = undefined
    this.maintenanceHeld = false
    maintenance?.removeAllListeners('end')
    /* v8 ignore next -- ending the session releases the lock even if the explicit unlock fails. */
    await maintenance?.query('SELECT pg_advisory_unlock_shared(hashtext($1))', [storageMaintenanceLockName(this.config.schema)]).catch(() => undefined)
    /* v8 ignore next -- best-effort close of the maintenance session. */
    await maintenance?.end().catch(() => undefined)
  }

  private connectionConfig(max?: number): PoolConfig & ClientConfig {
    return {
      // The `ssl` field decides, alone: `pg` merges the parsed connection string over the
      // explicit options, so a DSN carrying `sslmode=disable` would otherwise silently
      // turn a verified connection into a plaintext one.
      connectionString: withoutTlsParams(this.config.connectionString),
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
