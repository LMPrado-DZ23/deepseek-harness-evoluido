import { type Stats } from 'node:fs';
import { type FileHandle } from 'node:fs/promises';
import { type BuilderRuntimeRegistry, type BuilderRuntimeRegistrySlot } from './manager-registry.js';
import { type BuilderRuntimeScopeId } from './runtime-scope.js';
import { type BuilderSupervisorRootPolicy } from './supervisor-config.js';
export type BuilderRegistryWriteErrorCode = 'INVALID_RUNTIME_ACTIVATION' | 'RUNTIME_REGISTRY_BUSY' | 'RUNTIME_REGISTRY_CONFLICT' | 'RUNTIME_REGISTRY_FULL' | 'RUNTIME_REGISTRY_RECOVERY_FAILED';
export declare class BuilderRegistryWriteError extends Error {
    readonly code: BuilderRegistryWriteErrorCode;
    constructor(code: BuilderRegistryWriteErrorCode);
}
export interface BuilderRuntimeActivationRequest {
    readonly installationId: string;
    readonly scopeId: BuilderRuntimeScopeId;
    readonly configReference: `file:${string}`;
    readonly configSha256: string;
    readonly roots: BuilderSupervisorRootPolicy;
}
export interface BuilderRuntimeActivationResult {
    readonly state: 'ACTIVATED' | 'UNCHANGED';
    readonly generation: number;
    readonly registryReference: `file:${string}`;
    readonly registrySha256: string;
    readonly scopeId: BuilderRuntimeScopeId;
}
export interface BuilderRegistryWriterRuntime {
    readonly beforeRegistryRename?: () => Promise<void>;
    readonly afterRegistryRename?: () => Promise<void>;
    readonly afterAuthorityCommitted?: () => Promise<void>;
}
interface RegistryWriterAuthority {
    readonly version: 1;
    readonly installationId: string;
    readonly phase: 'pending' | 'committed';
    readonly generation: number;
    readonly registrySha256: string;
    readonly previousRegistrySha256?: string;
    readonly registryBytes: Buffer;
}
export declare function activateBuilderRuntimeSlot(request: BuilderRuntimeActivationRequest, runtime?: BuilderRegistryWriterRuntime): Promise<BuilderRuntimeActivationResult>;
declare function canonicalRegistryBytes(installationId: string, generation: number, slots: readonly BuilderRuntimeRegistrySlot[]): Buffer;
declare function assertRegistryHost(stateManager: string, filesystemType: number): void;
declare function assertMissing(error: unknown): void;
declare function reconcileAuthority(authority: RegistryWriterAuthority | undefined, current: BuilderRuntimeRegistry | undefined, authorityPath: string, registryPath: string, registryReference: `file:${string}`, stateManager: string, configManager: string, roots: BuilderSupervisorRootPolicy): Promise<BuilderRuntimeRegistry | undefined>;
declare function authorityBytes(input: Omit<RegistryWriterAuthority, 'version'>): Buffer;
declare function ensurePrivateDirectory(path: string): Promise<string>;
interface GuardOpenTestRuntime {
    readonly afterOpenMissing?: () => Promise<void>;
    readonly beforeCreate?: () => Promise<void>;
    readonly afterCreated?: () => Promise<void>;
}
declare function openPermanentGuard(path: string, directory: string, runtime?: GuardOpenTestRuntime): Promise<{
    readonly path: string;
    readonly handle: FileHandle;
    readonly identity: Stats;
}>;
declare function acquireGuardWithProcess(handle: FileHandle, flockPath: string, timeoutMs: number): Promise<void>;
export declare const MANAGER_REGISTRY_WRITER_TEST_ONLY: Readonly<{
    canonicalRegistryBytes: typeof canonicalRegistryBytes;
    authorityBytes: typeof authorityBytes;
    assertRegistryHost: typeof assertRegistryHost;
    acquireGuardWithProcess: typeof acquireGuardWithProcess;
    reconcileAuthority: typeof reconcileAuthority;
    ensurePrivateDirectory: typeof ensurePrivateDirectory;
    openPermanentGuard: typeof openPermanentGuard;
    assertMissing: typeof assertMissing;
}>;
export {};
//# sourceMappingURL=manager-registry-writer.d.ts.map