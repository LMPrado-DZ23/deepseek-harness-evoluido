import { type BuilderAttestation, type BuildState, type BuildStep, type FinishResult, type ManagedBuild, type StepResult } from './model.js';
import { type RpcReplayPort } from './replay.js';
export declare const BUILDER_RPC_PATH = "/v1/rpc";
export declare const BUILDER_RPC_MAX_BODY_BYTES: number;
export declare const BUILDER_RPC_MAX_RESPONSE_BYTES: number;
export declare const BUILDER_CREDENTIAL_REFERENCE_MAX_BYTES: number;
interface RequestIdentity {
    readonly request_id: string;
}
export interface ListManagedRequest extends RequestIdentity {
    readonly build_id?: string;
}
export interface PreflightRequest extends RequestIdentity {
}
export interface PrepareRequest extends RequestIdentity {
    readonly build_id: string;
    readonly upload_ref: string;
}
export interface ExecuteRequest extends RequestIdentity {
    readonly build_ref: string;
    readonly step: BuildStep;
}
export interface BuildReferenceRequest extends RequestIdentity {
    readonly build_ref: string;
}
export type BuilderRpcRequest = {
    readonly operation: 'preflight';
    readonly body: PreflightRequest;
} | {
    readonly operation: 'prepare';
    readonly body: PrepareRequest;
} | {
    readonly operation: 'execute';
    readonly body: ExecuteRequest;
} | {
    readonly operation: 'cancel' | 'finish';
    readonly body: BuildReferenceRequest;
} | {
    readonly operation: 'listManaged';
    readonly body: ListManagedRequest;
};
export interface BuilderRpcMethods {
    readonly preflight: (body: PreflightRequest, signal: AbortSignal) => Promise<BuilderAttestation>;
    readonly prepare: (body: PrepareRequest, signal: AbortSignal) => Promise<{
        readonly build_ref: string;
        readonly state: 'PREPARED';
    }>;
    readonly execute: (body: ExecuteRequest, signal: AbortSignal) => Promise<{
        readonly build_ref: string;
        readonly state: BuildState;
        readonly step: BuildStep;
        readonly result: StepResult;
    }>;
    readonly cancel: (body: BuildReferenceRequest, signal: AbortSignal) => Promise<{
        readonly build_ref: string;
        readonly state: 'CANCELLED';
    }>;
    readonly finish: (body: BuildReferenceRequest, signal: AbortSignal) => Promise<FinishResult>;
    readonly listManaged: (body: ListManagedRequest, signal: AbortSignal) => Promise<{
        readonly builds: readonly ManagedBuild[];
    }>;
}
export interface BuilderRpcInput {
    readonly path: string;
    readonly method: string;
    readonly headers: Readonly<Record<string, string | undefined>>;
    readonly body: Uint8Array;
    readonly signal: AbortSignal;
}
export interface BuilderRpcOutput {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
}
export declare function parseBuilderRpcRequest(value: unknown): BuilderRpcRequest;
export declare function createBuilderRpcHandler(options: {
    readonly credentialRef: string;
    readonly credentials: {
        resolve(reference: string): Promise<string | undefined>;
    };
    readonly methods: BuilderRpcMethods;
    readonly replay?: RpcReplayPort;
}): {
    handle: (input: BuilderRpcInput) => Promise<BuilderRpcOutput>;
};
export declare function isValidBuilderRpcResult(request: BuilderRpcRequest, value: unknown): boolean;
export declare function isBuilderCredentialReference(value: string): boolean;
export {};
//# sourceMappingURL=protocol.d.ts.map