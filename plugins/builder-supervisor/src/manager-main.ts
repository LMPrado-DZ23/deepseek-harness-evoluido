import { posix } from 'node:path'
import { FairGlobalBuilderCapacity, type GlobalBuilderCapacityPort } from './manager-capacity.js'
import {
  FileBuilderRuntimeHealthStore,
  runtimeHealth,
  sanitizeRuntimeHealthCode,
  type BuilderRuntimeHealth,
  type BuilderRuntimeHealthCode,
  type BuilderRuntimeHealthPort,
  type BuilderRuntimeHealthState,
} from './manager-health.js'
import {
  BuilderRuntimeRegistryError,
  loadBuilderRuntimeRegistry,
  type BuilderRuntimeRegistry,
  type BuilderRuntimeRegistrySlot,
} from './manager-registry.js'
import {
  FileBuilderManagerAuthority,
  type BuilderManagerCheckpointPort,
  type BuilderManagerCheckpointSlot,
  type BuilderManagerLease,
  type BuilderManagerLeasePort,
} from './manager-state.js'
import { isBuilderRuntimeScopeId, isInstallationId, type BuilderRuntimeScopeId } from './runtime-scope.js'
import {
  composeBuilderSupervisor,
  type BuilderSupervisorComposition,
  type BuilderSupervisorListener,
  type BuilderSupervisorSignalSource,
} from './supervisor-main.js'
import {
  loadPinnedBuilderSupervisorConfig,
  PRODUCTION_BUILDER_ROOT_POLICY,
  type BuilderSupervisorResolvedConfig,
  type BuilderSupervisorRootPolicy,
} from './supervisor-config.js'
import { listenBuilderUnix } from './unix-server.js'
import { isTerminalState } from './model.js'

export const BUILDER_MANAGER_EXIT = Object.freeze({ ok: 0, usage: 64, startup: 70, shutdown: 74 })
export const BUILDER_MANAGER_MAX_SLOTS = 512
type ManagerSignal = 'SIGHUP' | 'SIGINT' | 'SIGTERM'

export interface BuilderManagedRuntime {
  readonly scopeId: BuilderRuntimeScopeId
  retire(timeoutMs: number): Promise<void>
}

export interface BuilderRuntimeManagerSnapshot {
  readonly installationId: string | undefined
  readonly generation: number
  readonly activeScopes: readonly BuilderRuntimeScopeId[]
  readonly health: readonly BuilderRuntimeHealth[]
}

export interface BuilderRuntimeManagerDependencies {
  readonly loadRegistry: (reference: string, roots: BuilderSupervisorRootPolicy) => Promise<BuilderRuntimeRegistry>
  readonly startSlot: (slot: BuilderRuntimeRegistrySlot, installationId: string, roots: BuilderSupervisorRootPolicy, capacity: GlobalBuilderCapacityPort, drainTimeoutMs: number, signal: AbortSignal) => Promise<BuilderManagedRuntime>
  readonly health: BuilderRuntimeHealthPort
  readonly lease: BuilderManagerLeasePort
  readonly checkpoint: BuilderManagerCheckpointPort
  readonly now: () => Date
  readonly error: (code: string) => void
}

export interface BuilderRuntimeSlotStartRuntime {
  readonly loadConfig: typeof loadPinnedBuilderSupervisorConfig
  readonly compose: typeof composeBuilderSupervisor
  readonly listen: (options: Parameters<typeof listenBuilderUnix>[0]) => Promise<BuilderSupervisorListener>
  readonly scheduleTimeout: (callback: () => void, timeoutMs: number) => ReturnType<typeof setTimeout>
  readonly clearScheduledTimeout: (timer: ReturnType<typeof setTimeout>) => void
}

const DEFAULT_SLOT_START_RUNTIME: BuilderRuntimeSlotStartRuntime = {
  loadConfig: loadPinnedBuilderSupervisorConfig,
  compose: composeBuilderSupervisor,
  listen: listenBuilderUnix,
  scheduleTimeout: setTimeout,
  clearScheduledTimeout: clearTimeout,
}

