import { Client } from 'pg';
import type { StorageBackend } from '@deepseek-ai/dsh-storage';
import { postgresClientConnection, type PostgresClientConnection, type TlsPolicy } from './dsn.js';
import type { VerifiedStorageBundle } from './import-file.js';
import { loadRestoreJournal, reserveRestoreJournal, writeRestoreJournal } from './restore-journal.js';
import { type RestoreRecordLoss } from './restore-policy.js';
export interface RestorePostgresOptions {
    verifiedInput: VerifiedStorageBundle;
    attemptId: string;
    dsn: string;
    schema?: string;
    ssl?: TlsPolicy;
    write?: boolean;
    safetyBackup?: string;
    stateDirectory?: string;
    force?: boolean;
    allowDomainLoss?: boolean;
    allowRecordLoss?: boolean;
    allowUnknownObjects?: boolean;
    allowForeignInstallation?: boolean;
    confirmation?: string;
    signal?: AbortSignal;
    environment?: NodeJS.ProcessEnv;
    maxBytes?: number;
}
export interface RestoreInspectionReport {
    mode: 'dry-run';
    domains: number;
    existingUnits: number;
    targetDomains: string[];
    wouldBeLost: string[];
    targetSchemaExists: boolean;
    targetHasContent: boolean;
    recordsInBackup: number;
    recordsInTarget: number;
    recordLoss: RestoreRecordLoss[];
    unknownObjects: string[];
    unknownObjectCount: number;
    orphanStaging: string[];
    layoutProblem: string | null;
    backupInstallation: string | null;
    targetInstallation: string | null;
    installationAfter: string | null;
}
export interface RestoreWriteReport {
    mode: 'write';
    domains: number;
    safetyBackup: string | null;
    safetyBackupStatus: 'created' | 'not-needed-empty-target';
    safetyBackupSha256: string | null;
    replacedDomains: string[];
    droppedDomains: string[];
    reapedStaging: string[];
    recordsInBackup: number;
    recordsInTarget: number;
    recordLoss: RestoreRecordLoss[];
    unknownObjectsRemoved: string[];
    backupInstallation: string | null;
    targetInstallation: string | null;
    installationAfter: string | null;
    readyToStart: true;
}
export type RestorePostgresReport = RestoreInspectionReport | RestoreWriteReport;
export interface PostgresStorageStatus {
    reachable: true;
    serverVersion: string;
    schema: string;
    schemaExists: boolean;
    ready: boolean;
    layoutVersion: number | null;
    domains: number;
    condition: 'ready' | 'not-initialized' | 'unhealthy';
}
export interface RestorePostgresDependencies {
    resolveConnection?: typeof postgresClientConnection;
    createClient?: (connection: PostgresClientConnection) => Client;
    createBackend?: (connection: PostgresClientConnection, schema: string) => RestorableBackend;
    createSafetyBackup?: (dsn: string, schema: string, output: string, ssl: TlsPolicy, environment: NodeJS.ProcessEnv, signal?: AbortSignal, resume?: boolean, maxBytes?: number, ownership?: SafetyBackupOwnership) => Promise<SafetyBackupInfo>;
    now?: () => number;
    suffix?: () => string;
    loadJournal?: typeof loadRestoreJournal;
    reserveJournal?: typeof reserveRestoreJournal;
    writeJournal?: typeof writeRestoreJournal;
    platform?: NodeJS.Platform;
}
export interface SafetyBackupInfo {
    file: string;
    sha256: string;
    bytes: number;
}
export interface SafetyBackupOwnership {
    attemptId: string;
    targetSchema: string;
    targetFingerprint: string;
    inputSha256: string;
}
export interface RestorableBackend extends StorageBackend {
    waitUntilReady(): Promise<void>;
    close(): Promise<void>;
}
/**
 * Inspect or restore one logical Studio backup. The caller must keep every
 * Studio writer stopped until this function returns `readyToStart: true`.
 * It never starts a writer itself.
 */
export declare function restorePostgresStorage(options: RestorePostgresOptions, dependencies?: RestorePostgresDependencies): Promise<RestorePostgresReport>;
/** Read-only operator health. No connection material is ever returned. */
export declare function postgresStorageStatus(options: Pick<RestorePostgresOptions, 'dsn' | 'schema' | 'ssl' | 'signal'>, dependencies?: Pick<RestorePostgresDependencies, 'resolveConnection' | 'createClient'>): Promise<PostgresStorageStatus>;
export declare function createPostgresSafetyBackup(dsn: string, schema: string, output: string, ssl: TlsPolicy, environment?: NodeJS.ProcessEnv, signal?: AbortSignal, resume?: boolean, maxBytes?: number, ownership?: SafetyBackupOwnership): Promise<SafetyBackupInfo>;
export { postgresDumpInvocation } from './restore-policy.js';
//# sourceMappingURL=restore.d.ts.map