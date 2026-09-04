import { createHash, randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { DockerEnginePort } from './docker-engine.js'
import { publishValidatedDockerArchive } from './export-artifact.js'
import type { BuildStep, ExportedArtifact, StepResult } from './model.js'
import { BuilderSupervisorError } from './model.js'
import { Semaphore } from './semaphore.js'

const OUTPUT_LIMIT = 512 * 1024
const EXPORT_ARCHIVE_LIMIT = 640 * 1024 * 1024
const COMMANDS: Readonly<Record<BuildStep, readonly string[]>> = {
  install: ['pnpm', 'install', '--offline', '--frozen-lockfile', '--ignore-scripts', '--store-dir', '/template-store'],
  build: ['pnpm', 'run', 'build'], unit: ['pnpm', 'run', 'test'], e2e: ['pnpm', 'run', 'test:e2e'],
}

export interface BuilderLimits {
  readonly memoryBytes: number; readonly nanoCpus: number; readonly pids: number; readonly timeoutMs: number
  readonly workspaceBytes: number; readonly concurrentContainers: number
}
export interface DockerBuilderAdapterOptions {
  readonly engine: DockerEnginePort; readonly imageDigest: `sha256:${string}`; readonly instanceId: string
  readonly exportRoot: string; readonly limits?: BuilderLimits
}
export interface PreparedArtifact { readonly archive: Buffer; readonly sourceDirectory: string; readonly sha256: string; readonly files: number; readonly bytes: number }
export interface RecoveredBuild { readonly build_ref: string; readonly build_id: string }
export interface BuilderExecutionPort {
  preflight(signal: AbortSignal): Promise<'OK' | 'BLOCKED_EXTERNAL'>
  reconcile(signal: AbortSignal): Promise<readonly RecoveredBuild[]>
  prepare(buildRef: string, buildId: string, artifact: PreparedArtifact, signal: AbortSignal): Promise<void>
  execute(buildRef: string, step: BuildStep, signal: AbortSignal): Promise<StepResult>
  cancel(buildRef: string, signal: AbortSignal): Promise<void>
  exportArtifact(buildRef: string, signal: AbortSignal): Promise<ExportedArtifact>
  cleanup(buildRef: string, signal: AbortSignal): Promise<void>
  listManaged(signal: AbortSignal): Promise<readonly string[]>
}

export class DockerBuilderAdapter implements BuilderExecutionPort {
  readonly #limits: BuilderLimits
  readonly #active = new Map<string, string>()
  readonly #buildIds = new Map<string, string>()
  readonly #containers: Semaphore
  constructor(private readonly options: DockerBuilderAdapterOptions) {
    if (!/^sha256:[a-f0-9]{64}$/u.test(options.imageDigest)) throw new Error('INVALID_BUILDER_IMAGE')
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(options.instanceId)) throw new Error('INVALID_INSTANCE_ID')
    if (!isAbsolute(options.exportRoot) || options.exportRoot.includes('\0')) throw new Error('INVALID_EXPORT_ROOT')
    this.#limits = options.limits ?? { memoryBytes: 2 * 1024 ** 3, nanoCpus: 2_000_000_000, pids: 256, timeoutMs: 180_000, workspaceBytes: 4 * 1024 ** 3, concurrentContainers: 2 }
    for (const value of Object.values(this.#limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error('INVALID_BUILDER_LIMIT')
    this.#containers = new Semaphore(this.#limits.concurrentContainers)
  }

  async preflight(signal: AbortSignal): Promise<'OK' | 'BLOCKED_EXTERNAL'> {
    try { await this.options.engine.ping(signal); return (await this.options.engine.inspectImage(this.options.imageDigest, signal)).Id === this.options.imageDigest ? 'OK' : 'BLOCKED_EXTERNAL' }
    catch { return 'BLOCKED_EXTERNAL' }
  }

  async reconcile(signal: AbortSignal): Promise<readonly RecoveredBuild[]> {
    const filter = managedFilter(this.options.instanceId); const [containers, volumes] = await Promise.all([this.options.engine.listContainers(filter, signal), this.options.engine.listVolumes(filter, signal)])
    const recovered = new Map<string, string>(); const ids = new Map<string, string>()
    for (const row of [...containers, ...volumes]) {
      const labels = record(row.Labels); const buildRef = labels['dz23.build_ref']; const buildId = labels['dz23.build_id']
      if (typeof buildRef !== 'string' || !validBuildRef(buildRef) || typeof buildId !== 'string' || !validBuildId(buildId)) throw new BuilderSupervisorError('RECOVERY_FAILED')
      const previous = recovered.get(buildRef); if (previous !== undefined && previous !== buildId) throw new BuilderSupervisorError('RECOVERY_FAILED')
      const idOwner = ids.get(buildId); if (idOwner !== undefined && idOwner !== buildRef) throw new BuilderSupervisorError('RECOVERY_FAILED')
      recovered.set(buildRef, buildId)
      ids.set(buildId, buildRef)
    }
    for (const [buildRef, buildId] of recovered) { this.#buildIds.set(buildRef, buildId); await this.cleanup(buildRef, signal) }
    const [afterContainers, afterVolumes] = await Promise.all([this.options.engine.listContainers(filter, signal), this.options.engine.listVolumes(filter, signal)])
    if (afterContainers.length !== 0 || afterVolumes.length !== 0) throw new BuilderSupervisorError('RECOVERY_FAILED')
    return [...recovered].map(([build_ref, build_id]) => ({ build_ref, build_id }))
  }

  async prepare(buildRef: string, buildId: string, artifact: PreparedArtifact, signal: AbortSignal): Promise<void> {
    if (this.#buildIds.has(buildRef)) throw new BuilderSupervisorError('BUILD_ALREADY_EXISTS')
    const resources = names(this.options.instanceId, buildRef); const labels = baseLabels(this.options.instanceId, buildRef, buildId); let anchor: string | undefined
    try {
      await this.options.engine.createVolume(resources.volume, { ...labels, 'dz23.resource': 'workspace' }, { type: 'tmpfs', device: 'tmpfs', o: `size=${this.#limits.workspaceBytes},uid=10001,gid=10001,mode=0700` }, signal)
      anchor = await this.options.engine.createContainer(resources.anchor, containerBody(this.options.imageDigest, ['sleep', 'infinity'], labels, 'anchor', this.#limits, [{ Type: 'volume', Source: resources.volume, Target: '/workspace', ReadOnly: false }]), signal)
      await this.options.engine.putArchive(anchor, '/workspace', artifact.archive, signal); await this.options.engine.startContainer(anchor, signal)
      this.#buildIds.set(buildRef, buildId)
    } catch (error) {
      if (anchor !== undefined) await this.options.engine.removeContainer(anchor, AbortSignal.timeout(10_000)).catch(() => undefined)
      await this.options.engine.removeVolume(resources.volume, AbortSignal.timeout(10_000)).catch(() => undefined); throw error
    }
  }

  async execute(buildRef: string, step: BuildStep, signal: AbortSignal): Promise<StepResult> {
    const buildId = this.#buildIds.get(buildRef); if (buildId === undefined) throw new BuilderSupervisorError('BUILD_NOT_FOUND')
    const release = await this.#containers.acquire(signal); const resources = names(this.options.instanceId, buildRef); const labels = baseLabels(this.options.instanceId, buildRef, buildId)
    let container: string | undefined; let exitCode = -1; let timedOut = false; let outputLimited = false; let stdout: Buffer = Buffer.alloc(0); let stderr: Buffer = Buffer.alloc(0)
    const timeout = AbortSignal.timeout(this.#limits.timeoutMs); const executionSignal = AbortSignal.any([signal, timeout])
    try {
      container = await this.options.engine.createContainer(resources.step(step), containerBody(this.options.imageDigest, COMMANDS[step], labels, 'step', this.#limits, [
        { Type: 'volume', Source: resources.volume, Target: '/workspace', ReadOnly: false },
        { Type: 'volume', Source: 'dz23-builder-template-store', Target: '/template-store', ReadOnly: true },
      ], step), executionSignal)
      this.#active.set(buildRef, container); await this.options.engine.startContainer(container, executionSignal)
      const [completion, logs] = await Promise.all([this.options.engine.waitContainer(container, executionSignal), this.options.engine.containerLogs(container, executionSignal)])
      exitCode = completion.StatusCode; stdout = logs.stdout; stderr = logs.stderr
    } catch (error) {
      timedOut = timeout.aborted && !signal.aborted; outputLimited = error instanceof Error && error.message === 'DOCKER_RESPONSE_TOO_LARGE'
      if (container !== undefined) await this.options.engine.stopContainer(container, AbortSignal.timeout(10_000)).catch(() => undefined)
      if (!timedOut && !signal.aborted && !outputLimited) throw error
    } finally {
      if (container !== undefined) await this.options.engine.removeContainer(container, AbortSignal.timeout(10_000))
      this.#active.delete(buildRef); release()
    }
    outputLimited ||= stdout.byteLength + stderr.byteLength > OUTPUT_LIMIT
    return { exit_code: outputLimited || timedOut || signal.aborted ? -1 : exitCode, stdout: sanitized(stdout.subarray(0, OUTPUT_LIMIT)), stderr: sanitized(stderr.subarray(0, Math.max(0, OUTPUT_LIMIT - stdout.byteLength))), timed_out: timedOut, output_limited: outputLimited }
  }

  async cancel(buildRef: string, signal: AbortSignal): Promise<void> { const active = this.#active.get(buildRef); if (active !== undefined) await this.options.engine.stopContainer(active, signal) }

  async exportArtifact(buildRef: string, signal: AbortSignal): Promise<ExportedArtifact> {
    if (!this.#buildIds.has(buildRef)) throw new BuilderSupervisorError('BUILD_NOT_FOUND')
    const resources = names(this.options.instanceId, buildRef); const archive = resolve(this.options.exportRoot, `.archive-${buildRef}-${randomBytes(8).toString('hex')}.tar`)
    try {
      await this.options.engine.downloadArchive(resources.anchor, '/workspace/.', archive, EXPORT_ARCHIVE_LIMIT, signal)
      return await publishValidatedDockerArchive(this.options.exportRoot, buildRef, archive, signal)
    } finally { await rm(archive, { force: true }).catch(() => undefined) }
  }

  async cleanup(buildRef: string, signal: AbortSignal): Promise<void> {
    const filter = { label: [...managedFilter(this.options.instanceId).label, `dz23.build_ref=${buildRef}`] }; const errors: unknown[] = []
    const [containers, volumes] = await Promise.all([this.options.engine.listContainers(filter, signal).catch(error => { errors.push(error); return [] }), this.options.engine.listVolumes(filter, signal).catch(error => { errors.push(error); return [] })])
    for (const row of containers) {
      const id = identifier(row); if (id === undefined) { errors.push(new Error('INVALID_MANAGED_CONTAINER')); continue }
      try { await this.options.engine.stopContainer(id, signal) } catch (error) { errors.push(error) }
      try { await this.options.engine.removeContainer(id, signal) } catch (error) { errors.push(error) }
    }
    for (const row of volumes) { const name = identifier(row); if (name === undefined) { errors.push(new Error('INVALID_MANAGED_VOLUME')); continue } try { await this.options.engine.removeVolume(name, signal) } catch (error) { errors.push(error) } }
    const [remainingContainers, remainingVolumes] = await Promise.all([this.options.engine.listContainers(filter, signal).catch(error => { errors.push(error); return [{}] }), this.options.engine.listVolumes(filter, signal).catch(error => { errors.push(error); return [{}] })])
    if (errors.length > 0 || remainingContainers.length > 0 || remainingVolumes.length > 0) throw new BuilderSupervisorError('CLEANUP_INCOMPLETE')
    this.#active.delete(buildRef); this.#buildIds.delete(buildRef)
  }

  async listManaged(signal: AbortSignal): Promise<readonly string[]> {
    const filter = managedFilter(this.options.instanceId); const [containers, volumes] = await Promise.all([this.options.engine.listContainers(filter, signal), this.options.engine.listVolumes(filter, signal)])
    const refs = new Set<string>()
    for (const row of [...containers, ...volumes]) { const value = record(row.Labels)['dz23.build_ref']; if (typeof value !== 'string' || !validBuildRef(value)) throw new BuilderSupervisorError('RECOVERY_FAILED'); refs.add(value) }
    return [...refs].sort()
  }
}

function containerBody(image: string, command: readonly string[], labels: Readonly<Record<string, string>>, role: string, limits: BuilderLimits, mounts: readonly unknown[], step?: BuildStep): Readonly<Record<string, unknown>> {
  return { Image: image, Cmd: command, WorkingDir: '/workspace', User: '10001:10001', Env: ['CI=true', 'HOME=/tmp', 'XDG_CONFIG_HOME=/tmp/.config', 'NEXT_TELEMETRY_DISABLED=1'], Labels: { ...labels, 'dz23.role': role, ...(step === undefined ? {} : { 'dz23.step': step }) }, HostConfig: hardenedHost(limits, mounts), NetworkDisabled: true, LogConfig: boundedLogs() }
}
function hardenedHost(limits: BuilderLimits, mounts: readonly unknown[]): Readonly<Record<string, unknown>> { return { NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], PidsLimit: limits.pids, Memory: limits.memoryBytes, NanoCpus: limits.nanoCpus, OomKillDisable: false, PublishAllPorts: false, PortBindings: {}, IpcMode: 'private', Mounts: mounts, ShmSize: 268_435_456, Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=268435456,uid=10001,gid=10001' }, Ulimits: [{ Name: 'nofile', Soft: 1024, Hard: 1024 }] } }
function boundedLogs(): Readonly<Record<string, unknown>> { return { Type: 'local', Config: { 'max-size': '1m', 'max-file': '1' } } }
function names(instanceId: string, buildRef: string) { const slug = randomStable(instanceId, buildRef); return { volume: `dz23-build-work-${slug}`, anchor: `dz23-build-anchor-${slug}`, step: (value: BuildStep) => `dz23-build-${value}-${slug}` } }
function randomStable(instanceId: string, buildRef: string): string { return createHash('sha256').update(`${instanceId}:${buildRef}`).digest('hex').slice(0, 20) }
function baseLabels(instanceId: string, buildRef: string, buildId: string): Readonly<Record<string, string>> { return { 'dz23.managed': 'builder', 'dz23.instance_id': instanceId, 'dz23.build_ref': buildRef, 'dz23.build_id': buildId } }
function managedFilter(instanceId: string): { readonly label: readonly string[] } { return { label: ['dz23.managed=builder', `dz23.instance_id=${instanceId}`] } }
function record(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function identifier(value: unknown): string | undefined { const row = record(value); const id = row.Id ?? row.Name; return typeof id === 'string' && id !== '' ? id.replace(/^\//u, '') : undefined }
function validBuildRef(value: string): boolean { return /^build_[a-f0-9]{32}$/u.test(value) }
function validBuildId(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(value) }
function sanitized(value: Buffer): string { return value.toString('utf8').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '') }
