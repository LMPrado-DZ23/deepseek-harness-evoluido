import { randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { Client } from 'pg'
import type { StorageBackend } from '@deepseek-ai/dsh-storage'
import { PostgresStorageBackend } from './backend.js'
import { canonicalJson, sha256, type StorageExportBundle } from './bundle.js'
import { postgresClientConnection, type PostgresClientConnection, type TlsPolicy } from './dsn.js'
import { readStorageBundleFile } from './import-file.js'
import { assertDomainLossAllowed, assertReplacementAllowed, assertRestorableBundle, assertRestoreIntent, postgresDumpInvocation } from './restore-policy.js'
import { assertPinnedDirectory, openNewPinnedFile, pinnedChildPath, pinParent } from './safe-path.js'
import { assertConfiguredSchemaName, assertIdentifier, quoteIdentifier, STORAGE_POSTGRES_LAYOUT_VERSION, storageMaintenanceLockName, storageUnitLockName } from './schema.js'

/**
 * Table this tool writes inside every staging schema it creates, in the same
 * transaction that creates the schema. It is the ONLY thing that authorises the
 * orphan sweep to drop a schema: a name that merely looks like ours is not
 * enough, and a `LIKE` pattern whose `_` was never escaped made "looks like
 * ours" wider still.
 */
const STAGING_MARKER_TABLE = 'dz23_import_staging'
const STAGING_MARKER_TOOL = 'dz23-studio/import-postgres-storage'

const STUDIO_LAYOUT: Readonly<Record<string, readonly string[]>> = {
  storage_meta: ['key', 'value'],
  units: ['name', 'version'],
  records: ['unit', 'table_name', 'key', 'value'],
  unit_globals: ['unit', 'value'],
  unit_leases: ['unit', 'holder', 'acquired_at', 'heartbeat_at'],
}

export interface RestorePostgresOptions {
  input: string
  dsn: string
  schema?: string
  ssl?: TlsPolicy
  write?: boolean
  safetyBackup?: string
  force?: boolean
  allowDomainLoss?: boolean
  confirmation?: string
  signal?: AbortSignal
  environment?: NodeJS.ProcessEnv
}

export interface RestoreInspectionReport {
  mode: 'dry-run'
  domains: number
  existingUnits: number
  targetDomains: string[]
  wouldBeLost: string[]
  targetSchemaExists: boolean
  targetHasContent: boolean
}

export interface RestoreWriteReport {
  mode: 'write'
  domains: number
  safetyBackup: string | null
  safetyBackupStatus: 'created' | 'not-needed-empty-target'
  replacedDomains: string[]
  droppedDomains: string[]
  reapedStaging: string[]
  readyToStart: true
}

export type RestorePostgresReport = RestoreInspectionReport | RestoreWriteReport

export interface PostgresStorageStatus {
  reachable: true
  serverVersion: string
  schema: string
  schemaExists: boolean
  ready: boolean
  layoutVersion: number | null
  domains: number
}

export interface RestorePostgresDependencies {
  readBundle?: typeof readStorageBundleFile
  resolveConnection?: typeof postgresClientConnection
  createClient?: (connection: PostgresClientConnection) => Client
  createBackend?: (connection: PostgresClientConnection, schema: string) => RestorableBackend
  createSafetyBackup?: (dsn: string, schema: string, output: string, ssl: TlsPolicy, environment: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<string>
  now?: () => number
  suffix?: () => string
}

export interface RestorableBackend extends StorageBackend {
  waitUntilReady(): Promise<void>
  close(): Promise<void>
}

/**
 * Inspect or restore one logical Studio backup. The caller must keep every
 * Studio writer stopped until this function returns `readyToStart: true`.
 * It never starts a writer itself.
 */
export async function restorePostgresStorage(
  options: RestorePostgresOptions,
  dependencies: RestorePostgresDependencies = {},
): Promise<RestorePostgresReport> {
  const schema = options.schema ?? 'dz23_storage'
  const ssl = options.ssl ?? 'verify-full'
  const write = options.write ?? false
  assertConfiguredSchemaName(schema)
  assertRestoreIntent(write, options.safetyBackup)
  throwIfAborted(options.signal)
  const readBundle = dependencies.readBundle ?? readStorageBundleFile
  const bundle = await readBundle(resolve(options.input))
  // A bundle with no domains restores nothing: it can only ever destroy. Refused before the database is even opened.
  assertRestorableBundle(bundle)
  throwIfAborted(options.signal)
  // One authority for TLS: the explicit policy decides, and every TLS parameter
  // in the DSN is stripped before node-postgres sees it.
  const resolveConnection = dependencies.resolveConnection ?? postgresClientConnection
  const connection = await resolveConnection(options.dsn, ssl)
  const client = (dependencies.createClient ?? (value => new Client(value)))(connection)
  await client.connect()
  let staging: string | undefined
  try {
    // Order matters: everything that can refuse runs BEFORE pg_dump, staging or DROP.
    if (write) await acquireMaintenanceLock(client, schema)
    const namespace = await client.query<{ present: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1) AS present',
      [schema],
    )
    const targetSchemaExists = namespace.rows[0]?.present === true
  // Everything in the target schema, not only a table named `units`: the check that decides whether
  // a `DROP SCHEMA` is allowed must not be gated on the very structure it is meant to verify — a
  // schema whose `units` is a VIEW, or which belongs to something else entirely, used to walk
  // straight through both guards below.
  // ANY object, not only relations: `pg_class` does not hold functions, types, domains, operators
  // or collations, so a schema belonging to another product that has only those looked EMPTY —
  // and an empty target skips the layout check and the confirmation, straight into DROP SCHEMA.
  // Hand-listing catalogues was still a partial list (`pg_ts_config`, `pg_ts_dict`, `pg_conversion`,
  // `pg_opclass`, `pg_extension`, ... were all missing), so the list is DERIVED from the catalogue.
    const targetHasContent = targetSchemaExists && await schemaHasContent(client, schema)
    let existingUnits = 0
    let targetDomains: string[] = []
    if (targetHasContent) {
      await assertStudioLayout(client, schema)
      const result = await client.query<{ name: string }>(`SELECT name FROM ${quoteIdentifier(schema)}."units" ORDER BY name COLLATE "C"`)
      targetDomains = result.rows.map(row => row.name)
      existingUnits = targetDomains.length
    }
    // Anything already in the schema — units, zero units but other tables, anything — needs the
    // spoken confirmation before it is replaced.
    assertReplacementAllowed(targetHasContent, options.force === true, options.confirmation)
    // A bundle that does not carry every domain the target holds would silently DESTROY the missing ones.
    const bundleDomains = new Set(bundle.domains.map(domain => domain.descriptor.name))
    const wouldBeLost = targetDomains.filter(name => !bundleDomains.has(name))
    assertDomainLossAllowed(wouldBeLost, options.allowDomainLoss === true, options.confirmation)
    if (!write) {
      return { mode: 'dry-run', domains: bundle.domains.length, existingUnits, targetDomains, wouldBeLost, targetSchemaExists, targetHasContent }
    }

    throwIfAborted(options.signal)
    const backupPath = resolve(options.safetyBackup!)
    let safetyBackup: string | null = null
    let safetyBackupStatus: RestoreWriteReport['safetyBackupStatus'] = 'not-needed-empty-target'
    if (targetSchemaExists) {
      const createSafetyBackup = dependencies.createSafetyBackup ?? createPostgresSafetyBackup
      safetyBackup = await createSafetyBackup(options.dsn, schema, backupPath, ssl, options.environment ?? process.env, options.signal)
      safetyBackupStatus = 'created'
    }
    throwIfAborted(options.signal)
    // A run killed with SIGKILL leaves a full copy of the data in its staging schema, which nothing
    // would ever reap. Under the exclusive maintenance lock nobody else can own one, so the old ones
    // go now — before another copy is made.
    const orphans = await reapStagingSchemas(client, schema)
    staging = `${schema}_staging_${(dependencies.now ?? Date.now)().toString(36)}${(dependencies.suffix ?? (() => randomBytes(2).toString('hex')))()}`
    assertIdentifier(staging, 'staging schema')
    // Created here, with its ownership marker, in ONE transaction: a staging schema that
    // exists but carries no marker can never happen, so the sweep above never has to guess.
    await client.query('BEGIN')
    try {
      await client.query(`CREATE SCHEMA ${quoteIdentifier(staging)}`)
      await client.query(`CREATE TABLE ${quoteIdentifier(staging)}.${quoteIdentifier(STAGING_MARKER_TABLE)} (
        tool TEXT NOT NULL, target_schema TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL
      )`)
      await client.query(
        `INSERT INTO ${quoteIdentifier(staging)}.${quoteIdentifier(STAGING_MARKER_TABLE)} (tool, target_schema, created_at) VALUES ($1, $2, now())`,
        [STAGING_MARKER_TOOL, schema],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
    throwIfAborted(options.signal)
    const backend = (dependencies.createBackend ?? ((value, targetSchema) => new PostgresStorageBackend({ ...value, schema: targetSchema, poolMax: 4 })))(connection, staging)
    try {
      await backend.waitUntilReady()
      await importStorage(backend, bundle, options.signal)
      throwIfAborted(options.signal)
      await client.query('BEGIN')
      try {
        // The marker authorises orphan cleanup only. It is not part of the
        // restored product schema and must disappear before the atomic swap.
        await client.query(`DROP TABLE ${quoteIdentifier(staging)}.${quoteIdentifier(STAGING_MARKER_TABLE)}`)
        await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`)
        await client.query(`ALTER SCHEMA ${quoteIdentifier(staging)} RENAME TO ${quoteIdentifier(schema)}`)
        // Readiness is proved inside the same transaction as the swap. If it
        // fails, ROLLBACK restores the old target and the catch below removes
        // the still-named staging schema. Writers remain stopped throughout.
        await assertStudioLayout(client, schema)
        const restored = await client.query<{ name: string }>(`SELECT name FROM ${quoteIdentifier(schema)}."units" ORDER BY name COLLATE "C"`)
        const expected = [...bundleDomains].sort()
        if (restored.rows.map(row => row.name).join('\0') !== expected.join('\0')) {
          throw new Error('O esquema restaurado não contém exatamente os domínios da cópia. Troca cancelada.')
        }
        await client.query('COMMIT')
        staging = undefined
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    } catch (error) {
      // Any failure leaves nothing behind: the half-filled staging schema is dropped before the error surfaces.
      await backend.close().catch(() => undefined)
      if (staging !== undefined) await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(staging)} CASCADE`).catch(() => undefined)
      throw error
    }
    return {
      mode: 'write', domains: bundle.domains.length, safetyBackup, safetyBackupStatus,
      replacedDomains: targetDomains, droppedDomains: wouldBeLost, reapedStaging: orphans, readyToStart: true,
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock_all()').catch(() => undefined)
    await client.end()
  }
}

/** Read-only operator health. No connection material is ever returned. */
export async function postgresStorageStatus(
  options: Pick<RestorePostgresOptions, 'dsn' | 'schema' | 'ssl'>,
  dependencies: Pick<RestorePostgresDependencies, 'resolveConnection' | 'createClient'> = {},
): Promise<PostgresStorageStatus> {
  const schema = options.schema ?? 'dz23_storage'
  const ssl = options.ssl ?? 'verify-full'
  assertConfiguredSchemaName(schema)
  const resolveConnection = dependencies.resolveConnection ?? postgresClientConnection
  const connection = await resolveConnection(options.dsn, ssl)
  const client = (dependencies.createClient ?? (value => new Client(value)))(connection)
  await client.connect()
  try {
    const version = await client.query<{ server_version: string }>('SHOW server_version')
    const namespace = await client.query<{ present: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1) AS present', [schema],
    )
    if (namespace.rows[0]?.present !== true) {
      return { reachable: true, serverVersion: version.rows[0]?.server_version ?? 'unknown', schema, schemaExists: false, ready: false, layoutVersion: null, domains: 0 }
    }
    await assertStudioLayout(client, schema)
    const layout = await client.query<{ value: number }>(
      `SELECT value FROM ${quoteIdentifier(schema)}."storage_meta" WHERE key = 'layout_version'`,
    )
    const domains = await client.query<{ count: string }>(`SELECT count(*) FROM ${quoteIdentifier(schema)}."units"`)
    return {
      reachable: true, serverVersion: version.rows[0]?.server_version ?? 'unknown', schema,
      schemaExists: true, ready: true, layoutVersion: layout.rows[0]?.value ?? null,
      domains: Number(domains.rows[0]?.count ?? 0),
    }
  } finally {
    await client.end()
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason instanceof Error ? signal.reason : new Error('Operação cancelada.')
}

async function importStorage(backend: StorageBackend, bundle: StorageExportBundle, signal: AbortSignal | undefined): Promise<void> {
  if (backend.kv === undefined) throw new Error('target backend has no KV facet')
  try {
    for (const domain of bundle.domains) {
      throwIfAborted(signal)
      const unit = await backend.kv.open(domain.descriptor)
      try {
        const empty = await unit.loadAll()
        if (Object.values(empty.tables).some(table => Object.keys(table as Record<string, unknown>).length > 0) || empty.global !== null) {
          throw new Error(`target unit '${domain.descriptor.name}' is not empty`)
        }
        for (const [table, records] of Object.entries(domain.snapshot.tables)) {
          for (const [key, value] of Object.entries(records)) {
            throwIfAborted(signal)
            await unit.putRecord(table, key, value)
          }
        }
        if (domain.descriptor.hasGlobal && domain.snapshot.global !== null) await unit.setGlobal(domain.snapshot.global)
        const restored = await unit.loadAll()
        if (sha256(canonicalJson({ descriptor: domain.descriptor, snapshot: restored })) !== domain.sha256) {
          throw new Error(`checksum mismatch after importing '${domain.descriptor.name}'`)
        }
      } finally {
        await unit.close()
      }
    }
  } finally {
    await backend.close()
  }
}

/**
 * Exclusive maintenance lock over the WHOLE schema. A running Studio holds it
 * shared, so this fails while any Studio is up — including one whose open
 * units are not mentioned in the bundle, which is exactly the case a per-unit
 * lock used to let through straight into `DROP SCHEMA`. The per-unit locks are
 * still taken afterwards, as a second belt for a foreign writer that predates
 * the maintenance lock.
 */
async function acquireMaintenanceLock(client: Client, schema: string): Promise<void> {
  const result = await client.query<{ acquired: boolean }>(
    'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
    [storageMaintenanceLockName(schema)],
  )
  if (result.rows[0]?.acquired !== true) {
    throw new Error('O DZ23 STUDIO ainda está em execução no servidor. Pare-o antes de importar.')
  }
  const hasUnits = await client.query<{ count: string }>(
    `SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = $1 AND tablename = 'units'`,
    [schema],
  )
  const units = hasUnits.rows[0]?.count === '0'
    ? { rows: [] as { name: string }[] }
    : await client.query<{ name: string }>(`SELECT name FROM ${quoteIdentifier(schema)}."units"`)
  for (const row of units.rows) {
    const unit = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
      [storageUnitLockName(schema, row.name)],
    )
    if (unit.rows[0]?.acquired !== true) {
      throw new Error('O DZ23 STUDIO ainda está em execução no servidor. Pare-o antes de importar.')
    }
  }
}

/** A schema that has a `units` table but not the rest of the layout is not a Studio schema: refuse instead of dropping it. */

async function assertStudioLayout(client: Client, schema: string): Promise<void> {
  const expected = Object.keys(STUDIO_LAYOUT)
  // Real tables only (`relkind = 'r'`): a VIEW named `units` is not this Studio's storage.
  const found = await client.query<{ relname: string }>(
    `SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relname = ANY($2)`,
    [schema, expected],
  )
  const names = new Set(found.rows.map(row => row.relname))
  const missing = expected.filter(table => !names.has(table))
  if (missing.length > 0) {
    throw new Error(`O esquema '${schema}' não tem a estrutura do DZ23 STUDIO (faltam: ${missing.join(', ')}). Importação recusada para não apagar dados de outra coisa.`)
  }
  // Columns too: a table with the right name and the wrong shape is not the right table.
  const columns = await client.query<{ relname: string; attname: string }>(
    `SELECT c.relname, a.attname FROM pg_catalog.pg_attribute a
     JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relname = ANY($2) AND a.attnum > 0 AND NOT a.attisdropped`,
    [schema, expected],
  )
  const byTable = new Map<string, Set<string>>()
  for (const row of columns.rows) {
    const set = byTable.get(row.relname) ?? new Set<string>()
    set.add(row.attname)
    byTable.set(row.relname, set)
  }
  for (const [table, required] of Object.entries(STUDIO_LAYOUT)) {
    const present = byTable.get(table) ?? new Set<string>()
    const absent = required.filter(column => !present.has(column))
    if (absent.length > 0) {
      throw new Error(`A tabela '${table}' do esquema '${schema}' não tem a forma do DZ23 STUDIO (faltam colunas: ${absent.join(', ')}). Importação recusada.`)
    }
  }
  const layout = await client.query<{ value: number }>(
    `SELECT value FROM ${quoteIdentifier(schema)}."storage_meta" WHERE key = 'layout_version'`,
  )
  if (layout.rows[0] === undefined) {
    throw new Error(`O esquema '${schema}' não registra a versão do armazenamento. Importação recusada.`)
  }
  if (layout.rows[0].value !== STORAGE_POSTGRES_LAYOUT_VERSION) {
    throw new Error(`O esquema '${schema}' está na versão ${String(layout.rows[0].value)} do armazenamento e esta versão do Studio usa a ${String(STORAGE_POSTGRES_LAYOUT_VERSION)}. Importação recusada.`)
  }
}

export async function createPostgresSafetyBackup(
  dsn: string,
  schema: string,
  output: string,
  ssl: TlsPolicy,
  environment: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<string> {
  // The connection string is handed over almost whole — decomposing it into host/port/user
  // dropped every other libpq parameter the operator had set (`hostaddr`, `options`, ...), so
  // the dump could reach a different endpoint than the import it is protecting. What IS taken
  // out of it: the password and every TLS parameter. A command line is readable by every user
  // on the machine (`ps -ef`), so the password travels in the child's environment, and the TLS
  // policy is re-supplied there too, where the stripped URI can no longer contradict it.
  const invocation = postgresDumpInvocation(dsn, schema, ssl, environment)
  const parent = await pinParent(output, true)
  let destination: FileHandle
  try {
    destination = await openNewPinnedFile(parent.directory, parent.name)
  } catch (error) {
    await parent.directory.handle.close().catch(() => undefined)
    if ((error as { code?: string }).code === 'EEXIST') {
      throw new Error(`Já existe um arquivo em ${output} (provavelmente de uma tentativa anterior). Escolha outro caminho para --backup ou mova esse arquivo antes de repetir.`)
    }
    throw error
  }
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(invocation.command, invocation.args, {
        env: invocation.environment, stdio: ['ignore', destination.fd, 'ignore'], ...(signal === undefined ? {} : { signal }),
      })
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error(`pg_dump failed with code ${String(code)}`)))
    })
    await assertPinnedDirectory(parent.directory)
  } catch (error) {
    await destination.close()
    await assertPinnedDirectory(parent.directory)
    await rm(pinnedChildPath(parent.directory, parent.name), { force: true })
    throw error
  } finally {
    await parent.directory.handle.close().catch(() => undefined)
  }
  await destination.close()
  return resolve(output)
}

