import { randomBytes } from 'node:crypto'
import { createVerifiedBuildArchive } from './artifact.js'
import type { BuilderExecutionPort } from './docker-adapter.js'
import type { BuildState, ExportedArtifact, FinishResult, ManagedBuild } from './model.js'
import { BuilderSupervisorError, isTerminalState } from './model.js'
import type { BuilderRpcMethods } from './protocol.js'
import { ReplayGuard, type ReplayClaimPort } from './replay.js'
import type { BuildIdClaimPort } from './persistent-replay.js'
import { Semaphore } from './semaphore.js'
import { beginStep, completeStep } from './state-machine.js'

interface MutableBuild {
  readonly build_ref: string
  readonly build_id: string
  state: BuildState
  exported?: ExportedArtifact
  cleanup_pending: boolean
  finish_result?: FinishResult
}

export interface BuilderSupervisorOptions {
  readonly artifactRoot: string
  readonly adapter: BuilderExecutionPort
  readonly replay?: ReplayClaimPort
  readonly createReference?: () => string
  readonly maxBuilds?: number
  readonly maxConcurrentSteps?: number
  readonly buildClaims?: BuildIdClaimPort
}

export class BuilderSupervisor implements BuilderRpcMethods {
  readonly #builds = new Map<string, MutableBuild>()
  readonly #buildIds = new Set<string>()
  readonly #buildRefs = new Set<string>()
  readonly #controllers = new Map<string, AbortController>()
  readonly #replay: ReplayClaimPort
  readonly #createReference: () => string
  readonly #steps: Semaphore
  readonly #maxBuilds: number
  readonly #buildClaims: BuildIdClaimPort
  #initialized = false
  #initializing: Promise<void> | undefined

