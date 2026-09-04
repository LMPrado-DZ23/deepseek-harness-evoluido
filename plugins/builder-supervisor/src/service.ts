import { randomBytes } from 'node:crypto'
import { createVerifiedBuildArchive } from './artifact.js'
import type { BuilderExecutionPort } from './docker-adapter.js'
import type { BuildState, ManagedBuild } from './model.js'
import { BuilderSupervisorError, isTerminalState } from './model.js'
import type { BuilderRpcMethods } from './protocol.js'
import { ReplayGuard } from './replay.js'
import { beginStep, completeStep } from './state-machine.js'

interface MutableBuild { readonly build_ref: string; readonly build_id: string; state: BuildState }

export interface BuilderSupervisorOptions {
  readonly artifactRoot: string
  readonly adapter: BuilderExecutionPort
  readonly replay?: ReplayGuard
  readonly createReference?: () => string
}

export class BuilderSupervisor implements BuilderRpcMethods {
  readonly #builds = new Map<string, MutableBuild>()
  readonly #buildIds = new Set<string>()
  readonly #controllers = new Map<string, AbortController>()
  readonly #replay: ReplayGuard
  readonly #createReference: () => string

  constructor(private readonly options: BuilderSupervisorOptions) {
    this.#replay = options.replay ?? new ReplayGuard()
    this.#createReference = options.createReference ?? (() => `build_${randomBytes(16).toString('hex')}`)
  }

  async preflight(body: Parameters<BuilderRpcMethods['preflight']>[0], signal: AbortSignal): Promise<{ readonly state: 'OK' | 'BLOCKED_EXTERNAL' }> {
    this.#replay.claim(body.request_id)
    return { state: await this.options.adapter.preflight(signal) }
  }

  async prepare(body: Parameters<BuilderRpcMethods['prepare']>[0], signal: AbortSignal): Promise<{ readonly build_ref: string; readonly state: 'PREPARED' }> {
    this.#replay.claim(body.request_id)
    if (this.#buildIds.has(body.build_id)) throw new BuilderSupervisorError('BUILD_ALREADY_EXISTS')
    this.#buildIds.add(body.build_id)
    const buildRef = this.#createReference()
    try {
      if (!/^build_[a-f0-9]{32}$/u.test(buildRef) || this.#builds.has(buildRef) || (await this.options.adapter.listManaged(signal)).includes(buildRef)) {
        throw new BuilderSupervisorError('BUILD_ALREADY_EXISTS')
      }
      const artifact = await createVerifiedBuildArchive(this.options.artifactRoot, body.artifact_relative_path, body.artifact_sha256, signal)
      await this.options.adapter.prepare(buildRef, body.build_id, artifact, signal)
      this.#builds.set(buildRef, { build_ref: buildRef, build_id: body.build_id, state: 'PREPARED' })
      return { build_ref: buildRef, state: 'PREPARED' }
    } catch (error) {
      this.#buildIds.delete(body.build_id)
      throw error
    }
  }

  async execute(body: Parameters<BuilderRpcMethods['execute']>[0], signal: AbortSignal): Promise<Awaited<ReturnType<BuilderRpcMethods['execute']>>> {
    this.#replay.claim(body.request_id)
    const build = this.#build(body.build_ref)
    build.state = beginStep(build.state, body.step)
    const controller = new AbortController()
    this.#controllers.set(body.build_ref, controller)
    const combined = AbortSignal.any([signal, controller.signal])
    try {
      const result = await this.options.adapter.execute(body.build_ref, body.step, combined)
      if (build.state !== 'CANCELLED') build.state = completeStep(build.state, body.step, result.exit_code === 0 && !result.timed_out && !result.output_limited)
      return { build_ref: body.build_ref, state: build.state, step: body.step, result }
    } catch (error) {
      if (build.state !== 'CANCELLED') build.state = 'FAILED'
      throw error
    } finally {
      this.#controllers.delete(body.build_ref)
    }
  }

  async cancel(body: Parameters<BuilderRpcMethods['cancel']>[0], signal: AbortSignal): Promise<{ readonly build_ref: string; readonly state: 'CANCELLED' }> {
    this.#replay.claim(body.request_id)
    const build = this.#build(body.build_ref)
    if (isTerminalState(build.state)) throw new BuilderSupervisorError('INVALID_STEP_ORDER')
    build.state = 'CANCELLED'
    this.#controllers.get(body.build_ref)?.abort(new Error('BUILD_CANCELLED'))
    await this.options.adapter.cancel(body.build_ref, signal)
    return { build_ref: body.build_ref, state: 'CANCELLED' }
  }

  async finish(body: Parameters<BuilderRpcMethods['finish']>[0], signal: AbortSignal): Promise<Awaited<ReturnType<BuilderRpcMethods['finish']>>> {
    this.#replay.claim(body.request_id)
    const build = this.#build(body.build_ref)
    if (!isTerminalState(build.state)) throw new BuilderSupervisorError('BUILD_NOT_TERMINAL')
    const finalState = build.state
    await this.options.adapter.finish(body.build_ref, finalState, signal)
    this.#builds.delete(body.build_ref)
    this.#buildIds.delete(build.build_id)
    return { build_ref: body.build_ref, final_state: finalState, cleaned: true }
  }

  async listManaged(body: Parameters<BuilderRpcMethods['listManaged']>[0], _signal: AbortSignal): Promise<{ readonly builds: readonly ManagedBuild[] }> {
    this.#replay.claim(body.request_id)
    return { builds: [...this.#builds.values()].map(build => ({ ...build })).sort((left, right) => left.build_ref.localeCompare(right.build_ref)) }
  }

  #build(buildRef: string): MutableBuild {
    const build = this.#builds.get(buildRef)
    if (build === undefined) throw new BuilderSupervisorError('BUILD_NOT_FOUND')
    return build
  }
}
