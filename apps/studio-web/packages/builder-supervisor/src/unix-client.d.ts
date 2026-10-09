import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { BuilderAttestation, BuilderErrorCode, BuildState, BuildStep, FinishResult, ManagedBuild, StepResult } from './model.js';
import { type BuildReferenceRequest, type ExecuteRequest, type ListManagedRequest, type PreflightRequest, type PrepareRequest } from './protocol.js';
export interface BuilderUnixClientCallOptions {
    readonly signal?: AbortSignal;
}
export interface BuilderUnixClientCredentials {
    resolve(reference: string, signal: AbortSignal): Promise<string | undefined>;
}
export interface BuilderUnixClientOptions {
    readonly socketPath: string;
    readonly credentialRef: string;
    readonly credentials: BuilderUnixClientCredentials;
    readonly timeoutMs?: number;
    readonly maxRequestBytes?: number;
    readonly maxResponseBytes?: number;
    readonly transport?: BuilderUnixClientTransport;
}
export interface BuilderUnixClient {
    preflight(body: PreflightRequest, options?: BuilderUnixClientCallOptions): Promise<BuilderAttestation>;
    prepare(body: PrepareRequest, options?: BuilderUnixClientCallOptions): Promise<{
        readonly build_ref: string;
        readonly state: 'PREPARED';
    }>;
    execute(body: ExecuteRequest, options?: BuilderUnixClientCallOptions): Promise<{
        readonly build_ref: string;
        readonly state: BuildState;
        readonly step: BuildStep;
        readonly result: StepResult;
    }>;
    cancel(body: BuildReferenceRequest, options?: BuilderUnixClientCallOptions): Promise<{
        readonly build_ref: string;
        readonly state: 'CANCELLED';
    }>;
    finish(body: BuildReferenceRequest, options?: BuilderUnixClientCallOptions): Promise<FinishResult>;
    listManaged(body: ListManagedRequest, options?: BuilderUnixClientCallOptions): Promise<{
        readonly builds: readonly ManagedBuild[];
    }>;
}
export interface BuilderUnixClientTransportRequest {
    readonly socketPath: string;
    readonly path: string;
    readonly method: 'POST';
    readonly headers: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
}
export interface BuilderUnixClientTransport {
    request(options: BuilderUnixClientTransportRequest, onResponse: (response: IncomingMessage) => void): ReturnType<typeof httpRequest>;
}
export type BuilderUnixClientErrorCode = 'ABORTED' | 'CREDENTIAL_UNAVAILABLE' | 'DEADLINE_EXCEEDED' | 'INVALID_CONFIGURATION' | 'INVALID_REQUEST' | 'INVALID_RESPONSE' | 'REQUEST_TOO_LARGE' | 'RESPONSE_TOO_LARGE' | 'SOCKET_UNAVAILABLE' | 'TRANSPORT_ERROR' | 'UNAUTHORIZED' | 'NOT_FOUND' | 'METHOD_NOT_ALLOWED' | 'INTERNAL' | 'SUPERVISOR_UNAVAILABLE' | 'SUPERVISOR_SHUTTING_DOWN' | BuilderErrorCode;
export declare class BuilderUnixClientError extends Error {
    readonly code: BuilderUnixClientErrorCode;
    readonly status: number | undefined;
    constructor(code: BuilderUnixClientErrorCode, status?: number);
}
export type BuilderUnixClientFailureState = 'BLOCKED_EXTERNAL' | 'BUILD_FAILED' | 'CANCELLED' | 'INTERNAL';
export interface BuilderUnixClientFailureClassification {
    readonly state: BuilderUnixClientFailureState;
    readonly code: BuilderUnixClientErrorCode | 'UNKNOWN';
}
/**
 * Classifies the closed client error union for the future Prompt-to-App adapter.
 * This function is deliberately not wired to any call site in the foundation.
 */
export declare function classifyBuilderUnixClientFailure(error: unknown): BuilderUnixClientFailureClassification;
export declare function createBuilderUnixClient(options: BuilderUnixClientOptions): BuilderUnixClient;
//# sourceMappingURL=unix-client.d.ts.map