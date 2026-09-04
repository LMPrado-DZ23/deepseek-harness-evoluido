import { createHash } from 'node:crypto'
import type { DockerEnginePort } from './docker-engine.js'
import type { BuildStep, StepResult, TerminalBuildState } from './model.js'
import { BuilderSupervisorError } from './model.js'

const OUTPUT_LIMIT = 512 * 1024
const COMMANDS: Readonly<Record<BuildStep, readonly string[]>> = {
  install: ['pnpm', 'install', '--offline', '--frozen-lockfile', '--ignore-scripts', '--store-dir', '/template-store'],
  build: ['pnpm', 'run', 'build'],
  unit: ['pnpm', 'run', 'test'],
  e2e: ['pnpm', 'run', 'test:e2e'],
}

export interface BuilderLimits {
  readonly memoryBytes: number
  readonly nanoCpus: number
  readonly pids: number
  readonly timeoutMs: number
}

export interface DockerBuilderAdapterOptions {
  readonly engine: DockerEnginePort
  readonly imageDigest: `sha256:${string}`
  readonly instanceId: string
  readonly limits?: BuilderLimits
}

export interface PreparedArtifact {
  readonly archive: Buffer
  readonly sourceDirectory: string
  readonly sha256: string
  readonly files: number
  readonly bytes: number
}

export interface BuilderExecutionPort {
  preflight(signal: AbortSignal): Promise<'OK' | 'BLOCKED_EXTERNAL'>
  prepare(buildRef: string, buildId: string, artifact: PreparedArtifact, signal: AbortSignal): Promise<void>
  execute(buildRef: string, step: BuildStep, signal: AbortSignal): Promise<StepResult>
  cancel(buildRef: string, signal: AbortSignal): Promise<void>
  finish(buildRef: string, finalState: TerminalBuildState, signal: AbortSignal): Promise<void>
  listManaged(signal: AbortSignal): Promise<readonly string[]>
}

export class DockerBuilderAdapter implements BuilderExecutionPort {
  readonly #limits: BuilderLimits
  readonly #active = new Map<string, string>()
  readonly #sources = new Map<string, string>()

  constructor(private readonly options: DockerBuilderAdapterOptions) {
    if (!/^sha256:[a-f0-9]{64}$/u.test(options.imageDigest)) throw new Error('INVALID_BUILDER_IMAGE')
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(options.instanceId)) throw new Error('INVALID_INSTANCE_ID')
    this.#limits = options.limits ?? { memoryBytes: 2 * 1024 * 1024 * 1024, nanoCpus: 2_000_000_000, pids: 256, timeoutMs: 180_000 }
    for (const value of [this.#limits.memoryBytes, this.#limits.nanoCpus, this.#limits.pids, this.#limits.timeoutMs]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('INVALID_BUILDER_LIMIT')
    }
  }

  async preflight(signal: AbortSignal): Promise<'OK' | 'BLOCKED_EXTERNAL'> {
    try {
      await this.options.engine.ping(signal)
      const image = await this.options.engine.inspectImage(this.options.imageDigest, signal)
      return image.Id === this.options.imageDigest ? 'OK' : 'BLOCKED_EXTERNAL'
    } catch { return 'BLOCKED_EXTERNAL' }
  }

