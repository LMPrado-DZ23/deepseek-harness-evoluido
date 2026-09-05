import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { lstat, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { posix } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DockerBuilderAdapter, type BuilderLimits } from '../src/docker-adapter.js'
import type { DockerEnginePort } from '../src/docker-engine.js'
import type { BuilderRpcMethods } from '../src/protocol.js'
import { BuilderSupervisorConfigError, type BuilderSupervisorResolvedConfig } from '../src/supervisor-config.js'
import {
  BUILDER_SUPERVISOR_EXIT,
  applyBuilderSupervisorExitCode,
  composeBuilderSupervisor,
  executeBuilderSupervisorCli,
  runBuilderSupervisorMain,
  type BuilderSupervisorListener,
  type BuilderSupervisorSignalSource,
} from '../src/supervisor-main.js'
import { listenBuilderUnix } from '../src/unix-server.js'
import { deriveBuilderRuntimeScopeId } from '../src/runtime-scope.js'

const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('builder supervisor process entrypoint', () => {
  it('emits only the fixed CLI error through the default logger', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      expect(await executeBuilderSupervisorCli([])).toBe(BUILDER_SUPERVISOR_EXIT.usage)
      expect(write).toHaveBeenCalledOnce()
      expect(String(write.mock.calls[0]?.[0])).toBe('{"event":"builder-supervisor-error","code":"INVALID_ARGUMENTS"}\n')
    } finally { write.mockRestore() }
  })

  it('maps both a resolved process run and an unexpected rejection to stable exit codes', async () => {
    const target: { exitCode?: string | number | null | undefined } = {}
    await applyBuilderSupervisorExitCode(Promise.resolve(BUILDER_SUPERVISOR_EXIT.usage), target)
    expect(target.exitCode).toBe(BUILDER_SUPERVISOR_EXIT.usage)
    await applyBuilderSupervisorExitCode(Promise.reject(new Error('secret-value')), target)
    expect(target.exitCode).toBe(BUILDER_SUPERVISOR_EXIT.startup)
  })

  it('uses stable usage and startup exit codes without logging configuration or secret values', async () => {
    const messages: string[] = []; const token = `token_${'S'.repeat(48)}`
    expect(await executeBuilderSupervisorCli(['--bad', token], { error: code => messages.push(code) })).toBe(BUILDER_SUPERVISOR_EXIT.usage)
    const configFailure = await runBuilderSupervisorMain({
      configReference: 'file:/untrusted/config.json',
      dependencies: dependencies({ loadConfig: async () => { throw new BuilderSupervisorConfigError() }, error: code => messages.push(code) }),
    })
    expect(configFailure).toBe(BUILDER_SUPERVISOR_EXIT.usage)
    const startupFailure = await runBuilderSupervisorMain({
      configReference: 'file:/trusted/config.json',
      dependencies: dependencies({ loadConfig: async () => config({ bearerToken: token }), listen: async () => { throw new Error(token) }, error: code => messages.push(code) }),
    })
    expect(startupFailure).toBe(BUILDER_SUPERVISOR_EXIT.startup)
    expect(messages).toEqual(['INVALID_ARGUMENTS', 'INVALID_CONFIGURATION', 'STARTUP_FAILED'])
    expect(messages.join('\n')).not.toContain(token)
  })

  it('stops acceptance before abort, drains, removes authority and treats a second signal as forced close', async () => {
    const signals = new Signals(); const events: string[] = []; let finishClose!: () => void; const closePending = new Promise<void>(resolve => { finishClose = resolve }); let capturedSignal: AbortSignal | undefined
    const server = {
      close: vi.fn(),
      closeAllConnections: () => { events.push('force-close') },
      closeIdleConnections: vi.fn(),
    }
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve })
    const result = runBuilderSupervisorMain({
      configReference: 'file:/trusted/config.json',
      dependencies: dependencies({
        signals,
        loadConfig: async () => config(),
        listen: async options => { capturedSignal = options.signal; capturedSignal.addEventListener('abort', () => events.push('abort')); setTimeout(started, 0); return { server, close: async (afterStop?: () => void) => { events.push('close-idle', 'stop-accepting'); afterStop?.(); await closePending; events.push('release-authority') } } as unknown as BuilderSupervisorListener },
      }),
    })
    await ready; signals.emit('SIGTERM'); signals.emit('SIGINT')
    expect(events).toEqual(['close-idle', 'stop-accepting', 'abort', 'force-close'])
    finishClose(); expect(await result).toBe(BUILDER_SUPERVISOR_EXIT.ok)
    expect(events).toEqual(['close-idle', 'stop-accepting', 'abort', 'force-close', 'release-authority'])
    expect(capturedSignal?.aborted).toBe(true)
  })

  it('returns the shutdown code and a fixed message when authority cleanup fails', async () => {
    const signals = new Signals(); const messages: string[] = []; let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve })
    const server = { close: (callback: (error?: Error) => void) => { queueMicrotask(() => callback()); return server }, closeAllConnections: vi.fn(), closeIdleConnections: vi.fn() }
    const result = runBuilderSupervisorMain({ configReference: 'file:/trusted/config.json', dependencies: dependencies({
      signals, error: code => messages.push(code), loadConfig: async () => config(),
      listen: async () => { setTimeout(started, 0); return { server, close: async (afterStop?: () => void) => { afterStop?.(); throw new Error(config().bearerToken) } } as unknown as BuilderSupervisorListener },
    }) })
    await ready; signals.emit('SIGTERM')
    expect(await result).toBe(BUILDER_SUPERVISOR_EXIT.shutdown)
    expect(messages).toEqual(['SHUTDOWN_FAILED'])
  })

  it('honors a signal received during configuration without starting a listener', async () => {
    const signals = new Signals(); let release!: (value: BuilderSupervisorResolvedConfig) => void
    const pending = new Promise<BuilderSupervisorResolvedConfig>(resolve => { release = resolve })
    const listen = vi.fn(async () => { throw new Error('MUST_NOT_LISTEN') })
    const result = runBuilderSupervisorMain({ configReference: 'file:/trusted/config.json', dependencies: dependencies({ signals, loadConfig: async () => pending, listen }) })
    signals.emit('SIGTERM'); release(config())
    expect(await result).toBe(BUILDER_SUPERVISOR_EXIT.ok)
    expect(listen).not.toHaveBeenCalled()
  })

  it('shuts down when the signal arrives while binding and when binding then rejects', async () => {
    for (const rejectAfterSignal of [false, true]) {
      const signals = new Signals(); const close = vi.fn(async (afterStop?: () => void) => { afterStop?.() })
      const result = runBuilderSupervisorMain({ configReference: 'file:/trusted/config.json', dependencies: dependencies({
        signals,
        loadConfig: async () => config(),
        listen: async () => {
          signals.emit('SIGTERM')
          if (rejectAfterSignal) throw new Error('BIND_INTERRUPTED')
          return { server: { close: vi.fn(), closeAllConnections: vi.fn(), closeIdleConnections: vi.fn() }, close } as unknown as BuilderSupervisorListener
        },
      }) })
      expect(await result).toBe(BUILDER_SUPERVISOR_EXIT.ok)
      expect(close).toHaveBeenCalledTimes(rejectAfterSignal ? 0 : 1)
    }
  })

  it('aborts even when listener shutdown fails before acknowledging stopped acceptance', async () => {
    const signals = new Signals(); let observed: AbortSignal | undefined; let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const result = runBuilderSupervisorMain({ configReference: 'file:/trusted/config.json', dependencies: dependencies({
      signals,
      loadConfig: async () => config(),
      listen: async options => {
        observed = options.signal
        setTimeout(started, 0)
        return {
          server: { close: vi.fn(), closeAllConnections: vi.fn(), closeIdleConnections: vi.fn() },
          close: async () => { throw new Error('STOP_ACCEPTANCE_FAILED') },
        } as unknown as BuilderSupervisorListener
      },
    }) })
    await ready; signals.emit('SIGTERM')
    expect(await result).toBe(BUILDER_SUPERVISOR_EXIT.shutdown)
    expect(observed?.aborted).toBe(true)
  })

  it('accepts only the exact file-backed CLI form and uses the default engine composition lazily', async () => {
    const signals = new Signals(); let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve })
    const close = vi.fn(async (afterStop?: () => void) => { afterStop?.() })
    const result = executeBuilderSupervisorCli(['--config', 'file:/trusted/config.json'], dependencies({
      signals,
      loadConfig: async () => config(),
      compose: (value: BuilderSupervisorResolvedConfig) => composeBuilderSupervisor(value),
      listen: async () => { setTimeout(started, 0); return { server: { close: vi.fn(), closeAllConnections: vi.fn(), closeIdleConnections: vi.fn() }, close } as unknown as BuilderSupervisorListener },
    }))
    await ready; signals.emit('SIGTERM')
    expect(await result).toBe(BUILDER_SUPERVISOR_EXIT.ok)
    expect(close).toHaveBeenCalledOnce()
  })

  it('wires the durable journal and rejects an attestation that differs from the pinned policy', async () => {
    const root = await mkdtemp(posix.join(tmpdir(), 'dz23-supervisor-compose-')); temporary.push(root)
    const initial = config({ artifactRoot: posix.join(root, 'artifacts'), exportRoot: posix.join(root, 'exports'), journalRoot: posix.join(root, 'journal') })
    await mkdir(initial.artifactRoot, { recursive: true, mode: 0o700 })
    const engine = new HealthyEngine(initial)
    const probe = new DockerBuilderAdapter({ engine, imageDigest: initial.imageDigest, installationId: initial.installationId, scopeId: initial.scopeId, exportRoot: initial.exportRoot, templateStoreVersion: initial.templateStoreVersion, templateStoreSha256: initial.templateStoreSha256 })
    const policySha256 = (await probe.preflight(new AbortController().signal)).policy_sha256
    const pinned = { ...initial, policySha256 }
    const composition = composeBuilderSupervisor(pinned, engine)
    await composition.methods.initialize(new AbortController().signal)
    expect(await composition.methods.preflight({ request_id: `req_${'1'.repeat(32)}` }, new AbortController().signal)).toMatchObject({ state: 'OK', policy_sha256: policySha256 })
    const mismatched = composeBuilderSupervisor({ ...pinned, policySha256: 'f'.repeat(64) }, engine)
    await expect(mismatched.methods.initialize(new AbortController().signal)).rejects.toThrow('BUILDER_ATTESTATION_FAILED')
  })
})

