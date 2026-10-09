import { type BuilderRegistryWriterRuntime, type BuilderRuntimeActivationResult } from './manager-registry-writer.js';
import { type BuilderProvisionRequest, type BuilderProvisionResult, type BuilderProvisionRuntime } from './store-provision.js';
export interface BuilderRuntimeActivationRuntime {
    readonly provision?: BuilderProvisionRuntime;
    readonly registry?: BuilderRegistryWriterRuntime;
    readonly afterConfigurationPublished?: (provisioned: BuilderProvisionResult) => Promise<void>;
}
export interface ProvisionAndActivateResult {
    readonly provision: BuilderProvisionResult;
    readonly activation: BuilderRuntimeActivationResult;
}
/**
 * Durable activation boundary. Retrying the same request after a crash reuses
 * the exact provisioned configuration/token and makes the registry update
 * idempotent; it never derives logical identity from disk discovery.
 */
export declare function provisionAndActivateBuilderRuntime(request: BuilderProvisionRequest, runtime?: BuilderRuntimeActivationRuntime): Promise<ProvisionAndActivateResult>;
declare function activationRoots(roots: BuilderProvisionRequest['roots']): NonNullable<BuilderProvisionRequest['roots']>;
export declare const RUNTIME_ACTIVATION_TEST_ONLY: Readonly<{
    activationRoots: typeof activationRoots;
}>;
export {};
//# sourceMappingURL=runtime-activation.d.ts.map