import { Client } from 'pg'
import { StorageError } from '@deepseek-ai/dsh-storage'
import type { KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { compareUtf8, DEFAULT_STORAGE_BUNDLE_LIMITS, descriptorFingerprint, exportedDomain, sealBundle, sha256, type ExportedDomain, type StorageExportBundle } from './bundle.js'
import { withoutTlsParams } from './dsn.js'
import { assertConfiguredSchemaName, globalsTable, INSTALLATION_ID_KEY, quoteIdentifier, recordsTable, STORAGE_POSTGRES_LAYOUT_VERSION, unitsTable } from './schema.js'

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
  /** Diagnostic snapshots are bounded; large production backups use backup-worker's cursors. */
  maxDomains?: number
  maxRecords?: number
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
  for (const [name, limit] of [['maxDomains', options.maxDomains], ['maxRecords', options.maxRecords]] as const) {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit === Number.MAX_SAFE_INTEGER)) {
      throw new Error(`${name} must be a positive bounded safe integer`)
    }
  }
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
    const installation = await readInstallation(client, options.schema)
    const maxDomains = options.maxDomains ?? DEFAULT_STORAGE_BUNDLE_LIMITS.maxDomains
    const maxRecords = options.maxRecords ?? DEFAULT_STORAGE_BUNDLE_LIMITS.maxRecords
    const units = await client.query<UnitRow>(
      `SELECT ${await unitsProjection(client, options.schema)} FROM ${unitsTable(options.schema)} ORDER BY name COLLATE "C" LIMIT $1`,
      [maxDomains + 1],
    )
    if (units.rows.length > maxDomains) throw new Error(`postgres diagnostic snapshot exceeds the ${String(maxDomains)} domain limit; use the streaming backup worker`)
    const records = await client.query<RecordRow>(
      `SELECT unit, table_name, key, value FROM ${recordsTable(options.schema)} ORDER BY unit, table_name, key LIMIT $1`,
      [maxRecords + 1],
    )
    if (records.rows.length > maxRecords) throw new Error(`postgres diagnostic snapshot exceeds the ${String(maxRecords)} record limit; use the streaming backup worker`)
    const globals = await client.query<GlobalRow>(
      `SELECT unit, value FROM ${globalsTable(options.schema)} ORDER BY unit COLLATE "C" LIMIT $1`,
      [maxDomains + 1],
    )
    if (globals.rows.length > maxDomains) throw new Error(`postgres diagnostic snapshot exceeds the ${String(maxDomains)} global limit; use the streaming backup worker`)
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
    return sealBundle({ kind: 'postgres', sha256: sha256(`${options.schema}\0${marker.rows[0]!.snapshot}`) }, domains, createdAt, installation)
  } catch (error) {
    /* v8 ignore next -- rollback failure cannot supersede the snapshot error. */
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }
}

/** Read the logical installation identity without aborting a snapshot of an older schema. */
export async function readInstallation(client: Client, schema: string): Promise<string | undefined> {
  const column = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = 'storage_meta' AND a.attname = 'text_value'
        AND a.attnum > 0 AND NOT a.attisdropped`,
    [schema],
  )
  if ((column.rows[0]?.n ?? 0) === 0) return undefined
  const rows = await client.query<{ text_value: string | null }>(
    `SELECT text_value FROM ${quoteIdentifier(schema)}."storage_meta" WHERE key = $1`,
    [INSTALLATION_ID_KEY],
  )
  const value = rows.rows[0]?.text_value
  return value === undefined || value === null || value === '' ? undefined : value
}

const UNIT_OPTIONAL_COLUMNS: Readonly<Record<string, string>> = {
  tables: 'NULL::jsonb',
  has_global: 'NULL::boolean',
  descriptor_sha256: 'NULL::text',
}

/** Build a read-only projection that also works before additive columns existed. */
export async function unitsProjection(client: Client, schema: string): Promise<string> {
  const names = Object.keys(UNIT_OPTIONAL_COLUMNS)
  const present = await client.query<{ attname: string }>(
    `SELECT a.attname FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = 'units' AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attname = ANY($2)`,
    [schema, names],
  )
  const have = new Set(present.rows.map(row => row.attname))
  const optional = names.map(name => have.has(name) ? `"${name}"` : `${UNIT_OPTIONAL_COLUMNS[name]!} AS "${name}"`)
  return ['"name"', '"version"', ...optional].join(', ')
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
  const declares = declared !== null || unit.has_global !== null
  if (declares && unit.descriptor_sha256 === null) {
    throw new StorageError('malformed-medium', `kv unit '${unit.name}' declares a shape on the medium with no fingerprint next to it`)
  }
  if (unit.descriptor_sha256 !== null && descriptorFingerprint(stored) !== unit.descriptor_sha256) {
    throw new StorageError('malformed-medium', `kv unit '${unit.name}' has a declared shape that does not match its stored fingerprint`)
  }
  const tables = new Set(stored.tables)
  for (const table of observedTables ?? []) tables.add(table)
  return { name: unit.name, version: unit.version, tables: [...tables].sort(compareUtf8), hasGlobal: stored.hasGlobal || observedGlobal }
}
