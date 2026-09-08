export interface TenantScope {
    readonly orgId: string;
    readonly tenantId: string;
}
export interface TenantRecord<T = unknown> {
    readonly key: string;
    readonly value: T;
}
export interface PostgresTenantStoreConfig {
    readonly adminConnectionString: string;
    readonly runtimeConnectionString: string;
    readonly schema: string;
    readonly ssl: false | {
        rejectUnauthorized: boolean;
    };
    readonly poolMax: number;
}
/**
 * A tenant-aware repository that never accepts scope from stored JSON. Every
 * operation opens one transaction and installs the server-derived scope with
 * transaction-local PostgreSQL settings before touching the RLS table.
 */
export declare class PostgresTenantRecordStore {
    private readonly pool;
    private readonly schemaName;
    private closing;
    private constructor();
    static create(config: PostgresTenantStoreConfig): Promise<PostgresTenantRecordStore>;
    list<T = unknown>(scope: TenantScope, unit: string, table: string): Promise<readonly TenantRecord<T>[]>;
    get<T = unknown>(scope: TenantScope, unit: string, table: string, key: string): Promise<T | undefined>;
    put(scope: TenantScope, unit: string, table: string, key: string, value: unknown): Promise<void>;
    delete(scope: TenantScope, unit: string, table: string, key: string): Promise<boolean>;
    close(): Promise<void>;
    private withScope;
    private verifyRuntimeBoundary;
}
//# sourceMappingURL=tenant-store.d.ts.map