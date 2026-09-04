import { createHash, randomBytes } from 'node:crypto'
import { readdir, unlink } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { resolve } from 'node:path'
import { createPreviewDataSeedArchive, createVerifiedRuntimeArchive } from './artifact-stage.js'
import { DockerEngine } from './docker-engine.js'
import type { ManagedPreviewRow, PreviewSupervisorPort, SupervisorForwardResponse } from './manager.js'
import type { SupervisorForwardRequest, SupervisorStartRequest } from './protocol.js'

interface RuntimeLimits { readonly memoryBytes: number; readonly nanoCpus: number; readonly pids: number }
export interface DockerPreviewSupervisorOptions {
  readonly engine: DockerEngine
  readonly artifactRoot: string
  readonly proxySocketRoot: string
  readonly proxySocketMount: { readonly type: 'volume' | 'bind'; readonly source: string }
  readonly runtimeImageDigest: `sha256:${string}`
  readonly proxyImageDigest: `sha256:${string}`
  readonly instanceId: string
  readonly proxyUser?: `${number}:${number}`
  readonly diagnosticSink?: (entry: { readonly role: 'runtime' | 'proxy'; readonly output: string }) => void
  readonly limits?: Partial<RuntimeLimits>
}

interface DockerContainerRow { readonly Id?: unknown; readonly Labels?: unknown; readonly State?: unknown }
interface RuntimeResources {
  readonly previewId: string
  readonly runtimeRef: string
  readonly slug: string
  readonly runtimeContainer: string
  readonly proxyContainer: string
  readonly stagerContainer: string
  readonly artifactVolume: string
  readonly dataVolume: string
}

export class DockerPreviewSupervisor implements PreviewSupervisorPort {
  readonly #limits: RuntimeLimits
  readonly #events = new Map<string, Array<{ at: string; level: 'info' | 'warn' | 'error'; event: string }>>()
  readonly #tails = new Map<string, Promise<void>>()

