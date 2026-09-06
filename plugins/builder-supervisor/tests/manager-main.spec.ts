import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { BUILDER_MANAGER_EXIT, BUILDER_MANAGER_TEST_ONLY, BuilderRuntimeManager, createBuilderRuntimeSlotStarter, executeBuilderRuntimeManagerCli, runBuilderRuntimeManager, wrapBuilderSupervisorWithGlobalCapacity, type BuilderManagedRuntime, type BuilderRuntimeManagerDependencies, type BuilderRuntimeManagerRuntime, type BuilderRuntimeSlotStartRuntime } from '../src/manager-main.js'
import { FairGlobalBuilderCapacity } from '../src/manager-capacity.js'
import type { BuilderRpcMethods, PrepareRequest } from '../src/protocol.js'
import { MemoryBuilderRuntimeHealthStore } from '../src/manager-health.js'
import { BuilderRuntimeRegistryError, type BuilderRuntimeRegistry, type BuilderRuntimeRegistrySlot } from '../src/manager-registry.js'
import { BuilderManagerStateError, MemoryBuilderManagerCheckpointPort, MemoryBuilderManagerLeasePort, type BuilderManagerCheckpointPort, type BuilderManagerLeasePort } from '../src/manager-state.js'
import type { BuilderRuntimeScopeId } from '../src/runtime-scope.js'
import type { BuilderSupervisorResolvedConfig, BuilderSupervisorRootPolicy } from '../src/supervisor-config.js'
import type { BuilderSupervisorComposition, BuilderSupervisorListener } from '../src/supervisor-main.js'
import type { DockerEnginePort } from '../src/docker-engine.js'
import { DockerEngine } from '../src/docker-engine.js'
import { BuilderUnixListenerCleanupError, listenBuilderUnix } from '../src/unix-server.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scope = (digit: string): BuilderRuntimeScopeId => `s_${digit.repeat(48)}`
const roots: BuilderSupervisorRootPolicy = { configRoot: '/config', secretRoot: '/secret', socketRoot: '/run', artifactRoot: '/artifact', exportRoot: '/export', stateRoot: '/state', dockerSocketPath: '/docker.sock' }

