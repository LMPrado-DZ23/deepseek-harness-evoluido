import { type BuilderSupervisorRootPolicy } from './supervisor-config.js';
import { type BuilderRuntimeScopeId } from './runtime-scope.js';
import { type TemplateManifestEntry } from './store-security.js';
export type BuilderProvisionErrorCode = 'ALREADY_PROVISIONED' | 'INVALID_PROVISION_REQUEST' | 'PROVISION_BUSY' | 'PROVISION_RECOVERY_FAILED' | 'SOURCE_CHANGED' | 'SOURCE_UNSAFE' | 'TARGET_MISMATCH';
export declare class BuilderProvisionError extends Error {
    readonly code: BuilderProvisionErrorCode;
    constructor(code: BuilderProvisionErrorCode);
}
export interface BuilderProvisionRequest {
    readonly installationId: string;
    readonly tenantId: string;
    readonly instanceId: string;
    readonly sourceRoot: string;
    readonly manifestReference: string;
    readonly manifestSha256: string;
    readonly imageDigest: string;
    readonly policySha256: string;
    readonly roots?: BuilderSupervisorRootPolicy;
}
export interface BuilderProvisionResult {
    readonly state: 'CREATED';
    readonly scope_id: BuilderRuntimeScopeId;
    readonly template_store_version: string;
    readonly template_store_sha256: string;
    readonly manifest_sha256: string;
    readonly config_reference: string;
    readonly config_sha256: string;
}
export interface BuilderProvisionRuntime {
    readonly afterStaleLockProof?: (lockPath: string) => Promise<void>;
    readonly beforeStaleLockPathUnlink?: (lockPath: string) => Promise<void>;
    readonly afterStaleLockPathUnlink?: (lockPath: string) => Promise<void>;
    readonly afterProvisionCoordinatorAcquired?: (phase: 'acquire' | 'cleanup' | 'release') => Promise<void>;
    readonly afterProvisionGuardOpenMissing?: () => Promise<void>;
    readonly beforeProvisionLockRelease?: (lockPath: string) => Promise<void>;
    readonly afterTemplateStoreEntryCopied?: (entryPath: string) => Promise<void>;
}
export declare function provisionBuilderSupervisor(request: BuilderProvisionRequest, runtime?: BuilderProvisionRuntime): Promise<BuilderProvisionResult>;
/**
 * As entradas de um store, do jeito que o PROVISIONAMENTO as confere.
 *
 * Exportada para o instalador gerar o manifesto com ESTE percurso, e não com um
 * segundo. `assertTreeMatchesManifest` compara o manifesto com o que este
 * percurso devolve; um instalador que andasse a árvore do jeito dele
 * produziria um manifesto certo até o primeiro caso de borda em que os dois
 * discordassem — nome com caixa diferente, arquivo com dois links, limite de
 * entradas — e aí o provisionamento recusaria o que o instalador acabou de
 * gerar.
 * @param root - a raiz do store.
 * @returns as entradas, na ordem do percurso.
 */
export declare function inspectTemplateStoreSourceTree(root: string): Promise<TemplateManifestEntry[]>;
declare function assertProvisionGuardFilesystem(instanceRoot: string): Promise<void>;
declare function assertTrustedFlockBinary(path?: string): Promise<void>;
declare function consumeProvisionFlockStderr(currentBytes: number, chunk: Buffer, kill: () => void): number;
declare function classifyProvisionFlockOutcome(outcome: {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly failed: boolean;
}): void;
export declare const STORE_PROVISION_GUARD_TEST_ONLY: Readonly<{
    assertProvisionGuardFilesystem: typeof assertProvisionGuardFilesystem;
    assertTrustedFlockBinary: typeof assertTrustedFlockBinary;
    classifyProvisionFlockOutcome: typeof classifyProvisionFlockOutcome;
    consumeProvisionFlockStderr: typeof consumeProvisionFlockStderr;
}>;
export {};
//# sourceMappingURL=store-provision.d.ts.map