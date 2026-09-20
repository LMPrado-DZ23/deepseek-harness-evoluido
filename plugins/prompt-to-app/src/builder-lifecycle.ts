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

import type { BuilderAttestationFacts } from './attestation.js'

export interface BuilderLifecyclePreflight { readonly state: 'OK' | 'BLOCKED_EXTERNAL' }
export interface BuilderLifecyclePrepared { readonly buildRef: string }
export interface BuilderLifecycleStepResult { readonly state: BuildState; readonly step: BuildStep; readonly result: StepResult }
export interface BuilderLifecycleFinished {
  readonly finalState: 'E2E_OK' | 'FAILED' | 'CANCELLED'
  readonly exported: ExportedArtifact | null
  readonly cleanupPending: boolean
  readonly cleaned: boolean
  /**
   * Os fatos que SÓ a sessão do construtor conhece: com que imagem e sob que
   * política este artefato foi construído.
   *
   * É por AQUI que a atestação de aceitação atravessa — a pergunta que deixou
   * o caminho de sucesso do pipeline morto por várias versões. OPCIONAL de
   * propósito: uma sessão que não consegue declarar imagem e política não pode
   * produzir uma atestação de aprovação, e a execução continua bloqueada. Um
   * valor padrão aqui seria a mentira mais barata do repositório: bastaria
   * esquecer de preencher para o Studio afirmar que construiu sob uma política
   * que ninguém conferiu.
   */
  readonly attestation?: BuilderAttestationFacts
  /**
   * ONDE o construtor publicou a exportação, no disco desta máquina. Só a
   * sessão sabe (ela resolveu a raiz de exportação do escopo); sem isso o
   * Studio não tem como trazer o aplicativo e o relatório das conferências de
   * volta (`importarExportacao`).
   */
  readonly exportedPath?: string
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
