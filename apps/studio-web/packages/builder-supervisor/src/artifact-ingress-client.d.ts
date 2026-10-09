import { request as httpRequest } from 'node:http';
import type { ArtifactBeginResult } from './artifact-ingress.js';
import type { BuilderUnixClientCredentials } from './unix-client.js';
export interface ArtifactIngressUnixClientOptions {
    readonly socketPath: string;
    readonly credentialRef: string;
    readonly credentials: BuilderUnixClientCredentials;
    readonly timeoutMs?: number;
    readonly request?: typeof httpRequest;
}
export interface ArtifactIngressUnixClient {
    begin(input: {
        readonly requestId: string;
        readonly buildId: string;
        readonly contentLength: number;
        readonly wireSha256: string;
    }, signal?: AbortSignal): Promise<ArtifactBeginResult>;
    upload(input: {
        readonly uploadRef: string;
        readonly contentLength: number;
        readonly source: AsyncIterable<Uint8Array>;
    }, signal?: AbortSignal): Promise<ArtifactBeginResult>;
    abort(input: {
        readonly requestId: string;
        readonly uploadRef: string;
    }, signal?: AbortSignal): Promise<void>;
}
export declare class ArtifactIngressUnixClientError extends Error {
    readonly code: string;
    readonly status?: number | undefined;
    constructor(code: string, status?: number | undefined);
}
export type ArtifactIngressUnixClientFailureState = 'BLOCKED_EXTERNAL' | 'BUILD_FAILED' | 'CANCELLED' | 'INTERNAL';
export interface ArtifactIngressUnixClientFailureClassification {
    readonly state: ArtifactIngressUnixClientFailureState;
    readonly code: string;
}
export declare function classifyArtifactIngressUnixClientFailure(error: unknown): ArtifactIngressUnixClientFailureClassification;
export declare function createArtifactIngressUnixClient(options: ArtifactIngressUnixClientOptions): ArtifactIngressUnixClient;
//# sourceMappingURL=artifact-ingress-client.d.ts.map