describe('multi-runtime manager', () => {
  it('rejects invalid manager limits before acquiring authority', () => {
    const dependencies = fixture([]).dependencies
    expect(() => new BuilderRuntimeManager({ registryReference: 'file:/config/manager/runtime-registry.json', roots, drainTimeoutMs: 0, reloadTimeoutMs: 1, maximumGlobalBuilds: 1, dependencies })).toThrow('INVALID_RUNTIME_REGISTRY')
    expect(() => new BuilderRuntimeManager({ registryReference: 'file:/config/manager/runtime-registry.json', roots, drainTimeoutMs: 1, reloadTimeoutMs: 1.5, maximumGlobalBuilds: 1, dependencies })).toThrow('INVALID_RUNTIME_REGISTRY')
  })

  it('starts two opaque scopes independently and gives each its own exact config', async () => {
    const first = slot('1'); const second = slot('2')
    const harness = fixture([registry(1, [first, second])])
    await harness.manager.initialize()
    expect(harness.started).toEqual([{ slot: first, installationId: 'a'.repeat(64) }, { slot: second, installationId: 'a'.repeat(64) }])
    expect(harness.manager.snapshot().activeScopes).toEqual([scope('1'), scope('2')])
    expect(harness.manager.snapshot().health.map(item => [item.scope_id, item.state])).toEqual([[scope('1'), 'HEALTHY'], [scope('2'), 'HEALTHY']])
    expect(JSON.stringify(harness.manager.snapshot())).not.toMatch(/tenant|org|instance|token|secret/u)
    await harness.manager.shutdown()
  })

  it('keeps healthy scopes active when another slot is blocked by materialization', async () => {
    const first = slot('1'); const second = slot('2'); const health = new MemoryBuilderRuntimeHealthStore(); let load = 0
    const dependencies: BuilderRuntimeManagerDependencies = {
      ...memoryState(),
      loadRegistry: async () => load++ === 0 ? registry(1, [first]) : registry(2, [first, second]),
      startSlot: async candidate => {
        if (candidate.scopeId === second.scopeId) throw Object.assign(new Error('must-not-leak-token-or-path'), { code: 'BLOCKED_EXTERNAL' })
        return { scopeId: candidate.scopeId, retire: async () => undefined }
      },
      health, now: () => new Date(0), error: vi.fn(),
    }
    const manager = new BuilderRuntimeManager({ registryReference: 'file:/config/manager/runtime-registry.json', roots, drainTimeoutMs: 100, reloadTimeoutMs: 5, slotStartupTimeoutMs: 100, maximumGlobalBuilds: 1, dependencies })
    await manager.initialize(); await manager.requestReload()
    expect(manager.snapshot()).toMatchObject({
      activeScopes: [first.scopeId],
      health: [
        { scope_id: first.scopeId, state: 'HEALTHY', code: 'NONE' },
        { scope_id: second.scopeId, state: 'BLOCKED_EXTERNAL', code: 'EXTERNAL_DEPENDENCY' },
      ],
    })
    expect(JSON.stringify(manager.snapshot())).not.toMatch(/token|path|tenant/u)
    await manager.shutdown()
  })

  it('uses the slot startup deadline rather than the registry reload deadline', async () => {
    const first = slot('1'); const health = new MemoryBuilderRuntimeHealthStore()
    const dependencies: BuilderRuntimeManagerDependencies = {
      ...memoryState(), loadRegistry: async () => registry(1, [first]),
      startSlot: async candidate => { await new Promise(resolve => setTimeout(resolve, 20)); return { scopeId: candidate.scopeId, retire: async () => undefined } },
      health, now: () => new Date(0), error: vi.fn(),
    }
    const manager = new BuilderRuntimeManager({ registryReference: 'file:/config/manager/runtime-registry.json', roots, drainTimeoutMs: 100, reloadTimeoutMs: 5, slotStartupTimeoutMs: 100, maximumGlobalBuilds: 1, dependencies })
    await manager.initialize()
    expect(manager.snapshot().activeScopes).toEqual([first.scopeId])
    await manager.shutdown()
  })

  it('classifies a timed-out materialization as blocked external without publishing a socket', async () => {
    const first = slot('1'); const health = new MemoryBuilderRuntimeHealthStore(); const listen = vi.fn<BuilderRuntimeSlotStartRuntime['listen']>()
    const starter = createBuilderRuntimeSlotStarter(slotStartRuntime({
      ensureTemplateStore: async (_options, signal) => new Promise<never>((_resolve, reject) => {
        const stop = () => reject(signal.reason)
        if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true })
      }),
      listen,
    }))
    const dependencies: BuilderRuntimeManagerDependencies = {
      ...memoryState(), loadRegistry: async () => registry(1, [first]), startSlot: starter,
      health, now: () => new Date(0), error: vi.fn(),
    }
    const manager = new BuilderRuntimeManager({ registryReference: 'file:/config/manager/runtime-registry.json', roots, drainTimeoutMs: 100, reloadTimeoutMs: 100, slotStartupTimeoutMs: 5, maximumGlobalBuilds: 1, dependencies })
    await manager.initialize()
    expect(manager.snapshot().health).toEqual([expect.objectContaining({ scope_id: first.scopeId, state: 'BLOCKED_EXTERNAL', code: 'EXTERNAL_DEPENDENCY' })])
    expect(listen).not.toHaveBeenCalled()
    await manager.shutdown()
  })

  it('classifies a listener deadline as blocked external and never publishes a runtime', async () => {
    const first = slot('1'); const health = new MemoryBuilderRuntimeHealthStore(); let published = false
    const starter = createBuilderRuntimeSlotStarter(slotStartRuntime({
      listen: async options => new Promise<BuilderSupervisorListener>((_resolve, reject) => {
        const stop = () => reject(options.signal?.reason)
        if (options.signal?.aborted === true) stop(); else options.signal?.addEventListener('abort', stop, { once: true })
      }),
    }))
    const dependencies: BuilderRuntimeManagerDependencies = {
      ...memoryState(), loadRegistry: async () => registry(1, [first]),
      startSlot: async (...args) => { const value = await starter(...args); published = true; return value },
      health, now: () => new Date(0), error: vi.fn(),
    }
    const manager = new BuilderRuntimeManager({ registryReference: 'file:/config/manager/runtime-registry.json', roots, drainTimeoutMs: 100, reloadTimeoutMs: 100, slotStartupTimeoutMs: 100, listenerInitializationTimeoutMs: 5, maximumGlobalBuilds: 1, dependencies })
    await manager.initialize()
    expect({ published, active: manager.snapshot().activeScopes }).toEqual({ published: false, active: [] })
    expect(manager.snapshot().health).toEqual([expect.objectContaining({ scope_id: first.scopeId, state: 'BLOCKED_EXTERNAL', code: 'EXTERNAL_DEPENDENCY' })])
    await manager.shutdown()
  })

  it('retains authority and a sanitized cleanup witness when template-store cleanup is unproved', async () => {
    const firstSlot = slot('1'); const state = memoryState(); const listen = vi.fn<BuilderRuntimeSlotStartRuntime['listen']>()
    const starter = createBuilderRuntimeSlotStarter(slotStartRuntime({
      ensureTemplateStore: async () => { throw Object.assign(new Error('store-path-token-secret'), { code: 'TEMPLATE_STORE_CLEANUP_INCOMPLETE' }) },
      listen,
    }))
    const dependencies: BuilderRuntimeManagerDependencies = {
      ...state, loadRegistry: async () => registry(1, [firstSlot]), startSlot: starter,
      health: new MemoryBuilderRuntimeHealthStore(), now: () => new Date(0), error: vi.fn(),
    }
    const first = new BuilderRuntimeManager({ registryReference: 'file:/config/manager/runtime-registry.json', roots, drainTimeoutMs: 10, reloadTimeoutMs: 100, slotStartupTimeoutMs: 100, maximumGlobalBuilds: 1, dependencies })
    const second = fixture([registry(1, [firstSlot])], undefined, undefined, state)
    await expect(first.initialize()).rejects.toBeInstanceOf(Error)
    expect(first.snapshot().health).toEqual([expect.objectContaining({ scope_id: firstSlot.scopeId, state: 'DEGRADED', code: 'DRAIN_FAILED' })])
    expect(JSON.stringify(first.snapshot())).not.toMatch(/store-path|token|secret/u)
    expect(listen).not.toHaveBeenCalled()
    await expect(second.manager.initialize()).rejects.toThrow('MANAGER_ALREADY_RUNNING')
    await expect(first.shutdown()).rejects.toThrow('MANAGER_SHUTDOWN_FAILED')
  })

  it('retains authority when listener setup reports cleanup incomplete', async () => {
    const firstSlot = slot('1'); const state = memoryState()
    const starter = createBuilderRuntimeSlotStarter(slotStartRuntime({
      listen: async () => { throw new BuilderUnixListenerCleanupError() },
    }))
    const dependencies: BuilderRuntimeManagerDependencies = {
      ...state, loadRegistry: async () => registry(1, [firstSlot]), startSlot: starter,
      health: new MemoryBuilderRuntimeHealthStore(), now: () => new Date(0), error: vi.fn(),
    }
    const first = new BuilderRuntimeManager({ registryReference: 'file:/config/manager/runtime-registry.json', roots, drainTimeoutMs: 10, reloadTimeoutMs: 100, slotStartupTimeoutMs: 100, maximumGlobalBuilds: 1, dependencies })
    const second = fixture([registry(1, [firstSlot])], undefined, undefined, state)
    await expect(first.initialize()).rejects.toBeInstanceOf(Error)
    expect(first.snapshot().health).toEqual([expect.objectContaining({ state: 'DEGRADED', code: 'DRAIN_FAILED' })])
    await expect(second.manager.initialize()).rejects.toThrow('MANAGER_ALREADY_RUNNING')
    await expect(first.shutdown()).rejects.toThrow('MANAGER_SHUTDOWN_FAILED')
  })

  it('makes initialize idempotent and ignores reload after a proved shutdown', async () => {
    const harness = fixture([registry(1, [])])
    await harness.manager.initialize(); await harness.manager.initialize(); await harness.manager.shutdown(); await harness.manager.requestReload()
    expect(harness.manager.snapshot().generation).toBe(1)
  })

  it('rejects structural partial reload and rollback without altering current runtimes', async () => {
    const first = slot('1'); const harness = fixture([registry(2, [first]), new BuilderRuntimeRegistryError(), registry(1, [])])
    await harness.manager.initialize(); await harness.manager.requestReload(); await harness.manager.requestReload()
    expect(harness.manager.snapshot().generation).toBe(2)
    expect(harness.manager.snapshot().activeScopes).toEqual([scope('1')])
    expect(harness.retired).toEqual([])
    expect(harness.errors).toEqual(['REGISTRY_RELOAD_FAILED', 'REGISTRY_RELOAD_FAILED'])
  })

  it('rejects an in-place config mutation atomically before starting or retiring anything', async () => {
    const first = slot('1'); const changed = { ...first, configSha256: 'c'.repeat(64) }
    const harness = fixture([registry(1, [first]), registry(2, [changed, slot('2')])])
    await harness.manager.initialize(); await harness.manager.requestReload()
    expect(harness.manager.snapshot().generation).toBe(1)
    expect(harness.started).toHaveLength(1); expect(harness.retired).toEqual([])
    expect(harness.manager.snapshot().activeScopes).toEqual([scope('1')])
  })

  it('rejects installation identity changes and a runtime that reports another scope', async () => {
    const first = slot('1')
    const changedInstallation = { ...registry(2, [first]), installationId: 'f'.repeat(64) }
    const harness = fixture([registry(1, [first]), changedInstallation])
    ;(harness.dependencies as { startSlot: BuilderRuntimeManagerDependencies['startSlot'] }).startSlot = async () => ({ scopeId: scope('2'), retire: async () => { harness.retired.push(scope('2')) } })
    await harness.manager.initialize()
    expect(harness.manager.snapshot().activeScopes).toEqual([])
    expect(harness.retired).toEqual([scope('2')])
    await harness.manager.requestReload()
    expect(harness.errors).toEqual(['REGISTRY_RELOAD_FAILED'])
  })

  it('sanitizes cleanup failures for a runtime that reports another scope', async () => {
    const firstSlot = slot('1'); const state = memoryState(); let allowRetire = false
    const first = fixture([registry(1, [firstSlot])], undefined, undefined, state)
    ;(first.dependencies as { startSlot: BuilderRuntimeManagerDependencies['startSlot'] }).startSlot = async () => ({ scopeId: scope('2'), retire: async () => { if (!allowRetire) throw new Error('scope-cleanup-secret') } })
    const second = fixture([registry(1, [firstSlot])], undefined, undefined, state)
    await expect(first.manager.initialize()).rejects.toBeInstanceOf(Error)
    expect(first.manager.snapshot().health).toEqual([expect.objectContaining({ scope_id: firstSlot.scopeId, state: 'DEGRADED', code: 'DRAIN_FAILED' })])
    expect(JSON.stringify(first.manager.snapshot())).not.toContain('scope-cleanup-secret')
    await expect(second.manager.initialize()).rejects.toThrow('MANAGER_ALREADY_RUNNING')
    allowRetire = true; await first.manager.shutdown()
    await second.manager.initialize(); await second.manager.shutdown()
  })

  it('isolates a failed slot, publishes truthful health, and retries it at the same generation', async () => {
    const first = slot('1'); const second = slot('2'); let fail = true
    const value = registry(1, [first, second]); const harness = fixture([value, value], candidate => {
      if (candidate.scopeId === second.scopeId && fail) { fail = false; throw Object.assign(new Error('never-log-this-secret'), { code: 'BLOCKED_EXTERNAL' }) }
    })
    await harness.manager.initialize()
    expect(harness.manager.snapshot().activeScopes).toEqual([scope('1')])
    expect(harness.manager.snapshot().health.find(item => item.scope_id === scope('2'))).toEqual(expect.objectContaining({ state: 'BLOCKED_EXTERNAL', code: 'EXTERNAL_DEPENDENCY' }))
    expect(JSON.stringify(harness.manager.snapshot())).not.toContain('never-log-this-secret')
    await harness.manager.requestReload()
    expect(harness.manager.snapshot().activeScopes).toEqual([scope('1'), scope('2')])
  })

  it('retires removed and explicit retiring slots, stopping acceptance before bounded drain', async () => {
    const first = slot('1'); const second = slot('2')
    const harness = fixture([registry(1, [first, second]), registry(2, [{ ...first, state: 'retiring' }])])
    await harness.manager.initialize(); await harness.manager.requestReload()
    expect(harness.retired.sort()).toEqual([scope('1'), scope('2')])
    expect(harness.manager.snapshot().activeScopes).toEqual([])
    expect(harness.manager.snapshot().health.map(item => item.state)).toEqual(['STOPPED', 'STOPPED'])
  })

  it('publishes STOPPED without binding an initially retiring slot', async () => {
    const first = { ...slot('1'), state: 'retiring' as const }; const harness = fixture([registry(1, [first])])
    await harness.manager.initialize()
    expect(harness.started).toEqual([])
    expect(harness.manager.snapshot().health).toEqual([expect.objectContaining({ scope_id: first.scopeId, state: 'STOPPED', code: 'NONE' })])
  })

  it('marks drain failures without taking down an unrelated healthy runtime', async () => {
    const first = slot('1'); const second = slot('2')
    const harness = fixture([registry(1, [first, second]), registry(2, [second])], undefined, first.scopeId)
    await harness.manager.initialize(); await harness.manager.requestReload()
    expect(harness.manager.snapshot().activeScopes).toEqual([scope('2')])
    expect(harness.retired).toEqual([scope('1')])
    expect(harness.manager.snapshot().health.find(item => item.scope_id === first.scopeId)).toEqual(expect.objectContaining({ state: 'DEGRADED', code: 'DRAIN_FAILED' }))
  })

  it('coalesces a SIGHUP storm and does not block the event loop while loading', async () => {
    const first = slot('1'); let release!: () => void; let calls = 0
    const gate = new Promise<void>(resolve => { release = resolve })
    const harness = fixture([registry(1, [first])]); await harness.manager.initialize()
    ;(harness.dependencies as { loadRegistry: BuilderRuntimeManagerDependencies['loadRegistry'] }).loadRegistry = async () => { calls += 1; if (calls === 1) await gate; return registry(1, [first]) }
    const requests = Array.from({ length: 50 }, () => harness.manager.requestReload())
    let timerFired = false; await new Promise<void>(resolve => setTimeout(() => { timerFired = true; resolve() }, 0))
    expect(timerFired).toBe(true); release(); await Promise.all(requests)
    expect(calls).toBe(2)
  })

  it('rejects direct reload during initialization without creating a concurrent registry load', async () => {
    const first = slot('1'); let release!: () => void; let calls = 0
    const gate = new Promise<void>(resolve => { release = resolve })
    const harness = fixture([registry(1, [first])])
    ;(harness.dependencies as { loadRegistry: BuilderRuntimeManagerDependencies['loadRegistry'] }).loadRegistry = async () => {
      calls += 1
      if (calls === 1) await gate
      return registry(1, [first])
    }
    const initializing = harness.manager.initialize(); const reload = harness.manager.requestReload()
    await expect(reload).rejects.toThrow('MANAGER_NOT_INITIALIZED')
    release(); await initializing
    expect({ calls, starts: harness.started.length }).toEqual({ calls: 1, starts: 1 })
  })

  it('rejects direct reload before a failed initialization and preserves generation minus one', async () => {
    const first = slot('1'); let release!: () => void; let calls = 0
    const gate = new Promise<void>(resolve => { release = resolve })
    const state = memoryState()
    const harness = fixture([new BuilderRuntimeRegistryError(), registry(1, [first])], undefined, undefined, state)
    ;(harness.dependencies as { loadRegistry: BuilderRuntimeManagerDependencies['loadRegistry'] }).loadRegistry = async () => {
      calls += 1; if (calls === 1) { await gate; throw new BuilderRuntimeRegistryError() }; return registry(1, [first])
    }
    const pending = harness.manager.requestReload()
    await expect(pending).rejects.toThrow('MANAGER_NOT_INITIALIZED')
    const initializing = harness.manager.initialize()
    release()
    await expect(initializing).rejects.toThrow('INVALID_RUNTIME_REGISTRY')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect({ calls, generation: harness.manager.snapshot().generation }).toEqual({ calls: 1, generation: -1 })
    await harness.manager.initialize()
    expect({ calls, starts: harness.started.length }).toEqual({ calls: 2, starts: 1 })
  })

  it('keeps the lease when late initialization failure cannot close an already-live slot', async () => {
    const firstSlot = slot('1'); const secondSlot = slot('2'); const state = memoryState()
    const health = new MemoryBuilderRuntimeHealthStore(); let failHealth = true; let retireAttempts = 0
    const first = fixture([registry(1, [firstSlot, secondSlot])], undefined, undefined, state)
    ;(first.dependencies as { health: BuilderRuntimeManagerDependencies['health'] }).health = {
      write: async value => {
        if (value.scope_id === secondSlot.scopeId && value.state === 'STARTING' && failHealth) { failHealth = false; throw new Error('health-late-failure') }
        await health.write(value)
      },
    }
    ;(first.dependencies as { startSlot: BuilderRuntimeManagerDependencies['startSlot'] }).startSlot = async candidate => ({
      scopeId: candidate.scopeId,
      retire: async () => { retireAttempts += 1; if (retireAttempts === 1) throw new Error('listener-still-live') },
    })
    const second = fixture([registry(1, [firstSlot, secondSlot])], undefined, undefined, state)
    await expect(first.manager.initialize()).rejects.toThrow('health-late-failure')
    expect(first.manager.snapshot().activeScopes).toEqual([])
    await expect(second.manager.initialize()).rejects.toThrow('MANAGER_ALREADY_RUNNING')
    await first.manager.shutdown()
    await expect(second.manager.initialize()).resolves.toBeUndefined()
    await second.manager.shutdown()
  })

  it('closes a runtime that appears after its startup deadline and leaves no active slot', async () => {
    const first = slot('1'); let retired = false; let observedAbort = false
    const health = new MemoryBuilderRuntimeHealthStore()
    const dependencies: BuilderRuntimeManagerDependencies = {
      ...memoryState(),
      loadRegistry: async () => registry(1, [first]),
      startSlot: async (_slot, _installationId, _roots, _capacity, _drain, signal) => {
        await new Promise(resolve => setTimeout(resolve, 25)); observedAbort = signal.aborted
        return { scopeId: first.scopeId, retire: async () => { retired = true } }
      },
      health, now: () => new Date(0), error: vi.fn(),
    }
    const manager = new BuilderRuntimeManager({ registryReference: 'file:/config/manager/runtime-registry.json', roots, drainTimeoutMs: 100, reloadTimeoutMs: 5, slotStartupTimeoutMs: 5, maximumGlobalBuilds: 1, dependencies })
    await manager.initialize()
    expect({ retired, observedAbort, active: manager.snapshot().activeScopes }).toEqual({ retired: true, observedAbort: true, active: [] })
    expect(manager.snapshot().health[0]).toEqual(expect.objectContaining({ state: 'BLOCKED_EXTERNAL', code: 'EXTERNAL_DEPENDENCY' }))
  })

  it('waits for cleanup proof when a runtime appears after its startup deadline', async () => {
    const first = slot('1'); let retired = false
    const dependencies: BuilderRuntimeManagerDependencies = {
      ...memoryState(),
      loadRegistry: async () => registry(1, [first]),
      startSlot: async () => { await new Promise(resolve => setTimeout(resolve, 40)); return { scopeId: first.scopeId, retire: async () => { retired = true } } },
      health: new MemoryBuilderRuntimeHealthStore(), now: () => new Date(0), error: vi.fn(),
    }
    const manager = new BuilderRuntimeManager({ registryReference: 'file:/config/manager/runtime-registry.json', roots, drainTimeoutMs: 10, reloadTimeoutMs: 5, slotStartupTimeoutMs: 5, maximumGlobalBuilds: 1, dependencies })
    await manager.initialize(); expect(retired).toBe(true)
    expect(manager.snapshot().activeScopes).toEqual([])
  })

  it('retains installation authority while shutdown cannot prove cleanup of a late start', async () => {
    const firstSlot = slot('1'); const state = memoryState(); let releaseStart!: () => void; let started = false; let allowRetire = false
    const startGate = new Promise<void>(resolve => { releaseStart = resolve })
    const dependencies: BuilderRuntimeManagerDependencies = {
      ...state,
      loadRegistry: async () => registry(1, [firstSlot]),
      startSlot: async () => {
        started = true
        await startGate
        return { scopeId: firstSlot.scopeId, retire: async () => { if (!allowRetire) throw new Error('late-retire-secret') } }
      },
      health: new MemoryBuilderRuntimeHealthStore(), now: () => new Date(0), error: vi.fn(),
    }
    const first = new BuilderRuntimeManager({ registryReference: 'file:/config/manager/runtime-registry.json', roots, drainTimeoutMs: 10, reloadTimeoutMs: 5, slotStartupTimeoutMs: 5, maximumGlobalBuilds: 1, dependencies })
    const second = fixture([registry(1, [firstSlot])], undefined, undefined, state)
    const initializing = first.initialize()
    await until(() => started)
    await new Promise(resolve => setTimeout(resolve, 20))
    const shuttingDown = first.shutdown(); releaseStart()
    await expect(initializing).rejects.toBeInstanceOf(Error)
    await expect(shuttingDown).rejects.toThrow('MANAGER_SHUTDOWN_FAILED')
    await expect(second.manager.initialize()).rejects.toThrow('MANAGER_ALREADY_RUNNING')
    allowRetire = true
    await expect(first.shutdown()).resolves.toBeUndefined()
    await second.manager.initialize(); await second.manager.shutdown()
  })

  it('retires a slot that resolves after shutdown aborts its in-flight start', async () => {
    const firstSlot = slot('1'); let releaseStart!: () => void; let started = false; let retired = false
    const startGate = new Promise<void>(resolve => { releaseStart = resolve })
    const dependencies: BuilderRuntimeManagerDependencies = {
      ...memoryState(), loadRegistry: async () => registry(1, [firstSlot]),
      startSlot: async () => { started = true; await startGate; return { scopeId: firstSlot.scopeId, retire: async () => { retired = true } } },
      health: new MemoryBuilderRuntimeHealthStore(), now: () => new Date(0), error: vi.fn(),
    }
    const manager = new BuilderRuntimeManager({ registryReference: 'file:/config/manager/runtime-registry.json', roots, drainTimeoutMs: 100, reloadTimeoutMs: 100, maximumGlobalBuilds: 1, dependencies })
    const initializing = manager.initialize(); await until(() => started)
    const shuttingDown = manager.shutdown(); releaseStart()
    await expect(initializing).resolves.toBeUndefined()
    await expect(shuttingDown).resolves.toBeUndefined()
    expect({ retired, active: manager.snapshot().activeScopes }).toEqual({ retired: true, active: [] })
  })

  it('waits for an in-flight initialization during shutdown and absorbs its registry failure', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const harness = fixture([])
    ;(harness.dependencies as { loadRegistry: BuilderRuntimeManagerDependencies['loadRegistry'] }).loadRegistry = async () => { await gate; throw new BuilderRuntimeRegistryError() }
    const initializing = harness.manager.initialize(); const shuttingDown = harness.manager.shutdown(); release()
    await expect(initializing).rejects.toThrow('INVALID_RUNTIME_REGISTRY')
    await expect(shuttingDown).resolves.toBeUndefined()
  })

  it('keeps a scope configuration immutable after retirement and reintroduction', async () => {
    const first = slot('1'); const changed = { ...first, configSha256: 'c'.repeat(64) }
    const harness = fixture([registry(1, [first]), registry(2, []), registry(3, [changed])])
    await harness.manager.initialize(); await harness.manager.requestReload(); await harness.manager.requestReload()
    expect(harness.manager.snapshot().generation).toBe(2)
    expect(harness.started).toHaveLength(1)
    expect(harness.errors).toEqual(['REGISTRY_RELOAD_FAILED'])
  })

  it('rejects manager-side slot overflow even when a loader violates its contract', async () => {
    const oversized = registry(1, Array.from({ length: 513 }, (_, index) => slot(index.toString(16).padStart(1, '0').slice(-1))))
    const harness = fixture([oversized])
    await expect(harness.manager.initialize()).rejects.toThrow('INVALID_RUNTIME_REGISTRY')
    expect(harness.started).toEqual([])
  })

  it('publishes the durable checkpoint before starting a new generation', async () => {
    const events: string[] = []
    const checkpoint = new MemoryBuilderManagerCheckpointPort()
    checkpoint.save = async value => { events.push(`checkpoint:${value.generation}`); checkpoint.value = structuredClone(value) }
    const state = memoryState(checkpoint)
    const harness = fixture([registry(4, [slot('1')])], candidate => { events.push(`start:${candidate.scopeId}`) }, undefined, state)
    await harness.manager.initialize()
    expect(events).toEqual(['checkpoint:4', `start:${scope('1')}`])
  })

  it('does not apply a generation whose checkpoint cannot be committed and permits a clean retry', async () => {
    let fail = true
    const checkpoint = new MemoryBuilderManagerCheckpointPort()
    const save = checkpoint.save.bind(checkpoint)
    checkpoint.save = async value => { if (fail) { fail = false; throw new BuilderManagerStateError('INVALID_MANAGER_STATE') }; await save(value) }
    const state = { lease: new MemoryBuilderManagerLeasePort(), checkpoint }
    const harness = fixture([registry(1, [slot('1')])], undefined, undefined, state)
    await expect(harness.manager.initialize()).rejects.toThrow('INVALID_MANAGER_STATE')
    expect(harness.started).toEqual([])
    await expect(harness.manager.initialize()).resolves.toBeUndefined()
    expect(harness.started).toHaveLength(1)
  })

  it('keeps one exclusive manager per installation and releases the lease on shutdown', async () => {
    const state = memoryState()
    const first = fixture([registry(1, [slot('1')])], undefined, undefined, state)
    const second = fixture([registry(1, [slot('1')])], undefined, undefined, state)
    await first.manager.initialize()
    await expect(second.manager.initialize()).rejects.toThrow('MANAGER_ALREADY_RUNNING')
    expect(second.started).toEqual([])
    await first.manager.shutdown()
    await expect(second.manager.initialize()).resolves.toBeUndefined()
    expect(second.started).toHaveLength(1)
    await second.manager.shutdown()
  })

  it('keeps the process lease after failed runtime shutdown until a retry proves closure', async () => {
    const state = memoryState(); const firstSlot = slot('1'); let retireAttempts = 0
    const first = fixture([registry(1, [firstSlot])], undefined, undefined, state)
    ;(first.dependencies as { startSlot: BuilderRuntimeManagerDependencies['startSlot'] }).startSlot = async candidate => ({
      scopeId: candidate.scopeId,
      retire: async () => { retireAttempts += 1; if (retireAttempts === 1) throw new Error('listener-still-live') },
    })
    const second = fixture([registry(1, [firstSlot])], undefined, undefined, state)
    await first.manager.initialize()
    await expect(first.manager.shutdown()).rejects.toThrow('MANAGER_SHUTDOWN_FAILED')
    await expect(second.manager.initialize()).rejects.toThrow('MANAGER_ALREADY_RUNNING')
    expect(retireAttempts).toBe(1)
    await expect(first.manager.shutdown()).resolves.toBeUndefined()
    expect(retireAttempts).toBe(2)
    await expect(second.manager.initialize()).resolves.toBeUndefined()
    await second.manager.shutdown()
  })

  it('retains the lease handle when close fails and retries the same close on the next shutdown', async () => {
    let held = false; let closeAttempts = 0
    const lease: BuilderManagerLeasePort = {
      acquire: async () => {
        if (held) throw new BuilderManagerStateError('MANAGER_ALREADY_RUNNING')
        held = true
        return { close: async () => {
          closeAttempts += 1
          if (closeAttempts === 1) throw new BuilderManagerStateError('INVALID_MANAGER_STATE')
          held = false
        } }
      },
    }
    const checkpoint = new MemoryBuilderManagerCheckpointPort()
    const first = fixture([registry(1, [])], undefined, undefined, { lease, checkpoint })
    const second = fixture([registry(1, [])], undefined, undefined, { lease, checkpoint })
    await first.manager.initialize()
    await expect(first.manager.shutdown()).rejects.toThrow('INVALID_MANAGER_STATE')
    await expect(second.manager.initialize()).rejects.toThrow('MANAGER_ALREADY_RUNNING')
    await expect(first.manager.shutdown()).resolves.toBeUndefined()
    expect(closeAttempts).toBe(2)
    await expect(second.manager.initialize()).resolves.toBeUndefined()
    await second.manager.shutdown()
  })

  it('persists rollback and scope-config immutability across manager restarts', async () => {
    const checkpoint = new MemoryBuilderManagerCheckpointPort()
    const lease = new MemoryBuilderManagerLeasePort()
    const accepted = slot('1')
    const first = fixture([registry(3, [accepted])], undefined, undefined, { lease, checkpoint })
    await first.manager.initialize(); await first.manager.shutdown()

    const rollback = fixture([registry(2, [accepted])], undefined, undefined, { lease, checkpoint })
    await expect(rollback.manager.initialize()).rejects.toThrow('INVALID_RUNTIME_REGISTRY')
    expect(rollback.started).toEqual([])

    const changed = { ...accepted, configSha256: 'c'.repeat(64) }
    const mutation = fixture([registry(4, [changed])], undefined, undefined, { lease, checkpoint })
    await expect(mutation.manager.initialize()).rejects.toThrow('INVALID_RUNTIME_REGISTRY')
    expect(mutation.started).toEqual([])

    const divergent = fixture([{ ...registry(3, [accepted]), sha256: 'd'.repeat(64) }], undefined, undefined, { lease, checkpoint })
    await expect(divergent.manager.initialize()).rejects.toThrow('INVALID_RUNTIME_REGISTRY')
    expect(divergent.started).toEqual([])
  })

  it('reconciles a historically accepted but absent scope to persistent STOPPED after restart', async () => {
    const checkpoint = new MemoryBuilderManagerCheckpointPort()
    checkpoint.value = {
      version: 1,
      installationId: 'a'.repeat(64),
      generation: 1,
      registrySha256: registry(1, [slot('1')]).sha256,
      slots: [slot('1')],
    }
    const harness = fixture([registry(2, [])], undefined, undefined, { lease: new MemoryBuilderManagerLeasePort(), checkpoint })
    await harness.manager.initialize()
    expect(harness.manager.snapshot().health).toEqual([expect.objectContaining({ scope_id: scope('1'), state: 'STOPPED', code: 'NONE' })])
    expect(harness.started).toEqual([])
  })

  it('defends against duplicate config references and malformed slots from a faulty loader', async () => {
    const first = slot('1'); const second = { ...slot('2'), configReference: first.configReference }
    const duplicate = fixture([registry(1, [first, second])])
    await expect(duplicate.manager.initialize()).rejects.toThrow('INVALID_RUNTIME_REGISTRY')
    const malformed = fixture([{ ...registry(1, [first]), slots: [{ ...first, state: 'ready' as 'active' }] }])
    await expect(malformed.manager.initialize()).rejects.toThrow('INVALID_RUNTIME_REGISTRY')
  })
})

