/** PostgreSQL backend plugin for durable, single-writer Studio domains. */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import z from '@deepseek-ai/schemastery'
import { PostgresStorageBackend } from './backend.js'
import { childProcessBackupRunner, StorageBackupScheduler, type BackupResult } from './backup.js'
import { assertConfiguredSchemaName } from './schema.js'
import { snapshotPostgresStorage } from './snapshot.js'

export { PostgresStorageBackend } from './backend.js'
export type { PostgresStorageBackendConfig } from './backend.js'
export { StudioStorageError } from './errors.js'
export * from './bundle.js'
export { snapshotPostgresStorage, type SnapshotOptions } from './snapshot.js'
export { BACKUP_FILE_PATTERN, BACKUP_LEDGER_FILE, BACKUP_MIN_INTERVAL_MS, StorageBackupScheduler, childProcessBackupRunner, inProcessBackupRunner, verifyBackupFile, type BackupResult, type BackupRunner, type BackupSchedulerOptions, type ChildBackupRunnerOptions } from './backup.js'
export { parseWorkerArgs, writeBackupBundle, type WorkerArgs, type WorkerReport } from './backup-worker.js'
export {
  POSTGRES_IDENTIFIER_MAX_LENGTH,
  POSTGRES_SCHEMA_MAX_LENGTH,
  STORAGE_POSTGRES_LAYOUT_VERSION,
  assertConfiguredSchemaName,
  storageUnitLockName,
} from './schema.js'

/** Environment name under which the scheduler hands the resolved DSN to the backup process. */
export const BACKUP_DSN_ENV = 'DZ23_STORAGE_BACKUP_DSN'

export const name = 'storage-postgres'
export const inject = ['storage', 'credentials']

export interface Config {
  dsnRef: string
  schema?: string
  ssl?: 'off' | 'require' | 'verify-full'
  poolMax?: number
  /** Directory that receives `studio-backup-<stamp>.json` bundles (created 0700). Empty/absent = no scheduled backup. */
  backupDirectory?: string
  backupIntervalMinutes?: number
  backupKeep?: number
  /** Ceiling for one backup file; a bigger database fails the run instead of filling the disk. */
  backupMaxBytes?: number
  /** A backup that takes longer than this is killed: a stuck copy must never become a stuck Studio. */
  backupTimeoutMinutes?: number
  /** Heap cap of the backup process, in MB. */
  backupHeapMb?: number
}

export const Config: z<Config> = z.object({
  dsnRef: z.string().role('credential-ref').required(),
  schema: z.string().default('dz23_storage'),
  ssl: z.union(['off', 'require', 'verify-full'] as const).default('verify-full'),
  poolMax: z.number().step(1).min(1).max(32).default(4),
  backupDirectory: z.string().default(''),
  backupIntervalMinutes: z.number().step(1).min(5).max(24 * 60).default(60),
  backupKeep: z.number().step(1).min(1).max(1000).default(48),
  backupMaxBytes: z.number().step(1).min(1024 * 1024).default(2 * 1024 * 1024 * 1024),
  backupTimeoutMinutes: z.number().step(1).min(1).max(24 * 60).default(15),
  backupHeapMb: z.number().step(1).min(128).max(16 * 1024).default(1024),
})

export interface StudioStorageBackupService {
  runOnce(): Promise<BackupResult>
  lastResult(): BackupResult | undefined
  snapshot(): Promise<ReturnType<typeof snapshotPostgresStorage>>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    studioStorageBackup?: StudioStorageBackupService
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const schema = config.schema ?? 'dz23_storage'
  assertConfiguredSchemaName(schema)
  const resolved = await ctx.credentials.resolve(credentialRef(config.dsnRef))
  if (resolved === undefined) {
    throw new Error(`storage-postgres: credential reference '${config.dsnRef}' is not configured`)
  }
  const sslMode = config.ssl ?? 'verify-full'
  const ssl = sslMode === 'off'
    ? false
    : { rejectUnauthorized: sslMode === 'verify-full' }
  const backend = new PostgresStorageBackend({
    connectionString: resolved.value,
    schema,
    ssl,
    poolMax: config.poolMax ?? 4,
  })
  try {
    await backend.waitUntilReady()
  } catch (error) {
    await backend.close()
    throw new Error('storage-postgres: PostgreSQL is unavailable or incompatible', { cause: error })
  }
  ctx.effect(() => {
    const dispose = ctx.storage.backend.register('postgres', backend)
    return async () => {
      dispose()
      await backend.close()
    }
  }, 'storage-postgres.registerBackend')
  ctx.provide(storageBackendServiceKey('postgres'), backend)

  // Descriptors are derived from the medium: every unit stamped on this schema.
  const snapshot = () => snapshotPostgresStorage({ connectionString: resolved.value, ssl, schema })
  if (config.backupDirectory !== undefined && config.backupDirectory !== '') {
    const scheduler = new StorageBackupScheduler({
      // Out of this process on purpose: copying the database must never cost the
      // Studio its memory or its event loop (review finding on M3).
      runner: childProcessBackupRunner({
        // The child reads the DSN from its own environment, never from the command
        // line (a command line is world-readable; a process environment is not).
        dsnRef: BACKUP_DSN_ENV,
        env: { ...process.env, [BACKUP_DSN_ENV]: resolved.value },
        schema,
        ssl: sslMode,
        maxBytes: config.backupMaxBytes ?? 2 * 1024 * 1024 * 1024,
        timeoutMs: (config.backupTimeoutMinutes ?? 15) * 60_000,
        heapMb: config.backupHeapMb ?? 1024,
      }),
      directory: config.backupDirectory,
      label: schema,
      intervalMs: (config.backupIntervalMinutes ?? 60) * 60_000,
      keep: config.backupKeep ?? 48,
      log: (level, line) => { if (level === 'warn') ctx.logger.warn(line); else ctx.logger.info(line) },
    })
    ctx.effect(() => {
      scheduler.start()
      return () => scheduler.stop()
    }, 'storage-postgres.backupSchedule')
    ctx.provide('studioStorageBackup', { runOnce: () => scheduler.runOnce(), lastResult: () => scheduler.lastResult, snapshot })
  } else {
    ctx.provide('studioStorageBackup', {
      runOnce: () => Promise.reject(new Error('storage-postgres: scheduled backup is not configured (backupDirectory)')),
      lastResult: () => undefined,
      snapshot,
    })
  }
}
