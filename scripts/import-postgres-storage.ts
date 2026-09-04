import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { Client } from 'pg'
import { PostgresStorageBackend } from '../plugins/storage-postgres/src/backend.ts'
import { assertTlsPolicy, postgresClientConnection, postgresToolConnection, type TlsPolicy } from '../plugins/storage-postgres/src/dsn.ts'
import { assertConfiguredSchemaName, assertIdentifier, quoteIdentifier, STORAGE_POSTGRES_LAYOUT_VERSION, storageMaintenanceLockName, storageUnitLockName } from '../plugins/storage-postgres/src/schema.ts'
import { importStorage, type StorageExportBundle, validateBundle } from './storage-migration.ts'

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

const args = parseArgs(process.argv.slice(2))
assertConfiguredSchemaName(args.schema)
if (args.write && args.backup === undefined) throw new Error('--backup is mandatory with --write')
const dsn = process.env[args.dsnRef]
if (dsn === undefined || dsn === '') throw new Error(`Credential reference '${args.dsnRef}' is not configured.`)
const bundle = JSON.parse(await readFile(resolve(args.input), 'utf8')) as StorageExportBundle
validateBundle(bundle)
// A bundle with no domains restores nothing: it can only ever destroy. Refused before the database is even opened.
if (!Array.isArray(bundle.domains) || bundle.domains.length === 0) {
  throw new Error('O arquivo de cópia não contém nenhum domínio. Nada seria restaurado — só apagado. Importação recusada.')
}
// One authority for TLS: the policy from --ssl decides, and every ssl parameter the
// DSN carries is stripped, because `pg` merges the parsed connection string OVER the
// explicit `ssl` option — a DSN saying `sslmode=disable` used to defeat --ssl verify-full.
const connection = await postgresClientConnection(dsn, args.ssl)
const client = new Client(connection)
await client.connect()
try {
  // Order matters: everything that can refuse runs BEFORE pg_dump, staging or DROP.
  if (args.write) await acquireMaintenanceLock(client, args.schema)
  const namespace = await client.query<{ present: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1) AS present',
    [args.schema],
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
  const targetHasContent = targetSchemaExists && await schemaHasContent(client, args.schema)
  let existingUnits = 0
  let targetDomains: string[] = []
  if (targetHasContent) {
    await assertStudioLayout(client, args.schema)
    const result = await client.query<{ name: string }>(`SELECT name FROM ${quoteIdentifier(args.schema)}."units" ORDER BY name COLLATE "C"`)
    targetDomains = result.rows.map(row => row.name)
    existingUnits = targetDomains.length
  }
  // Anything already in the schema — units, zero units but other tables, anything — needs the
  // spoken confirmation before it is replaced.
  if (targetHasContent && !(args.force && args.confirm === 'REPLACE_DZ23_STORAGE')) {
    throw new Error('O esquema de destino já tem conteúdo. Use --force --confirm REPLACE_DZ23_STORAGE só depois de conferir a cópia de segurança.')
  }
  // A bundle that does not carry every domain the target holds would silently DESTROY the missing ones.
  const bundleDomains = new Set(bundle.domains.map(domain => domain.descriptor.name))
  const wouldBeLost = targetDomains.filter(name => !bundleDomains.has(name))
  if (wouldBeLost.length > 0 && !(args.allowDomainLoss && args.confirm === 'REPLACE_DZ23_STORAGE')) {
    throw new Error(`Esta cópia não contém ${String(wouldBeLost.length)} conjunto(s) de dados que existem no destino (${wouldBeLost.join(', ')}). Restaurar assim apagaria esses dados. Importação recusada. Se for mesmo isso que você quer, repita com --allow-domain-loss --confirm REPLACE_DZ23_STORAGE.`)
  }
  if (!args.write) {
    process.stdout.write(`${JSON.stringify({ mode: 'dry-run', domains: bundle.domains.length, existingUnits, targetDomains, wouldBeLost, targetSchemaExists, targetHasContent }, null, 2)}\n`)
    process.exitCode = 0
  } else {
    const backupPath = resolve(args.backup!)
    let backup: string | null = null
    let backupStatus = 'not-needed-empty-target'
    if (targetSchemaExists) {
      await mkdir(dirname(backupPath), { recursive: true })
      await pgDump(dsn, args.schema, backupPath, args.ssl)
      backup = backupPath
      backupStatus = 'created'
    }
    // A run killed with SIGKILL leaves a full copy of the data in its staging schema, which nothing
    // would ever reap. Under the exclusive maintenance lock nobody else can own one, so the old ones
    // go now — before another copy is made.
    const orphans = await reapStagingSchemas(client, args.schema)
    const staging = `${args.schema}_staging_${Date.now().toString(36)}${randomBytes(2).toString('hex')}`
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
        [STAGING_MARKER_TOOL, args.schema],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
    // Ctrl+C or a `kill` in the middle of staging leaves a full copy of the data behind. A signal
    // handler drops it on the way out; a SIGKILL still cannot be caught, which is why the reaping
    // above exists as well.
    const cleanupOnSignal = (signal: NodeJS.Signals) => {
      const emergency = new Client(connection)
      emergency.connect()
        .then(() => emergency.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(staging)} CASCADE`))
        .catch(() => undefined)
        .finally(() => { void emergency.end().catch(() => undefined); process.exit(signal === 'SIGINT' ? 130 : 143) })
    }
    process.once('SIGINT', cleanupOnSignal)
    process.once('SIGTERM', cleanupOnSignal)
    const backend = new PostgresStorageBackend({ ...connection, schema: staging, poolMax: 4 })
    try {
      await backend.waitUntilReady()
      await importStorage(backend, bundle)
      await backend.close()
      await client.query('BEGIN')
      try {
        await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(args.schema)} CASCADE`)
        await client.query(`ALTER SCHEMA ${quoteIdentifier(staging)} RENAME TO ${quoteIdentifier(args.schema)}`)
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    } catch (error) {
      // Any failure leaves nothing behind: the half-filled staging schema is dropped before the error surfaces.
      await backend.close().catch(() => undefined)
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(staging)} CASCADE`).catch(() => undefined)
      throw error
    }
    process.stdout.write(`${JSON.stringify({ mode: 'write', domains: bundle.domains.length, backup, backupStatus, replacedDomains: targetDomains, droppedDomains: wouldBeLost, reapedStaging: orphans }, null, 2)}\n`)
  }
} finally {
  await client.end()
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

async function pgDump(dsn: string, schema: string, output: string, ssl: TlsPolicy): Promise<void> {
  // The connection string is handed over almost whole — decomposing it into host/port/user
  // dropped every other libpq parameter the operator had set (`hostaddr`, `options`, ...), so
  // the dump could reach a different endpoint than the import it is protecting. What IS taken
  // out of it: the password and every TLS parameter. A command line is readable by every user
  // on the machine (`ps -ef`), so the password travels in the child's environment, and the TLS
  // policy is re-supplied there too, where the stripped URI can no longer contradict it.
  const target = postgresToolConnection(dsn, ssl, process.env)
  const env = target.env
  let destination
  try {
    destination = await open(output, 'wx', 0o600)
  } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') {
      throw new Error(`Já existe um arquivo em ${output} (provavelmente de uma tentativa anterior). Escolha outro caminho para --backup ou mova esse arquivo antes de repetir.`)
    }
    throw error
  }
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn('pg_dump', [`--dbname=${target.dsn}`, `--schema=${schema}`, '--format=custom'], {
        env,
        stdio: ['ignore', destination.fd, 'inherit'],
      })
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error(`pg_dump exited with code ${String(code)}`)))
    })
  } catch (error) {
    await destination.close()
    await rm(output, { force: true })
    throw error
  }
  await destination.close()
}

function parseArgs(argv: string[]) {
  const required = (name: string) => {
    const at = argv.indexOf(name)
    if (at < 0 || argv[at + 1] === undefined) throw new Error(`Missing ${name}`)
    return argv[at + 1]!
  }
  const optional = (name: string) => {
    const at = argv.indexOf(name)
    return at < 0 ? undefined : argv[at + 1]
  }
  const ssl = assertTlsPolicy(optional('--ssl') ?? 'verify-full')
  return {
    input: required('--input'),
    dsnRef: required('--dsn-ref'),
    schema: optional('--schema') ?? 'dz23_storage',
    ssl,
    backup: optional('--backup'),
    force: argv.includes('--force'),
    allowDomainLoss: argv.includes('--allow-domain-loss'),
    confirm: optional('--confirm'),
    write: argv.includes('--write'),
  }
}

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