describe('slot starter lifecycle', () => {
  it('materializes config v2 with one shared engine, initializes exactly once, and only then listens', async () => {
    const order: string[] = []; const config = resolvedConfig(); const engine = {} as DockerEnginePort
    const artifactIngress = {} as NonNullable<BuilderSupervisorComposition['artifactIngress']>
    const base = methods('1')
    const runtime = slotStartRuntime({
      loadConfig: async () => { order.push('load-config'); return config },
      createEngine: value => { order.push('create-engine'); expect(value).toBe(config); return engine },
      ensureTemplateStore: async options => {
        order.push('materialize')
        expect(options).toMatchObject({
          engine,
          installationId: config.installationId,
          scopeId: config.scopeId,
          version: config.templateStoreVersion,
          treeSha256: config.templateStoreSha256,
          imageDigest: config.imageDigest,
          sourceEnvelope: `/state/instances/${config.scopeId}/template-store/v1`,
          manifest: config.templateStoreManifest,
        })
        return { state: 'REUSED', volumeName: 'opaque-volume', treeSha256: config.templateStoreSha256 }
      },
      compose: (value, reused) => {
        order.push('compose'); expect({ value, reused }).toEqual({ value: config, reused: engine })
        return { artifactIngress, methods: {
          ...base,
          initialize: async signal => { signal.throwIfAborted(); order.push('initialize') },
          preflight: async () => { order.push('rpc-preflight'); return base.preflight({ request_id: `req_${'0'.repeat(32)}` }, new AbortController().signal) },
        } }
      },
      listen: async options => {
        order.push('listen')
        expect('initialize' in options.methods).toBe(false)
        expect(options.artifactIngress).toBe(artifactIngress)
        return { server: { close: vi.fn(), closeAllConnections: vi.fn(), closeIdleConnections: vi.fn() }, close: async () => undefined }
      },
    })
    const managed = await createBuilderRuntimeSlotStarter(runtime)(slot('1'), config.installationId, roots, new FairGlobalBuilderCapacity(1), 100, new AbortController().signal, 100)
    expect(order).toEqual(['load-config', 'create-engine', 'materialize', 'compose', 'initialize', 'listen'])
    await managed.retire(100)
  })

  it.skipIf(process.platform === 'win32')('opens a real Unix listener after exactly one authoritative initialization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-manager-listener-'))
    try {
      const base = methods('1'); const initialize = vi.fn(base.initialize)
      const config: BuilderSupervisorResolvedConfig = {
        ...resolvedConfig(),
        bearerToken: 'A'.repeat(43),
        socketPath: join(root, 'builder.sock').replaceAll('\\', '/'),
        replayRoot: join(root, 'replay').replaceAll('\\', '/'),
      }
      const managed = await createBuilderRuntimeSlotStarter(slotStartRuntime({
        loadConfig: async () => config,
        compose: () => ({ methods: { ...base, initialize } }),
        listen: listenBuilderUnix,
      }))(slot('1'), config.installationId, roots, new FairGlobalBuilderCapacity(1), 100, new AbortController().signal, 100)
      expect(initialize).toHaveBeenCalledOnce()
      await managed.retire(100)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rejects v1 authority and materialization failure before composition or socket publication', async () => {
    const compose = vi.fn<BuilderRuntimeSlotStartRuntime['compose']>(); const listen = vi.fn<BuilderRuntimeSlotStartRuntime['listen']>()
    const { templateStoreManifest: _manifest, templateStoreManifestReference: _manifestReference, ...v1 } = resolvedConfig()
    const createEngine = vi.fn<BuilderRuntimeSlotStartRuntime['createEngine']>()
    await expect(createBuilderRuntimeSlotStarter(slotStartRuntime({ loadConfig: async () => v1, createEngine, compose, listen }))(slot('1'), v1.installationId, roots, new FairGlobalBuilderCapacity(1), 100, new AbortController().signal)).rejects.toThrow('INVALID_RUNTIME_REGISTRY')
    expect(createEngine).not.toHaveBeenCalled()

    const blocked = createBuilderRuntimeSlotStarter(slotStartRuntime({
      ensureTemplateStore: async () => { throw new Error('tenant-path-token-secret') }, compose, listen,
    }))
    await expect(blocked(slot('1'), 'a'.repeat(64), roots, new FairGlobalBuilderCapacity(1), 100, new AbortController().signal)).rejects.toMatchObject({ message: 'BLOCKED_EXTERNAL', code: 'BLOCKED_EXTERNAL' })
    expect(compose).not.toHaveBeenCalled(); expect(listen).not.toHaveBeenCalled()

    const unprovedCleanup = createBuilderRuntimeSlotStarter(slotStartRuntime({
      ensureTemplateStore: async () => { throw Object.assign(new Error('cleanup-secret'), { code: 'TEMPLATE_STORE_CLEANUP_INCOMPLETE' }) }, compose, listen,
    }))
    await expect(unprovedCleanup(slot('1'), 'a'.repeat(64), roots, new FairGlobalBuilderCapacity(1), 100, new AbortController().signal)).rejects.toBeInstanceOf(Error)
    expect(compose).not.toHaveBeenCalled(); expect(listen).not.toHaveBeenCalled()
  })

  it('cancels materialization without composing or opening a listener', async () => {
    const controller = new AbortController(); const compose = vi.fn<BuilderRuntimeSlotStartRuntime['compose']>(); const listen = vi.fn<BuilderRuntimeSlotStartRuntime['listen']>()
    const ensureTemplateStore = vi.fn<BuilderRuntimeSlotStartRuntime['ensureTemplateStore']>(async (_options, signal) => {
      controller.abort(new Error('manager-cancelled'))
      signal.throwIfAborted()
      throw new Error('unreachable')
    })
    const starter = createBuilderRuntimeSlotStarter(slotStartRuntime({ ensureTemplateStore, compose, listen }))
    await expect(starter(slot('1'), 'a'.repeat(64), roots, new FairGlobalBuilderCapacity(1), 100, controller.signal)).rejects.toThrow('manager-cancelled')
    expect(ensureTemplateStore).toHaveBeenCalledOnce(); expect(compose).not.toHaveBeenCalled(); expect(listen).not.toHaveBeenCalled()
  })

  it('bounds listener initialization independently and closes a listener that resolves late', async () => {
    let resolve!: (listener: BuilderSupervisorListener) => void; let observedSignal: AbortSignal | undefined
    const close = vi.fn(async () => undefined)
    const listening = new Promise<BuilderSupervisorListener>(done => { resolve = done })
    const runtime = slotStartRuntime({ listen: async options => { observedSignal = options.signal; return listening } })
    const startup = createBuilderRuntimeSlotStarter(runtime)(slot('1'), 'a'.repeat(64), roots, new FairGlobalBuilderCapacity(1), 100, new AbortController().signal, 5)
    await until(() => observedSignal?.aborted === true)
    resolve({ server: { close: vi.fn(), closeAllConnections: vi.fn(), closeIdleConnections: vi.fn() }, close })
    await expect(startup).rejects.toThrow('LISTENER_INITIALIZATION_TIMEOUT'); expect(close).toHaveBeenCalledOnce()

    let reject!: (error: Error) => void; let rejectedSignal: AbortSignal | undefined
    const rejected = new Promise<BuilderSupervisorListener>((_resolve, rejectPromise) => { reject = rejectPromise })
    const rejectedStart = createBuilderRuntimeSlotStarter(slotStartRuntime({ listen: async options => { rejectedSignal = options.signal; return rejected } }))(slot('1'), 'a'.repeat(64), roots, new FairGlobalBuilderCapacity(1), 100, new AbortController().signal, 5)
    await until(() => rejectedSignal?.aborted === true)
    reject(new Error('late-listener-secret'))
    await expect(rejectedStart).rejects.toThrow('LISTENER_INITIALIZATION_TIMEOUT')

    let resolveUnclean!: (listener: BuilderSupervisorListener) => void; let uncleanSignal: AbortSignal | undefined
    const unclean = new Promise<BuilderSupervisorListener>(done => { resolveUnclean = done })
    const uncleanStart = createBuilderRuntimeSlotStarter(slotStartRuntime({ listen: async options => { uncleanSignal = options.signal; return unclean } }))(slot('1'), 'a'.repeat(64), roots, new FairGlobalBuilderCapacity(1), 100, new AbortController().signal, 5)
    await until(() => uncleanSignal?.aborted === true)
    resolveUnclean({ server: { close: vi.fn(), closeAllConnections: vi.fn(), closeIdleConnections: vi.fn() }, close: async () => { throw new Error('late-close-secret') } })
    await expect(uncleanStart).rejects.toBeInstanceOf(Error)

    const never = new Promise<BuilderSupervisorListener>(() => undefined)
    const unprovedStart = createBuilderRuntimeSlotStarter(slotStartRuntime({ listen: async () => never }))(slot('1'), 'a'.repeat(64), roots, new FairGlobalBuilderCapacity(1), 1, new AbortController().signal, 1)
    await expect(unprovedStart).rejects.toBeInstanceOf(Error)
  })

  it('rejects an attestation failure from authoritative initialization and covers the inert Docker engine factory', async () => {
    const config = resolvedConfig(); const listen = vi.fn<BuilderRuntimeSlotStartRuntime['listen']>()
    const base = methods('1')
    const runtime = slotStartRuntime({
      compose: () => ({ methods: { ...base, initialize: async () => { throw new Error('BUILDER_ATTESTATION_FAILED') } } }),
      listen,
    })
    await expect(createBuilderRuntimeSlotStarter(runtime)(slot('1'), config.installationId, roots, new FairGlobalBuilderCapacity(1), 100, new AbortController().signal)).rejects.toThrow('BUILDER_ATTESTATION_FAILED')
    expect(listen).not.toHaveBeenCalled()
    expect(BUILDER_MANAGER_TEST_ONLY.createBuilderDockerEngine(config)).toBeInstanceOf(DockerEngine)
  })

  it('loads the pinned config once and rejects cancellation or identity mismatches before listen', async () => {
    const capacity = new FairGlobalBuilderCapacity(1); const first = slot('1'); const baseConfig = resolvedConfig()
    for (const mismatch of [{ ...baseConfig, scopeId: scope('2') }, { ...baseConfig, installationId: 'f'.repeat(64) }]) {
      const listen = vi.fn<BuilderRuntimeSlotStartRuntime['listen']>()
      const starter = createBuilderRuntimeSlotStarter(slotStartRuntime({ loadConfig: async () => mismatch, listen }))
      await expect(starter(first, 'a'.repeat(64), roots, capacity, 100, new AbortController().signal)).rejects.toThrow('INVALID_RUNTIME_REGISTRY')
      expect(listen).not.toHaveBeenCalled()
    }

    const beforeLoad = new AbortController(); beforeLoad.abort(new Error('cancelled-before-load'))
    const loadBefore = vi.fn<BuilderRuntimeSlotStartRuntime['loadConfig']>()
    await expect(createBuilderRuntimeSlotStarter(slotStartRuntime({ loadConfig: loadBefore }))(first, 'a'.repeat(64), roots, capacity, 100, beforeLoad.signal)).rejects.toThrow('cancelled-before-load')
    expect(loadBefore).not.toHaveBeenCalled()

    const afterLoad = new AbortController()
    const compose = vi.fn<BuilderRuntimeSlotStartRuntime['compose']>()
    const starter = createBuilderRuntimeSlotStarter(slotStartRuntime({ loadConfig: async () => { afterLoad.abort(new Error('cancelled-after-load')); return baseConfig }, compose }))
    await expect(starter(first, 'a'.repeat(64), roots, capacity, 100, afterLoad.signal)).rejects.toThrow('cancelled-after-load')
    expect(compose).not.toHaveBeenCalled()
  })

  it('binds one isolated listener, propagates startup abort, and retires idempotently with forced cleanup', async () => {
    const first = slot('1'); const managerSignal = new AbortController(); const capacity = new FairGlobalBuilderCapacity(1)
    const closeAllConnections = vi.fn(); const closeIdleConnections = vi.fn(); const clearScheduledTimeout = vi.fn()
    let listenSignal: AbortSignal | undefined; let closeCalls = 0
    const listener: BuilderSupervisorListener = {
      server: { close: vi.fn(), closeAllConnections, closeIdleConnections },
      close: async afterStopAccepting => { closeCalls += 1; afterStopAccepting?.() },
    }
    const runtime = slotStartRuntime({
      listen: async options => { listenSignal = options.signal; return listener },
      scheduleTimeout: callback => { callback(); return 1 as unknown as ReturnType<typeof setTimeout> },
      clearScheduledTimeout,
    })
    const managed = await createBuilderRuntimeSlotStarter(runtime)(first, 'a'.repeat(64), roots, capacity, 100, managerSignal.signal)
    await managed.retire(50); await managed.retire(50)
    expect(closeCalls).toBe(1)
    expect(clearScheduledTimeout).toHaveBeenCalledTimes(1)
    expect(listenSignal?.aborted).toBe(true)
    expect(closeAllConnections).toHaveBeenCalled(); expect(closeIdleConnections).toHaveBeenCalled()
  })

  it('retains global capacity after close rejection and releases it only after a successful retry', async () => {
    const first = slot('1'); const capacity = new FairGlobalBuilderCapacity(1); let closeCalls = 0; let rpc: BuilderRpcMethods | undefined
    const listener: BuilderSupervisorListener = {
      server: { close: vi.fn(), closeAllConnections: vi.fn(), closeIdleConnections: vi.fn() },
      close: async afterStopAccepting => { closeCalls += 1; afterStopAccepting?.(); if (closeCalls === 1) throw new Error('close-failed') },
    }
    const runtime = slotStartRuntime({ listen: async options => { rpc = options.methods; return listener } })
    const managed = await createBuilderRuntimeSlotStarter(runtime)(first, 'a'.repeat(64), roots, capacity, 100, new AbortController().signal)
    await rpc?.prepare(prepareBody('1', 'one'), new AbortController().signal)
    expect(capacity.active).toBe(1)
    await expect(managed.retire(100)).rejects.toThrow('close-failed')
    expect(capacity.active).toBe(1)
    await expect(managed.retire(100)).resolves.toBeUndefined()
    expect({ closeCalls, active: capacity.active }).toEqual({ closeCalls: 2, active: 0 })
    await managed.retire(100); expect(closeCalls).toBe(2)
  })

  it('shares concurrent close, retains capacity after the deadline, and releases on late close proof', async () => {
    const first = slot('1'); const capacity = new FairGlobalBuilderCapacity(1); let resolveClose!: () => void; let closeCalls = 0; let rpc: BuilderRpcMethods | undefined
    const closeGate = new Promise<void>(resolve => { resolveClose = resolve })
    const listener: BuilderSupervisorListener = {
      server: { close: vi.fn(), closeAllConnections: vi.fn(), closeIdleConnections: vi.fn() },
      close: async afterStopAccepting => { closeCalls += 1; afterStopAccepting?.(); await closeGate },
    }
    const runtime = slotStartRuntime({ listen: async options => { rpc = options.methods; return listener } })
    const managed = await createBuilderRuntimeSlotStarter(runtime)(first, 'a'.repeat(64), roots, capacity, 1, new AbortController().signal)
    await rpc?.prepare(prepareBody('1', 'one'), new AbortController().signal)
    const results = await Promise.allSettled([managed.retire(1), managed.retire(1)])
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected'])
    expect({ closeCalls, active: capacity.active }).toEqual({ closeCalls: 1, active: 1 })
    resolveClose(); await until(() => capacity.active === 0)
    await expect(managed.retire(1)).resolves.toBeUndefined()
    expect(closeCalls).toBe(1)
  })

  it('removes the manager abort hook when listen fails and passes an already-aborted signal to no listener', async () => {
    const first = slot('1'); const capacity = new FairGlobalBuilderCapacity(1); const failureSignal = new AbortController()
    const listen = vi.fn<BuilderRuntimeSlotStartRuntime['listen']>().mockRejectedValue(new Error('listen-failed'))
    await expect(createBuilderRuntimeSlotStarter(slotStartRuntime({ listen }))(first, 'a'.repeat(64), roots, capacity, 100, failureSignal.signal)).rejects.toThrow('listen-failed')
    failureSignal.abort(new Error('after-listen-failure'))

    const duringListen = new AbortController(); let cancelledListenSignal: AbortSignal | undefined
    const cancelledRuntime = slotStartRuntime({ listen: async options => { cancelledListenSignal = options.signal; duringListen.abort(new Error('cancelled-during-listen')); throw new Error('listener-cancelled') } })
    await expect(createBuilderRuntimeSlotStarter(cancelledRuntime)(first, 'a'.repeat(64), roots, capacity, 100, duringListen.signal)).rejects.toThrow('listener-cancelled')
    expect(cancelledListenSignal?.aborted).toBe(true)

    const abortedDuringCompose = new AbortController(); let observed: AbortSignal | undefined
    const runtime = slotStartRuntime({
      compose: config => { abortedDuringCompose.abort(new Error('abort-before-listen')); return { methods: methods(config.scopeId[2] ?? '1') } },
      listen: async options => { observed = options.signal; throw new Error('listener-refused-aborted-start') },
    })
    await expect(createBuilderRuntimeSlotStarter(runtime)(first, 'a'.repeat(64), roots, capacity, 100, abortedDuringCompose.signal)).rejects.toThrow('abort-before-listen')
    expect(observed).toBeUndefined()
  })
})

