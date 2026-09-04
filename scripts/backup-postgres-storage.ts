import { resolve } from 'node:path'
import { StorageBackupScheduler, BACKUP_MAX_BYTES_DEFAULT, BACKUP_MIN_INTERVAL_MS, inProcessBackupRunner } from '../plugins/storage-postgres/src/backup.ts'
import { writeBackupBundle } from '../plugins/storage-postgres/src/backup-worker.ts'
import { assertTlsPolicy, postgresClientConnection } from '../plugins/storage-postgres/src/dsn.ts'
import { assertConfiguredSchemaName } from '../plugins/storage-postgres/src/schema.ts'
import { snapshotPostgresStorage } from '../plugins/storage-postgres/src/snapshot.ts'
import { STUDIO_DOMAIN_SPECS } from './studio-domain-specs.ts'
import { descriptorOf } from '@deepseek-ai/dsh-storage-domain'

/**
 * Operator backup of a running (or stopped) Studio on PostgreSQL.
 *
 *   pnpm storage:backup-postgres --dsn-ref DZ23_POSTGRES_DSN --schema dz23_storage \
 *     --ssl verify-full --out /var/backups/dz23-studio [--keep 48] [--max-bytes N] [--write]
 *
 * Hot: it never takes the writer lock, so the Studio keeps running. Without
 * --write it only reports what would be written. The bundle is the same
 * format the restore CLI (scripts/import-postgres-storage.ts) consumes.
 */
const args = parseArgs(process.argv.slice(2))
assertConfiguredSchemaName(args.schema)
if (args.write && args.out === '') throw new Error('--out is mandatory with --write')
const dsn = process.env[args.dsnRef]
if (dsn === undefined || dsn === '') throw new Error(`Credential reference '${args.dsnRef}' is not configured.`)
// One authority for TLS here too: --ssl decides, and the DSN's own ssl parameters are stripped.
const connection = await postgresClientConnection(dsn, args.ssl)

const snapshot = () => snapshotPostgresStorage({
  connectionString: connection.connectionString, ssl: connection.ssl, schema: args.schema,
  // Declared Studio domains are version-checked; anything else stamped on the medium is still exported.
  ...(args.declaredOnly ? { descriptors: STUDIO_DOMAIN_SPECS.map(spec => descriptorOf(spec)) } : {}),
})

if (!args.write) {
  const bundle = await snapshot()
  process.stdout.write(`${JSON.stringify({
    mode: 'dry-run', schema: args.schema, domains: bundle.domains.map(domain => ({
      name: domain.descriptor.name, version: domain.descriptor.version,
      records: Object.values(domain.snapshot.tables).reduce((total, table) => total + Object.keys(table).length, 0),
    })),
  }, null, 2)}\n`)
} else {
  const scheduler = new StorageBackupScheduler({
    // Same engine, same ceiling as the scheduled backup: one domain at a time, straight
    // to the file, refusing anything over --max-bytes. `--declared-only` is the one case
    // that still builds the bundle in memory, because it seals declared units the medium
    // may not hold at all — and it is bounded by the same number.
    runner: args.declaredOnly
      ? inProcessBackupRunner(snapshot, { maxBytes: args.maxBytes })
      : { run: target => writeBackupBundle({ dsnRef: 'unused', schema: args.schema, ssl: args.ssl, out: target, maxBytes: args.maxBytes }, dsn) },
    directory: resolve(args.out), label: args.schema, intervalMs: BACKUP_MIN_INTERVAL_MS, keep: args.keep,
    log: (level, line) => process.stderr.write(`[${level}] ${line}\n`),
  })
  const result = await scheduler.runOnce()
  process.stdout.write(`${JSON.stringify({ mode: 'write', ...result }, null, 2)}\n`)
  if (result.status !== 'created') process.exitCode = 1
}

function parseArgs(argv: string[]) {
  const value = (name: string, fallback?: string) => {
    const at = argv.indexOf(name)
    if (at < 0 || argv[at + 1] === undefined) {
      if (fallback !== undefined) return fallback
      throw new Error(`Missing ${name}`)
    }
    return argv[at + 1]!
  }
  const ssl = assertTlsPolicy(value('--ssl', 'verify-full'))
  const keep = Number(value('--keep', '48'))
  if (!Number.isInteger(keep) || keep < 1) throw new Error('--keep must be a positive integer')
  const maxBytes = Number(value('--max-bytes', String(BACKUP_MAX_BYTES_DEFAULT)))
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('--max-bytes must be a positive integer')
  return {
    dsnRef: value('--dsn-ref'),
    schema: value('--schema', 'dz23_storage'),
    ssl,
    out: value('--out', ''),
    keep,
    maxBytes,
    write: argv.includes('--write'),
    declaredOnly: argv.includes('--declared-only'),
  }
}