  constructor(private readonly options: DockerPreviewSupervisorOptions) {
    if (!/^sha256:[a-f0-9]{64}$/u.test(options.runtimeImageDigest) || !/^sha256:[a-f0-9]{64}$/u.test(options.proxyImageDigest)) throw new Error('INVALID_IMAGE_DIGEST')
    if (!/^[a-z0-9-]{3,64}$/u.test(options.instanceId)) throw new Error('INVALID_INSTANCE_ID')
    if (!options.artifactRoot.startsWith('/') || !options.proxySocketRoot.startsWith('/')) throw new Error('INVALID_SUPERVISOR_ROOT')
    if (options.proxySocketMount.type === 'volume' && !/^[a-zA-Z0-9_.-]{3,100}$/u.test(options.proxySocketMount.source)) throw new Error('INVALID_PROXY_VOLUME')
    if (options.proxySocketMount.type === 'bind' && !options.proxySocketMount.source.startsWith('/')) throw new Error('INVALID_PROXY_BIND')
    if (options.proxyUser !== undefined && !/^\d{1,10}:\d{1,10}$/u.test(options.proxyUser)) throw new Error('INVALID_PROXY_USER')
    this.#limits = {
      memoryBytes: boundedInteger(options.limits?.memoryBytes ?? 512 * 1024 * 1024, 128 * 1024 * 1024, 4 * 1024 * 1024 * 1024),
      nanoCpus: boundedInteger(options.limits?.nanoCpus ?? 1_000_000_000, 100_000_000, 4_000_000_000),
      pids: boundedInteger(options.limits?.pids ?? 256, 32, 1_024),
    }
  }

  async preflight(signal: AbortSignal): Promise<void> {
    await this.options.engine.ping(signal)
    const [runtime, proxy] = await Promise.all([
      this.options.engine.inspectImage(this.options.runtimeImageDigest, signal),
      this.options.engine.inspectImage(this.options.proxyImageDigest, signal),
    ])
    if (runtime.Id !== this.options.runtimeImageDigest || proxy.Id !== this.options.proxyImageDigest) throw new Error('PINNED_IMAGE_NOT_PRESENT')
  }

  /** Removes every resource owned by this supervisor instance after a crash or during shutdown. */
  async drain(signal: AbortSignal): Promise<{ readonly containers: number; readonly networks: number; readonly volumes: number; readonly sockets: number }> {
    const filter = { label: [`dz23.managed=preview`, `dz23.instance_id=${this.options.instanceId}`] }
    const errors: unknown[] = []
    const [containers, networks, volumes] = await Promise.all([
      this.options.engine.listContainers(filter, signal),
      this.options.engine.listNetworks(filter, signal),
      this.options.engine.listVolumes(filter, signal),
    ])
    const containerIds = containers.map(dockerIdentifier).filter((value): value is string => value !== undefined)
    if (containerIds.length !== containers.length) errors.push(new Error('INVALID_MANAGED_CONTAINER'))
    for (const id of containerIds) {
      try { await this.options.engine.stopContainer(id, signal) } catch (error) { errors.push(error) }
      try { await this.options.engine.removeContainer(id, signal) } catch (error) { errors.push(error) }
    }
    const networkIds = networks.map(dockerIdentifier).filter((value): value is string => value !== undefined)
    if (networkIds.length !== networks.length) errors.push(new Error('INVALID_MANAGED_NETWORK'))
    for (const id of networkIds) {
      try { await this.options.engine.removeNetwork(id, signal) } catch (error) { errors.push(error) }
    }
    const volumeNames = volumes.map(row => stringProperty(row, 'Name')).filter((value): value is string => value !== undefined)
    if (volumeNames.length !== volumes.length) errors.push(new Error('INVALID_MANAGED_VOLUME'))
    for (const name of volumeNames) {
      try { await this.options.engine.removeVolume(name, signal) } catch (error) { errors.push(error) }
    }
    const sockets = await this.#removeOwnedSockets(errors)
    const [containerSurvivors, networkSurvivors, volumeSurvivors] = await Promise.all([
      this.options.engine.listContainers(filter, signal).catch(error => { errors.push(error); return [{}] }),
      this.options.engine.listNetworks(filter, signal).catch(error => { errors.push(error); return [{}] }),
      this.options.engine.listVolumes(filter, signal).catch(error => { errors.push(error); return [{}] }),
    ])
    if (containerSurvivors.length > 0 || networkSurvivors.length > 0 || volumeSurvivors.length > 0 || errors.length > 0) throw new Error('SUPERVISOR_DRAIN_INCOMPLETE')
    return { containers: containerIds.length, networks: networkIds.length, volumes: volumeNames.length, sockets }
  }

  async start(input: SupervisorStartRequest, signal: AbortSignal): Promise<{ readonly runtime_ref: string }> {
    return this.#serialized(`preview:${input.preview_id}`, () => this.#start(input, signal))
  }

  async #start(input: SupervisorStartRequest, signal: AbortSignal): Promise<{ readonly runtime_ref: string }> {
    await this.preflight(signal)
    const existing = (await this.listManaged(signal)).find(row => row.preview_id === input.preview_id)
    if (existing !== undefined) return { runtime_ref: existing.runtime_ref }
    const archive = await createVerifiedRuntimeArchive(this.options.artifactRoot, input.artifact_relative_path, input.artifact_sha256, signal)
    const runtimeRef = `pv_${randomBytes(16).toString('hex')}`
    const resources = resourceNames(this.options.instanceId, input.preview_id, runtimeRef)
    const labels = baseLabels(this.options.instanceId, resources)
    try {
      await this.options.engine.createVolume(resources.artifactVolume, { ...labels, 'dz23.resource': 'artifact' }, signal)
      await this.options.engine.createVolume(resources.dataVolume, { ...labels, 'dz23.resource': 'data' }, signal)
      const stager = await this.options.engine.createContainer(resources.stagerContainer, {
        Image: this.options.proxyImageDigest, Cmd: ['node', '-e', 'process.exit(0)'], User: '10001:10001',
        Labels: { ...labels, 'dz23.role': 'stager' },
        HostConfig: hardenedHost('none', this.#limits, [
          { Type: 'volume', Source: resources.artifactVolume, Target: '/app', ReadOnly: false },
          { Type: 'volume', Source: resources.dataVolume, Target: '/preview-storage', ReadOnly: false },
        ]),
      }, signal)
      try {
        await this.options.engine.putArchive(stager, '/app', archive.archive, signal)
        await this.options.engine.putArchive(stager, '/preview-storage', createPreviewDataSeedArchive(), signal)
      }
      finally { await this.options.engine.removeContainer(stager, AbortSignal.timeout(10_000)) }

      await this.options.engine.createContainer(resources.runtimeContainer, runtimeContainerBody(this.options.runtimeImageDigest, resources, labels, input.owner_email, this.#limits), signal)
      await this.options.engine.createContainer(resources.proxyContainer, proxyContainerBody(this.options.proxyImageDigest, resources, labels, this.options.proxySocketMount, this.#limits, this.options.proxyUser ?? '10001:10001'), signal)
      await this.options.engine.startContainer(resources.runtimeContainer, signal)
      await this.options.engine.startContainer(resources.proxyContainer, signal)
      await this.#waitReady(resources, signal)
      this.#event(runtimeRef, 'info', 'ARTIFACT_VERIFIED')
      this.#event(runtimeRef, 'info', 'PREVIEW_STARTED')
      this.#event(runtimeRef, 'info', 'HEALTH_OK')
      return { runtime_ref: runtimeRef }
    } catch (error) {
      await this.#emitDiagnostics(resources)
      await this.#cleanup(resources, AbortSignal.timeout(20_000))
      throw error
    }
  }

  async stop(runtimeRef: string, signal: AbortSignal): Promise<void> {
    return this.#serialized(`runtime:${runtimeRef}`, () => this.#stop(runtimeRef, signal))
  }

  async #stop(runtimeRef: string, signal: AbortSignal): Promise<void> {
    const resources = await this.#resourcesFor(runtimeRef, signal)
    if (resources === undefined) return
    await this.#cleanup(resources, signal)
    this.#event(runtimeRef, 'info', 'PREVIEW_STOPPED')
  }

  async health(runtimeRef: string, signal: AbortSignal): Promise<'OK' | 'DOWN'> {
    const resources = await this.#resourcesFor(runtimeRef, signal)
    if (resources === undefined) return 'DOWN'
    try {
      const response = await this.#dataRequest(resources, { operation: 'forward', body: {
        runtime_ref: runtimeRef, method: 'GET', path: '/', headers: { accept: 'text/html' }, body_base64: '',
      } }, signal, 512 * 1024)
      const row = JSON.parse(response.toString('utf8')) as { status?: unknown }
      const state = typeof row.status === 'number' && row.status >= 200 && row.status < 500 ? 'OK' : 'DOWN'
      this.#event(runtimeRef, state === 'OK' ? 'info' : 'warn', state === 'OK' ? 'HEALTH_OK' : 'HEALTH_DOWN')
      return state
    } catch { this.#event(runtimeRef, 'warn', 'HEALTH_DOWN'); return 'DOWN' }
  }

  async logs(runtimeRef: string, limit: number): Promise<readonly unknown[]> { return (this.#events.get(runtimeRef) ?? []).slice(-limit) }

  async verificationMessages(runtimeRef: string, signal: AbortSignal): Promise<readonly unknown[]> {
    const resources = await this.#resourcesFor(runtimeRef, signal)
    if (resources === undefined) return []
    const response = await this.#dataRequest(resources, { operation: 'verification-messages', body: { runtime_ref: runtimeRef } }, signal, 64 * 1024)
    const parsed = JSON.parse(response.toString('utf8')) as { messages?: unknown }
    return Array.isArray(parsed.messages) ? parsed.messages.slice(-20) : []
  }

  async listManaged(signal: AbortSignal): Promise<readonly ManagedPreviewRow[]> {
    const rows = await this.options.engine.listContainers({ label: [`dz23.managed=preview`, `dz23.instance_id=${this.options.instanceId}`, 'dz23.role=runtime'] }, signal)
    return rows.flatMap(row => {
      const labels = asLabels((row as DockerContainerRow).Labels)
      const runtimeRef = labels['dz23.runtime_ref']; const previewId = labels['dz23.preview_id']
      return runtimeRef !== undefined && previewId !== undefined ? [{ runtime_ref: runtimeRef, preview_id: previewId }] : []
    })
  }

  async forward(input: SupervisorForwardRequest, signal: AbortSignal): Promise<SupervisorForwardResponse> {
    const resources = await this.#resourcesFor(input.runtime_ref, signal)
    if (resources === undefined) throw new Error('RUNTIME_NOT_FOUND')
    return JSON.parse((await this.#dataRequest(resources, { operation: 'forward', body: input }, signal, 12 * 1024 * 1024)).toString('utf8')) as SupervisorForwardResponse
  }

  async #waitReady(resources: RuntimeResources, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (signal.aborted) throw signal.reason
      if (await this.health(resources.runtimeRef, signal) === 'OK') return
      await new Promise<void>((resolveWait, reject) => {
        const timer = setTimeout(resolveWait, 250)
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
      })
    }
    const [runtime, proxy] = await Promise.all([
      this.#containerState(resources.runtimeContainer, signal),
      this.#containerState(resources.proxyContainer, signal),
    ])
    throw new Error(`RUNTIME_READINESS_TIMEOUT:runtime=${runtime};proxy=${proxy}`)
  }

  async #containerState(container: string, signal: AbortSignal): Promise<string> {
    try {
      const inspected = await this.options.engine.inspectContainer<Record<string, unknown>>(container, signal)
      const state = typeof inspected.State === 'object' && inspected.State !== null ? inspected.State as Record<string, unknown> : {}
      const status = typeof state.Status === 'string' ? state.Status : 'unknown'
      const exitCode = Number.isInteger(state.ExitCode) ? String(state.ExitCode) : 'unknown'
      return `${status}/${exitCode}`
    } catch { return 'unavailable' }
  }

  async #emitDiagnostics(resources: RuntimeResources): Promise<void> {
    if (this.options.diagnosticSink === undefined) return
    for (const [role, container] of [['runtime', resources.runtimeContainer], ['proxy', resources.proxyContainer]] as const) {
      try {
        const raw = await this.options.engine.containerLogs(container, AbortSignal.timeout(3_000))
        const output = raw.slice(-8_000).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[email]').replace(/\b\d{6}\b/gu, '[code]')
        this.options.diagnosticSink({ role, output })
      } catch { /* diagnosis cannot weaken cleanup */ }
    }
  }

  async #resourcesFor(runtimeRef: string, signal: AbortSignal): Promise<RuntimeResources | undefined> {
    const rows = await this.options.engine.listContainers({ label: [`dz23.managed=preview`, `dz23.instance_id=${this.options.instanceId}`, `dz23.runtime_ref=${runtimeRef}`, 'dz23.role=runtime'] }, signal)
    const labels = asLabels((rows[0] as DockerContainerRow | undefined)?.Labels)
    const previewId = labels['dz23.preview_id']
    return previewId === undefined ? undefined : resourceNames(this.options.instanceId, previewId, runtimeRef)
  }

  async #cleanup(resources: RuntimeResources, signal: AbortSignal): Promise<void> {
    const errors: unknown[] = []
    for (const work of [
      () => this.options.engine.stopContainer(resources.proxyContainer, signal),
      () => this.options.engine.stopContainer(resources.runtimeContainer, signal),
      () => this.options.engine.stopContainer(resources.stagerContainer, signal),
      () => this.options.engine.removeContainer(resources.proxyContainer, signal),
      () => this.options.engine.removeContainer(resources.runtimeContainer, signal),
      () => this.options.engine.removeContainer(resources.stagerContainer, signal),
      () => this.options.engine.removeVolume(resources.artifactVolume, signal),
      () => this.options.engine.removeVolume(resources.dataVolume, signal),
      () => this.#removeSocket(resources.runtimeRef),
    ]) {
      try { await work() } catch (error) { errors.push(error) }
    }
    const filter = { label: [`dz23.managed=preview`, `dz23.instance_id=${this.options.instanceId}`, `dz23.runtime_ref=${resources.runtimeRef}`] }
    const [containers, networks, volumes] = await Promise.all([
      this.options.engine.listContainers(filter, signal).catch(error => { errors.push(error); return [{}] }),
      this.options.engine.listNetworks(filter, signal).catch(error => { errors.push(error); return [{}] }),
      this.options.engine.listVolumes(filter, signal).catch(error => { errors.push(error); return [{}] }),
    ])
    if (containers.length > 0 || networks.length > 0 || volumes.length > 0 || errors.length > 0) throw new Error('RUNTIME_CLEANUP_INCOMPLETE')
  }

  async #removeSocket(runtimeRef: string): Promise<void> {
    try { await unlink(resolve(this.options.proxySocketRoot, `${runtimeRef}.sock`)) }
    catch (error) { if (!isNotFound(error)) throw error }
  }

  async #removeOwnedSockets(errors: unknown[]): Promise<number> {
    let entries: string[]
    try { entries = await readdir(this.options.proxySocketRoot) }
    catch (error) { if (isNotFound(error)) return 0; errors.push(error); return 0 }
    const owned = entries.filter(entry => /^pv_[a-f0-9]{32}\.sock$/u.test(entry))
    let removed = 0
    for (const entry of owned) {
      try { await unlink(resolve(this.options.proxySocketRoot, entry)); removed++ }
      catch (error) { if (!isNotFound(error)) errors.push(error) }
    }
    return removed
  }

  async #dataRequest(resources: RuntimeResources, value: unknown, signal: AbortSignal, maximum: number): Promise<Buffer> {
    const payload = Buffer.from(JSON.stringify(value), 'utf8')
    const socketPath = resolve(this.options.proxySocketRoot, `${resources.runtimeRef}.sock`)
    return new Promise((resolveResult, reject) => {
      const request = httpRequest({ socketPath, path: '/v1/data', method: 'POST', signal, headers: { 'content-type': 'application/json', 'content-length': String(payload.byteLength) } }, response => {
        const chunks: Buffer[] = []; let size = 0
        response.on('data', chunk => { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.byteLength; if (size > maximum) request.destroy(new Error('PROXY_RESPONSE_TOO_LARGE')); else chunks.push(bytes) })
        response.once('end', () => response.statusCode === 200 ? resolveResult(Buffer.concat(chunks)) : reject(new Error('PROXY_STATUS')))
      })
      request.once('error', reject); request.end(payload)
    })
  }

  #event(runtimeRef: string, level: 'info' | 'warn' | 'error', event: string): void {
    const current = this.#events.get(runtimeRef) ?? []
    this.#events.set(runtimeRef, [...current.slice(-99), { at: new Date().toISOString(), level, event }])
  }

  async #serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolveLock => { release = resolveLock })
    this.#tails.set(key, current)
    await previous
    try { return await work() }
    finally { release(); if (this.#tails.get(key) === current) this.#tails.delete(key) }
  }
}