describe('global capacity wiring', () => {
  it('preserves the authenticated artifact-ingress port while wrapping capacity', () => {
    const artifactIngress = {} as NonNullable<BuilderSupervisorComposition['artifactIngress']>
    const wrapped = wrapBuilderSupervisorWithGlobalCapacity(scope('1'), { artifactIngress, methods: methods('1') }, new FairGlobalBuilderCapacity(1))
    expect(wrapped.artifactIngress).toBe(artifactIngress)
  })

  it('holds one global lease from prepare until cancel and then admits the next scope', async () => {
    const capacity = new FairGlobalBuilderCapacity(1)
    const first = wrapBuilderSupervisorWithGlobalCapacity(scope('1'), { methods: methods('1') }, capacity)
    const second = wrapBuilderSupervisorWithGlobalCapacity(scope('2'), { methods: methods('2') }, capacity)
    const prepared = await first.methods.prepare(prepareBody('1', 'one'), new AbortController().signal)
    let admitted = false
    const waiting = second.methods.prepare(prepareBody('2', 'two'), new AbortController().signal).then(value => { admitted = true; return value })
    await new Promise(resolve => setTimeout(resolve, 0)); expect(admitted).toBe(false)
    await first.methods.cancel({ request_id: `req_${'3'.repeat(32)}`, build_ref: prepared.build_ref }, new AbortController().signal)
    const next = await waiting; expect(admitted).toBe(true)
    second.releaseAll(); expect(capacity.active).toBe(0); expect(next.build_ref).toBe(`build_${'2'.repeat(32)}`)
  })

  it('releases leases on terminal execute, prepare failure, finish failure, and explicit cleanup', async () => {
    const capacity = new FairGlobalBuilderCapacity(2)
    const baseFailing = methods('1'); const failing = { ...baseFailing, prepare: async () => { throw new Error('prepare-failed') } } satisfies typeof baseFailing
    const wrappedFailing = wrapBuilderSupervisorWithGlobalCapacity(scope('1'), { methods: failing }, capacity)
    await expect(wrappedFailing.methods.prepare(prepareBody('1', 'one'), new AbortController().signal)).rejects.toThrow('prepare-failed')
    expect(capacity.active).toBe(0)
    const wrapped = wrapBuilderSupervisorWithGlobalCapacity(scope('1'), { methods: methods('1') }, capacity)
    const first = await wrapped.methods.prepare(prepareBody('2', 'one'), new AbortController().signal)
    await wrapped.methods.execute({ request_id: `req_${'3'.repeat(32)}`, build_ref: first.build_ref, step: 'install' }, new AbortController().signal)
    expect(capacity.active).toBe(0)
    const second = await wrapped.methods.prepare(prepareBody('4', 'two'), new AbortController().signal)
    const failFinishBase = methods('3')
    const failFinish = wrapBuilderSupervisorWithGlobalCapacity(scope('3'), { methods: { ...failFinishBase, finish: async body => { throw Object.assign(new Error('finish-failed'), { build_ref: body.build_ref }) } } }, capacity)
    const third = await failFinish.methods.prepare(prepareBody('6', 'three'), new AbortController().signal)
    await expect(failFinish.methods.finish({ request_id: `req_${'5'.repeat(32)}`, build_ref: third.build_ref }, new AbortController().signal)).rejects.toThrow('finish-failed')
    expect(capacity.active).toBe(2)
    failFinish.releaseAll()
    wrapped.releaseAll()
    expect(capacity.active).toBe(0)
  })

  it('retains a lease after execute or cancel throws until finish or runtime cleanup', async () => {
    const capacity = new FairGlobalBuilderCapacity(1)
    const base = methods('1')
    const wrapped = wrapBuilderSupervisorWithGlobalCapacity(scope('1'), { methods: {
      ...base,
      execute: async () => { throw new Error('execute-failed') },
      cancel: async () => { throw new Error('cancel-failed') },
    } }, capacity)
    const prepared = await wrapped.methods.prepare(prepareBody('1', 'one'), new AbortController().signal)
    await expect(wrapped.methods.execute({ request_id: `req_${'2'.repeat(32)}`, build_ref: prepared.build_ref, step: 'install' }, new AbortController().signal)).rejects.toThrow('execute-failed')
    expect(capacity.active).toBe(1)
    await expect(wrapped.methods.cancel({ request_id: `req_${'3'.repeat(32)}`, build_ref: prepared.build_ref }, new AbortController().signal)).rejects.toThrow('cancel-failed')
    expect(capacity.active).toBe(1)
    await wrapped.methods.finish({ request_id: `req_${'4'.repeat(32)}`, build_ref: prepared.build_ref }, new AbortController().signal)
    expect(capacity.active).toBe(0)
  })

  it('handles duplicate prepare references, nonterminal execution, and release of an unknown reference', async () => {
    const capacity = new FairGlobalBuilderCapacity(2); const base = methods('1')
    const wrapped = wrapBuilderSupervisorWithGlobalCapacity(scope('1'), { methods: {
      ...base,
      execute: async body => ({ build_ref: body.build_ref, state: 'INSTALLING', step: body.step, result: { exit_code: 0, stdout: '', stderr: '', timed_out: false, termination_reason: null, output_limit_exceeded: false } }),
    } }, capacity)
    const first = await wrapped.methods.prepare(prepareBody('1', 'one'), new AbortController().signal)
    await wrapped.methods.prepare(prepareBody('2', 'two'), new AbortController().signal)
    expect(capacity.active).toBe(1)
    await wrapped.methods.execute({ request_id: `req_${'3'.repeat(32)}`, build_ref: first.build_ref, step: 'install' }, new AbortController().signal)
    expect(capacity.active).toBe(1)
    await wrapped.methods.cancel({ request_id: `req_${'4'.repeat(32)}`, build_ref: `build_${'f'.repeat(32)}` }, new AbortController().signal)
    expect(capacity.active).toBe(1)
    wrapped.releaseAll(); expect(capacity.active).toBe(0)
  })

  it('retains a lease across cleanup-incomplete finish and releases only after a clean retry', async () => {
    const capacity = new FairGlobalBuilderCapacity(1); let attempts = 0
    const base = methods('1')
    const wrapped = wrapBuilderSupervisorWithGlobalCapacity(scope('1'), { methods: {
      ...base,
      finish: async body => {
        attempts += 1
        if (attempts === 1) throw Object.assign(new Error('CLEANUP_INCOMPLETE'), { code: 'CLEANUP_INCOMPLETE' })
        if (attempts === 2) return { build_ref: body.build_ref, final_state: 'CANCELLED', exported: null, cleanup_pending: true, cleaned: false }
        return { build_ref: body.build_ref, final_state: 'CANCELLED', exported: null, cleanup_pending: false, cleaned: true }
      },
    } }, capacity)
    const prepared = await wrapped.methods.prepare(prepareBody('1', 'one'), new AbortController().signal)
    await expect(wrapped.methods.finish({ request_id: `req_${'2'.repeat(32)}`, build_ref: prepared.build_ref }, new AbortController().signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
    expect(capacity.active).toBe(1)
    await expect(wrapped.methods.finish({ request_id: `req_${'3'.repeat(32)}`, build_ref: prepared.build_ref }, new AbortController().signal)).resolves.toEqual(expect.objectContaining({ cleanup_pending: true, cleaned: false }))
    expect(capacity.active).toBe(1)
    await wrapped.methods.finish({ request_id: `req_${'4'.repeat(32)}`, build_ref: prepared.build_ref }, new AbortController().signal)
    expect(capacity.active).toBe(0)
  })

  it('retires a started runtime if persistent healthy state cannot be committed', async () => {
    const first = slot('1'); let retired = false; let writes = 0
    const dependencies: BuilderRuntimeManagerDependencies = {
      ...memoryState(),
      loadRegistry: async () => registry(1, [first]),
      startSlot: async () => ({ scopeId: first.scopeId, retire: async () => { retired = true } }),
      health: { write: async value => { writes += 1; if (value.state === 'HEALTHY') throw new Error('health-disk-secret') } },
      now: () => new Date(0), error: vi.fn(),
    }
    const manager = new BuilderRuntimeManager({ registryReference: 'file:/config/manager/runtime-registry.json', roots, drainTimeoutMs: 100, reloadTimeoutMs: 100, maximumGlobalBuilds: 1, dependencies })
    await manager.initialize()
    expect({ retired, writes, active: manager.snapshot().activeScopes }).toEqual({ retired: true, writes: 3, active: [] })
    expect(manager.snapshot().health[0]).toEqual(expect.objectContaining({ state: 'DEGRADED', code: 'START_FAILED' }))
  })

  it('sanitizes a persistent-health failure even when late runtime retirement also fails', async () => {
    const firstSlot = slot('1'); let healthy = true; let allowRetire = false; const state = memoryState()
    const dependencies: BuilderRuntimeManagerDependencies = {
      ...state, loadRegistry: async () => registry(1, [firstSlot]),
      startSlot: async () => ({ scopeId: firstSlot.scopeId, retire: async () => { if (!allowRetire) throw new Error('retire-secret') } }),
      health: { write: async value => { if (value.state === 'HEALTHY' && healthy) { healthy = false; throw new Error('health-secret') } } },
      now: () => new Date(0), error: vi.fn(),
    }
    const manager = new BuilderRuntimeManager({ registryReference: 'file:/config/manager/runtime-registry.json', roots, drainTimeoutMs: 100, reloadTimeoutMs: 100, maximumGlobalBuilds: 1, dependencies })
    const other = fixture([registry(1, [firstSlot])], undefined, undefined, state)
    await expect(manager.initialize()).rejects.toBeInstanceOf(Error)
    expect(manager.snapshot().health).toEqual([expect.objectContaining({ state: 'DEGRADED', code: 'DRAIN_FAILED' })])
    await expect(other.manager.initialize()).rejects.toThrow('MANAGER_ALREADY_RUNNING')
    allowRetire = true; await manager.shutdown()
    await other.manager.initialize(); await other.manager.shutdown()
  })
})

describe('manager process lifecycle', () => {
  it('polls, reloads on SIGHUP, coalesces events, and shuts every runtime down', async () => {
    const signals = new Signals(); const intervals: Array<() => void> = []
    const runtime = fakeRuntime(signals, intervals)
    const first = slot('1'); const values = [registry(1, [first]), registry(1, [first])]
    const harness = fixture(values)
    const { now: _now, ...dependencies } = harness.dependencies
    const execution = runBuilderRuntimeManager({ registryReference: 'file:/config/manager/runtime-registry.json', roots, pollIntervalMs: 10, reloadTimeoutMs: 100, drainTimeoutMs: 100, dependencies, runtime })
    await until(() => harness.started.length === 1)
    signals.emit('SIGHUP'); intervals[0]?.(); signals.emit('SIGTERM'); signals.emit('SIGTERM')
    expect(await execution).toBe(BUILDER_MANAGER_EXIT.ok)
    expect(harness.retired).toEqual([scope('1')])
    expect(signals.eventNames()).toEqual([])
  })

  it('returns usage for invalid options and emits only sanitized startup codes', async () => {
    const error = vi.fn(); const dependencies = { ...fixture([]).dependencies, loadRegistry: async () => { throw new BuilderRuntimeRegistryError() }, error }
    expect(await runBuilderRuntimeManager({ registryReference: 'file:/config/manager/runtime-registry.json', roots, pollIntervalMs: 0, dependencies })).toBe(BUILDER_MANAGER_EXIT.usage)
    expect(await runBuilderRuntimeManager({ registryReference: 'file:/config/manager/runtime-registry.json', roots, maximumGlobalBuilds: 0, dependencies })).toBe(BUILDER_MANAGER_EXIT.usage)
    expect(await runBuilderRuntimeManager({ registryReference: 'file:/config/manager/runtime-registry.json', roots, dependencies })).toBe(BUILDER_MANAGER_EXIT.usage)
    expect(error).toHaveBeenCalledWith('INVALID_RUNTIME_REGISTRY')
    expect(JSON.stringify(error.mock.calls)).not.toMatch(/tenant|token|secret/u)
  })

  it('does not register reload or shutdown signals until initialization is proven', async () => {
    const signals = new Signals(); const intervals: Array<() => void> = []; let entered = false; let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve }); const error = vi.fn()
    const dependencies = {
      ...fixture([]).dependencies,
      loadRegistry: async () => { entered = true; await gate; throw new BuilderRuntimeRegistryError() },
      error,
    }
    const execution = runBuilderRuntimeManager({ registryReference: 'file:/config/manager/runtime-registry.json', roots, dependencies, runtime: fakeRuntime(signals, intervals) })
    await until(() => entered)
    expect(signals.eventNames()).toEqual([])
    expect(signals.emit('SIGHUP')).toBe(false)
    release()
    expect(await execution).toBe(BUILDER_MANAGER_EXIT.usage)
    expect(error).toHaveBeenCalledWith('INVALID_RUNTIME_REGISTRY')
    expect(intervals).toEqual([])
    expect(signals.eventNames()).toEqual([])
  })

  it('reports generic startup and failed shutdown without leaking the underlying error', async () => {
    const startupError = vi.fn()
    const brokenStart = { ...fixture([]).dependencies, loadRegistry: async () => { throw new Error('startup-secret') }, error: startupError }
    expect(await runBuilderRuntimeManager({ registryReference: 'file:/config/manager/runtime-registry.json', roots, dependencies: brokenStart })).toBe(BUILDER_MANAGER_EXIT.startup)
    expect(startupError).toHaveBeenCalledWith('MANAGER_STARTUP_FAILED')

    const signals = new Signals(); const intervals: Array<() => void> = []; const shutdownError = vi.fn(); const harness = fixture([registry(1, [slot('1')])], undefined, scope('1'))
    const execution = runBuilderRuntimeManager({ registryReference: 'file:/config/manager/runtime-registry.json', roots, dependencies: { ...harness.dependencies, error: shutdownError }, runtime: fakeRuntime(signals, intervals) })
    await until(() => harness.started.length === 1); signals.emit('SIGINT')
    expect(await execution).toBe(BUILDER_MANAGER_EXIT.shutdown)
    expect(shutdownError).toHaveBeenCalledWith('SHUTDOWN_FAILED')
  })

  it('validates CLI arguments and maps a missing default registry to usage failure', async () => {
    expect(await executeBuilderRuntimeManagerCli([])).toBe(BUILDER_MANAGER_EXIT.usage)
    expect(await executeBuilderRuntimeManagerCli(['--registry', 'https://example.invalid/registry.json'])).toBe(BUILDER_MANAGER_EXIT.usage)
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    await expect(executeBuilderRuntimeManagerCli(['--registry', 'file:///definitely-missing/runtime-registry.json'])).resolves.toBe(BUILDER_MANAGER_EXIT.usage)
    expect(write).toHaveBeenCalled()
    write.mockRestore()
  })

  it('retains authority when both initialization cleanup and final shutdown cannot close a runtime', async () => {
    const first = slot('1'); const second = slot('2'); let writes = 0; const error = vi.fn()
    const dependencies: Partial<BuilderRuntimeManagerDependencies> = {
      ...memoryState(), loadRegistry: async () => registry(1, [first, second]),
      startSlot: async candidate => ({ scopeId: candidate.scopeId, retire: async () => { throw new Error('still-live-secret') } }),
      health: { write: async value => { writes += 1; if (value.scope_id === second.scopeId && value.state === 'STARTING') throw new Error('health-start-secret') } },
      now: () => new Date(0), error,
    }
    expect(await runBuilderRuntimeManager({ registryReference: 'file:/config/manager/runtime-registry.json', roots, dependencies })).toBe(BUILDER_MANAGER_EXIT.startup)
    expect(error).toHaveBeenCalledWith('MANAGER_STARTUP_FAILED')
    expect(writes).toBeGreaterThan(0)
  })
})

