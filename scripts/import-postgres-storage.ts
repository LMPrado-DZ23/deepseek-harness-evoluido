import { restorePostgresStorage, createPostgresSafetyBackup } from '../plugins/storage-postgres/src/restore.ts'
import { assertTlsPolicy } from '../plugins/storage-postgres/src/dsn.ts'

const args = parseArgs(process.argv.slice(2))
if (args.write && args.backup === '') throw new Error('--backup is mandatory with --write')
const dsn = process.env[args.dsnRef]
if (dsn === undefined || dsn === '') throw new Error(`Credential reference '${args.dsnRef}' is not configured.`)

const controller = new AbortController()
const cancel = (): void => controller.abort(new Error('Operação cancelada.'))
process.once('SIGINT', cancel)
process.once('SIGTERM', cancel)
try {
  const result = await restorePostgresStorage({
    input: args.input, dsn, schema: args.schema, ssl: args.ssl, write: args.write,
    safetyBackup: args.backup, force: args.force, allowDomainLoss: args.allowDomainLoss,
    confirmation: args.confirmation, signal: controller.signal,
  }, { createSafetyBackup: createPostgresSafetyBackup })
  const legacy = result.mode === 'write'
    ? { ...result, backup: result.safetyBackup, backupStatus: result.safetyBackupStatus }
    : result
  process.stdout.write(`${JSON.stringify(legacy, null, 2)}\n`)
} finally {
  process.off('SIGINT', cancel)
  process.off('SIGTERM', cancel)
}

function parseArgs(argv: readonly string[]) {
  const value = (name: string, fallback?: string): string => {
    const at = argv.indexOf(name)
    if (at < 0 || argv[at + 1] === undefined) {
      if (fallback !== undefined) return fallback
      throw new Error(`Missing ${name}`)
    }
    return argv[at + 1]!
  }
  return {
    input: value('--input'), dsnRef: value('--dsn-ref'), schema: value('--schema', 'dz23_storage'),
    ssl: assertTlsPolicy(value('--ssl', 'verify-full')), backup: value('--backup', ''),
    force: argv.includes('--force'), allowDomainLoss: argv.includes('--allow-domain-loss'),
    confirmation: value('--confirm', ''), write: argv.includes('--write'),
  }
}
