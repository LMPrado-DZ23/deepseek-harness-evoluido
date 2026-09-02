import type { Client } from 'pg'
import { StorageError } from '@deepseek-ai/dsh-storage'
import type { KvUnit, KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { StudioStorageError } from './errors.js'
import { globalsTable, leasesTable, recordsTable } from './schema.js'

interface StoredRecord {
  table: string
  key: string
  value: unknown
}

interface SnapshotRow {
  records: StoredRecord[]
  global: unknown | null
}

export interface PostgresKvUnitOptions {
  client: Client
  descriptor: KvUnitDescriptor
  schema: string
  holder: string
  heartbeatMs: number
  onClose: () => void
}

/** One unit and its session-scoped writer lock share the same connection. */
export class PostgresKvUnit implements KvUnit {
  private readonly tables: Set<string>
  private readonly heartbeat: NodeJS.Timeout
  private closed = false
  private leaseLost = false
  private closing: Promise<void> | undefined

  constructor(private readonly options: PostgresKvUnitOptions) {
    this.tables = new Set(options.descriptor.tables)
    options.client.on('error', error => this.markLeaseLost(error))
    this.heartbeat = setInterval(() => {
      void this.touchLease().catch(error => this.markLeaseLost(error))
    }, options.heartbeatMs)
    this.heartbeat.unref()
  }

  async loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    this.ensureOpen()
    try {
      const result = await this.options.client.query<SnapshotRow>(`
        SELECT
          COALESCE(
            jsonb_agg(jsonb_build_object('table', table_name, 'key', key, 'value', value))
              FILTER (WHERE table_name IS NOT NULL),
            '[]'::jsonb
          ) AS records,
          (SELECT value FROM ${globalsTable(this.options.schema)} WHERE unit = $1) AS global
        FROM ${recordsTable(this.options.schema)}
        WHERE unit = $1
      `, [this.options.descriptor.name])
      const tables: Record<string, Record<string, unknown>> = {}
      for (const table of this.options.descriptor.tables) {
        tables[table] = Object.create(null) as Record<string, unknown>
      }
      const row = result.rows[0]!
      for (const record of row.records) {
        if (tables[record.table] === undefined) {
          throw new StorageError('malformed-medium', `kv unit '${this.options.descriptor.name}' holds undeclared table '${record.table}'`)
        }
        tables[record.table]![record.key] = record.value
      }
      return { tables, global: row.global ?? null }
    } catch (error) {
      throw this.operationFailure(error)
    }
  }

  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    this.ensureOpen()
    this.assertTable(table)
    const encoded = encodeJson(value)
    try {
      await this.options.client.query(
        `INSERT INTO ${recordsTable(this.options.schema)} (unit, table_name, key, value)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (unit, table_name, key) DO UPDATE SET value = EXCLUDED.value`,
        [this.options.descriptor.name, table, key, encoded],
      )
    } catch (error) {
      throw this.operationFailure(error)
    }
  }

  async deleteRecord(table: string, key: string): Promise<void> {
    this.ensureOpen()
    this.assertTable(table)
    try {
      await this.options.client.query(
        `DELETE FROM ${recordsTable(this.options.schema)} WHERE unit = $1 AND table_name = $2 AND key = $3`,
        [this.options.descriptor.name, table, key],
      )
    } catch (error) {
      throw this.operationFailure(error)
    }
  }

  async setGlobal(value: unknown): Promise<void> {
    this.ensureOpen()
    if (!this.options.descriptor.hasGlobal) {
      throw new Error(`kv unit '${this.options.descriptor.name}' declared no global slot`)
    }
    const encoded = encodeJson(value)
    try {
      await this.options.client.query(
        `INSERT INTO ${globalsTable(this.options.schema)} (unit, value) VALUES ($1, $2::jsonb)
         ON CONFLICT (unit) DO UPDATE SET value = EXCLUDED.value`,
        [this.options.descriptor.name, encoded],
      )
    } catch (error) {
      throw this.operationFailure(error)
    }
  }

  close(): Promise<void> {
    this.closing ??= this.doClose()
    return this.closing
  }

  private async touchLease(): Promise<void> {
    /* v8 ignore next -- a timer already queued during close/loss may enter once after clearInterval. */
    if (this.closed || this.leaseLost) return
    const result = await this.options.client.query(
      `UPDATE ${leasesTable(this.options.schema)} SET heartbeat_at = clock_timestamp()
       WHERE unit = $1 AND holder = $2`,
      [this.options.descriptor.name, this.options.holder],
    )
    if (result.rowCount !== 1) throw new Error('writer lease row is no longer owned by this process')
  }

  private async doClose(): Promise<void> {
    this.closed = true
    clearInterval(this.heartbeat)
    this.options.onClose()
    if (!this.leaseLost) {
      await this.options.client.query(
        `DELETE FROM ${leasesTable(this.options.schema)} WHERE unit = $1 AND holder = $2`,
        [this.options.descriptor.name, this.options.holder],
      /* v8 ignore next -- cleanup remains best effort; closing the session releases the advisory lock. */
      ).catch(() => undefined)
      /* v8 ignore next -- cleanup remains best effort; closing the session releases the advisory lock. */
      await this.options.client.query('SELECT pg_advisory_unlock(hashtext($1))', [this.lockName()]).catch(() => undefined)
    }
    /* v8 ignore next -- close is idempotent and connection loss is already represented by leaseLost. */
    await this.options.client.end().catch(() => undefined)
  }

  private ensureOpen(): void {
    if (this.leaseLost) throw new StudioStorageError(`writer lock for kv unit '${this.options.descriptor.name}' was lost`)
    if (this.closed) throw new StorageError('closed', `kv unit '${this.options.descriptor.name}' is closed`)
  }

  private assertTable(table: string): void {
    if (!this.tables.has(table)) throw new Error(`kv unit '${this.options.descriptor.name}' declared no table '${table}'`)
  }

  private markLeaseLost(_cause: unknown): void {
    this.leaseLost = true
    clearInterval(this.heartbeat)
  }

  private operationFailure(error: unknown): Error {
    if (this.leaseLost || isConnectionFailure(error)) {
      this.markLeaseLost(error)
      return new StudioStorageError(`writer lock for kv unit '${this.options.descriptor.name}' was lost`, { cause: error })
    }
    return error instanceof Error ? error : new Error(String(error))
  }

  private lockName(): string {
    return `dz23-storage-unit:${this.options.schema}:${this.options.descriptor.name}`
  }
}

function encodeJson(value: unknown): string {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new TypeError('postgres kv values must be JSON-serializable')
  return encoded
}

const CONNECTION_FAILURE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', '57P01', '57P02', '57P03'])

function isConnectionFailure(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code !== undefined && CONNECTION_FAILURE_CODES.has(code)
}