function fixture(values: Array<BuilderRuntimeRegistry | Error>, beforeStart?: (slot: BuilderRuntimeRegistrySlot) => void, failRetire?: BuilderRuntimeScopeId, state = memoryState()) {
  const health = new MemoryBuilderRuntimeHealthStore(); const started: Array<{ slot: BuilderRuntimeRegistrySlot; installationId: string }> = []; const retired: BuilderRuntimeScopeId[] = []; const errors: string[] = []
  let index = 0
  const dependencies: BuilderRuntimeManagerDependencies = {
    ...state,
    loadRegistry: async () => { const value = values[Math.min(index, values.length - 1)]; index += 1; if (value instanceof Error) throw value; if (value === undefined) throw new BuilderRuntimeRegistryError(); return value },
    startSlot: async (candidate, installationId) => {
      beforeStart?.(candidate); started.push({ slot: candidate, installationId })
      return { scopeId: candidate.scopeId, retire: async () => { retired.push(candidate.scopeId); if (candidate.scopeId === failRetire) throw new Error('drain-secret') } }
    },
    health,
    now: (() => { let tick = 0; return () => new Date(1_700_000_000_000 + tick++ * 1_000) })(),
    error: code => { errors.push(code) },
  }
  const manager = new BuilderRuntimeManager({ registryReference: 'file:/config/manager/runtime-registry.json', roots, drainTimeoutMs: 100, reloadTimeoutMs: 100, maximumGlobalBuilds: 2, dependencies })
  return { manager, dependencies, health, started, retired, errors }
}

