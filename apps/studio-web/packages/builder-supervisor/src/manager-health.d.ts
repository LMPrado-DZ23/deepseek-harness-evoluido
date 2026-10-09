import { type BuilderRuntimeScopeId } from './runtime-scope.js';
export type BuilderRuntimeHealthState = 'STARTING' | 'HEALTHY' | 'DEGRADED' | 'RETIRING' | 'STOPPED' | 'BLOCKED_EXTERNAL';
export type BuilderRuntimeHealthCode = 'NONE' | 'START_FAILED' | 'CONFIG_INVALID' | 'DRAIN_FAILED' | 'SHUTDOWN_FAILED' | 'EXTERNAL_DEPENDENCY';
export interface BuilderRuntimeHealth {
    readonly version: 1;
    readonly scope_id: BuilderRuntimeScopeId;
    readonly state: BuilderRuntimeHealthState;
    readonly since: string;
    readonly updated_at: string;
    readonly code: BuilderRuntimeHealthCode;
}
export interface BuilderRuntimeHealthPort {
    write(value: BuilderRuntimeHealth): Promise<void>;
}
export type BuilderRuntimeHealthMkdir = (path: string, options: {
    readonly mode: number;
}) => Promise<unknown>;
export declare class MemoryBuilderRuntimeHealthStore implements BuilderRuntimeHealthPort {
    readonly values: Map<`s_${string}`, BuilderRuntimeHealth>;
    write(value: BuilderRuntimeHealth): Promise<void>;
}
export declare class FileBuilderRuntimeHealthStore implements BuilderRuntimeHealthPort {
    private readonly root;
    private readonly uid;
    private readonly makeDirectory;
    constructor(root: string, uid?: number | undefined, makeDirectory?: BuilderRuntimeHealthMkdir);
    write(value: BuilderRuntimeHealth): Promise<void>;
}
export declare function runtimeHealth(scopeId: BuilderRuntimeScopeId, state: BuilderRuntimeHealthState, previous: BuilderRuntimeHealth | undefined, code?: BuilderRuntimeHealthCode, now?: Date): BuilderRuntimeHealth;
export declare function sanitizeRuntimeHealthCode(error: unknown): {
    readonly state: 'DEGRADED' | 'BLOCKED_EXTERNAL';
    readonly code: BuilderRuntimeHealthCode;
};
//# sourceMappingURL=manager-health.d.ts.map