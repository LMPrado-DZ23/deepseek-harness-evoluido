import { activateBuilderRuntimeSlot } from './manager-registry-writer.js';
import { PRODUCTION_BUILDER_ROOT_POLICY } from './supervisor-config.js';
import { provisionBuilderSupervisor } from './store-provision.js';
/**
 * Durable activation boundary. Retrying the same request after a crash reuses
 * the exact provisioned configuration/token and makes the registry update
 * idempotent; it never derives logical identity from disk discovery.
 */
export async function provisionAndActivateBuilderRuntime(request, runtime = {}) {
    const provision = await provisionBuilderSupervisor(request, runtime.provision);
    await runtime.afterConfigurationPublished?.(provision);
    const activation = await activateBuilderRuntimeSlot({
        installationId: request.installationId,
        scopeId: provision.scope_id,
        configReference: provision.config_reference,
        configSha256: provision.config_sha256,
        roots: activationRoots(request.roots),
    }, runtime.registry);
    return { provision, activation };
}
function activationRoots(roots) {
    return roots ?? PRODUCTION_BUILDER_ROOT_POLICY;
}
export const RUNTIME_ACTIVATION_TEST_ONLY = Object.freeze({ activationRoots });
//# sourceMappingURL=runtime-activation.js.map