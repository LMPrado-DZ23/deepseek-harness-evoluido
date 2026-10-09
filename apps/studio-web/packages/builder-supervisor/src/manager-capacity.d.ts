import type { BuilderRuntimeScopeId } from './runtime-scope.js';
export interface GlobalBuilderCapacityPort {
    acquire(scopeId: BuilderRuntimeScopeId, signal?: AbortSignal): Promise<() => void>;
}
export declare class FairGlobalBuilderCapacity implements GlobalBuilderCapacityPort {
    #private;
    readonly maximum: number;
    readonly maximumPending: number;
    readonly maximumPendingPerScope: number;
    constructor(maximum: number, maximumPending?: number, maximumPendingPerScope?: number);
    acquire(scopeId: BuilderRuntimeScopeId, signal?: AbortSignal): Promise<() => void>;
    get active(): number;
    get pending(): number;
}
//# sourceMappingURL=manager-capacity.d.ts.map