import { type AcquireBundleRequest, type DistributedCapacityGovernor, type CapacityLease, type CapacityLimits, type CapacitySnapshot, type CapacityTakeoverRequest, type LeaseReference, type ReconcileResult } from '@dz23-studio/runtime-governor';
export interface PostgresCapacityGovernorOptions {
    readonly connectionString: string;
    readonly schema: string;
    readonly ssl: false | {
        readonly rejectUnauthorized: boolean;
    };
    readonly poolMax?: number;
    readonly limits?: CapacityLimits;
    readonly defaultTtlMs?: number;
    readonly lockTimeoutMs?: number;
    readonly statementTimeoutMs?: number;
    readonly createId?: () => string;
    readonly holderId?: string;
}
/** PostgreSQL-backed capacity authority. Every admission is serialized by capacity_meta. */
export declare class PostgresCapacityGovernor implements DistributedCapacityGovernor {
    #private;
    constructor(options: PostgresCapacityGovernorOptions);
    waitUntilReady(): Promise<void>;
    acquireBundle(request: AcquireBundleRequest): Promise<CapacityLease>;
    heartbeat(reference: LeaseReference, ttlMs?: number): Promise<CapacityLease>;
    release(reference: LeaseReference): Promise<void>;
    takeover(request: CapacityTakeoverRequest): Promise<CapacityLease>;
    reconcile(): Promise<ReconcileResult>;
    snapshot(): Promise<CapacitySnapshot>;
    close(): Promise<void>;
}
//# sourceMappingURL=capacity.d.ts.map