  async prepare(buildRef: string, buildId: string, artifact: PreparedArtifact, signal: AbortSignal): Promise<void> {
    const resources = names(this.options.instanceId, buildRef)
    const labels = baseLabels(this.options.instanceId, buildRef, buildId)
    let stager: string | undefined
    try {
      await this.options.engine.createVolume(resources.volume, { ...labels, 'dz23.resource': 'workspace' }, signal)
      stager = await this.options.engine.createContainer(resources.stager, {
        Image: this.options.imageDigest,
        Cmd: ['node', '-e', 'process.exit(0)'],
        User: '10001:10001',
        Labels: { ...labels, 'dz23.role': 'stager' },
        HostConfig: hardenedHost(this.#limits, [{ Type: 'volume', Source: resources.volume, Target: '/workspace', ReadOnly: false }]),
        NetworkDisabled: true,
        LogConfig: boundedLogs(),
      }, signal)
      await this.options.engine.putArchive(stager, '/workspace', artifact.archive, signal)
      await this.options.engine.removeContainer(stager, signal)
      this.#sources.set(buildRef, artifact.sourceDirectory)
    } catch (error) {
      if (stager !== undefined) await this.options.engine.removeContainer(stager, AbortSignal.timeout(10_000)).catch(() => undefined)
      await this.options.engine.removeVolume(resources.volume, AbortSignal.timeout(10_000)).catch(() => undefined)
      throw error
    }
  }

  async execute(buildRef: string, step: BuildStep, signal: AbortSignal): Promise<StepResult> {
    const resources = names(this.options.instanceId, buildRef)
    const labels = baseLabels(this.options.instanceId, buildRef, 'managed')
    const container = await this.options.engine.createContainer(resources.step(step), {
      Image: this.options.imageDigest,
      Cmd: COMMANDS[step],
      WorkingDir: '/workspace',
      User: '10001:10001',
      Env: ['CI=true', 'HOME=/tmp', 'XDG_CONFIG_HOME=/tmp/.config', 'NEXT_TELEMETRY_DISABLED=1'],
      Labels: { ...labels, 'dz23.role': 'step', 'dz23.step': step },
      HostConfig: hardenedHost(this.#limits, [
        { Type: 'volume', Source: resources.volume, Target: '/workspace', ReadOnly: false },
        { Type: 'volume', Source: 'dz23-builder-template-store', Target: '/template-store', ReadOnly: true },
      ]),
      NetworkDisabled: true,
      LogConfig: boundedLogs(),
    }, signal)
    this.#active.set(buildRef, container)
    let exitCode = -1; let timedOut = false; let logs: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    const timeout = AbortSignal.timeout(this.#limits.timeoutMs)
    const executionSignal = AbortSignal.any([signal, timeout])
    try {
      await this.options.engine.startContainer(container, executionSignal)
      exitCode = (await this.options.engine.waitContainer(container, executionSignal)).StatusCode
      logs = await this.options.engine.containerLogs(container, signal)
    } catch (error) {
      timedOut = timeout.aborted && !signal.aborted
      await this.options.engine.stopContainer(container, AbortSignal.timeout(10_000)).catch(() => undefined)
      if (!timedOut && !signal.aborted) throw error
    } finally {
      await this.options.engine.removeContainer(container, AbortSignal.timeout(10_000))
      this.#active.delete(buildRef)
    }
    const outputLimited = logs.byteLength > OUTPUT_LIMIT
    const stdout = sanitized(logs.subarray(0, OUTPUT_LIMIT))
    return { exit_code: outputLimited || timedOut || signal.aborted ? -1 : exitCode, stdout, stderr: '', timed_out: timedOut, output_limited: outputLimited }
  }

  async cancel(buildRef: string, signal: AbortSignal): Promise<void> {
    const active = this.#active.get(buildRef)
    if (active !== undefined) await this.options.engine.stopContainer(active, signal)
    await this.#cleanup(buildRef, signal)
  }

  async finish(buildRef: string, finalState: TerminalBuildState, signal: AbortSignal): Promise<void> {
    if (finalState === 'E2E_OK') await this.#export(buildRef, signal)
    await this.#cleanup(buildRef, signal)
  }

  async listManaged(signal: AbortSignal): Promise<readonly string[]> {
    const rows = await this.options.engine.listVolumes({ label: [`dz23.managed=builder`, `dz23.instance_id=${this.options.instanceId}`] }, signal)
    return rows.flatMap(row => {
      const labels = record(row.Labels); const value = labels['dz23.build_ref']
      return typeof value === 'string' && /^build_[a-f0-9]{32}$/u.test(value) ? [value] : []
    })
  }

  async #cleanup(buildRef: string, signal: AbortSignal): Promise<void> {
    const resources = names(this.options.instanceId, buildRef)
    const filter = { label: [`dz23.managed=builder`, `dz23.instance_id=${this.options.instanceId}`, `dz23.build_ref=${buildRef}`] }
    const errors: unknown[] = []
    const containers = await this.options.engine.listContainers(filter, signal).catch(error => { errors.push(error); return [] })
    for (const row of containers) {
      const id = identifier(row)
      if (id === undefined) { errors.push(new Error('INVALID_MANAGED_CONTAINER')); continue }
      try { await this.options.engine.stopContainer(id, signal) } catch (error) { errors.push(error) }
      try { await this.options.engine.removeContainer(id, signal) } catch (error) { errors.push(error) }
    }
    try { await this.options.engine.removeVolume(resources.volume, signal) } catch (error) { errors.push(error) }
    const [containerSurvivors, volumeSurvivors] = await Promise.all([
      this.options.engine.listContainers(filter, signal).catch(error => { errors.push(error); return [{}] }),
      this.options.engine.listVolumes(filter, signal).catch(error => { errors.push(error); return [{}] }),
    ])
    this.#active.delete(buildRef)
    this.#sources.delete(buildRef)
    if (errors.length > 0 || containerSurvivors.length > 0 || volumeSurvivors.length > 0) throw new BuilderSupervisorError('CLEANUP_INCOMPLETE')
  }

