import { spawn } from 'node:child_process';
import { type Stats } from 'node:fs';
import { type FileHandle } from 'node:fs/promises';
import { type BuilderRuntimeScopeId } from './runtime-scope.js';
import type { BuilderSupervisorRootPolicy } from './supervisor-config.js';
export declare class BuilderManagerStateError extends Error {
    readonly code: 'MANAGER_ALREADY_RUNNING' | 'INVALID_MANAGER_STATE';
    constructor(code: 'MANAGER_ALREADY_RUNNING' | 'INVALID_MANAGER_STATE');
}
export interface BuilderManagerLease {
    close(): Promise<void>;
}
export interface BuilderManagerLeasePort {
    acquire(installationId: string, roots: BuilderSupervisorRootPolicy): Promise<BuilderManagerLease>;
}
export interface BuilderManagerCheckpointSlot {
    readonly scopeId: BuilderRuntimeScopeId;
    readonly configReference: `file:${string}`;
    readonly configSha256: string;
}
export interface BuilderManagerCheckpoint {
    readonly version: 1;
    readonly installationId: string;
    readonly generation: number;
    readonly registrySha256: string;
    readonly slots: readonly BuilderManagerCheckpointSlot[];
}
export interface BuilderManagerCheckpointPort {
    load(installationId: string, roots: BuilderSupervisorRootPolicy): Promise<BuilderManagerCheckpoint | undefined>;
    save(value: BuilderManagerCheckpoint, roots: BuilderSupervisorRootPolicy): Promise<void>;
}
export interface BuilderManagerStateRuntime {
    readonly spawnFlock: typeof spawn;
    readonly getuid: () => number | undefined;
    readonly open: (path: string, flags: string | number, mode?: number) => Promise<FileHandle>;
    readonly lstat: (path: string) => Promise<Stats>;
    readonly mkdir: (path: string, options: {
        readonly mode: number;
    }) => Promise<void>;
    readonly readdir: (path: string) => Promise<string[]>;
    readonly realpath: (path: string) => Promise<string>;
    readonly rename: (from: string, to: string) => Promise<void>;
    readonly statfs: (path: string) => Promise<{
        readonly type: number | bigint;
    }>;
    readonly unlink: (path: string) => Promise<void>;
}
export declare class MemoryBuilderManagerLeasePort implements BuilderManagerLeasePort {
    #private;
    acquire(): Promise<BuilderManagerLease>;
}
export declare class MemoryBuilderManagerCheckpointPort implements BuilderManagerCheckpointPort {
    value: BuilderManagerCheckpoint | undefined;
    load(): Promise<BuilderManagerCheckpoint | undefined>;
    save(value: BuilderManagerCheckpoint): Promise<void>;
}
export declare class FileBuilderManagerAuthority implements BuilderManagerLeasePort, BuilderManagerCheckpointPort {
    #private;
    constructor(runtime?: Partial<BuilderManagerStateRuntime>);
    acquire(installationId: string, roots: BuilderSupervisorRootPolicy): Promise<BuilderManagerLease>;
    load(installationId: string, roots: BuilderSupervisorRootPolicy): Promise<BuilderManagerCheckpoint | undefined>;
    save(value: BuilderManagerCheckpoint, roots: BuilderSupervisorRootPolicy): Promise<void>;
}
//# sourceMappingURL=manager-state.d.ts.map