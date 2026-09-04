import { Client } from 'pg'
import { StorageError } from '@deepseek-ai/dsh-storage'
import type { KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { exportedDomain, sealBundle, sha256, type ExportedDomain, type StorageExportBundle } from './bundle.js'
import { assertConfiguredSchemaName, globalsTable, quoteIdentifier, recordsTable, STORAGE_POSTGRES_LAYOUT_VERSION, unitsTable } from './schema.js'

export interface SnapshotOptions {
  connectionString: string
  ssl: false | { rejectUnauthorized: boolean }
  schema: string
  /**
   * Units to snapshot. When given, each stamped unit must match its declared
   * version. When omitted, descriptors are derived from the medium itself:
   * every stamped unit, with the tables actually holding records and a
   * global slot when one is stored — enough for a complete restore.
   */
  descriptors?: readonly KvUnitDescriptor[]
  now?: () => Date
}

interface UnitRow { name: string; version: number }
interface RecordRow { unit: string; table_name: string; key: string; value: unknown }
interface GlobalRow { unit: string; value: unknown }

/**
 * Hot logical snapshot of every Studio unit in one REPEATABLE READ, READ ONLY
 * transaction. It never takes the unit writer lock, so it runs while the
 * Studio is serving requests; the running writer keeps its lease and the
 * snapshot is a consistent point-in-time view of the whole schema.
 */
export async function snapshotPostgresStorage(options: SnapshotOptions): Promise<StorageExportBundle> {
  assertConfiguredSchemaName(options.schema)
  const client = new Client({ connectionString: options.connectionString, ssl: options.ssl, application_name: 'dz23-storage:snapshot' })
  await client.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const layout = await client.query<{ value: number }>(
      `SELECT value FROM ${quoteIdentifier(options.schema)}."storage_meta" WHERE key = 'layout_version'`,
    )
    if (layout.rows[0] === undefined) throw new StorageError('malformed-medium', `postgres schema '${options.schema}' has no Studio storage layout`)
    if (layout.rows[0].value !== STORAGE_POSTGRES_LAYOUT_VERSION) {
      throw new StorageError('version-mismatch', `postgres storage schema '${options.schema}' has layout version ${String(layout.rows[0].value)}, incompatible with this build (${String(STORAGE_POSTGRES_LAYOUT_VERSION)})`)
    }
    const marker = await client.query<{ snapshot: string }>('SELECT pg_current_snapshot()::text AS snapshot')
    const units = await client.query<UnitRow>(`SELECT name, version FROM ${unitsTable(options.schema)}`)
    const records = await client.query<RecordRow>(`SELECT unit, table_name, key, value FROM ${recordsTable(options.schema)} ORDER BY unit, table_name, key`)
    const globals = await client.query<GlobalRow>(`SELECT unit, value FROM ${globalsTable(options.schema)}`)
    await client.query('COMMIT')

    const stamped = new Map(units.rows.map(row => [row.name, row.version]))
    const globalByUnit = new Map(globals.rows.map(row => [row.unit, row.value]))
    const recordsByUnit = new Map<string, RecordRow[]>()
    for (const row of records.rows) {
      const list = recordsByUnit.get(row.unit) ?? []
      list.push(row)
      recordsByUnit.set(row.unit, list)
    }
    const descriptors = options.descriptors ?? deriveDescriptors(units.rows, records.rows, globals.rows)
    const domains: ExportedDomain[] = []
    for (const descriptor of descriptors) {
      const onDisk = stamped.get(descriptor.name)
      if (onDisk !== undefined && onDisk !== descriptor.version) {
        throw new StorageError(
          'version-mismatch',
          `kv unit '${descriptor.name}' is stamped version ${String(onDisk)} on the medium, incompatible with descriptor version ${String(descriptor.version)}`,
        )
      }
      const tables: Record<string, Record<string, unknown>> = {}
      for (const table of descriptor.tables) tables[table] = Object.create(null) as Record<string, unknown>
      for (const row of recordsByUnit.get(descriptor.name) ?? []) {
        if (tables[row.table_name] === undefined) {
          throw new StorageError('malformed-medium', `kv unit '${descriptor.name}' holds undeclared table '${row.table_name}'`)
        }
        tables[row.table_name]![row.key] = row.value
      }
      const global = descriptor.hasGlobal ? (globalByUnit.get(descriptor.name) ?? null) : null
      domains.push(exportedDomain(descriptor, { tables, global }))
    }
    const createdAt = (options.now ?? (() => new Date()))().toISOString()
    return sealBundle({ kind: 'postgres', sha256: sha256(`${options.schema}\0${marker.rows[0]!.snapshot}`) }, domains, createdAt)
  } catch (error) {
    /* v8 ignore next -- rollback failure cannot supersede the snapshot error. */
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }
}

function deriveDescriptors(units: readonly UnitRow[], records: readonly RecordRow[], globals: readonly GlobalRow[]): KvUnitDescriptor[] {
  const tablesByUnit = new Map<string, Set<string>>()
  for (const row of records) {
    const set = tablesByUnit.get(row.unit) ?? new Set<string>()
    set.add(row.table_name)
    tablesByUnit.set(row.unit, set)
  }
  const withGlobal = new Set(globals.map(row => row.unit))
  // Code-point order here too: the domain order is part of the sealed payload.
  return [...units].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)).map(unit => ({
    name: unit.name,
    version: unit.version,
    tables: [...(tablesByUnit.get(unit.name) ?? [])].sort(),
    hasGlobal: withGlobal.has(unit.name),
  }))
}
