import type { PreparedArtifact } from './docker-adapter.js';
import type { BuilderAttestation } from './model.js';
export declare const ARTIFACT_UPLOAD_MAX_ENTRIES = 20000;
export declare const ARTIFACT_UPLOAD_MAX_LOGICAL_BYTES: number;
export declare const ARTIFACT_UPLOAD_MAX_FILE_BYTES: number;
export declare const ARTIFACT_UPLOAD_MAX_WIRE_BYTES: number;
export type ArtifactUploadState = 'RECEIVING' | 'READY' | 'CONSUMING' | 'CONSUMED' | 'FAILED';
export type ArtifactIngressErrorCode = 'ARTIFACT_CONFLICT' | 'ARTIFACT_INVALID' | 'ARTIFACT_NOT_FOUND' | 'ARTIFACT_NOT_READY' | 'ARTIFACT_QUOTA_EXCEEDED' | 'ARTIFACT_TIMEOUT' | 'CLEANUP_INCOMPLETE' | 'INVALID_CONFIGURATION';
export declare class ArtifactIngressError extends Error {
    readonly code: ArtifactIngressErrorCode;
    constructor(code: ArtifactIngressErrorCode);
}
export interface ArtifactBeginInput {
    readonly buildId: string;
    readonly contentLength: number;
    readonly wireSha256: string;
}
export interface ArtifactBeginResult {
    readonly uploadRef: string;
    readonly state: ArtifactUploadState;
    readonly idempotent: boolean;
}
export interface ArtifactConsumeBinding {
    readonly buildId: string;
    readonly attestation: BuilderAttestation;
}
export interface ClaimedArtifact {
    readonly artifact: PreparedArtifact;
    complete(): Promise<void>;
    fail(): Promise<void>;
}
export interface ArtifactIngressPort {
    begin(input: ArtifactBeginInput): Promise<ArtifactBeginResult>;
    upload(uploadRef: string, source: AsyncIterable<Uint8Array>, contentLength: number, signal: AbortSignal): Promise<ArtifactBeginResult>;
    abort(uploadRef: string): Promise<void>;
    claim(uploadRef: string, binding: ArtifactConsumeBinding): Promise<ClaimedArtifact>;
    sweep(): Promise<number>;
}
export interface ArtifactIngressStoreOptions {
    readonly spoolRoot: string;
    readonly scopeId: string;
    readonly imageDigest: string;
    readonly policySha256: string;
    readonly maxReservedBytes?: number;
    readonly receivingTtlMs?: number;
    readonly readyTtlMs?: number;
    readonly now?: () => number;
    readonly createReference?: () => string;
}
export declare class ArtifactIngressStore implements ArtifactIngressPort {
    #private;
    constructor(options: ArtifactIngressStoreOptions);
    begin(input: ArtifactBeginInput): Promise<ArtifactBeginResult>;
    upload(uploadRef: string, source: AsyncIterable<Uint8Array>, contentLength: number, signal: AbortSignal): Promise<ArtifactBeginResult>;
    abort(uploadRef: string): Promise<void>;
    claim(uploadRef: string, binding: ArtifactConsumeBinding): Promise<ClaimedArtifact>;
    sweep(): Promise<number>;
}
export declare function validateUploadRef(value: string): void;
//# sourceMappingURL=artifact-ingress.d.ts.map