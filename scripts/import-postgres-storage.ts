import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { Client } from 'pg'
import { PostgresStorageBackend } from '../plugins/storage-postgres/src/backend.ts'
import { assertIdentifier, quoteIdentifier } from '../plugins/storage-postgres/src/schema.ts'
import { importStorage, type StorageExportBundle, validateBundle } from './storage-migration.ts'

const args = parseArgs(process.argv.slice(2))
assertIdentifier(args.schema, 'postgres schema')
const dsn = process.env[args.dsnRef]
if (dsn === undefined || dsn === '') throw new Error(`Credential reference '${args.dsnRef}' is not configured.`)
const bundle = JSON.parse(await readFile(resolve(args.input), 'utf8')) as StorageExportBundle
validateBundle(bundle)
const client = new Client({ connectionString: dsn, ssl: args.ssl === 'off' ? false : { rejectUnauthorized: args.ssl === 'verify-full' } })
await client.connect()
try {
  const current = await client.query<{ count: string }>(
    `SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = $1 AND tablename = 'units'`,
    [args.schema],
  )
  let existingUnits = 0
  if (current.rows[0]?.count !== '0') {
    const result = await client.query<{ count: string }>(`SELECT count(*) FROM ${quoteIdentifier(args.schema)}."units"`)
    existingUnits = Number(result.rows[0]?.count ?? 0)
  }
  if (existingUnits > 0 && !(args.force && args.confirm === 'REPLACE_DZ23_STORAGE')) {
    throw new Error('Target has Studio units. Use --force --confirm REPLACE_DZ23_STORAGE only after reviewing the backup.')
  }
  if (!args.write) {
    process.stdout.write(`${JSON.stringify({ mode: 'dry-run', domains: bundle.domains.length, existingUnits }, null, 2)}\n`)
    process.exitCode = 0
  } else {
    if (args.backup === undefined) throw new Error('--backup is mandatory with --write')
    await mkdir(dirname(resolve(args.backup)), { recursive: true })
    await pgDump(dsn, args.schema, resolve(args.backup))
    const staging = `${args.schema}_staging_${Date.now().toString(36)}`
    assertIdentifier(staging, 'staging schema')
    const backend = new PostgresStorageBackend({ connectionString: dsn, schema: staging, ssl: args.ssl === 'off' ? false : { rejectUnauthorized: args.ssl === 'verify-full' }, poolMax: 4 })
    await backend.waitUntilReady()
    await importStorage(backend, bundle)
    await client.query('BEGIN')
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(args.schema)} CASCADE`)
      await client.query(`ALTER SCHEMA ${quoteIdentifier(staging)} RENAME TO ${quoteIdentifier(args.schema)}`)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
    process.stdout.write(`${JSON.stringify({ mode: 'write', domains: bundle.domains.length, backup: resolve(args.backup) }, null, 2)}\n`)
  }
} finally {
  await client.end()
}

async function pgDump(dsn: string, schema: string, output: string): Promise<void> {
  const url = new URL(dsn)
  const env = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
  }
  const destination = await open(output, 'wx', 0o600)
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
    confirm: optional('--confirm'),
    write: argv.includes('--write'),
  }
}