const unix = process.platform === 'linux' ? describe : describe.skip
unix('builder supervisor real Unix process boundary', () => {
  it('fails closed and preserves a stale occupied socket path', async () => {
    const root = await mkdtemp(posix.join(tmpdir(), 'dz23-supervisor-stale-')); temporary.push(root)
    const socketPath = posix.join(root, 'rpc', 'builder.sock'); await mkdir(posix.dirname(socketPath), { recursive: true, mode: 0o700 }); await writeFile(socketPath, 'evidence', { mode: 0o600 })
    const messages: string[] = []
    const result = await runBuilderSupervisorMain({ configReference: 'file:/trusted/config.json', dependencies: dependencies({
      loadConfig: async () => config({ socketPath, replayRoot: posix.join(root, 'state') }), listen: listenBuilderUnix, error: code => messages.push(code),
    }) })
    expect(result).toBe(BUILDER_SUPERVISOR_EXIT.startup)
    expect(messages).toEqual(['STARTUP_FAILED'])
    expect(await lstat(socketPath).then(item => item.isFile())).toBe(true)
  })

  it('preserves an alien replacement socket and reports failed authority cleanup', async () => {
    const root = await mkdtemp(posix.join(tmpdir(), 'dz23-supervisor-owner-')); temporary.push(root)
    const socketPath = posix.join(root, 'rpc', 'builder.sock'); const signals = new Signals(); const messages: string[] = []
    let listener: BuilderSupervisorListener | undefined; let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve })
    const result = runBuilderSupervisorMain({ configReference: 'file:/trusted/config.json', dependencies: dependencies({
      signals, loadConfig: async () => config({ socketPath, replayRoot: posix.join(root, 'state') }), error: code => messages.push(code),
      listen: async options => { listener = await listenBuilderUnix(options); setTimeout(started, 0); return listener },
    }) })
    await ready; await unlink(socketPath)
    const alien = createServer(); await new Promise<void>((resolve, reject) => { alien.once('error', reject); alien.listen(socketPath, resolve) })
    try {
      signals.emit('SIGTERM')
      expect(await result).toBe(BUILDER_SUPERVISOR_EXIT.shutdown)
      expect(messages).toEqual(['SHUTDOWN_FAILED'])
      expect(await lstat(socketPath).then(item => item.isSocket())).toBe(true)
    } finally {
      await new Promise<void>(resolve => alien.close(() => resolve()))
      await unlink(socketPath).catch(() => undefined)
      listener?.server.closeAllConnections()
    }
  })
})

