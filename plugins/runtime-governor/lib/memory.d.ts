import { type AcquireBundleRequest, type CapacityGovernor, type CapacityLease, type CapacityLimits, type CapacitySnapshot, type LeaseReference, type ReconcileResult } from './model.js';
export type MemoryCapacityGovernorOptions = Readonly<{
    limits?: CapacityLimits;
    defaultTtlMs?: number;
    now?: () => number;
    createId?: () => string;
    initialFencingToken?: number;
}>;
export declare class MemoryCapacityGovernor implements CapacityGovernor {
    #private;
    constructor(options?: MemoryCapacityGovernorOptions);
    acquireBundle(request: AcquireBundleRequest): Promise<CapacityLease>;
    heartbeat(reference: LeaseReference, ttlMs?: number): Promise<CapacityLease>;
    release(reference: LeaseReference): Promise<void>;
    reconcile(): Promise<ReconcileResult>;
    snapshot(): Promise<CapacitySnapshot>;
}
//# sourceMappingURL=memory.d.ts.map