function memoryState(checkpoint?: BuilderManagerCheckpointPort): { readonly lease: BuilderManagerLeasePort; readonly checkpoint: BuilderManagerCheckpointPort } {
  return { lease: new MemoryBuilderManagerLeasePort(), checkpoint: checkpoint ?? new MemoryBuilderManagerCheckpointPort() }
}

function slot(digit: string): BuilderRuntimeRegistrySlot {
  const scopeId = scope(digit)
  return { scopeId, configReference: `file:/config/instances/${scopeId}/supervisor.json`, configSha256: 'b'.repeat(64), state: 'active' }
}

function registry(generation: number, slots: readonly BuilderRuntimeRegistrySlot[]): BuilderRuntimeRegistry {
  return { version: 1, installationId: 'a'.repeat(64), generation, slots, sha256: createHash('sha256').update(JSON.stringify({ generation, slots })).digest('hex') }
}

class Signals extends EventEmitter {
  override on(signal: 'SIGHUP' | 'SIGINT' | 'SIGTERM', listener: () => void): this { return super.on(signal, listener) }
  override off(signal: 'SIGHUP' | 'SIGINT' | 'SIGTERM', listener: () => void): this { return super.off(signal, listener) }
  emit(signal: 'SIGHUP' | 'SIGINT' | 'SIGTERM'): boolean { return super.emit(signal) }
}

