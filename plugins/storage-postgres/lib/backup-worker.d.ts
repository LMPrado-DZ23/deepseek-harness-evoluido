export interface WorkerArgs {
    dsnRef: string;
    schema: string;
    ssl: 'off' | 'require' | 'verify-full';
    out: string;
    maxBytes: number;
    now?: () => Date;
    signal?: AbortSignal;
}
export interface WorkerReport {
    sha256: string;
    bytes: number;
    records: number;
    domains: number;
}
/** Writes the bundle to `out` and reports it, holding at most one domain in memory at a time. */
export declare function writeBackupBundle(args: WorkerArgs, dsn: string): Promise<WorkerReport>;
export declare function parseWorkerArgs(argv: readonly string[]): WorkerArgs;
//# sourceMappingURL=backup-worker.d.ts.map