function runtimeContainerBody(image: string, resources: RuntimeResources, labels: Readonly<Record<string, string>>, ownerEmail: string, limits: RuntimeLimits): unknown {
  return {
    Image: image, Cmd: ['node', 'server.js'], WorkingDir: '/app', User: '10001:10001', Labels: { ...labels, 'dz23.role': 'runtime' },
    Env: ['NODE_ENV=production', 'NEXT_TELEMETRY_DISABLED=1', 'HOSTNAME=127.0.0.1', 'PORT=3000', 'HOME=/tmp', 'NODE_PATH=/app/node_modules/.pnpm/node_modules', 'APP_EMAIL_MODE=studio-preview', `APP_OWNER_EMAIL=${ownerEmail}`, `DZ23_PREVIEW_ID=${resources.previewId}`, 'DATA_DIR=/preview-storage/data'],
    HostConfig: hardenedHost('none', limits, [
      { Type: 'volume', Source: resources.artifactVolume, Target: '/app', ReadOnly: true },
      { Type: 'volume', Source: resources.dataVolume, Target: '/preview-storage', ReadOnly: false },
    ]),
  }
}

function proxyContainerBody(image: string, resources: RuntimeResources, labels: Readonly<Record<string, string>>, proxySocketMount: DockerPreviewSupervisorOptions['proxySocketMount'], limits: RuntimeLimits, proxyUser: string): unknown {
  return {
    Image: image, Cmd: ['node', '/opt/dz23-preview-supervisor/lib/proxy-main.js'], User: proxyUser, Labels: { ...labels, 'dz23.role': 'proxy' },
    Env: [`DZ23_PROXY_SOCKET=/run/dz23-preview-proxies/${resources.runtimeRef}.sock`, `DZ23_PROXY_RUNTIME_REF=${resources.runtimeRef}`, 'DZ23_PROXY_RUNTIME_HOST=127.0.0.1', `DZ23_PREVIEW_ID=${resources.previewId}`, 'DZ23_PROXY_DATA_ROOT=/preview-storage/data'],
    HostConfig: { ...hardenedHost(`container:${resources.runtimeContainer}`, { ...limits, memoryBytes: Math.min(limits.memoryBytes, 128 * 1024 * 1024), pids: Math.min(limits.pids, 64) }, [
      { Type: proxySocketMount.type, Source: proxySocketMount.source, Target: '/run/dz23-preview-proxies', ReadOnly: false },
      { Type: 'volume', Source: resources.dataVolume, Target: '/preview-storage', ReadOnly: true },
    ]), GroupAdd: ['10001'] },
  }
}