interface ActiveRuntime { readonly slot: BuilderRuntimeRegistrySlot; readonly runtime: BuilderManagedRuntime }
class RuntimeCleanupIncomplete extends Error {}

export class BuilderRuntimeManager {
  readonly #runtimes = new Map<BuilderRuntimeScopeId, ActiveRuntime>()
  readonly #health = new Map<BuilderRuntimeScopeId, BuilderRuntimeHealth>()
  readonly #acceptedSlots = new Map<BuilderRuntimeScopeId, BuilderManagerCheckpointSlot>()
  readonly #capacity: GlobalBuilderCapacityPort
  #installationId: string | undefined
  #generation = -1
  #registrySha256: string | undefined
  #reloadPending = false
  #reloadExecution: Promise<void> | undefined
  #stopped = false
  #lease: BuilderManagerLease | undefined
  #checkpointLoaded = false
  #initialized = false
  #initializing = false

  constructor(private readonly options: {
    readonly registryReference: string
    readonly roots: BuilderSupervisorRootPolicy
    readonly drainTimeoutMs: number
    readonly reloadTimeoutMs: number
    readonly maximumGlobalBuilds: number
    readonly dependencies: BuilderRuntimeManagerDependencies
  }) {
    if (![options.drainTimeoutMs, options.reloadTimeoutMs, options.maximumGlobalBuilds].every(value => Number.isSafeInteger(value) && value > 0)) throw new BuilderRuntimeRegistryError()
    this.#capacity = new FairGlobalBuilderCapacity(options.maximumGlobalBuilds)
  }

