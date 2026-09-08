export declare const DEFAULT_ARTIFACT_RETENTION_POLICY: Readonly<{
    failedRetentionMs: number;
    supersededPassedRetentionMs: number;
    preserveNewestPerProject: 3;
    tenantQuotaBytes: number;
    globalQuotaBytes: number;
    freeSpaceFloorBytes: number;
}>;
export type ArtifactRunStatus = 'PENDING' | 'RUNNING' | 'PASSED' | 'FAILED' | 'INTERRUPTED' | 'CANCELLED';
export type ArtifactRetentionCandidate = Readonly<{
    artifactId: string;
    orgId: string;
    tenantId: string;
    projectId: string;
    runId: string;
    directory: string;
    status: ArtifactRunStatus;
    completedAt: number;
    active?: boolean;
    previewActive?: boolean;
    latest?: boolean;
    valid?: boolean;
}>;
export type ArtifactRetentionPolicy = Readonly<{
    failedRetentionMs: number;
    supersededPassedRetentionMs: number;
    preserveNewestPerProject: number;
    tenantQuotaBytes: number;
    globalQuotaBytes: number;
    freeSpaceFloorBytes: number;
}>;
export type RetentionDecision = 'KEEP' | 'DELETE' | 'SKIP_UNSAFE';
export type RetentionPhase = 'PLANNED' | 'DRY_RUN' | 'RENAMED' | 'RECOVERED' | 'DELETING' | 'REMOVED' | 'RESTORED';
export type RetentionOutcome = 'SATISFIED' | 'PROJECTED_SATISFIED' | 'QUOTA_UNSATISFIABLE' | 'BLOCKED_UNSAFE';
export type FilesystemIdentity = Readonly<{
    device: string;
    inode: string;
    treeHash: string;
}>;
export type RetentionManifestEntry = Readonly<{
    artifactId: string;
    orgId: string;
    tenantId: string;
    projectId: string;
    runId: string;
    source: string;
    trash: string;
    status: ArtifactRunStatus;
    completedAt: number;
    sizeBytes: number;
    logicalBytes: number;
    allocatedBytes: number;
    identity?: FilesystemIdentity;
    protectionGeneration?: string;
    decision: RetentionDecision;
    reason: string;
    phase: RetentionPhase;
}>;
export type RetentionQuotaSnapshot = Readonly<{
    globalBytes: number;
    globalLogicalBytes: number;
    globalAllocatedBytes: number;
    countedBytes: number;
    countedLogicalBytes: number;
    countedAllocatedBytes: number;
    uncountedBytes: number;
    uncountedLogicalBytes: number;
    uncountedAllocatedBytes: number;
    attributionComplete: boolean;
    tenantBytes: Readonly<Record<string, number>>;
    freeBytes: number;
    globalOverQuota: boolean;
    tenantsOverQuota: readonly string[];
    belowFreeSpaceFloor: boolean;
}>;
export type RetentionManifest = Readonly<{
    schemaVersion: 1;
    executionId: string;
    fencingToken: string;
    createdAt: number;
    completedAt?: number;
    dryRun: boolean;
    artifactRoot: string;
    policy: ArtifactRetentionPolicy;
    outcome: RetentionOutcome;
    before: RetentionQuotaSnapshot;
    projectedAfter: RetentionQuotaSnapshot;
    after?: RetentionQuotaSnapshot;
    offlineGeneration?: string;
    entries: readonly RetentionManifestEntry[];
    manifestPath: string;
}>;
export type RetentionPhaseEvent = Readonly<{
    artifactId: string;
    phase: RetentionPhase;
    manifestPath: string;
}>;
export type ProtectionReservation = Readonly<{
    generation: string;
    protected: boolean;
    reason?: string;
    validate: () => boolean | Promise<boolean>;
    release: () => void | Promise<void>;
}>;
export type OfflineCleanupLease = Readonly<{
    generation: string;
    validate: () => boolean | Promise<boolean>;
    release: () => void | Promise<void>;
}>;
export type ArtifactRetentionOptions = Readonly<{
    artifactRoot: string;
    policy?: Partial<ArtifactRetentionPolicy>;
    now?: () => number;
    createExecutionId?: () => string;
    freeBytes?: (root: string) => Promise<number>;
    resolveProtection?: (candidate: ArtifactRetentionCandidate) => ProtectionReservation | Promise<ProtectionReservation>;
    beginOfflineCleanup?: () => OfflineCleanupLease | Promise<OfflineCleanupLease>;
    onPhase?: (event: RetentionPhaseEvent) => void | Promise<void>;
}>;
export declare class ArtifactRetentionError extends Error {
    readonly code: 'INVALID_RETENTION_CONFIG' | 'UNSAFE_ARTIFACT_ROOT' | 'GC_IO_FAILURE' | 'GC_ALREADY_RUNNING';
    constructor(code: 'INVALID_RETENTION_CONFIG' | 'UNSAFE_ARTIFACT_ROOT' | 'GC_IO_FAILURE' | 'GC_ALREADY_RUNNING', message: string);
}
export declare class ArtifactRetentionGarbageCollector {
    #private;
    constructor(options: ArtifactRetentionOptions);
    collect(candidates: readonly ArtifactRetentionCandidate[], options?: Readonly<{
        dryRun?: boolean;
    }>): Promise<RetentionManifest>;
    recoverOffline(currentCandidates?: readonly ArtifactRetentionCandidate[]): Promise<RetentionManifest>;
}
export declare function readRetentionManifest(path: string): Promise<RetentionManifest>;
//# sourceMappingURL=retention.d.ts.map