function fakeRuntime(signals: Signals, intervals: Array<() => void>): BuilderRuntimeManagerRuntime {
  return {
    signals,
    setInterval: ((callback: () => void) => { intervals.push(callback); return { unref: () => undefined } }) as unknown as typeof setInterval,
    clearInterval: (() => undefined) as typeof clearInterval,
  }
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)) }
  throw new Error('TEST_TIMEOUT')
}

function methods(digit: string): BuilderRpcMethods & { initialize(signal: AbortSignal): Promise<void> } {
  const buildRef = `build_${digit.repeat(32)}` as const
  return {
    initialize: async signal => { signal.throwIfAborted() },
    preflight: async () => ({ state: 'OK', protocol_version: 1, scope_id: scope(digit), image_id: `sha256:${'a'.repeat(64)}`, policy_sha256: 'b'.repeat(64) }),
    prepare: async () => ({ build_ref: buildRef, state: 'PREPARED' }),
    execute: async body => ({ build_ref: body.build_ref, state: 'FAILED', step: body.step, result: { exit_code: 1, stdout: '', stderr: '', timed_out: false, termination_reason: null, output_limit_exceeded: false } }),
    cancel: async body => ({ build_ref: body.build_ref, state: 'CANCELLED' }),
    finish: async body => ({ build_ref: body.build_ref, final_state: 'CANCELLED', exported: null, cleanup_pending: false, cleaned: true }),
    listManaged: async () => ({ builds: [] }),
  }
}