export { postgresDumpInvocation } from './restore-policy.js'

/**
 * Does the schema hold ANYTHING? The answer decides whether `DROP SCHEMA` may
 * run without the spoken confirmation, so a partial answer is a data-loss bug:
 * a schema holding only a TEXT SEARCH CONFIGURATION, a conversion, an operator
 * class or an extension looked empty to a hand-written list of catalogues.
 *
 * So the catalogues are not hand-written: every `pg_catalog` table with an
 * `oid` column named `*namespace` IS, by definition, a catalogue whose rows
 * belong to a schema. Their names come from the catalogue itself and are still
 * checked against a strict identifier pattern before being interpolated.
 */
async function schemaHasContent(client: Client, schema: string): Promise<boolean> {
  const catalogs = await client.query<{ relname: string; attname: string }>(
    `SELECT c.relname, a.attname
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
      WHERE n.nspname = 'pg_catalog' AND c.relkind = 'r'
        AND a.attnum > 0 AND NOT a.attisdropped
        AND a.atttypid = 'oid'::regtype AND a.attname LIKE '%namespace'`,
  )
  if (catalogs.rows.length === 0) {
    throw new Error('Não foi possível inspecionar o catálogo do PostgreSQL para saber se o esquema de destino está vazio. Importação recusada.')
  }
  const safe = /^[a-z][a-z0-9_]*$/u
  const clauses = catalogs.rows.map(row => {
    if (!safe.test(row.relname) || !safe.test(row.attname)) {
      throw new Error(`Nome inesperado no catálogo do PostgreSQL ('${row.relname}.${row.attname}'). Importação recusada.`)
    }
    return `EXISTS (SELECT 1 FROM pg_catalog."${row.relname}" WHERE "${row.attname}" = target.oid)`
  })
  const present = await client.query<{ present: boolean }>(
    `SELECT COALESCE((SELECT ${clauses.join(' OR ')} FROM pg_catalog.pg_namespace target WHERE target.nspname = $1), false) AS present`,
    [schema],
  )
  return present.rows[0]?.present === true
}

