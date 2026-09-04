export declare const CAPACITY_RESOURCES: readonly ["prompt-job", "build", "preview"];
export type CapacityResource = typeof CAPACITY_RESOURCES[number];
export type CapacityLimit = Readonly<{
    global: number;
    perTenant: number;
    perProject: number;
}>;
export type CapacityLimits = Readonly<Record<CapacityResource, CapacityLimit>>;
export type CapacityScope = Readonly<{
    orgId: string;
    tenantId: string;
    projectId: string;
}>;
export type CapacityRequest = Readonly<{
    resource: CapacityResource;
    units?: number;
}>;
export type AcquireBundleRequest = Readonly<{
    ownerId: string;
    scope: CapacityScope;
    requests: readonly CapacityRequest[];
    ttlMs?: number;
}>;
export type LeaseReference = Readonly<{
    leaseId: string;
    fencingToken: number;
}>;
export type CapacityLease = LeaseReference & Readonly<{
    ownerId: string;
    scope: CapacityScope;
    allocations: Readonly<Record<CapacityResource, number>>;
    acquiredAt: number;
    expiresAt: number;
}>;
export type TenantCapacityUsage = Readonly<{
    orgId: string;
    tenantId: string;
    units: number;
}>;
export type ProjectCapacityUsage = CapacityScope & Readonly<{
    units: number;
}>;
export type ResourceCapacityUsage = Readonly<{
    resource: CapacityResource;
    global: number;
    tenants: readonly TenantCapacityUsage[];
    projects: readonly ProjectCapacityUsage[];
}>;
export type CapacitySnapshot = Readonly<{
    capturedAt: number;
    limits: CapacityLimits;
    leases: readonly CapacityLease[];
    usage: readonly ResourceCapacityUsage[];
}>;
export type ReconcileResult = Readonly<{
    reconciledAt: number;
    expired: readonly LeaseReference[];
    activeLeaseCount: number;
}>;
export type CapacityLimitLevel = 'global' | 'tenant' | 'project';
export type CapacityErrorCode = 'CAPACITY_EXCEEDED' | 'INVALID_CAPACITY_REQUEST' | 'LEASE_NOT_FOUND' | 'STALE_FENCING_TOKEN' | 'LEASE_ID_COLLISION';
export declare class CapacityGovernorError extends Error {
    readonly code: CapacityErrorCode;
    readonly details: Readonly<Record<string, string | number>>;
    constructor(code: CapacityErrorCode, message: string, details?: Readonly<Record<string, string | number>>);
}
export interface CapacityGovernor {
    acquireBundle(request: AcquireBundleRequest): Promise<CapacityLease>;
    heartbeat(reference: LeaseReference, ttlMs?: number): Promise<CapacityLease>;
    release(reference: LeaseReference): Promise<void>;
    reconcile(): Promise<ReconcileResult>;
    snapshot(): Promise<CapacitySnapshot>;
}
export declare const DEFAULT_CAPACITY_LIMITS: CapacityLimits;
export declare const DEFAULT_LEASE_TTL_MS = 120000;
export declare const MIN_LEASE_TTL_MS = 1000;
export declare const MAX_LEASE_TTL_MS = 3600000;
//# sourceMappingURL=model.d.ts.map