class Signals extends EventEmitter implements BuilderSupervisorSignalSource {
  override on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): this { return super.on(signal, listener) }
  override off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): this { return super.off(signal, listener) }
  emit(signal: 'SIGINT' | 'SIGTERM'): boolean { return super.emit(signal) }
}

function dependencies(overrides: Record<string, unknown>) {
  return {
    signals: new Signals(),
    compose: () => ({ methods: fakeMethods() }),
    listen: async () => { throw new Error('LISTENER_NOT_CONFIGURED') },
    error: vi.fn(),
    ...overrides,
  } as never
}

function fakeMethods(): BuilderRpcMethods & { initialize(signal: AbortSignal): Promise<void> } {
  return {
    initialize: async signal => { signal.throwIfAborted() },
    preflight: async () => ({ state: 'OK', protocol_version: 1, scope_id: deriveBuilderRuntimeScopeId({ installationId: '1'.repeat(64), tenantId: 'tenant-one', instanceId: 'instance-one' }), image_id: `sha256:${'a'.repeat(64)}`, policy_sha256: 'c'.repeat(64) }),
    prepare: async () => ({ build_ref: `build_${'1'.repeat(32)}`, state: 'PREPARED' }),
    execute: async body => ({ build_ref: body.build_ref, state: 'FAILED', step: body.step, result: { exit_code: 1, stdout: '', stderr: '', timed_out: false, termination_reason: null, output_limit_exceeded: false } }),
    cancel: async body => ({ build_ref: body.build_ref, state: 'CANCELLED' }),
    finish: async body => ({ build_ref: body.build_ref, final_state: 'CANCELLED', exported: null, cleanup_pending: false, cleaned: true }),
    listManaged: async () => ({ builds: [] }),
  }
}