function prepareBody(digit: string, buildId: string): PrepareRequest {
  return { request_id: `req_${digit.repeat(32)}`, build_id: buildId, upload_ref: `upload_${digit.repeat(32)}` }
}

function resolvedConfig(): BuilderSupervisorResolvedConfig {
  const templateStoreSha256 = 'b'.repeat(64)
  return {
    installationId: 'a'.repeat(64), tenantId: 'tenant-internal', instanceId: 'instance-internal', scopeId: scope('1'),
    socketPath: '/run/builder.sock', artifactRoot: '/artifact', exportRoot: '/export', journalRoot: '/state/journal', replayRoot: '/state/replay', dockerSocketPath: '/docker.sock',
    bearerToken: 'test-only-token', imageDigest: `sha256:${'a'.repeat(64)}`, templateStoreVersion: 'v1', templateStoreSha256,
    templateStoreManifest: { version: 1, template_store_version: 'v1', tree_sha256: templateStoreSha256, entries: [] },
    templateStoreManifestReference: `file:/config/instances/${scope('1')}/template-store.manifest.json`, policySha256: 'b'.repeat(64),
  }
}

function slotStartRuntime(overrides: Partial<BuilderRuntimeSlotStartRuntime> = {}): BuilderRuntimeSlotStartRuntime {
  const config = resolvedConfig()
  const composition: BuilderSupervisorComposition = { methods: methods('1') }
  const engine = {} as DockerEnginePort
  return {
    loadConfig: async () => config,
    createEngine: () => engine,
    ensureTemplateStore: async options => ({ state: 'REUSED', volumeName: `test-${options.scopeId}`, treeSha256: options.treeSha256 }),
    compose: () => composition,
    listen: async () => ({ server: { close: vi.fn(), closeAllConnections: vi.fn(), closeIdleConnections: vi.fn() }, close: async () => undefined }),
    scheduleTimeout: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
    clearScheduledTimeout: timer => clearTimeout(timer),
    ...overrides,
  }
}
