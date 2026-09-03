/** PostgreSQL backend plugin for durable, single-writer Studio domains. */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import z from '@deepseek-ai/schemastery'
import { PostgresStorageBackend } from './backend.js'
import { StorageBackupScheduler, type BackupResult } from './backup.js'
import { assertConfiguredSchemaName } from './schema.js'
import { snapshotPostgresStorage } from './snapshot.js'

export { PostgresStorageBackend } from './backend.js'
export type { PostgresStorageBackendConfig } from './backend.js'
export { StudioStorageError } from './errors.js'
export * from './bundle.js'
export { snapshotPostgresStorage, type SnapshotOptions } from './snapshot.js'
export { BACKUP_FILE_PATTERN, BACKUP_LEDGER_FILE, BACKUP_MIN_INTERVAL_MS, StorageBackupScheduler, verifyBackupFile, type BackupResult, type BackupSchedulerOptions } from './backup.js'
export {
  POSTGRES_IDENTIFIER_MAX_LENGTH,
  POSTGRES_SCHEMA_MAX_LENGTH,
  STORAGE_POSTGRES_LAYOUT_VERSION,
  assertConfiguredSchemaName,
  storageUnitLockName,
} from './schema.js'

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
}

export const Config: z<Config> = z.object({
  dsnRef: z.string().role('credential-ref').required(),
  schema: z.string().default('dz23_storage'),
  ssl: z.union(['off', 'require', 'verify-full'] as const).default('verify-full'),
  poolMax: z.number().step(1).min(1).max(32).default(4),
  backupDirectory: z.string().default(''),
  backupIntervalMinutes: z.number().step(1).min(5).max(24 * 60).default(60),
  backupKeep: z.number().step(1).min(1).max(1000).default(48),
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
      snapshot,
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
