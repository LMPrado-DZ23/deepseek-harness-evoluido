import { Client } from 'pg'
import { StorageError } from '@deepseek-ai/dsh-storage'
import type { KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { compareUtf8, descriptorFingerprint, exportedDomain, sealBundle, sha256, type ExportedDomain, type StorageExportBundle } from './bundle.js'
import { withoutTlsParams } from './dsn.js'
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

export interface UnitRow { name: string; version: number; tables: string[] | null; has_global: boolean | null; descriptor_sha256: string | null }
export interface RecordRow { unit: string; table_name: string; key: string; value: unknown }
export interface GlobalRow { unit: string; value: unknown }

/**
 * Hot logical snapshot of every Studio unit in one REPEATABLE READ, READ ONLY
 * transaction. It never takes the unit writer lock, so it runs while the
 * Studio is serving requests; the running writer keeps its lease and the
 * snapshot is a consistent point-in-time view of the whole schema.
 */
export async function snapshotPostgresStorage(options: SnapshotOptions): Promise<StorageExportBundle> {
  assertConfiguredSchemaName(options.schema)
  // The `ssl` option is the authority; the DSN's own ssl parameters are stripped so
  // `pg` cannot let the string override it (it merges the parsed string OVER the option).
  const client = new Client({ connectionString: withoutTlsParams(options.connectionString), ssl: options.ssl, application_name: `dz23-storage:snapshot:${options.schema}` })
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
    const units = await client.query<UnitRow>(`SELECT name, version, tables, has_global, descriptor_sha256 FROM ${unitsTable(options.schema)}`)
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

/**
 * The descriptor of each unit, from the DECLARATION stamped on the medium when
 * the unit was opened, widened by whatever the rows actually show.
 *
 * Inference alone lost every declared-but-empty table and every `hasGlobal`
 * that had not been written yet, so a restore came back with a narrower shape
 * than the product declares. The stored declaration fixes that; the union with
 * the observed tables makes sure no stored row is ever left undeclared, and a
 * row written by an older build (no declaration stored) still degrades to pure
 * inference instead of failing.
 */
export function deriveDescriptors(units: readonly UnitRow[], records: readonly RecordRow[], globals: readonly GlobalRow[]): KvUnitDescriptor[] {
  const tablesByUnit = new Map<string, Set<string>>()
  for (const row of records) {
    const set = tablesByUnit.get(row.unit) ?? new Set<string>()
    set.add(row.table_name)
    tablesByUnit.set(row.unit, set)
  }
  const withGlobal = new Set(globals.map(row => row.unit))
  // Byte order here too: the domain order is part of the sealed payload.
  return [...units].sort((left, right) => compareUtf8(left.name, right.name)).map(unit => storedDescriptor(unit, tablesByUnit.get(unit.name), withGlobal.has(unit.name)))
}

/** One unit's descriptor: the stamped declaration checked against its fingerprint, widened by what is on the medium. */
export function storedDescriptor(unit: UnitRow, observedTables: ReadonlySet<string> | undefined, observedGlobal: boolean): KvUnitDescriptor {
  const declared = unit.tables ?? null
  if (declared !== null && (!Array.isArray(declared) || declared.some(table => typeof table !== 'string'))) {
    throw new StorageError('malformed-medium', `kv unit '${unit.name}' has a malformed declared table list on the medium`)
  }
  const stored: KvUnitDescriptor = {
    name: unit.name,
    version: unit.version,
    tables: [...(declared ?? [])].sort(compareUtf8),
    hasGlobal: unit.has_global ?? false,
  }
  // A stored declaration must match the fingerprint written with it: a hand-edited
  // `units` row must not be able to redefine a unit's shape behind the product's back.
  if (unit.descriptor_sha256 !== null && descriptorFingerprint(stored) !== unit.descriptor_sha256) {
    throw new StorageError('malformed-medium', `kv unit '${unit.name}' has a declared shape that does not match its stored fingerprint`)
  }
  const tables = new Set(stored.tables)
  for (const table of observedTables ?? []) tables.add(table)
  return { name: unit.name, version: unit.version, tables: [...tables].sort(compareUtf8), hasGlobal: stored.hasGlobal || observedGlobal }
}