function hardenedHost(network: string, limits: RuntimeLimits, mounts: readonly unknown[]): Record<string, unknown> {
  return {
    NetworkMode: network, ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
    PidsLimit: limits.pids, Memory: limits.memoryBytes, NanoCpus: limits.nanoCpus, PublishAllPorts: false, PortBindings: {},
    IpcMode: 'private', Mounts: mounts, Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=67108864,uid=10001,gid=10001' },
  }
}

function resourceNames(instanceId: string, previewId: string, runtimeRef: string): RuntimeResources {
  const slug = createHash('sha256').update(`${instanceId}:${previewId}`).digest('hex').slice(0, 16)
  return { previewId, runtimeRef, slug, runtimeContainer: `dz23-pv-app-${slug}`, proxyContainer: `dz23-pv-proxy-${slug}`, stagerContainer: `dz23-pv-stage-${slug}`, artifactVolume: `dz23-pv-art-${slug}`, dataVolume: `dz23-pv-data-${slug}` }
}
function baseLabels(instanceId: string, resources: RuntimeResources): Readonly<Record<string, string>> {
  return { 'dz23.managed': 'preview', 'dz23.instance_id': instanceId, 'dz23.preview_id': resources.previewId, 'dz23.runtime_ref': resources.runtimeRef }
}
function asLabels(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}
function boundedInteger(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('INVALID_RUNTIME_LIMIT')
  return value
}
function stringProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const item = (value as Record<string, unknown>)[key]
  return typeof item === 'string' && item !== '' ? item : undefined
}
function dockerIdentifier(value: unknown): string | undefined {
  const id = stringProperty(value, 'Id')
  if (id !== undefined) return id
  const name = stringProperty(value, 'Name')
  if (name !== undefined) return name
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const names = (value as Record<string, unknown>).Names
  const first = Array.isArray(names) ? names.find(item => typeof item === 'string' && item !== '') : undefined
  return typeof first === 'string' ? first.replace(/^\//u, '') : undefined
}
function isNotFound(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT' }
