import type { KvFacet, StorageBackend } from '@deepseek-ai/dsh-storage';
export interface PostgresStorageBackendConfig {
    connectionString: string;
    schema: string;
    ssl: false | {
        rejectUnauthorized: boolean;
    };
    poolMax: number;
    heartbeatMs?: number;
}
/** PostgreSQL KV backend with one dedicated, locked connection per open unit. */
export declare class PostgresStorageBackend implements StorageBackend {
    private readonly config;
    readonly kv: KvFacet;
    private readonly pool;
    private readonly ready;
    private readonly units;
    private closing;
    constructor(config: PostgresStorageBackendConfig);
    /** Resolve only after the schema and database connection are usable. */
    waitUntilReady(): Promise<void>;
    private openUnit;
    private materializeUnit;
    close(): Promise<void>;
    private doClose;
    private connectionConfig;
    private lockName;
}
//# sourceMappingURL=backend.d.ts.map