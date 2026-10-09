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
import { createHash, randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { Client } from 'pg'
import { HARNESS_UPSTREAM_COMMIT, STORAGE_EXPORT_FORMAT, canonicalJson, sha256 } from './bundle.js'
import { postgresClientConnection } from './dsn.js'
import { t } from './i18n.js'
import { assertConfiguredSchemaName, globalsTable, quoteIdentifier, recordsTable, STORAGE_POSTGRES_LAYOUT_VERSION, unitsTable } from './schema.js'
import { readInstallation, storedDescriptor, unitsProjection, type UnitRow } from './snapshot.js'
import { assertPinnedDirectory, openNewPinnedFile, pinnedChildPath, pinParent } from './safe-path.js'
import { OPERATOR_BUNDLE_MAX_BYTES, assertOperatorBundleLimit } from './operator-limits.js'

export interface WorkerArgs {
  dsnRef: string
  schema: string
  ssl: 'off' | 'require' | 'verify-full'
  out: string
  maxBytes: number
  now?: () => Date
  signal?: AbortSignal
}

export interface WorkerReport {
  sha256: string
  bytes: number
  records: number
  domains: number
}

/** Rows per cursor round-trip: big enough to be cheap, small enough that memory stays flat. */
const CURSOR_BATCH = 500

/** Writes the bundle to `out` and reports it, holding at most one domain in memory at a time. */
export async function writeBackupBundle(args: WorkerArgs, dsn: string): Promise<WorkerReport> {
  throwIfAborted(args.signal)
  assertConfiguredSchemaName(args.schema)
  assertOperatorBundleLimit(args.maxBytes, 'backup maxBytes')
  // TLS is decided here and nowhere else: the DSN's own ssl parameters are stripped
  // so they cannot downgrade the configured policy.
  const connection = await postgresClientConnection(dsn, args.ssl)
  // The output file is claimed BEFORE the database is opened. It used to be the other
  // way round, and outside the try/finally: an `EEXIST` from a previous attempt, or a
  // directory the process cannot write, left one CONNECTED client behind per attempt.
  const output = await pinParent(args.out)
  const file = await openNewPinnedFile(output.directory, output.name)
  const client = new Client({ ...connection, application_name: `dz23-storage:backup:${args.schema}` })
  let connected = false
  const fileHash = createHash('sha256')
  const payloadHash = createHash('sha256')
  let bytes = 0
  let records = 0
  let domains = 0
  const write = async (chunk: string): Promise<void> => {
    throwIfAborted(args.signal)
    bytes += Buffer.byteLength(chunk, 'utf8')
    if (bytes > args.maxBytes) throw new Error(`backup exceeds the ${String(args.maxBytes)} byte limit`)
    fileHash.update(chunk, 'utf8')
    await file.write(chunk, null, 'utf8')
  }
  try {
    await client.connect()
    throwIfAborted(args.signal)
    connected = true
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const layout = await client.query<{ value: number }>(
      `SELECT value FROM ${quoteIdentifier(args.schema)}."storage_meta" WHERE key = 'layout_version'`,
    )
    if (layout.rows[0] === undefined) throw new Error(`postgres schema '${args.schema}' has no Studio storage layout`)
    if (layout.rows[0].value !== STORAGE_POSTGRES_LAYOUT_VERSION) {
      throw new Error(`postgres storage schema '${args.schema}' has layout version ${String(layout.rows[0].value)}, incompatible with this build (${String(STORAGE_POSTGRES_LAYOUT_VERSION)})`)
    }
    const marker = await client.query<{ snapshot: string }>('SELECT pg_current_snapshot()::text AS snapshot')
    const createdAt = (args.now ?? (() => new Date()))().toISOString()
    const source = { kind: 'postgres' as const, sha256: sha256(`${args.schema}\0${marker.rows[0]!.snapshot}`) }
    const installation = await readInstallation(client, args.schema)
    const installationJson = installation === undefined ? '' : `"installation":${JSON.stringify(installation)},`

    // The canonical payload has its keys in code-point order: createdAt, domains, format, installation, source, upstreamCommit.
    payloadHash.update(`{"createdAt":${JSON.stringify(createdAt)},"domains":[`, 'utf8')
    await write(`{"format":${JSON.stringify(STORAGE_EXPORT_FORMAT)},"upstreamCommit":${JSON.stringify(HARNESS_UPSTREAM_COMMIT)},${installationJson}"source":${JSON.stringify(source)},"createdAt":${JSON.stringify(createdAt)},"domains":[`)

    for await (const unit of cursorUnits(client, args.schema, await unitsProjection(client, args.schema))) {
      throwIfAborted(args.signal)
      const globalRow = await client.query<{ value: unknown }>(
        `SELECT value FROM ${globalsTable(args.schema)} WHERE unit = $1`,
        [unit.name],
      )
      // Which tables hold records, in byte order (`COLLATE "C"`), which is what
      // which is what the canonical form needs — the database's own collation is not).
      const tableRows = await client.query<{ table_name: string }>(
        `SELECT table_name FROM ${recordsTable(args.schema)} WHERE unit = $1 GROUP BY table_name ORDER BY table_name COLLATE "C"`,
        [unit.name],
      )
      // Same rule as the in-process snapshot: the DECLARED shape stamped on the medium,
      // widened by whatever rows exist. Inferring from rows alone dropped a declared
      // table that happened to be empty and a global slot that had not been written.
      const descriptor = storedDescriptor(unit, new Set(tableRows.rows.map(row => row.table_name)), globalRow.rows[0] !== undefined)
      const global = globalRow.rows[0] === undefined ? null : globalRow.rows[0].value

      /**
       * The canonical bytes of this domain WITHOUT its own digest, in pieces.
       * Records are read through a server-side cursor, so a unit with millions
       * of rows never sits in memory — the whole reason this work left the
       * Studio process. Runs twice inside the same REPEATABLE READ snapshot:
       * once to learn the digest, once to write it out with the digest in
       * place. Two passes over the rows, constant memory.
       */
      const streamDomain = async (sink: (chunk: string) => Promise<void> | void): Promise<number> => {
        await sink(`{"descriptor":${canonicalJson(descriptor)},`)
        await sink(`"snapshot":{"global":${canonicalJson(global)},"tables":{`)
        let counted = 0
        let firstTable = true
        for (const table of descriptor.tables) {
          await sink(`${firstTable ? '' : ','}${JSON.stringify(table)}:{`)
          firstTable = false
          let firstRow = true
          for await (const row of cursorRows(client, args.schema, unit.name, table)) {
            throwIfAborted(args.signal)
            await sink(`${firstRow ? '' : ','}${JSON.stringify(row.key)}:${canonicalJson(row.value)}`)
            firstRow = false
            counted += 1
          }
          await sink('}')
        }
        await sink('}}}')
        return counted
      }

      const domainHash = createHash('sha256')
      const counted = await streamDomain(chunk => { domainHash.update(chunk, 'utf8') })
      const domainDigest = domainHash.digest('hex')
      records += counted

      // Canonical order of the sealed domain is descriptor, sha256, snapshot; the file may spell
      // the same object in any key order, so the digest is written last there.
      const separator = domains === 0 ? '' : ','
      payloadHash.update(separator, 'utf8')
      await write(separator)
      let seenDescriptor = false
      await streamDomain(async chunk => {
        if (!seenDescriptor && chunk.startsWith('{"descriptor":')) {
          seenDescriptor = true
          payloadHash.update(`${chunk}"sha256":${JSON.stringify(domainDigest)},`, 'utf8')
          await write(chunk)
          return
        }
        payloadHash.update(chunk, 'utf8')
        // The closing `}}}` of the file copy carries the digest, so the file object is complete on its own.
        await write(chunk === '}}}' ? `}},"sha256":${JSON.stringify(domainDigest)}}` : chunk)
      })
      domains += 1
    }

    throwIfAborted(args.signal)
    await client.query('COMMIT')

    payloadHash.update(`],"format":${JSON.stringify(STORAGE_EXPORT_FORMAT)},${installationJson}"source":${canonicalJson(source)},"upstreamCommit":${JSON.stringify(HARNESS_UPSTREAM_COMMIT)}}`, 'utf8')
    await write(`],"payloadSha256":${JSON.stringify(payloadHash.digest('hex'))}}\n`)
    await assertPinnedDirectory(output.directory)
    await file.sync()
    await file.close()
    return { sha256: fileHash.digest('hex'), bytes, records, domains }
  } catch (error) {
    /* v8 ignore next 3 -- cleanup of a partial file cannot supersede the original failure. */
    if (connected) await client.query('ROLLBACK').catch(() => undefined)
    await file.close().catch(() => undefined)
    await assertPinnedDirectory(output.directory)
      .then(() => rm(pinnedChildPath(output.directory, output.name), { force: true }))
      .catch(() => undefined)
    throw error
  } finally {
    // Only a client that actually connected: `end()` on one that never did never settles.
    if (connected) await client.end().catch(() => undefined)
    await output.directory.handle.close().catch(() => undefined)
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason instanceof Error ? signal.reason : new Error(t('common.operationCancelled'))
}

/** Units are cursored too: a schema with many small domains stays bounded just like one huge domain. */
async function* cursorUnits(client: Client, schema: string, projection: string): AsyncGenerator<UnitRow> {
  const name = `dz23_backup_units_${randomUUID().replaceAll('-', '')}`
  await client.query(
    `DECLARE ${name} NO SCROLL CURSOR FOR SELECT ${projection} FROM ${unitsTable(schema)} ORDER BY name COLLATE "C"`,
  )
  try {
    for (;;) {
      const batch = await client.query<UnitRow>(`FETCH FORWARD ${String(CURSOR_BATCH)} FROM ${name}`)
      for (const row of batch.rows) yield row
      if (batch.rows.length < CURSOR_BATCH) return
    }
  } finally {
    /* v8 ignore next -- transaction end also closes the cursor after failure. */
    await client.query(`CLOSE ${name}`).catch(() => undefined)
  }
}

/**
 * Records of one unit table, in code-point order, read through a PostgreSQL
 * cursor in batches. The cursor lives inside the caller's transaction, so every
 * batch sees the same snapshot as the rest of the backup.
 */
async function* cursorRows(client: Client, schema: string, unit: string, table: string): AsyncGenerator<{ key: string; value: unknown }> {
  const name = `dz23_backup_${randomUUID().replaceAll('-', '')}`
  await client.query(
    `DECLARE ${name} NO SCROLL CURSOR FOR SELECT key, value FROM ${recordsTable(schema)} WHERE unit = $1 AND table_name = $2 ORDER BY key COLLATE "C"`,
    [unit, table],
  )
  try {
    for (;;) {
      const batch = await client.query<{ key: string; value: unknown }>(`FETCH FORWARD ${String(CURSOR_BATCH)} FROM ${name}`)
      for (const row of batch.rows) yield row
      if (batch.rows.length < CURSOR_BATCH) return
    }
  } finally {
    /* v8 ignore next -- closing the cursor is best effort; the transaction ends it anyway. */
    await client.query(`CLOSE ${name}`).catch(() => undefined)
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
  const maxBytes = assertOperatorBundleLimit(Number(value('--max-bytes', String(OPERATOR_BUNDLE_MAX_BYTES))), '--max-bytes')
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
