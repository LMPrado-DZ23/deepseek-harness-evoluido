import type { KvFacet, StorageBackend } from '@deepseek-ai/dsh-storage';
export interface PostgresStorageBackendConfig {
    connectionString: string;
    schema: string;
    ssl: false | {
        rejectUnauthorized: boolean;
    };
    poolMax: number;
    heartbeatMs?: number;
    /** How long to wait before taking the maintenance lock again after losing its session. */
    maintenanceRetryMs?: number;
}
/** PostgreSQL KV backend with one dedicated, locked connection per open unit. */
export declare class PostgresStorageBackend implements StorageBackend {
    private readonly config;
    readonly kv: KvFacet;
    private readonly pool;
    private readonly ready;
    private readonly units;
    private closing;
    /** Dedicated session holding the shared maintenance lock while this Studio is up. */
    private maintenance;
    private maintenanceHeld;
    private maintenanceRetry;
    private readonly maintenanceRetryMs;
    constructor(config: PostgresStorageBackendConfig);
    /**
     * Announce "a Studio is using this schema" for as long as the process lives.
     * Shared, so several readers coexist; a restore that wants the schema takes
     * it exclusive and is refused while this session exists. Its own session is
     * what releases it, so a crashed Studio never leaves it stuck.
     *
     * The session is supervised: a dropped connection (failover, an idle reaper,
     * `pg_terminate_backend`, a network blip) would otherwise both crash the
     * process with an unhandled `error` event AND silently drop the guarantee,
     * leaving a live Studio that a restore is free to `DROP SCHEMA` under. On
     * loss it reconnects and takes the lock again; while it is not held, the
     * backend refuses to open new units instead of running unprotected.
     */
    private holdMaintenanceLock;
    /** The lock session died: stop claiming the guarantee, and try to take it again. */
    private onMaintenanceLost;
    /** Whether this Studio currently holds the shared maintenance lock on its schema. */
    get maintenanceLockHeld(): boolean;
    /** Resolve only after the schema and database connection are usable. */
    waitUntilReady(): Promise<void>;
    private openUnit;
    private materializeUnit;
    close(): Promise<void>;
    private doClose;
    private connectionConfig;
}
//# sourceMappingURL=backend.d.ts.map