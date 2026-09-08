import { type StorageExportBundle } from './bundle.js';
/** Ceiling shared by the worker, the operator CLI and the verifier: one number, one behaviour. */
export declare const BACKUP_MAX_BYTES_DEFAULT: number;
export declare const BACKUP_FILE_PATTERN: RegExp;
export declare const BACKUP_LEDGER_FILE = "backups.jsonl";
export declare const BACKUP_MIN_INTERVAL_MS: number;
export interface BackupResult {
    status: 'created' | 'failed';
    file: string | null;
    sha256: string | null;
    bytes: number;
    records: number;
    domains: number;
    startedAt: string;
    finishedAt: string;
    pruned: string[];
    /** Total removed; `pruned` is capped so a neglected directory cannot exhaust memory just by reporting cleanup. */
    prunedCount: number;
    error: string | null;
}
export type BackupLogLevel = 'info' | 'warn';
/** What actually produces one backup file. The scheduler only names files, prunes and records. */
export interface BackupRunner {
    run(target: string, signal?: AbortSignal): Promise<{
        sha256: string;
        bytes: number;
        records: number;
        domains: number;
    }>;
}
/**
 * Builds the whole bundle in THIS process. Fine for the operator CLI, which is
 * a process of its own; the Studio uses the child-process runner instead.
 */
export declare function inProcessBackupRunner(snapshot: () => Promise<StorageExportBundle>, options?: {
    maxBytes?: number;
}): BackupRunner;
export interface ChildBackupRunnerOptions {
    dsnRef: string;
    schema: string;
    ssl: 'off' | 'require' | 'verify-full';
    /** Hard ceiling for the file; beyond it the child gives up and removes what it had written. */
    maxBytes?: number;
    /** The child is killed after this long: a stuck backup must never become a stuck Studio. */
    timeoutMs?: number;
    /** Heap cap of the child, in MB. It holds one domain at a time, so this is a guard rail, not a target. */
    heapMb?: number;
    execPath?: string;
    workerPath?: string;
    env?: NodeJS.ProcessEnv;
}
/**
 * Runs the backup in a separate process (`backup-worker.js`), with a time
 * limit, a size limit and its own heap: the Studio's own memory and event loop
 * are never spent copying the database. The DSN is passed by **reference**;
 * the child reads it from its own environment, like every other seam here.
 */
export declare function childProcessBackupRunner(options: ChildBackupRunnerOptions): BackupRunner;
/**
 * The compiled worker next to this module. Under a TypeScript runner this file
 * is the source, so the built `lib/` sibling is used instead — the child is a
 * real Node process either way.
 */
export declare function defaultWorkerPath(): string;
export interface BackupSchedulerOptions {
    /** Either a runner (preferred) or a snapshot function, which is wrapped in the in-process runner. */
    runner?: BackupRunner;
    snapshot?: () => Promise<StorageExportBundle>;
    directory: string;
    /** Backup family, normally the PostgreSQL schema: it names the files and bounds pruning to this family only. */
    label: string;
    intervalMs: number;
    keep: number;
    now?: () => Date;
    log?: (level: BackupLogLevel, line: string) => void;
    /** Test seam for the per-file suffix; defaults to 6 random hex characters. */
    suffix?: () => string;
    signal?: AbortSignal;
}
/**
 * Periodic logical backup. Every run writes one self-verifying bundle
 * (`studio-backup-<label>-<stamp>-<suffix>.json`, mode 0600) with a `.sha256`
 * sidecar, appends one line to the `backups.jsonl` ledger and prunes older
 * bundles of the SAME label beyond `keep`. Only files matching
 * BACKUP_FILE_PATTERN with this label are ever removed. `start()` runs a first
 * backup immediately (a Studio that restarts often would otherwise never back
 * up) and then every `intervalMs`. A failed run is recorded and logged as a
 * warning; it never stops the schedule or the Studio.
 */
export declare class StorageBackupScheduler {
    private readonly options;
    private timer;
    private inFlight;
    private queued;
    private last;
    private readonly now;
    private readonly log;
    private readonly suffix;
    private readonly runner;
    constructor(options: BackupSchedulerOptions);
    get lastResult(): BackupResult | undefined;
    start(): void;
    /** Stops the schedule and DRAINS: when it returns, nothing is running and nothing is owed. */
    stop(): Promise<void>;
    /**
     * Serialized AND coalesced: at most one run in flight and at most one waiting.
     * A tick that arrives while a copy is running joins the one already queued —
     * otherwise a backup slower than the interval would grow a queue without
     * limit and the machine would spend the rest of its life copying.
     */
    runOnce(): Promise<BackupResult>;
    private startQueued;
    /** How many ticks joined the waiting run instead of starting one of their own. */
    get pending(): boolean;
    private execute;
    private prune;
    private record;
}
/**
 * Verify a backup file against its sidecar digest.
 *
 * STREAMED, and bounded. Reading the whole file into a Buffer meant a large
 * backup also became a large live allocation in the verifier. Here the
 * bytes go through the digest as they arrive, so memory stays flat whatever the
 * file weighs, and a file over `maxBytes` is refused instead of being read.
 */
export declare function verifyBackupFile(file: string, options?: {
    maxBytes?: number;
}): Promise<{
    file: string;
    bytes: number;
    sha256: string;
    matches: boolean;
}>;
//# sourceMappingURL=backup.d.ts.map