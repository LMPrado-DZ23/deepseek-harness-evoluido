import { type Stats } from 'node:fs';
import { type FileHandle } from 'node:fs/promises';
import { type TemplateStoreManifest } from './store-security.js';
import { type BuilderRuntimeScopeId } from './runtime-scope.js';
export declare class BuilderSupervisorConfigError extends Error {
    readonly code = "INVALID_SUPERVISOR_CONFIGURATION";
    constructor();
}
export interface BuilderSupervisorRootPolicy {
    readonly configRoot: string;
    readonly secretRoot: string;
    readonly socketRoot: string;
    readonly artifactRoot: string;
    readonly exportRoot: string;
    readonly stateRoot: string;
    readonly dockerSocketPath: string;
}
export declare const PRODUCTION_BUILDER_ROOT_POLICY: BuilderSupervisorRootPolicy;
export interface BuilderSupervisorResolvedConfig {
    readonly installationId: string;
    readonly tenantId: string;
    readonly instanceId: string;
    readonly scopeId: BuilderRuntimeScopeId;
    readonly socketPath: string;
    readonly artifactRoot: string;
    readonly exportRoot: string;
    readonly journalRoot: string;
    readonly replayRoot: string;
    readonly dockerSocketPath: string;
    readonly bearerToken: string;
    readonly imageDigest: `sha256:${string}`;
    readonly templateStoreVersion: string;
    readonly templateStoreSha256: string;
    readonly templateStoreManifest?: TemplateStoreManifest;
    readonly templateStoreManifestReference?: `file:${string}`;
    readonly policySha256: string;
}
export interface BuilderSupervisorConfigEnvelope {
    readonly config: BuilderSupervisorResolvedConfig;
    readonly envelopeSha256: string;
}
export interface SupervisorConfigRuntime {
    readonly platform: NodeJS.Platform;
    readonly uid: number | undefined;
    readonly noFollowFlag: number;
    readonly open: (path: string, flags: number) => Promise<FileHandle>;
    readonly lstat: (path: string) => Promise<Stats>;
    readonly realpath: (path: string) => Promise<string>;
}
export declare function loadBuilderSupervisorConfig(configReference: string, roots?: BuilderSupervisorRootPolicy, runtime?: SupervisorConfigRuntime): Promise<BuilderSupervisorResolvedConfig>;
export declare function loadBuilderSupervisorConfigEnvelope(configReference: string, roots?: BuilderSupervisorRootPolicy, runtime?: SupervisorConfigRuntime): Promise<BuilderSupervisorConfigEnvelope>;
/**
 * Loads the supervisor configuration and its immutable referenced pins from the
 * exact file descriptors whose raw bytes form `expectedEnvelopeSha256`.
 * The bearer token is deliberately excluded so credentials can be rotated.
 */
export declare function loadPinnedBuilderSupervisorConfig(configReference: string, expectedEnvelopeSha256: string, roots?: BuilderSupervisorRootPolicy, runtime?: SupervisorConfigRuntime): Promise<BuilderSupervisorResolvedConfig>;
export declare function computeBuilderSupervisorConfigEnvelopeSha256(input: {
    readonly configBytes: Uint8Array;
    readonly imageDigestBytes: Uint8Array;
    readonly templateStoreSha256Bytes: Uint8Array;
    readonly policySha256Bytes: Uint8Array;
}): string;
export declare function computeBuilderSupervisorConfigEnvelopeV2Sha256(input: {
    readonly configBytes: Uint8Array;
    readonly imageDigestBytes: Uint8Array;
    readonly templateStoreSha256Bytes: Uint8Array;
    readonly templateStoreManifestBytes: Uint8Array;
    readonly policySha256Bytes: Uint8Array;
}): string;
export declare function validateBuilderSupervisorRootPolicy(roots: BuilderSupervisorRootPolicy): void;
//# sourceMappingURL=supervisor-config.d.ts.map