  async #export(buildRef: string, signal: AbortSignal): Promise<void> {
    const source = this.#sources.get(buildRef)
    if (source === undefined) throw new BuilderSupervisorError('CLEANUP_INCOMPLETE')
    const resources = names(this.options.instanceId, buildRef)
    const labels = baseLabels(this.options.instanceId, buildRef, 'managed')
    const exporter = await this.options.engine.createContainer(resources.exporter, {
      Image: this.options.imageDigest,
      Cmd: ['cp', '-a', '/workspace/.', '/output/'],
      User: '10001:10001',
      Labels: { ...labels, 'dz23.role': 'exporter' },
      HostConfig: hardenedHost(this.#limits, [
        { Type: 'volume', Source: resources.volume, Target: '/workspace', ReadOnly: true },
        { Type: 'bind', Source: source, Target: '/output', ReadOnly: false },
      ]),
      NetworkDisabled: true,
      LogConfig: boundedLogs(),
    }, signal)
    try {
      await this.options.engine.startContainer(exporter, signal)
      const result = await this.options.engine.waitContainer(exporter, signal)
      if (result.StatusCode !== 0) throw new Error('BUILDER_EXPORT_FAILED')
    } finally { await this.options.engine.removeContainer(exporter, AbortSignal.timeout(10_000)) }
  }
}

function hardenedHost(limits: BuilderLimits, mounts: readonly unknown[]): Readonly<Record<string, unknown>> {
  return {
    NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
    PidsLimit: limits.pids, Memory: limits.memoryBytes, NanoCpus: limits.nanoCpus, OomKillDisable: false,
    PublishAllPorts: false, PortBindings: {}, IpcMode: 'private', Mounts: mounts,
    ShmSize: 268_435_456,
    Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=268435456,uid=10001,gid=10001' },
    Ulimits: [{ Name: 'nofile', Soft: 1024, Hard: 1024 }],
  }
}
function boundedLogs(): Readonly<Record<string, unknown>> { return { Type: 'local', Config: { 'max-size': '1m', 'max-file': '1' } } }
function names(instanceId: string, buildRef: string) {
  const slug = createHash('sha256').update(`${instanceId}:${buildRef}`).digest('hex').slice(0, 20)
  return { volume: `dz23-build-work-${slug}`, stager: `dz23-build-stage-${slug}`, exporter: `dz23-build-export-${slug}`, step: (value: BuildStep) => `dz23-build-${value}-${slug}` }
}
function baseLabels(instanceId: string, buildRef: string, buildId: string): Readonly<Record<string, string>> {
  return { 'dz23.managed': 'builder', 'dz23.instance_id': instanceId, 'dz23.build_ref': buildRef, 'dz23.build_id': buildId }
}
function record(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function identifier(value: unknown): string | undefined {
  const row = record(value); const id = row.Id ?? row.Name
  return typeof id === 'string' && id !== '' ? id.replace(/^\//u, '') : undefined
}
function sanitized(value: Buffer): string { return value.toString('utf8').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '') }