  constructor(private readonly options: BuilderSupervisorOptions) {
    this.#replay = options.replay ?? new ReplayGuard()
    this.#createReference = options.createReference ?? (() => `build_${randomBytes(16).toString('hex')}`)
    this.#maxBuilds = options.maxBuilds ?? 32
    this.#buildClaims = options.buildClaims ?? { claim: async buildId => { if (this.#buildIds.has(buildId)) throw new BuilderSupervisorError('BUILD_ALREADY_EXISTS') } }
    this.#steps = new Semaphore(options.maxConcurrentSteps ?? 2)
    if (!Number.isSafeInteger(this.#maxBuilds) || this.#maxBuilds < 1 || this.#maxBuilds > 1_000) throw new Error('INVALID_BUILD_LIMIT')
  }

  async initialize(signal: AbortSignal): Promise<void> {
    if (this.#initialized) return
    this.#initializing ??= (async () => {
      const recovered = await this.options.adapter.reconcile(signal)
      for (const item of recovered) {
        if (this.#buildIds.has(item.build_id) || this.#buildRefs.has(item.build_ref)) throw new BuilderSupervisorError('RECOVERY_FAILED')
        this.#buildIds.add(item.build_id); this.#buildRefs.add(item.build_ref)
      }
      this.#initialized = true
    })()
    try { await this.#initializing } finally { if (!this.#initialized) this.#initializing = undefined }
  }

  async preflight(body: Parameters<BuilderRpcMethods['preflight']>[0], signal: AbortSignal): Promise<{ readonly state: 'OK' | 'BLOCKED_EXTERNAL' }> {
    await this.#claim(body.request_id)
    return { state: await this.options.adapter.preflight(signal) }
  }

  async prepare(body: Parameters<BuilderRpcMethods['prepare']>[0], signal: AbortSignal): Promise<{ readonly build_ref: string; readonly state: 'PREPARED' }> {
    await this.#claim(body.request_id)
    const activeBuilds = [...this.#builds.values()].filter(build => build.finish_result === undefined).length
    if (activeBuilds >= this.#maxBuilds || this.#builds.size >= 4_096) throw new BuilderSupervisorError('CAPACITY_EXCEEDED')
    if (this.#buildIds.has(body.build_id)) throw new BuilderSupervisorError('BUILD_ALREADY_EXISTS')
    const buildRef = this.#createReference()
    try {
      if (!/^build_[a-f0-9]{32}$/u.test(buildRef) || this.#builds.has(buildRef) || this.#buildRefs.has(buildRef) || (await this.options.adapter.listManaged(signal)).includes(buildRef)) {
        throw new BuilderSupervisorError('BUILD_ALREADY_EXISTS')
      }
      const artifact = await createVerifiedBuildArchive(this.options.artifactRoot, body.artifact_relative_path, body.artifact_sha256, signal)
      await this.#buildClaims.claim(body.build_id); this.#buildIds.add(body.build_id)
      await this.options.adapter.prepare(buildRef, body.build_id, artifact, signal)
      this.#buildRefs.add(buildRef); this.#builds.set(buildRef, { build_ref: buildRef, build_id: body.build_id, state: 'PREPARED', cleanup_pending: false })
      return { build_ref: buildRef, state: 'PREPARED' }
    } catch (error) {
      throw error
    }
  }

  async execute(body: Parameters<BuilderRpcMethods['execute']>[0], signal: AbortSignal): Promise<Awaited<ReturnType<BuilderRpcMethods['execute']>>> {
    await this.#claim(body.request_id)
    const build = this.#build(body.build_ref)
    build.state = beginStep(build.state, body.step)
    const controller = new AbortController()
    this.#controllers.set(body.build_ref, controller)
    const combined = AbortSignal.any([signal, controller.signal])
    let release: (() => void) | undefined
    try {
      release = await this.#steps.acquire(combined)
      const result = await this.options.adapter.execute(body.build_ref, body.step, combined)
      if (build.state !== 'CANCELLED') build.state = completeStep(build.state, body.step, result.exit_code === 0 && !result.timed_out && !result.output_limited)
      return { build_ref: body.build_ref, state: build.state, step: body.step, result }
    } catch (error) {
      if (build.state !== 'CANCELLED') build.state = 'FAILED'
      throw error
    } finally {
      release?.(); this.#controllers.delete(body.build_ref)
    }
  }

  async cancel(body: Parameters<BuilderRpcMethods['cancel']>[0], signal: AbortSignal): Promise<{ readonly build_ref: string; readonly state: 'CANCELLED' }> {
    await this.#claim(body.request_id)
    const build = this.#build(body.build_ref)
    if (isTerminalState(build.state)) throw new BuilderSupervisorError('INVALID_STEP_ORDER')
    build.state = 'CANCELLED'
    this.#controllers.get(body.build_ref)?.abort(new Error('BUILD_CANCELLED'))
    await this.options.adapter.cancel(body.build_ref, signal)
    return { build_ref: body.build_ref, state: 'CANCELLED' }
  }

  async finish(body: Parameters<BuilderRpcMethods['finish']>[0], signal: AbortSignal): Promise<Awaited<ReturnType<BuilderRpcMethods['finish']>>> {
    await this.#claim(body.request_id)
    const build = this.#build(body.build_ref)
    if (build.finish_result !== undefined) return build.finish_result
    if (!isTerminalState(build.state)) throw new BuilderSupervisorError('BUILD_NOT_TERMINAL')
    const finalState = build.state
    if (finalState === 'E2E_OK' && build.exported === undefined) build.exported = await this.options.adapter.exportArtifact(body.build_ref, signal)
    build.cleanup_pending = true
    try {
      await this.options.adapter.cleanup(body.build_ref, signal)
    } catch {
      throw new BuilderSupervisorError('CLEANUP_INCOMPLETE')
    }
    build.cleanup_pending = false
    const result: FinishResult = { build_ref: body.build_ref, final_state: finalState, exported: build.exported ?? null, cleanup_pending: false, cleaned: true }
    build.finish_result = result
    return result
  }

  async listManaged(body: Parameters<BuilderRpcMethods['listManaged']>[0], _signal: AbortSignal): Promise<{ readonly builds: readonly ManagedBuild[] }> {
    await this.#claim(body.request_id)
    return { builds: [...this.#builds.values()].filter(build => build.finish_result === undefined).map(build => ({ build_ref: build.build_ref, build_id: build.build_id, state: build.state, exported: build.exported !== undefined, cleanup_pending: build.cleanup_pending })).sort((left, right) => left.build_ref.localeCompare(right.build_ref)) }
  }

  #build(buildRef: string): MutableBuild {
    const build = this.#builds.get(buildRef)
    if (build === undefined) throw new BuilderSupervisorError('BUILD_NOT_FOUND')
    return build
  }

  async #claim(requestId: string): Promise<void> {
    if (!this.#initialized) await this.initialize(AbortSignal.timeout(30_000))
    await this.#replay.claim(requestId)
  }
}
