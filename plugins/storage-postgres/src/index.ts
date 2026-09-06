/** PostgreSQL backend plugin for durable, single-writer Studio domains. */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import z from '@deepseek-ai/schemastery'
import type { DistributedCapacityGovernor } from '@dz23-studio/runtime-governor'
import { PostgresStorageBackend } from './backend.js'
import { BACKUP_MAX_BYTES_DEFAULT, childProcessBackupRunner, StorageBackupScheduler, type BackupResult } from './backup.js'
import { postgresClientConnection } from './dsn.js'
import { PostgresCapacityGovernor } from './capacity.js'
import { assertConfiguredSchemaName } from './schema.js'
import { snapshotPostgresStorage } from './snapshot.js'
import { PostgresTenantRecordStore } from './tenant-store.js'

export { PostgresStorageBackend } from './backend.js'
export type { PostgresStorageBackendConfig } from './backend.js'
export { StudioStorageError } from './errors.js'
export { PostgresCapacityGovernor } from './capacity.js'
export type { PostgresCapacityGovernorOptions } from './capacity.js'
export type { CapacityTakeoverRequest } from '@dz23-studio/runtime-governor'
export { CAPACITY_POSTGRES_LAYOUT_VERSION } from './capacity-schema.js'
export { PostgresTenantRecordStore } from './tenant-store.js'
export type { PostgresTenantStoreConfig, TenantRecord, TenantScope } from './tenant-store.js'
export * from './bundle.js'
export { DEFAULT_STORAGE_IMPORT_LIMITS, IMPORT_MAX_BYTES_DEFAULT, readStorageBundleFile, type StorageImportLimits } from './import-file.js'
export { snapshotPostgresStorage, storedDescriptor, deriveDescriptors, type SnapshotOptions } from './snapshot.js'
export { assertTlsPolicy, postgresClientConnection, postgresToolConnection, withoutTlsParams, type PostgresClientConnection, type PostgresToolConnection, type TlsPolicy } from './dsn.js'
export { BACKUP_FILE_PATTERN, BACKUP_LEDGER_FILE, BACKUP_MAX_BYTES_DEFAULT, BACKUP_MIN_INTERVAL_MS, StorageBackupScheduler, childProcessBackupRunner, inProcessBackupRunner, verifyBackupFile, type BackupResult, type BackupRunner, type BackupSchedulerOptions, type ChildBackupRunnerOptions } from './backup.js'
export { parseWorkerArgs, writeBackupBundle, type WorkerArgs, type WorkerReport } from './backup-worker.js'
export {
  createPostgresSafetyBackup,
  postgresDumpInvocation,
  postgresStorageStatus,
  restorePostgresStorage,
  type PostgresStorageStatus,
  type RestorableBackend,
  type RestoreInspectionReport,
  type RestorePostgresDependencies,
  type RestorePostgresOptions,
  type RestorePostgresReport,
  type RestoreWriteReport,
} from './restore.js'
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

declare module '@deepseek-ai/cordis' {
  interface Context { studioCapacity: DistributedCapacityGovernor }
}

export interface Config {
  dsnRef: string
  /** Separate NOSUPERUSER/NOBYPASSRLS credential for the tenant-aware repository. Empty = RLS repository disabled. */
  tenantRuntimeDsnRef?: string
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
  tenantRuntimeDsnRef: z.string().role('credential-ref').default(''),
  schema: z.string().default('dz23_storage'),
  ssl: z.union(['off', 'require', 'verify-full'] as const).default('verify-full'),
  poolMax: z.number().step(1).min(1).max(32).default(4),
  backupDirectory: z.string().default(''),
  backupIntervalMinutes: z.number().step(1).min(5).max(24 * 60).default(60),
  backupKeep: z.number().step(1).min(1).max(1000).default(48),
  backupMaxBytes: z.number().step(1).min(1024 * 1024).max(BACKUP_MAX_BYTES_DEFAULT).default(BACKUP_MAX_BYTES_DEFAULT),
  backupTimeoutMinutes: z.number().step(1).min(1).max(24 * 60).default(15),
  backupHeapMb: z.number().step(1).min(128).max(16 * 1024).default(1024),
})

export interface StudioStorageBackupService {
  runOnce(): Promise<BackupResult>
  lastResult(): BackupResult | undefined
  snapshot(): Promise<ReturnType<typeof snapshotPostgresStorage>>
}

export interface StudioTenantStorageService {
  readonly records: PostgresTenantRecordStore
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    studioStorageBackup?: StudioStorageBackupService
    studioTenantStorage?: StudioTenantStorageService
    studioCapacity: DistributedCapacityGovernor
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
  // One authority for TLS: the policy decides, and the DSN's own ssl parameters are
  // stripped so they cannot quietly downgrade it.
  const connection = await postgresClientConnection(resolved.value, sslMode)
  const ssl = connection.ssl
  const backend = new PostgresStorageBackend({
    connectionString: connection.connectionString,
    schema,
    ssl,
    poolMax: config.poolMax ?? 4,
  })
  let capacity: PostgresCapacityGovernor | undefined
  let tenantStore: PostgresTenantRecordStore | undefined
  try {
    // Both services share one PostgreSQL schema. Initialise the storage writer
    // first so its physical layout exists before the capacity tables are added;
    // concurrent CREATE SCHEMA IF NOT EXISTS calls can still race inside
    // PostgreSQL and raise a duplicate pg_namespace key.
    await backend.waitUntilReady()
    capacity = new PostgresCapacityGovernor({
      connectionString: connection.connectionString,
      schema,
      ssl,
      poolMax: Math.min(4, config.poolMax ?? 4),
    })
    await capacity.waitUntilReady()
    if (config.tenantRuntimeDsnRef !== undefined && config.tenantRuntimeDsnRef !== '') {
      if (config.tenantRuntimeDsnRef === config.dsnRef) {
        throw new Error('storage-postgres: tenant runtime credential must be separate from the admin credential')
      }
      const tenantResolved = await ctx.credentials.resolve(credentialRef(config.tenantRuntimeDsnRef))
      if (tenantResolved === undefined) {
        throw new Error(`storage-postgres: credential reference '${config.tenantRuntimeDsnRef}' is not configured`)
      }
      const tenantConnection = await postgresClientConnection(tenantResolved.value, sslMode)
      tenantStore = await PostgresTenantRecordStore.create({
        adminConnectionString: connection.connectionString,
        runtimeConnectionString: tenantConnection.connectionString,
        schema,
        ssl: tenantConnection.ssl,
        poolMax: config.poolMax ?? 4,
      })
    }
  } catch (error) {
    await Promise.allSettled([backend.close(), capacity?.close(), tenantStore?.close()])
    throw new Error('storage-postgres: PostgreSQL is unavailable or incompatible', { cause: error })
  }
  ctx.effect(() => {
    const dispose = ctx.storage.backend.register('postgres', backend)
    return async () => {
      dispose()
      await Promise.all([backend.close(), capacity.close(), tenantStore?.close()])
    }
  }, 'storage-postgres.registerBackend')
  ctx.provide(storageBackendServiceKey('postgres'), backend)
  ctx.provide('studioCapacity', capacity)
  if (tenantStore !== undefined) ctx.provide('studioTenantStorage', { records: tenantStore })

  // Descriptors are derived from the medium: every unit stamped on this schema.
  const snapshot = () => snapshotPostgresStorage({ connectionString: connection.connectionString, ssl, schema })
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
        maxBytes: config.backupMaxBytes ?? BACKUP_MAX_BYTES_DEFAULT,
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