function config(overrides: Partial<BuilderSupervisorResolvedConfig> = {}): BuilderSupervisorResolvedConfig {
  const installationId = '1'.repeat(64); const tenantId = 'tenant-one'; const instanceId = 'instance-one'
  const scopeId = deriveBuilderRuntimeScopeId({ installationId, tenantId, instanceId })
  return {
    installationId, tenantId, instanceId, scopeId, socketPath: `/run/dz23-studio/builder/instances/${scopeId}/rpc.sock`,
    artifactRoot: `/srv/dz23-studio/generated-runs/instances/${scopeId}`, exportRoot: `/srv/dz23-studio/builder-exports/instances/${scopeId}`,
    journalRoot: `/var/lib/dz23-studio/builder/instances/${scopeId}/journal`, replayRoot: `/var/lib/dz23-studio/builder/instances/${scopeId}/rpc-replay`, dockerSocketPath: '/var/run/docker.sock',
    bearerToken: `token_${'T'.repeat(48)}`, imageDigest: `sha256:${'a'.repeat(64)}`, templateStoreVersion: 'v2.0.0',
    templateStoreSha256: 'b'.repeat(64), policySha256: 'c'.repeat(64), ...overrides,
  }
}

class HealthyEngine implements DockerEnginePort {
  readonly #templateVolume: string
  constructor(private readonly config: BuilderSupervisorResolvedConfig) {
    this.#templateVolume = `dz23-template-${createHash('sha256').update(`${config.scopeId}:${config.templateStoreVersion}:${config.templateStoreSha256}`).digest('hex').slice(0, 24)}`
  }
  async ping(): Promise<void> {}
  async inspectImage(): Promise<{ readonly Id: string }> { return { Id: this.config.imageDigest } }
  async createVolume(): Promise<void> { throw new Error('UNEXPECTED_CREATE_VOLUME') }
  async removeVolume(): Promise<void> {}
  async listVolumes(filters: Readonly<Record<string, readonly string[]>>): Promise<readonly Record<string, unknown>[]> {
    const labels = filters.label ?? []
    return labels.includes('dz23.managed=builder-template-store') ? [{ Name: this.#templateVolume, Labels: Object.fromEntries(labels.map(item => item.split(/=(.*)/su).slice(0, 2) as [string, string])) }] : []
  }
  async createContainer(): Promise<string> { return 'a'.repeat(12) }
  async putArchive(): Promise<void> { throw new Error('UNEXPECTED_PUT_ARCHIVE') }
  async startContainer(): Promise<void> {}
  async waitContainer(): Promise<{ readonly StatusCode: number }> { return { StatusCode: 0 } }
  async containerLogs(): Promise<{ readonly stdout: Buffer; readonly stderr: Buffer }> { return { stdout: Buffer.from(this.config.templateStoreSha256), stderr: Buffer.alloc(0) } }
  async downloadArchive(): Promise<{ readonly bytes: number; readonly sha256: string }> { throw new Error('UNEXPECTED_DOWNLOAD') }
  async stopContainer(): Promise<void> {}
  async removeContainer(): Promise<void> {}
  async listContainers(): Promise<readonly Record<string, unknown>[]> { return [] }
}
