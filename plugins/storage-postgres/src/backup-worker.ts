/**
 * Backup worker: a process of its own, started by the scheduler.
 *
 * The Studio process must never materialise the whole database and the whole
 * canonical JSON in its heap to make a copy — that is an availability risk for
 * everybody using it. So the work happens here, one domain at a time, writing
 * straight to the file while both digests are computed as the bytes go by.
 * The parent only reads the single JSON line this prints.
 *
 *   node backup-worker.js --dsn-ref DZ23_POSTGRES_DSN --schema dz23_storage \
 *     --ssl verify-full --out <file> [--max-bytes N]
 */
import { createHash } from 'node:crypto'
import { open, rm } from 'node:fs/promises'
import { Client } from 'pg'
import { HARNESS_UPSTREAM_COMMIT, STORAGE_EXPORT_FORMAT, canonicalJson, sha256 } from './bundle.js'
import { assertConfiguredSchemaName, globalsTable, quoteIdentifier, recordsTable, STORAGE_POSTGRES_LAYOUT_VERSION, unitsTable } from './schema.js'

export interface WorkerArgs {
  dsnRef: string
  schema: string
  ssl: 'off' | 'require' | 'verify-full'
  out: string
  maxBytes: number
  now?: () => Date
}

export interface WorkerReport {
  sha256: string
  bytes: number
  records: number
  domains: number
}

interface UnitRow { name: string; version: number }
interface RecordRow { table_name: string; key: string; value: unknown }

/** Writes the bundle to `out` and reports it, holding at most one domain in memory at a time. */
export async function writeBackupBundle(args: WorkerArgs, dsn: string): Promise<WorkerReport> {
  assertConfiguredSchemaName(args.schema)
  const ssl = args.ssl === 'off' ? false : { rejectUnauthorized: args.ssl === 'verify-full' }
  const client = new Client({ connectionString: dsn, ssl, application_name: 'dz23-storage:backup' })
  await client.connect()
  const file = await open(args.out, 'wx', 0o600)
  const fileHash = createHash('sha256')
  const payloadHash = createHash('sha256')
  let bytes = 0
  let records = 0
  let domains = 0
  const write = async (chunk: string): Promise<void> => {
    bytes += Buffer.byteLength(chunk, 'utf8')
    if (bytes > args.maxBytes) throw new Error(`backup exceeds the ${String(args.maxBytes)} byte limit`)
    fileHash.update(chunk, 'utf8')
    await file.write(chunk, null, 'utf8')
  }
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const layout = await client.query<{ value: number }>(
      `SELECT value FROM ${quoteIdentifier(args.schema)}."storage_meta" WHERE key = 'layout_version'`,
    )
    if (layout.rows[0] === undefined) throw new Error(`postgres schema '${args.schema}' has no Studio storage layout`)
    if (layout.rows[0].value !== STORAGE_POSTGRES_LAYOUT_VERSION) {
      throw new Error(`postgres storage schema '${args.schema}' has layout version ${String(layout.rows[0].value)}, incompatible with this build (${String(STORAGE_POSTGRES_LAYOUT_VERSION)})`)
    }
    const marker = await client.query<{ snapshot: string }>('SELECT pg_current_snapshot()::text AS snapshot')
    const units = await client.query<UnitRow>(`SELECT name, version FROM ${unitsTable(args.schema)} ORDER BY name`)
    const createdAt = (args.now ?? (() => new Date()))().toISOString()
    const source = { kind: 'postgres' as const, sha256: sha256(`${args.schema}\0${marker.rows[0]!.snapshot}`) }

    // The canonical payload has its keys in code-point order: createdAt, domains, format, source, upstreamCommit.
    payloadHash.update(`{"createdAt":${JSON.stringify(createdAt)},"domains":[`, 'utf8')
    await write(`{"format":${JSON.stringify(STORAGE_EXPORT_FORMAT)},"upstreamCommit":${JSON.stringify(HARNESS_UPSTREAM_COMMIT)},"source":${JSON.stringify(source)},"createdAt":${JSON.stringify(createdAt)},"domains":[`)

    for (const unit of units.rows) {
      const rows = await client.query<RecordRow>(
        `SELECT table_name, key, value FROM ${recordsTable(args.schema)} WHERE unit = $1 ORDER BY table_name, key`,
        [unit.name],
      )
      const globalRow = await client.query<{ value: unknown }>(
        `SELECT value FROM ${globalsTable(args.schema)} WHERE unit = $1`,
        [unit.name],
      )
      const tables: Record<string, Record<string, unknown>> = {}
      for (const row of rows.rows) {
        tables[row.table_name] ??= Object.create(null) as Record<string, unknown>
        tables[row.table_name]![row.key] = row.value
      }
      records += rows.rowCount ?? 0
      const descriptor = {
        name: unit.name,
        version: unit.version,
        tables: Object.keys(tables).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
        hasGlobal: globalRow.rows[0] !== undefined,
      }
      const domain = {
        descriptor,
        snapshot: { tables, global: globalRow.rows[0] === undefined ? null : globalRow.rows[0].value },
      }
      const withDigest = { ...domain, sha256: sha256(canonicalJson(domain)) }
      const separator = domains === 0 ? '' : ','
      payloadHash.update(`${separator}${canonicalJson(withDigest)}`, 'utf8')
      await write(`${separator}${JSON.stringify(withDigest)}`)
      domains += 1
    }
    await client.query('COMMIT')

    payloadHash.update(`],"format":${JSON.stringify(STORAGE_EXPORT_FORMAT)},"source":${canonicalJson(source)},"upstreamCommit":${JSON.stringify(HARNESS_UPSTREAM_COMMIT)}}`, 'utf8')
    await write(`],"payloadSha256":${JSON.stringify(payloadHash.digest('hex'))}}\n`)
    await file.close()
    return { sha256: fileHash.digest('hex'), bytes, records, domains }
  } catch (error) {
    /* v8 ignore next 3 -- cleanup of a partial file cannot supersede the original failure. */
    await client.query('ROLLBACK').catch(() => undefined)
    await file.close().catch(() => undefined)
    await rm(args.out, { force: true }).catch(() => undefined)
    throw error
  } finally {
    await client.end().catch(() => undefined)
  }
}

export function parseWorkerArgs(argv: readonly string[]): WorkerArgs {
  const value = (name: string, fallback?: string): string => {
    const at = argv.indexOf(name)
    if (at < 0 || argv[at + 1] === undefined) {
      if (fallback !== undefined) return fallback
      throw new Error(`Missing ${name}`)
    }
    return argv[at + 1]!
  }
  const ssl = value('--ssl', 'verify-full')
  if (ssl !== 'off' && ssl !== 'require' && ssl !== 'verify-full') throw new Error('--ssl must be off, require or verify-full')
  const maxBytes = Number(value('--max-bytes', String(2 * 1024 * 1024 * 1024)))
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('--max-bytes must be a positive integer')
  return { dsnRef: value('--dsn-ref'), schema: value('--schema'), ssl, out: value('--out'), maxBytes }
}

/* v8 ignore start -- the entry point runs in the child process; the proof exercises it end to end. */
if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = parseWorkerArgs(process.argv.slice(2))
  const dsn = process.env[args.dsnRef]
  if (dsn === undefined || dsn === '') throw new Error(`Credential reference '${args.dsnRef}' is not configured.`)
  const report = await writeBackupBundle(args, dsn)
  process.stdout.write(`${JSON.stringify(report)}\n`)
}
/* v8 ignore stop */
