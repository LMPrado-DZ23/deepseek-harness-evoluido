/** PostgreSQL backend plugin for durable, single-writer Studio domains. */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { DistributedCapacityGovernor } from '@dz23-studio/runtime-governor';
import { type BackupResult } from './backup.js';
import { snapshotPostgresStorage } from './snapshot.js';
import { PostgresTenantRecordStore } from './tenant-store.js';
export { PostgresStorageBackend } from './backend.js';
export type { PostgresStorageBackendConfig } from './backend.js';
export { StudioStorageError } from './errors.js';
export { PostgresCapacityGovernor } from './capacity.js';
export type { PostgresCapacityGovernorOptions } from './capacity.js';
export type { CapacityTakeoverRequest } from '@dz23-studio/runtime-governor';
export { CAPACITY_POSTGRES_LAYOUT_VERSION } from './capacity-schema.js';
export { PostgresTenantRecordStore } from './tenant-store.js';
export type { PostgresTenantStoreConfig, TenantRecord, TenantScope } from './tenant-store.js';
export * from './bundle.js';
export { DEFAULT_STORAGE_IMPORT_LIMITS, IMPORT_MAX_BYTES_DEFAULT, readStorageBundleFile, type StorageImportLimits } from './import-file.js';
export { snapshotPostgresStorage, storedDescriptor, deriveDescriptors, type SnapshotOptions } from './snapshot.js';
export { assertTlsPolicy, postgresClientConnection, postgresToolConnection, withoutTlsParams, type PostgresClientConnection, type PostgresToolConnection, type TlsPolicy } from './dsn.js';
export { BACKUP_FILE_PATTERN, BACKUP_LEDGER_FILE, BACKUP_MAX_BYTES_DEFAULT, BACKUP_MIN_INTERVAL_MS, StorageBackupScheduler, childProcessBackupRunner, inProcessBackupRunner, verifyBackupFile, type BackupResult, type BackupRunner, type BackupSchedulerOptions, type ChildBackupRunnerOptions } from './backup.js';
export { parseWorkerArgs, writeBackupBundle, type WorkerArgs, type WorkerReport } from './backup-worker.js';
export { createPostgresSafetyBackup, postgresDumpInvocation, postgresStorageStatus, restorePostgresStorage, type PostgresStorageStatus, type RestorableBackend, type RestoreInspectionReport, type RestorePostgresDependencies, type RestorePostgresOptions, type RestorePostgresReport, type RestoreWriteReport, } from './restore.js';
export { POSTGRES_IDENTIFIER_MAX_LENGTH, POSTGRES_SCHEMA_MAX_LENGTH, STORAGE_POSTGRES_LAYOUT_VERSION, assertConfiguredSchemaName, storageUnitLockName, } from './schema.js';
/** Environment name under which the scheduler hands the resolved DSN to the backup process. */
export declare const BACKUP_DSN_ENV = "DZ23_STORAGE_BACKUP_DSN";
export declare const name = "storage-postgres";
export declare const inject: string[];
declare module '@deepseek-ai/cordis' {
    interface Context {
        studioCapacity: DistributedCapacityGovernor;
    }
}
export interface Config {
    dsnRef: string;
    /** Separate NOSUPERUSER/NOBYPASSRLS credential for the tenant-aware repository. Empty = RLS repository disabled. */
    tenantRuntimeDsnRef?: string;
    schema?: string;
    ssl?: 'off' | 'require' | 'verify-full';
    poolMax?: number;
    /** Directory that receives `studio-backup-<stamp>.json` bundles (created 0700). Empty/absent = no scheduled backup. */
    backupDirectory?: string;
    backupIntervalMinutes?: number;
    backupKeep?: number;
    /** Ceiling for one backup file; a bigger database fails the run instead of filling the disk. */
    backupMaxBytes?: number;
    /** A backup that takes longer than this is killed: a stuck copy must never become a stuck Studio. */
    backupTimeoutMinutes?: number;
    /** Heap cap of the backup process, in MB. */
    backupHeapMb?: number;
}
export declare const Config: z<Config>;
export interface StudioStorageBackupService {
    runOnce(): Promise<BackupResult>;
    lastResult(): BackupResult | undefined;
    snapshot(): Promise<ReturnType<typeof snapshotPostgresStorage>>;
}
export interface StudioTenantStorageService {
    readonly records: PostgresTenantRecordStore;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        studioStorageBackup?: StudioStorageBackupService;
        studioTenantStorage?: StudioTenantStorageService;
        studioCapacity: DistributedCapacityGovernor;
    }
}
export declare function apply(ctx: Context, config: Config): Promise<void>;
//# sourceMappingURL=index.d.ts.map