import { type Stats } from 'node:fs';
import { type FileHandle } from 'node:fs/promises';
import { type BuilderRuntimeScopeId } from './runtime-scope.js';
import type { BuilderSupervisorRootPolicy } from './supervisor-config.js';
export declare class BuilderRuntimeRegistryError extends Error {
    readonly code = "INVALID_RUNTIME_REGISTRY";
    constructor();
}
export interface BuilderRuntimeRegistrySlot {
    readonly scopeId: BuilderRuntimeScopeId;
    readonly configReference: `file:${string}`;
    readonly configSha256: string;
    readonly state: 'active' | 'retiring';
}
export interface BuilderRuntimeRegistry {
    readonly version: 1;
    readonly installationId: string;
    readonly generation: number;
    readonly slots: readonly BuilderRuntimeRegistrySlot[];
    readonly sha256: string;
}
export interface ManagerSecureFileRuntime {
    readonly platform: NodeJS.Platform;
    readonly uid: number | undefined;
    readonly noFollowFlag: number;
    readonly open: (path: string, flags: number) => Promise<FileHandle>;
    readonly lstat: (path: string) => Promise<Stats>;
    readonly realpath: (path: string) => Promise<string>;
}
export declare function builderRuntimeRegistryPath(roots: BuilderSupervisorRootPolicy): string;
export declare function loadBuilderRuntimeRegistry(registryReference: string, roots: BuilderSupervisorRootPolicy, runtime?: ManagerSecureFileRuntime): Promise<BuilderRuntimeRegistry>;
export declare function parseBuilderRuntimeRegistryBytes(bytes: Buffer, roots: BuilderSupervisorRootPolicy): BuilderRuntimeRegistry;
//# sourceMappingURL=manager-registry.d.ts.map