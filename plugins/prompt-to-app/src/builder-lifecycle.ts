import type { BuildState, BuildStep, ExportedArtifact, ManagedBuild, StepResult } from '@dz23-studio/builder-supervisor'

export { BUILD_STEPS } from '@dz23-studio/builder-supervisor'
export type { BuildStep }

export type BuilderLifecycleFailureState = 'BLOCKED_EXTERNAL' | 'BUILD_FAILED' | 'CANCELLED' | 'INTERRUPTED'

export class BuilderLifecycleError extends Error {
  constructor(readonly state: BuilderLifecycleFailureState, readonly code: string, options?: ErrorOptions) {
    super(code, options)
    this.name = 'BuilderLifecycleError'
  }
}

export interface BuilderLifecyclePreflight { readonly state: 'OK' | 'BLOCKED_EXTERNAL' }
export interface BuilderLifecyclePrepared { readonly buildRef: string }
export interface BuilderLifecycleStepResult { readonly state: BuildState; readonly step: BuildStep; readonly result: StepResult }
export interface BuilderLifecycleFinished {
  readonly finalState: 'E2E_OK' | 'FAILED' | 'CANCELLED'
  readonly exported: ExportedArtifact | null
  readonly cleanupPending: boolean
  readonly cleaned: boolean
}
export interface BuilderLifecycleManaged {
  readonly buildRef: string
  readonly buildId: string
  readonly state: BuildState
  readonly exported: boolean
  readonly cleanupPending: boolean
}

export interface BuilderLifecycleSession {
  preflight(signal?: AbortSignal): Promise<BuilderLifecyclePreflight>
  prepare(sourceDirectory: string, buildId: string, signal?: AbortSignal): Promise<BuilderLifecyclePrepared>
  execute(buildRef: string, step: BuildStep, signal?: AbortSignal): Promise<BuilderLifecycleStepResult>
  cancel(buildRef: string, signal?: AbortSignal): Promise<void>
  finish(buildRef: string, signal?: AbortSignal): Promise<BuilderLifecycleFinished>
  listManaged(signal?: AbortSignal): Promise<readonly BuilderLifecycleManaged[]>
}

export interface BuilderLifecycleResolverPort<Actor> {
  forActor(actor: Actor): Promise<BuilderLifecycleSession>
}

export function managedBuild(value: ManagedBuild): BuilderLifecycleManaged {
  return { buildRef: value.build_ref, buildId: value.build_id, state: value.state, exported: value.exported, cleanupPending: value.cleanup_pending }
}
