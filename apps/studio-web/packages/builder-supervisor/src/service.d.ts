import { type ArtifactIngressPort } from './artifact-ingress.js';
import type { BuilderExecutionPort } from './docker-adapter.js';
import type { BuilderAttestation, ManagedBuild } from './model.js';
import type { BuilderRpcMethods } from './protocol.js';
import { type ReplayClaimPort } from './replay.js';
import type { BuildIdClaimPort } from './persistent-replay.js';
export interface BuilderSupervisorOptions {
    readonly artifactIngress?: ArtifactIngressPort;
    readonly adapter: BuilderExecutionPort;
    readonly replay?: ReplayClaimPort;
    readonly createReference?: () => string;
    readonly maxBuilds?: number;
    readonly maxConcurrentSteps?: number;
    readonly buildClaims: BuildIdClaimPort;
}
export declare class BuilderSupervisor implements BuilderRpcMethods {
    #private;
    private readonly options;
    constructor(options: BuilderSupervisorOptions);
    initialize(signal: AbortSignal): Promise<void>;
    preflight(body: Parameters<BuilderRpcMethods['preflight']>[0], signal: AbortSignal): Promise<BuilderAttestation>;
    prepare(body: Parameters<BuilderRpcMethods['prepare']>[0], signal: AbortSignal): Promise<{
        readonly build_ref: string;
        readonly state: 'PREPARED';
    }>;
    execute(body: Parameters<BuilderRpcMethods['execute']>[0], signal: AbortSignal): Promise<Awaited<ReturnType<BuilderRpcMethods['execute']>>>;
    cancel(body: Parameters<BuilderRpcMethods['cancel']>[0], _signal: AbortSignal): Promise<{
        readonly build_ref: string;
        readonly state: 'CANCELLED';
    }>;
    finish(body: Parameters<BuilderRpcMethods['finish']>[0], signal: AbortSignal): Promise<Awaited<ReturnType<BuilderRpcMethods['finish']>>>;
    listManaged(body: Parameters<BuilderRpcMethods['listManaged']>[0], signal: AbortSignal): Promise<{
        readonly builds: readonly ManagedBuild[];
    }>;
}
//# sourceMappingURL=service.d.ts.map