/**
 * Drop the staging schemas THIS tool left behind for THIS target, and nothing
 * else. Two independent conditions, both required:
 *
 *  - the name is exactly `<schema>_staging_<suffix>` — matched by a regular
 *    expression here, not by a `LIKE` whose unescaped `_` is a wildcard: with
 *    `dz23_storage_staging_%`, the pattern also matched a foreign
 *    `dz23xstorage_staging_...`, and that was dropped with CASCADE;
 *  - the schema carries the marker table this tool writes when it creates one,
 *    naming this tool and this exact target schema.
 */
async function reapStagingSchemas(client: Client, schema: string): Promise<string[]> {
  const escaped = `${schema.replaceAll('\\', '\\\\').replaceAll('_', '\\_').replaceAll('%', '\\%')}\\_staging\\_%`
  const candidates = await client.query<{ nspname: string }>(
    `SELECT n.nspname FROM pg_catalog.pg_namespace n WHERE n.nspname LIKE $1 ESCAPE '\\'`,
    [escaped],
  )
  const shape = new RegExp(`^${schema.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')}_staging_[a-z0-9]+$`, 'u')
  const reaped: string[] = []
  for (const candidate of candidates.rows) {
    if (!shape.test(candidate.nspname)) continue
    assertIdentifier(candidate.nspname, 'staging schema')
    const marker = await client.query<{ tool: string; target_schema: string }>(
      `SELECT m.tool, m.target_schema FROM ${quoteIdentifier(candidate.nspname)}.${quoteIdentifier(STAGING_MARKER_TABLE)} m
        WHERE m.tool = $1 AND m.target_schema = $2`,
      [STAGING_MARKER_TOOL, schema],
    ).catch(() => ({ rows: [] as { tool: string; target_schema: string }[] }))
    if (marker.rows.length === 0) continue
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(candidate.nspname)} CASCADE`)
    reaped.push(candidate.nspname)
  }
  return reaped
}
