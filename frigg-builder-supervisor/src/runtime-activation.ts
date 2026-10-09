import { activateBuilderRuntimeSlot, type BuilderRegistryWriterRuntime, type BuilderRuntimeActivationResult } from './manager-registry-writer.js'
import { PRODUCTION_BUILDER_ROOT_POLICY } from './supervisor-config.js'
import { provisionBuilderSupervisor, type BuilderProvisionRequest, type BuilderProvisionResult, type BuilderProvisionRuntime } from './store-provision.js'

export interface BuilderRuntimeActivationRuntime {
  readonly provision?: BuilderProvisionRuntime
  readonly registry?: BuilderRegistryWriterRuntime
  readonly afterConfigurationPublished?: (provisioned: BuilderProvisionResult) => Promise<void>
}

export interface ProvisionAndActivateResult {
  readonly provision: BuilderProvisionResult
  readonly activation: BuilderRuntimeActivationResult
}

/**
 * Durable activation boundary. Retrying the same request after a crash reuses
 * the exact provisioned configuration/token and makes the registry update
 * idempotent; it never derives logical identity from disk discovery.
 */
export async function provisionAndActivateBuilderRuntime(
  request: BuilderProvisionRequest,
  runtime: BuilderRuntimeActivationRuntime = {},
): Promise<ProvisionAndActivateResult> {
  const provision = await provisionBuilderSupervisor(request, runtime.provision)
  await runtime.afterConfigurationPublished?.(provision)
  const activation = await activateBuilderRuntimeSlot({
    installationId: request.installationId,
    scopeId: provision.scope_id,
    configReference: provision.config_reference as `file:${string}`,
    configSha256: provision.config_sha256,
    roots: activationRoots(request.roots),
  }, runtime.registry)
  return { provision, activation }
}

function activationRoots(roots: BuilderProvisionRequest['roots']): NonNullable<BuilderProvisionRequest['roots']> {
  return roots ?? PRODUCTION_BUILDER_ROOT_POLICY
}

export const RUNTIME_ACTIVATION_TEST_ONLY = Object.freeze({ activationRoots })
