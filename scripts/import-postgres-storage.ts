import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { Client } from 'pg'
import { PostgresStorageBackend } from '../plugins/storage-postgres/src/backend.ts'
import { assertConfiguredSchemaName, assertIdentifier, quoteIdentifier, STORAGE_POSTGRES_LAYOUT_VERSION, storageMaintenanceLockName, storageUnitLockName } from '../plugins/storage-postgres/src/schema.ts'
import { importStorage, type StorageExportBundle, validateBundle } from './storage-migration.ts'

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
const client = new Client({ connectionString: dsn, ssl: args.ssl === 'off' ? false : { rejectUnauthorized: args.ssl === 'verify-full' } })
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
  const relations = await client.query<{ count: string }>(
    'SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1',
    [args.schema],
  )
  const targetHasContent = targetSchemaExists && relations.rows[0]?.count !== '0'
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
    const orphans = await client.query<{ nspname: string }>(
      'SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname LIKE $1',
      [`${args.schema}_staging_%`],
    )
    for (const orphan of orphans.rows) {
      assertIdentifier(orphan.nspname, 'staging schema')
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(orphan.nspname)} CASCADE`)
    }
    const staging = `${args.schema}_staging_${Date.now().toString(36)}`
    assertIdentifier(staging, 'staging schema')
    const backend = new PostgresStorageBackend({ connectionString: dsn, schema: staging, ssl: args.ssl === 'off' ? false : { rejectUnauthorized: args.ssl === 'verify-full' }, poolMax: 4 })
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
    process.stdout.write(`${JSON.stringify({ mode: 'write', domains: bundle.domains.length, backup, backupStatus, replacedDomains: targetDomains, droppedDomains: wouldBeLost, reapedStaging: orphans.rows.map(row => row.nspname) }, null, 2)}\n`)
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
  const expected = ['storage_meta', 'units', 'records', 'unit_globals']
  const found = await client.query<{ tablename: string }>(
    'SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = $1 AND tablename = ANY($2)',
    [schema, expected],
  )
  const names = new Set(found.rows.map(row => row.tablename))
  const missing = expected.filter(table => !names.has(table))
  if (missing.length > 0) {
    throw new Error(`O esquema '${schema}' não tem a estrutura do DZ23 STUDIO (faltam: ${missing.join(', ')}). Importação recusada para não apagar dados de outra coisa.`)
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

async function pgDump(dsn: string, schema: string, output: string, ssl: 'off' | 'require' | 'verify-full'): Promise<void> {
  const url = new URL(dsn)
  const env = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    // The safety copy travels under the SAME TLS policy as the import itself:
    // it would make no sense to demand verify-full here and dump in the clear.
    PGSSLMODE: ssl === 'off' ? 'disable' : ssl === 'require' ? 'require' : 'verify-full',
  }
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
      const child = spawn('pg_dump', [`--schema=${schema}`, '--format=custom'], {
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
  const ssl = optional('--ssl') ?? 'verify-full'
  if (!['off', 'require', 'verify-full'].includes(ssl)) throw new Error('Invalid --ssl value')
  return {
    input: required('--input'),
    dsnRef: required('--dsn-ref'),
    schema: optional('--schema') ?? 'dz23_storage',
    ssl: ssl as 'off' | 'require' | 'verify-full',
    backup: optional('--backup'),
    force: argv.includes('--force'),
    allowDomainLoss: argv.includes('--allow-domain-loss'),
    confirm: optional('--confirm'),
    write: argv.includes('--write'),
  }
}