  snapshot(): BuilderRuntimeManagerSnapshot {
    return {
      installationId: this.#installationId,
      generation: this.#generation,
      activeScopes: [...this.#runtimes.keys()].filter(scopeId => this.#health.get(scopeId)?.state === 'HEALTHY').sort(),
      health: [...this.#health.values()].sort((left, right) => left.scope_id.localeCompare(right.scope_id)),
    }
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return
    this.#initializing = true
    const execution = this.#reloadExecution ?? this.#reload()
    this.#reloadExecution = execution
    try {
      await execution
      this.#initialized = true
    }
    catch (error) {
      this.#reloadPending = false
      const cleanup = await Promise.allSettled([...this.#runtimes].map(([scopeId, current]) => this.#retire(scopeId, current)))
      if (cleanup.every(result => result.status === 'fulfilled')) await this.#releaseLease()
      throw error
    }
    finally {
      this.#reloadExecution = undefined
      this.#initializing = false
      if (this.#initialized && this.#reloadPending && this.#reloadExecution === undefined && !this.#stopped) void this.requestReload()
    }
  }

  requestReload(): Promise<void> {
    if (this.#stopped) return Promise.resolve()
    this.#reloadPending = true
    this.#reloadExecution ??= this.#drainReloadRequests()
    return this.#reloadExecution
  }

  async shutdown(): Promise<void> {
    this.#stopped = true
    await this.#reloadExecution?.catch(() => undefined)
    const runtimes = [...this.#runtimes]
    const results = await Promise.allSettled(runtimes.map(([scopeId, current]) => this.#retire(scopeId, current)))
    if (results.some(result => result.status === 'rejected')) throw new Error('MANAGER_SHUTDOWN_FAILED')
    await this.#releaseLease()
  }

  async #drainReloadRequests(): Promise<void> {
    try {
      while (this.#reloadPending && !this.#stopped) {
        this.#reloadPending = false
        try { await this.#reload() }
        catch { this.options.dependencies.error('REGISTRY_RELOAD_FAILED') }
      }
    } finally { this.#reloadExecution = undefined }
  }

  async #reload(): Promise<void> {
    const registry = await deadline(
      this.options.dependencies.loadRegistry(this.options.registryReference, this.options.roots),
      this.options.reloadTimeoutMs,
      'REGISTRY_RELOAD_TIMEOUT',
    )
    await this.#ensureAuthority(registry.installationId)
    this.#validateTransition(registry)
    if (registry.generation > this.#generation) {
      const remembered = new Map(this.#acceptedSlots)
      for (const slot of registry.slots) remembered.set(slot.scopeId, slot)
      await this.options.dependencies.checkpoint.save({
        version: 1,
        installationId: registry.installationId,
        generation: registry.generation,
        registrySha256: registry.sha256,
        slots: [...remembered.values()].map(slot => ({ scopeId: slot.scopeId, configReference: slot.configReference, configSha256: slot.configSha256 })),
      }, this.options.roots)
      this.#installationId = registry.installationId
      this.#generation = registry.generation
      this.#registrySha256 = registry.sha256
      for (const slot of remembered.values()) this.#acceptedSlots.set(slot.scopeId, slot)
    }
    const desired = new Map(registry.slots.map(slot => [slot.scopeId, slot]))
    const retiring = [...this.#runtimes].filter(([scopeId]) => desired.get(scopeId)?.state !== 'active')
    const starting = registry.slots.filter(slot => slot.state === 'active' && !this.#runtimes.has(slot.scopeId))

    for (const slot of starting) {
      await this.#setHealth(slot.scopeId, 'STARTING')
      try {
        const runtime = await this.#startBounded(slot, registry.installationId)
        const current = { slot, runtime }
        this.#runtimes.set(slot.scopeId, current)
        if (runtime.scopeId !== slot.scopeId) { await this.#discardStartedRuntime(slot.scopeId, current); throw new Error('SLOT_SCOPE_MISMATCH') }
        try { await this.#setHealth(slot.scopeId, 'HEALTHY') }
        catch (error) { await this.#discardStartedRuntime(slot.scopeId, current); throw error }
      } catch (error) {
        const status = error instanceof RuntimeCleanupIncomplete ? { state: 'DEGRADED' as const, code: 'DRAIN_FAILED' as const } : sanitizeRuntimeHealthCode(error)
        await this.#setHealth(slot.scopeId, status.state, status.code)
        if (error instanceof RuntimeCleanupIncomplete) throw error
      }
    }
    for (const scopeId of this.#acceptedSlots.keys()) {
      if (!this.#runtimes.has(scopeId) && desired.get(scopeId)?.state !== 'active' && this.#health.get(scopeId)?.state !== 'STOPPED') await this.#setHealth(scopeId, 'STOPPED')
    }

    await Promise.allSettled(retiring.map(([scopeId, current]) => this.#retire(scopeId, current)))
  }

  async #ensureAuthority(installationId: string): Promise<void> {
    if (this.#lease === undefined) this.#lease = await this.options.dependencies.lease.acquire(installationId, this.options.roots)
    if (this.#checkpointLoaded) return
    const checkpoint = await this.options.dependencies.checkpoint.load(installationId, this.options.roots)
    if (checkpoint !== undefined) {
      this.#installationId = checkpoint.installationId
      this.#generation = checkpoint.generation
      this.#registrySha256 = checkpoint.registrySha256
      for (const slot of checkpoint.slots) this.#acceptedSlots.set(slot.scopeId, slot)
    }
    this.#checkpointLoaded = true
  }

  async #releaseLease(): Promise<void> {
    const lease = this.#lease
    if (lease === undefined) return
    await lease.close()
    this.#lease = undefined
  }

  async #startBounded(slot: BuilderRuntimeRegistrySlot, installationId: string): Promise<BuilderManagedRuntime> {
    const controller = new AbortController()
    const execution = this.options.dependencies.startSlot(slot, installationId, this.options.roots, this.#capacity, this.options.drainTimeoutMs, controller.signal)
    let lateRetired = false
    const cleanupLateRuntime = execution.then(async runtime => {
      if (!controller.signal.aborted || lateRetired) return
      lateRetired = true
      await runtime.retire(this.options.drainTimeoutMs)
    })
    try { return await deadline(execution, this.options.reloadTimeoutMs, 'SLOT_START_TIMEOUT') }
    catch (error) {
      controller.abort(new Error('SLOT_START_CANCELLED'))
      await deadline(cleanupLateRuntime, this.options.drainTimeoutMs, 'SLOT_START_CLEANUP_TIMEOUT').catch(() => {
        // Keep the cleanup attached even after the manager reports the bounded failure.
        void cleanupLateRuntime.catch(() => undefined)
      })
      throw error
    }
  }

  #validateTransition(registry: BuilderRuntimeRegistry): void {
    const scopes = new Set(registry.slots.map(slot => slot.scopeId)); const references = new Set(registry.slots.map(slot => slot.configReference))
    if (!isInstallationId(registry.installationId) || !Number.isSafeInteger(registry.generation) || registry.generation < 0 || !/^[a-f0-9]{64}$/u.test(registry.sha256) || registry.slots.length > BUILDER_MANAGER_MAX_SLOTS || scopes.size !== registry.slots.length || references.size !== registry.slots.length || registry.slots.some(slot => !isBuilderRuntimeScopeId(slot.scopeId) || !/^[a-f0-9]{64}$/u.test(slot.configSha256) || (slot.state !== 'active' && slot.state !== 'retiring') || slot.configReference !== `file:${posix.join(this.options.roots.configRoot, 'instances', slot.scopeId, 'supervisor.json')}`)) throw new BuilderRuntimeRegistryError()
    if (this.#installationId !== undefined && registry.installationId !== this.#installationId) throw new BuilderRuntimeRegistryError()
    if (registry.generation < this.#generation) throw new BuilderRuntimeRegistryError()
    if (registry.generation === this.#generation) {
      if (registry.sha256 !== this.#registrySha256) throw new BuilderRuntimeRegistryError()
      return
    }
    const next = new Map(registry.slots.map(slot => [slot.scopeId, slot]))
    for (const [scopeId, current] of this.#acceptedSlots) {
      const candidate = next.get(scopeId)
      if (candidate !== undefined && (candidate.configReference !== current.configReference || candidate.configSha256 !== current.configSha256)) throw new BuilderRuntimeRegistryError()
    }
  }

  async #retire(scopeId: BuilderRuntimeScopeId, current: ActiveRuntime): Promise<void> {
    await this.#setHealth(scopeId, 'RETIRING')
    try {
      await deadline(current.runtime.retire(this.options.drainTimeoutMs), this.options.drainTimeoutMs + 250, 'SLOT_DRAIN_TIMEOUT')
      this.#runtimes.delete(scopeId)
      await this.#setHealth(scopeId, 'STOPPED')
    } catch {
      await this.#setHealth(scopeId, 'DEGRADED', 'DRAIN_FAILED')
      throw new Error('SLOT_DRAIN_FAILED')
    }
  }

  async #discardStartedRuntime(scopeId: BuilderRuntimeScopeId, current: ActiveRuntime): Promise<void> {
    try { await deadline(current.runtime.retire(this.options.drainTimeoutMs), this.options.drainTimeoutMs + 250, 'SLOT_DRAIN_TIMEOUT') }
    catch { throw new RuntimeCleanupIncomplete() }
    this.#runtimes.delete(scopeId)
  }

  async #setHealth(scopeId: BuilderRuntimeScopeId, state: BuilderRuntimeHealthState, code: BuilderRuntimeHealthCode = 'NONE'): Promise<void> {
    const next = runtimeHealth(scopeId, state, this.#health.get(scopeId), code, this.options.dependencies.now())
    await this.options.dependencies.health.write(next)
    this.#health.set(scopeId, next)
  }
}

export interface BuilderRuntimeManagerSignalSource extends BuilderSupervisorSignalSource {
  on(signal: ManagerSignal, listener: () => void): void
  off(signal: ManagerSignal, listener: () => void): void
}

export interface BuilderRuntimeManagerRuntime {
  readonly signals: BuilderRuntimeManagerSignalSource
  readonly setInterval: typeof setInterval
  readonly clearInterval: typeof clearInterval
}

export async function runBuilderRuntimeManager(options: {
  readonly registryReference: string
  readonly roots?: BuilderSupervisorRootPolicy
  readonly pollIntervalMs?: number
  readonly reloadTimeoutMs?: number
  readonly drainTimeoutMs?: number
  readonly maximumGlobalBuilds?: number
  readonly dependencies?: Partial<BuilderRuntimeManagerDependencies>
  readonly runtime?: BuilderRuntimeManagerRuntime
}): Promise<number> {
  const roots = options.roots ?? PRODUCTION_BUILDER_ROOT_POLICY
  const runtime = options.runtime ?? { signals: process, setInterval, clearInterval }
  const pollIntervalMs = options.pollIntervalMs ?? 5_000
  const reloadTimeoutMs = options.reloadTimeoutMs ?? 5_000
  const drainTimeoutMs = options.drainTimeoutMs ?? 30_000
  const maximumGlobalBuilds = options.maximumGlobalBuilds ?? 4
  if (![pollIntervalMs, reloadTimeoutMs, drainTimeoutMs, maximumGlobalBuilds].every(value => Number.isSafeInteger(value) && value > 0)) return BUILDER_MANAGER_EXIT.usage
  const health = new FileBuilderRuntimeHealthStore(`${roots.stateRoot}/manager-health`)
  const authority = new FileBuilderManagerAuthority()
  const dependencies: BuilderRuntimeManagerDependencies = {
    loadRegistry: loadBuilderRuntimeRegistry,
    startSlot: createBuilderRuntimeSlotStarter(),
    health,
    lease: authority,
    checkpoint: authority,
    now: () => new Date(),
    error: code => { process.stderr.write(`${JSON.stringify({ event: 'builder-manager-error', code })}\n`) },
    ...options.dependencies,
  }
  const manager = new BuilderRuntimeManager({
    registryReference: options.registryReference,
    roots,
    drainTimeoutMs,
    reloadTimeoutMs,
    maximumGlobalBuilds,
    dependencies,
  })
  let resolveShutdown!: () => void
  const shutdown = new Promise<void>(resolve => { resolveShutdown = resolve })
  let requested = false
  const requestShutdown = () => { if (!requested) { requested = true; resolveShutdown() } }
  const reload = () => { void manager.requestReload() }
  runtime.signals.on('SIGHUP', reload); runtime.signals.on('SIGINT', requestShutdown); runtime.signals.on('SIGTERM', requestShutdown)
  let poll: ReturnType<typeof setInterval> | undefined
  try {
    await manager.initialize()
    poll = runtime.setInterval(reload, pollIntervalMs)
    poll.unref?.()
    await shutdown
    try { await manager.shutdown(); return BUILDER_MANAGER_EXIT.ok }
    catch { dependencies.error('SHUTDOWN_FAILED'); return BUILDER_MANAGER_EXIT.shutdown }
  } catch (error) {
    dependencies.error(error instanceof BuilderRuntimeRegistryError ? 'INVALID_RUNTIME_REGISTRY' : 'MANAGER_STARTUP_FAILED')
    return error instanceof BuilderRuntimeRegistryError ? BUILDER_MANAGER_EXIT.usage : BUILDER_MANAGER_EXIT.startup
  } finally {
    if (poll !== undefined) runtime.clearInterval(poll)
    runtime.signals.off('SIGHUP', reload); runtime.signals.off('SIGINT', requestShutdown); runtime.signals.off('SIGTERM', requestShutdown)
    if (!requested) await manager.shutdown().catch(() => undefined)
  }
}

export async function executeBuilderRuntimeManagerCli(argv: readonly string[]): Promise<number> {
  if (argv.length !== 2 || argv[0] !== '--registry' || typeof argv[1] !== 'string' || !argv[1].startsWith('file:/')) return BUILDER_MANAGER_EXIT.usage
  return runBuilderRuntimeManager({ registryReference: argv[1] })
}

export function createBuilderRuntimeSlotStarter(runtime: BuilderRuntimeSlotStartRuntime = DEFAULT_SLOT_START_RUNTIME): BuilderRuntimeManagerDependencies['startSlot'] {
  return async (slot, installationId, roots, capacity, drainTimeoutMs, signal) => {
    signal.throwIfAborted()
    const config = await runtime.loadConfig(slot.configReference, slot.configSha256, roots)
    signal.throwIfAborted()
    if (config.scopeId !== slot.scopeId || config.installationId !== installationId) throw new BuilderRuntimeRegistryError()
    const composition = runtime.compose(config)
    return listenManagedRuntime(config, wrapBuilderSupervisorWithGlobalCapacity(config.scopeId, composition, capacity), drainTimeoutMs, signal, runtime)
  }
}

export function wrapBuilderSupervisorWithGlobalCapacity(scopeId: BuilderRuntimeScopeId, composition: BuilderSupervisorComposition, capacity: GlobalBuilderCapacityPort): BuilderSupervisorComposition & { releaseAll(): void } {
  const releases = new Map<string, () => void>()
  const release = (buildRef: string) => { const current = releases.get(buildRef); if (current !== undefined) { releases.delete(buildRef); current() } }
  const methods = composition.methods
  return { methods: {
    initialize: methods.initialize.bind(methods),
    preflight: methods.preflight.bind(methods),
    prepare: async (body, signal) => {
      const acquired = await capacity.acquire(scopeId, signal)
      try {
        const result = await methods.prepare(body, signal)
        const previous = releases.get(result.build_ref)
        if (previous === undefined) releases.set(result.build_ref, acquired); else acquired()
        return result
      } catch (error) { acquired(); throw error }
    },
    execute: async (body, signal) => {
      const result = await methods.execute(body, signal)
      if (isTerminalState(result.state)) release(result.build_ref)
      return result
    },
    cancel: async (body, signal) => {
      const result = await methods.cancel(body, signal)
      release(body.build_ref)
      return result
    },
    finish: async (body, signal) => {
      const result = await methods.finish(body, signal)
      if (result.cleaned && !result.cleanup_pending) release(body.build_ref)
      return result
    },
    listManaged: methods.listManaged.bind(methods),
  }, releaseAll: () => { for (const current of releases.values()) current(); releases.clear() } }
}

async function listenManagedRuntime(config: BuilderSupervisorResolvedConfig, composition: BuilderSupervisorComposition & { releaseAll(): void }, drainTimeoutMs: number, managerSignal: AbortSignal, runtime: BuilderRuntimeSlotStartRuntime): Promise<BuilderManagedRuntime> {
  const controller = new AbortController()
  const cancel = () => controller.abort(managerSignal.reason)
  if (managerSignal.aborted) cancel(); else managerSignal.addEventListener('abort', cancel, { once: true })
  let listener: BuilderSupervisorListener
  try {
    listener = await runtime.listen({
      socketPath: config.socketPath,
      bearerToken: config.bearerToken,
      methods: composition.methods,
      scopeId: config.scopeId,
      policySha256: config.policySha256,
      replayRoot: config.replayRoot,
      signal: controller.signal,
    })
  } finally { managerSignal.removeEventListener('abort', cancel) }
  let closing: Promise<void> | undefined
  let closed = false
  const beginClose = (): Promise<void> => {
    const attempt = listener.close(() => controller.abort(new Error('RUNTIME_RETIRING')))
    const observed = attempt.then(
      () => { closed = true; composition.releaseAll() },
      error => { closing = undefined; throw error },
    )
    closing = observed
    return observed
  }
  return {
    scopeId: config.scopeId,
    retire: async timeoutMs => {
      if (closed) return
      const current = closing ?? beginClose()
      const forced = runtime.scheduleTimeout(() => { controller.abort(new Error('RUNTIME_DRAIN_TIMEOUT')); listener.server.closeAllConnections(); listener.server.closeIdleConnections() }, Math.min(timeoutMs, drainTimeoutMs))
      try { await deadline(current, Math.min(timeoutMs, drainTimeoutMs) + 200, 'RUNTIME_DRAIN_TIMEOUT') }
      finally { runtime.clearScheduledTimeout(forced) }
    },
  }
}

async function deadline<T>(execution: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([
      execution,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), timeoutMs); timer.unref?.() }),
    ])
  } finally { clearTimeout(timer) }
}
