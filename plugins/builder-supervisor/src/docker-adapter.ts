import { createHash, randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { DockerEnginePort } from './docker-engine.js'
import { cleanupManagedExportResources, enforceExportRetention, listManagedExportArchives, openManagedExportArchive, publishValidatedDockerArchive, readValidatedPublishedArtifact } from './export-artifact.js'
import type { BuilderAttestation, BuildStep, ExportedArtifact, StepResult } from './model.js'
import { BuilderSupervisorError } from './model.js'
import { Semaphore } from './semaphore.js'

const OUTPUT_LIMIT = 512 * 1024
const EXPORT_ARCHIVE_LIMIT = 640 * 1024 * 1024
const COMMANDS: Readonly<Record<BuildStep, readonly string[]>> = {
  install: ['pnpm', 'install', '--offline', '--frozen-store', '--frozen-lockfile', '--trust-lockfile', '--ignore-scripts', '--store-dir', '/template-store'],
  build: ['pnpm', 'run', 'build'], test: ['pnpm', 'run', 'test'], e2e: ['pnpm', 'run', 'test:e2e'],
}

export interface BuilderLimits {
  readonly memoryBytes: number; readonly nanoCpus: number; readonly pids: number; readonly timeoutMs: number
  readonly workspaceBytes: number; readonly maxWorkspaceBytes: number; readonly concurrentContainers: number
  readonly maxExportBytes: number; readonly maxRetainedExports: number
}
export interface DockerBuilderAdapterOptions {
  readonly engine: DockerEnginePort; readonly imageDigest: `sha256:${string}`; readonly instanceId: string
  readonly exportRoot: string; readonly templateStoreVersion: string; readonly templateStoreSha256: string; readonly limits?: BuilderLimits
  /** @internal Deterministic filesystem fault seam; production uses node:fs/promises.rm. */
  readonly removeArchive?: (path: string) => Promise<void>
  /** @internal Deterministic export-garbage fault seam. */
  readonly cleanupExportResources?: typeof cleanupManagedExportResources
  /** @internal Deterministic descriptor-close fault seam. */
  readonly closeArchive?: (handle: FileHandle) => Promise<void>
}
export interface PreparedArtifact { readonly archivePath: string; readonly archiveBytes: number; readonly sha256: string; readonly files: number; readonly bytes: number }
export interface RecoveredBuild { readonly build_ref: string; readonly build_id: string }
export interface BuilderExecutionPort {
  preflight(signal: AbortSignal): Promise<BuilderAttestation>
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
  readonly #prepares = new Semaphore(1)
  readonly #exports = new Semaphore(1)
  readonly #templateStoreVolume: string
  readonly #policySha256: string
  constructor(private readonly options: DockerBuilderAdapterOptions) {
    if (!/^sha256:[a-f0-9]{64}$/u.test(options.imageDigest)) throw new Error('INVALID_BUILDER_IMAGE')
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(options.instanceId)) throw new Error('INVALID_INSTANCE_ID')
    if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/u.test(options.templateStoreVersion) || !/^[a-f0-9]{64}$/u.test(options.templateStoreSha256)) throw new Error('INVALID_TEMPLATE_STORE')
    if (!isAbsolute(options.exportRoot) || options.exportRoot.includes('\0')) throw new Error('INVALID_EXPORT_ROOT')
    this.#limits = options.limits ?? { memoryBytes: 2 * 1024 ** 3, nanoCpus: 2_000_000_000, pids: 256, timeoutMs: 180_000, workspaceBytes: 4 * 1024 ** 3, maxWorkspaceBytes: 8 * 1024 ** 3, concurrentContainers: 2, maxExportBytes: 2 * 1024 ** 3, maxRetainedExports: 5 }
    for (const value of Object.values(this.#limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error('INVALID_BUILDER_LIMIT')
    if (this.#limits.workspaceBytes > this.#limits.maxWorkspaceBytes || this.#limits.maxRetainedExports > 1_000) throw new Error('INVALID_BUILDER_LIMIT')
    this.#containers = new Semaphore(this.#limits.concurrentContainers)
    this.#templateStoreVolume = templateStoreVolumeName(options.instanceId, options.templateStoreVersion, options.templateStoreSha256)
    this.#policySha256 = createHash('sha256').update(JSON.stringify({ protocol: 1, image: options.imageDigest, instance: options.instanceId, templateStoreVersion: options.templateStoreVersion, templateStoreSha256: options.templateStoreSha256, templateStoreVerifierSha256: createHash('sha256').update(TEMPLATE_STORE_VERIFY_SCRIPT).digest('hex'), templateStoreMountSteps: ['install'], commands: COMMANDS, exportAllowlist: ['.next/standalone/**', '.next/static/**', 'public/**', 'evidence/appspec-report.json'], limits: this.#limits, user: '10001:10001', network: 'none', readOnlyRoot: true, capDrop: ['ALL'], noNewPrivileges: true })).digest('hex')
  }

  async preflight(signal: AbortSignal): Promise<BuilderAttestation> {
    let state: 'OK' | 'BLOCKED_EXTERNAL' = 'BLOCKED_EXTERNAL'; let imageId = this.options.imageDigest
    try {
      await this.options.engine.ping(signal); imageId = (await this.options.engine.inspectImage(this.options.imageDigest, signal)).Id as `sha256:${string}`
      const stores = await this.options.engine.listVolumes({ label: templateStoreLabels(this.options.instanceId, this.options.templateStoreVersion, this.options.templateStoreSha256) }, signal)
      const storeMetadataValid = stores.length === 1 && identifier(stores[0]) === this.#templateStoreVolume && hasLabels(stores[0], templateStoreLabels(this.options.instanceId, this.options.templateStoreVersion, this.options.templateStoreSha256))
      const storeContentValid = storeMetadataValid && await this.#verifyTemplateStore(signal)
      state = imageId === this.options.imageDigest && storeContentValid ? 'OK' : 'BLOCKED_EXTERNAL'
    } catch { state = 'BLOCKED_EXTERNAL' }
    return { state, protocol_version: 1, instance_id: this.options.instanceId, image_id: /^sha256:[a-f0-9]{64}$/u.test(imageId) ? imageId : this.options.imageDigest, policy_sha256: this.#policySha256 }
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
    await cleanupManagedExportResources(this.options.exportRoot, undefined, signal)
    const [afterContainers, afterVolumes] = await Promise.all([this.options.engine.listContainers(filter, signal), this.options.engine.listVolumes(filter, signal)])
    if (afterContainers.length !== 0 || afterVolumes.length !== 0) throw new BuilderSupervisorError('RECOVERY_FAILED')
    return [...recovered].map(([build_ref, build_id]) => ({ build_ref, build_id }))
  }

  async prepare(buildRef: string, buildId: string, artifact: PreparedArtifact, signal: AbortSignal): Promise<void> {
    const release = await this.#prepares.acquire(signal)
    if (this.#buildIds.has(buildRef)) { release(); throw new BuilderSupervisorError('BUILD_ALREADY_EXISTS') }
    if ((this.#buildIds.size + 1) * this.#limits.workspaceBytes > this.#limits.maxWorkspaceBytes) { release(); throw new BuilderSupervisorError('CAPACITY_EXCEEDED') }
    const resources = names(this.options.instanceId, buildRef); const labels = baseLabels(this.options.instanceId, buildRef, buildId); let anchor: string | undefined; let volumeCreated = false
    try {
      await this.options.engine.createVolume(resources.volume, { ...labels, 'dz23.resource': 'workspace' }, { type: 'tmpfs', device: 'tmpfs', o: `size=${this.#limits.workspaceBytes},uid=10001,gid=10001,mode=0700` }, signal)
      volumeCreated = true
      anchor = await this.options.engine.createContainer(resources.anchor, containerBody(this.options.imageDigest, ['sleep', 'infinity'], labels, 'anchor', this.#limits, [{ Type: 'volume', Source: resources.volume, Target: '/workspace', ReadOnly: false }]), signal)
      await this.options.engine.putArchive(anchor, '/workspace', artifact.archivePath, artifact.archiveBytes, signal); await this.options.engine.startContainer(anchor, signal)
      this.#buildIds.set(buildRef, buildId)
    } catch (error) {
      const rollbackErrors: unknown[] = []
      if (anchor !== undefined) await this.options.engine.removeContainer(anchor, AbortSignal.timeout(10_000)).catch(item => rollbackErrors.push(item))
      if (volumeCreated) await this.options.engine.removeVolume(resources.volume, AbortSignal.timeout(10_000)).catch(item => rollbackErrors.push(item))
      const filter = { label: [...managedFilter(this.options.instanceId).label, `dz23.build_ref=${buildRef}`] }
      const [containers, volumes] = await Promise.all([
        this.options.engine.listContainers(filter, AbortSignal.timeout(10_000)).catch(item => { rollbackErrors.push(item); return [{}] }),
        this.options.engine.listVolumes(filter, AbortSignal.timeout(10_000)).catch(item => { rollbackErrors.push(item); return [{}] }),
      ])
      if (rollbackErrors.length > 0 || containers.length > 0 || volumes.length > 0) throw new BuilderSupervisorError('CLEANUP_INCOMPLETE')
      throw error
    } finally { release() }
  }

  async execute(buildRef: string, step: BuildStep, signal: AbortSignal): Promise<StepResult> {
    const buildId = this.#buildIds.get(buildRef); if (buildId === undefined) throw new BuilderSupervisorError('BUILD_NOT_FOUND')
    const release = await this.#containers.acquire(signal); const resources = names(this.options.instanceId, buildRef); const labels = baseLabels(this.options.instanceId, buildRef, buildId)
    let container: string | undefined; let exitCode = -1; let timedOut = false; let outputLimited = false; let stdout: Buffer = Buffer.alloc(0); let stderr: Buffer = Buffer.alloc(0)
    const timeout = AbortSignal.timeout(this.#limits.timeoutMs); const executionSignal = AbortSignal.any([signal, timeout])
    try {
      container = await this.options.engine.createContainer(resources.step(step), containerBody(this.options.imageDigest, COMMANDS[step], labels, 'step', this.#limits, [
        { Type: 'volume', Source: resources.volume, Target: '/workspace', ReadOnly: false },
        ...(step === 'install' ? [{ Type: 'volume', Source: this.#templateStoreVolume, Target: '/template-store', ReadOnly: true }] : []),
      ], step), executionSignal)
      this.#active.set(buildRef, container); await this.options.engine.startContainer(container, executionSignal)
      const [completion, logs] = await Promise.all([this.options.engine.waitContainer(container, executionSignal), this.options.engine.containerLogs(container, OUTPUT_LIMIT, executionSignal)])
      exitCode = completion.StatusCode; stdout = logs.stdout; stderr = logs.stderr
    } catch (error) {
      timedOut = timeout.aborted && !signal.aborted; outputLimited = error instanceof Error && error.message === 'DOCKER_RESPONSE_TOO_LARGE'
      if (container !== undefined) await this.options.engine.stopContainer(container, AbortSignal.timeout(10_000)).catch(() => undefined)
      if (!timedOut && !signal.aborted && !outputLimited) throw error
    } finally {
      let cleanupError: unknown
      try { if (container !== undefined) await this.options.engine.removeContainer(container, AbortSignal.timeout(10_000)) }
      catch (error) { cleanupError = error }
      finally { this.#active.delete(buildRef); release() }
      if (cleanupError !== undefined) throw new BuilderSupervisorError('CLEANUP_INCOMPLETE')
    }
    outputLimited ||= stdout.byteLength + stderr.byteLength > OUTPUT_LIMIT
    const stdoutText = sanitized(stdout, OUTPUT_LIMIT); const stderrText = sanitized(stderr, Math.max(0, OUTPUT_LIMIT - Buffer.byteLength(stdoutText)))
    return { exit_code: outputLimited || timedOut || signal.aborted ? -1 : exitCode, stdout: stdoutText, stderr: stderrText, timed_out: timedOut, termination_reason: timedOut ? 'timeout' : outputLimited ? 'output_limit' : null, output_limit_exceeded: outputLimited }
  }

  async cancel(buildRef: string, signal: AbortSignal): Promise<void> { const active = this.#active.get(buildRef); if (active !== undefined) await this.options.engine.stopContainer(active, signal) }

  async exportArtifact(buildRef: string, signal: AbortSignal): Promise<ExportedArtifact> {
    const recovered = await readValidatedPublishedArtifact(this.options.exportRoot, buildRef)
    if (recovered !== undefined) {
      try { await cleanupManagedExportResources(this.options.exportRoot, buildRef, signal) }
      catch { throw new BuilderSupervisorError('CLEANUP_INCOMPLETE') }
      await enforceExportRetention(this.options.exportRoot, buildRef, this.#limits.maxRetainedExports, this.#limits.maxExportBytes, signal)
      return recovered
    }
    const buildId = this.#buildIds.get(buildRef); if (buildId === undefined) throw new BuilderSupervisorError('BUILD_NOT_FOUND')
    const resources = names(this.options.instanceId, buildRef)
    const release = await this.#exports.acquire(signal); let exporter: string | undefined; let exportVolumeCreated = false; let result: ExportedArtifact | undefined; let operationError: unknown; let archive: Awaited<ReturnType<typeof openManagedExportArchive>> | undefined; let archiveClosed = false
    try {
      const existing = await readValidatedPublishedArtifact(this.options.exportRoot, buildRef)
      if (existing !== undefined) {
        await cleanupManagedExportResources(this.options.exportRoot, buildRef, signal); await enforceExportRetention(this.options.exportRoot, buildRef, this.#limits.maxRetainedExports, this.#limits.maxExportBytes, signal); result = existing
      } else {
        await cleanupManagedExportResources(this.options.exportRoot, undefined, signal)
        archive = await openManagedExportArchive(this.options.exportRoot, buildRef)
        const labels = baseLabels(this.options.instanceId, buildRef, buildId)
        await this.options.engine.createVolume(resources.exportVolume, { ...labels, 'dz23.resource': 'export' }, { type: 'tmpfs', device: 'tmpfs', o: `size=${Math.min(EXPORT_ARCHIVE_LIMIT, this.#limits.maxExportBytes)},uid=10001,gid=10001,mode=0700` }, signal)
        exportVolumeCreated = true
        exporter = await this.options.engine.createContainer(resources.exporter, containerBody(this.options.imageDigest, ['node', '-e', EXPORT_SCRIPT], labels, 'export', this.#limits, [
          { Type: 'volume', Source: resources.volume, Target: '/workspace', ReadOnly: true },
          { Type: 'volume', Source: resources.exportVolume, Target: '/export', ReadOnly: false },
        ]), signal)
        await this.options.engine.startContainer(exporter, signal)
        const completion = await this.options.engine.waitContainer(exporter, signal)
        if (completion.StatusCode !== 0) throw new BuilderSupervisorError('EXPORT_INVALID')
        const downloaded = await this.options.engine.downloadArchive(exporter, '/export/.', archive.handle, Math.min(EXPORT_ARCHIVE_LIMIT, this.#limits.maxExportBytes), signal)
        const stat = await archive.handle.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== archive.dev || stat.ino !== archive.ino || stat.size !== downloaded.bytes) throw new BuilderSupervisorError('EXPORT_INVALID')
        await (this.options.closeArchive?.(archive.handle) ?? archive.handle.close()); archiveClosed = true
        const published = await publishValidatedDockerArchive(this.options.exportRoot, buildRef, archive.path, signal, undefined, { dev: stat.dev, ino: stat.ino, size: stat.size, sha256: downloaded.sha256 })
        await enforceExportRetention(this.options.exportRoot, buildRef, this.#limits.maxRetainedExports, this.#limits.maxExportBytes, signal)
        result = published
      }
    } catch (error) { operationError = error }
    const cleanupErrors: unknown[] = []
    try {
      if (exporter !== undefined) {
        await this.options.engine.stopContainer(exporter, AbortSignal.timeout(10_000)).catch(error => cleanupErrors.push(error))
        await this.options.engine.removeContainer(exporter, AbortSignal.timeout(10_000)).catch(error => cleanupErrors.push(error))
      }
      if (exportVolumeCreated) await this.options.engine.removeVolume(resources.exportVolume, AbortSignal.timeout(10_000)).catch(error => cleanupErrors.push(error))
      const containerFilter = { label: [...managedFilter(this.options.instanceId).label, `dz23.build_ref=${buildRef}`, 'dz23.role=export'] }
      const volumeFilter = { label: [...managedFilter(this.options.instanceId).label, `dz23.build_ref=${buildRef}`, 'dz23.resource=export'] }
      const [containers, volumes] = await Promise.all([
        this.options.engine.listContainers(containerFilter, AbortSignal.timeout(10_000)).catch(error => { cleanupErrors.push(error); return [{}] }),
        this.options.engine.listVolumes(volumeFilter, AbortSignal.timeout(10_000)).catch(error => { cleanupErrors.push(error); return [{}] }),
      ])
      if (archive !== undefined) { if (!archiveClosed) await (this.options.closeArchive?.(archive.handle) ?? archive.handle.close()).catch(error => cleanupErrors.push(error)); await (this.options.removeArchive?.(archive.path) ?? rm(archive.path, { force: true })).catch(error => cleanupErrors.push(error)) }
      await (this.options.cleanupExportResources ?? cleanupManagedExportResources)(this.options.exportRoot, buildRef, AbortSignal.timeout(10_000)).catch(error => cleanupErrors.push(error))
      if (cleanupErrors.length > 0 || containers.length > 0 || volumes.length > 0) throw new BuilderSupervisorError('CLEANUP_INCOMPLETE')
      if (result === undefined) throw operationError
      return result
    } finally { release() }
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
    await (this.options.cleanupExportResources ?? cleanupManagedExportResources)(this.options.exportRoot, buildRef, signal).catch(error => errors.push(error))
    const [remainingContainers, remainingVolumes] = await Promise.all([this.options.engine.listContainers(filter, signal).catch(error => { errors.push(error); return [{}] }), this.options.engine.listVolumes(filter, signal).catch(error => { errors.push(error); return [{}] })])
    if (errors.length > 0 || remainingContainers.length > 0 || remainingVolumes.length > 0) throw new BuilderSupervisorError('CLEANUP_INCOMPLETE')
    this.#active.delete(buildRef); this.#buildIds.delete(buildRef)
  }

  async listManaged(signal: AbortSignal): Promise<readonly string[]> {
    const filter = managedFilter(this.options.instanceId); const [containers, volumes, archives] = await Promise.all([this.options.engine.listContainers(filter, signal), this.options.engine.listVolumes(filter, signal), listManagedExportArchives(this.options.exportRoot)])
    const refs = new Set<string>()
    for (const row of [...containers, ...volumes]) { const value = record(row.Labels)['dz23.build_ref']; if (typeof value !== 'string' || !validBuildRef(value)) throw new BuilderSupervisorError('RECOVERY_FAILED'); refs.add(value) }
    for (const value of archives) refs.add(value)
    return [...refs].sort()
  }

  async #verifyTemplateStore(signal: AbortSignal): Promise<boolean> {
    const labels = templateVerifierLabels(this.options.instanceId, this.options.templateStoreVersion, this.options.templateStoreSha256)
    const stale = await this.options.engine.listContainers({ label: Object.entries(labels).map(([key, value]) => `${key}=${value}`) }, signal)
    for (const row of stale) { const id = identifier(row); if (id === undefined) throw new BuilderSupervisorError('RECOVERY_FAILED'); await this.options.engine.removeContainer(id, signal) }
    let container: string | undefined
    try {
      container = await this.options.engine.createContainer(`${this.#templateStoreVolume}-verify-${randomBytes(4).toString('hex')}`, containerBody(this.options.imageDigest, ['node', '-e', TEMPLATE_STORE_VERIFY_SCRIPT], labels, 'template-verify', this.#limits, [
        { Type: 'volume', Source: this.#templateStoreVolume, Target: '/template-store', ReadOnly: true },
      ]), signal)
      await this.options.engine.startContainer(container, signal)
      const [completion, logs] = await Promise.all([this.options.engine.waitContainer(container, signal), this.options.engine.containerLogs(container, 256, signal)])
      return completion.StatusCode === 0 && logs.stderr.byteLength === 0 && logs.stdout.toString('utf8').trim() === this.options.templateStoreSha256
    } finally {
      if (container !== undefined) await this.options.engine.removeContainer(container, AbortSignal.timeout(10_000))
    }
  }
}

function containerBody(image: string, command: readonly string[], labels: Readonly<Record<string, string>>, role: string, limits: BuilderLimits, mounts: readonly unknown[], step?: BuildStep): Readonly<Record<string, unknown>> {
  return { Image: image, Cmd: command, WorkingDir: '/workspace', User: '10001:10001', Env: ['CI=true', 'HOME=/tmp', 'XDG_CONFIG_HOME=/tmp/.config', 'NEXT_TELEMETRY_DISABLED=1'], Labels: { ...labels, 'dz23.role': role, ...(step === undefined ? {} : { 'dz23.step': step }) }, HostConfig: hardenedHost(limits, mounts), NetworkDisabled: true, LogConfig: boundedLogs() }
}
function hardenedHost(limits: BuilderLimits, mounts: readonly unknown[]): Readonly<Record<string, unknown>> { return { NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], PidsLimit: limits.pids, Memory: limits.memoryBytes, NanoCpus: limits.nanoCpus, OomKillDisable: false, PublishAllPorts: false, PortBindings: {}, IpcMode: 'private', Mounts: mounts, ShmSize: 268_435_456, Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=268435456,uid=10001,gid=10001' }, Ulimits: [{ Name: 'nofile', Soft: 1024, Hard: 1024 }] } }
function boundedLogs(): Readonly<Record<string, unknown>> { return { Type: 'local', Config: { 'max-size': '1m', 'max-file': '1' } } }
function names(instanceId: string, buildRef: string) { const slug = randomStable(instanceId, buildRef); return { volume: `dz23-build-work-${slug}`, exportVolume: `dz23-build-export-${slug}`, anchor: `dz23-build-anchor-${slug}`, exporter: `dz23-build-exporter-${slug}`, step: (value: BuildStep) => `dz23-build-${value}-${slug}` } }
function randomStable(instanceId: string, buildRef: string): string { return createHash('sha256').update(`${instanceId}:${buildRef}`).digest('hex').slice(0, 20) }
function baseLabels(instanceId: string, buildRef: string, buildId: string): Readonly<Record<string, string>> { return { 'dz23.managed': 'builder', 'dz23.instance_id': instanceId, 'dz23.build_ref': buildRef, 'dz23.build_id': buildId } }
function managedFilter(instanceId: string): { readonly label: readonly string[] } { return { label: ['dz23.managed=builder', `dz23.instance_id=${instanceId}`] } }
function record(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function identifier(value: unknown): string | undefined { const row = record(value); const id = row.Id ?? row.Name; return typeof id === 'string' && id !== '' ? id.replace(/^\//u, '') : undefined }
function validBuildRef(value: string): boolean { return /^build_[a-f0-9]{32}$/u.test(value) }
function validBuildId(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(value) }
function sanitized(value: Buffer, maximumBytes: number): string {
  const source = value.toString('utf8').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ''); let result = ''; let bytes = 0
  for (const character of source) { const size = Buffer.byteLength(character); if (bytes + size > maximumBytes) break; result += character; bytes += size }
  return result
}
function templateStoreLabels(instanceId: string, version: string, sha256: string): readonly string[] { return ['dz23.managed=builder-template-store', `dz23.instance_id=${instanceId}`, `dz23.template_version=${version}`, `dz23.template_sha256=${sha256}`] }
function templateStoreVolumeName(instanceId: string, version: string, sha256: string): string { return `dz23-template-${createHash('sha256').update(`${instanceId}:${version}:${sha256}`).digest('hex').slice(0, 24)}` }
function hasLabels(value: unknown, expected: readonly string[]): boolean { const labels = record(record(value).Labels); return expected.every(item => { const index = item.indexOf('='); return labels[item.slice(0, index)] === item.slice(index + 1) }) }
function templateVerifierLabels(instanceId: string, version: string, sha256: string): Readonly<Record<string, string>> { return { 'dz23.managed': 'builder-template-verifier', 'dz23.instance_id': instanceId, 'dz23.template_version': version, 'dz23.template_sha256': sha256 } }

const EXPORT_SCRIPT = String.raw`const fs=require('node:fs'),p=require('node:path');const rows=[['.next/standalone',true,true],['.next/static',true,true],['public',true,false],['evidence/appspec-report.json',false,true]];for(const [name,dir,required]of rows){const from=p.join('/workspace',name),to=p.join('/export',name);if(!fs.existsSync(from)){if(required)throw new Error('EXPORT_SOURCE_MISSING');continue}const stat=fs.lstatSync(from);if(stat.isSymbolicLink()||(dir?!stat.isDirectory():!stat.isFile()))throw new Error('EXPORT_SOURCE_INVALID');fs.mkdirSync(p.dirname(to),{recursive:true});fs.cpSync(from,to,{recursive:dir,dereference:false,errorOnExist:true,force:false})}`
const TEMPLATE_STORE_VERIFY_SCRIPT = String.raw`const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto');const root='/template-store',names=[];function walk(dir,prefix=''){for(const item of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const name=prefix?prefix+'/'+item.name:item.name,full=p.join(dir,item.name),stat=fs.lstatSync(full);if(item.isSymbolicLink()||stat.isSymbolicLink())throw new Error('UNSAFE_STORE');if(item.isDirectory()&&stat.isDirectory())walk(full,name);else if(item.isFile()&&stat.isFile()&&stat.nlink===1)names.push(name);else throw new Error('UNSAFE_STORE')}}walk(root);const hash=c.createHash('sha256');for(const name of names){hash.update(name).update('\0').update(fs.readFileSync(p.join(root,...name.split('/')))).update('\0')}process.stdout.write(hash.digest('hex'))`
