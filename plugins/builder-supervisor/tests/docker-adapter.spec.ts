import { describe, expect, it, vi } from 'vitest'
import { DockerBuilderAdapter } from '../src/docker-adapter.js'
import type { DockerEnginePort } from '../src/docker-engine.js'

const image = `sha256:${'a'.repeat(64)}` as const
const buildRef = `build_${'b'.repeat(32)}`
const artifact = { archive: Buffer.alloc(1_024), sourceDirectory: '/srv/dz23/runs/run-1', sha256: 'c'.repeat(64), files: 1, bytes: 1 }

describe('server-authoritative Docker builder adapter', () => {
  it('uses only its pinned image and creates an isolated, read-only-rootfs step', async () => {
    const engine = new FakeEngine()
    const adapter = create(engine)
    const signal = new AbortController().signal

    await expect(adapter.preflight(signal)).resolves.toBe('OK')
    await adapter.prepare(buildRef, 'run-1', { ...artifact, command: 'curl attacker', image: 'evil', mount: '/', env: ['SECRET'] } as never, signal)
    const result = await adapter.execute(buildRef, 'install', signal)

    expect(result).toEqual({ exit_code: 0, stdout: 'clean output', stderr: '', timed_out: false, output_limited: false })
    expect(engine.inspected).toEqual([image])
    expect(engine.archives).toEqual([{ destination: '/workspace', bytes: 1_024 }])
    const stager = engine.created.find(row => labels(row.body)['dz23.role'] === 'stager')?.body
    const step = engine.created.find(row => labels(row.body)['dz23.role'] === 'step')?.body
    expect(stager).toMatchObject({ Image: image, Cmd: ['node', '-e', 'process.exit(0)'], User: '10001:10001', NetworkDisabled: true })
    expect(step).toMatchObject({
      Image: image,
      Cmd: ['pnpm', 'install', '--offline', '--frozen-lockfile', '--ignore-scripts', '--store-dir', '/template-store'],
      WorkingDir: '/workspace', User: '10001:10001', NetworkDisabled: true,
      Env: ['CI=true', 'HOME=/tmp', 'XDG_CONFIG_HOME=/tmp/.config', 'NEXT_TELEMETRY_DISABLED=1'],
    })
    expect(JSON.stringify(engine.created)).not.toMatch(/curl attacker|SECRET|"evil"/u)
    assertHardened(stager); assertHardened(step)
    expect(host(step).Mounts).toEqual([
      expect.objectContaining({ Type: 'volume', Target: '/workspace', ReadOnly: false }),
      { Type: 'volume', Source: 'dz23-builder-template-store', Target: '/template-store', ReadOnly: true },
    ])
    expect(await adapter.listManaged(signal)).toEqual([buildRef])
    await adapter.finish(buildRef, 'E2E_OK', signal)
    const exporter = engine.created.find(row => labels(row.body)['dz23.role'] === 'exporter')?.body
    expect(exporter).toMatchObject({ Image: image, Cmd: ['cp', '-a', '/workspace/.', '/output/'], User: '10001:10001', NetworkDisabled: true })
    assertHardened(exporter)
    expect(host(exporter).Mounts).toEqual([
      expect.objectContaining({ Type: 'volume', Target: '/workspace', ReadOnly: true }),
      { Type: 'bind', Source: artifact.sourceDirectory, Target: '/output', ReadOnly: false },
    ])
    expect(await adapter.listManaged(signal)).toEqual([])
  })

  it.each([
    ['build', ['pnpm', 'run', 'build']],
    ['unit', ['pnpm', 'run', 'test']],
    ['e2e', ['pnpm', 'run', 'test:e2e']],
  ] as const)('maps %s to one fixed argv', async (stepName, command) => {
    const engine = new FakeEngine(); const adapter = create(engine); const signal = new AbortController().signal
    await adapter.prepare(buildRef, 'run', artifact, signal)
    await adapter.execute(buildRef, stepName, signal)
    expect(engine.created.at(-1)?.body).toMatchObject({ Cmd: command })
  })

  it('returns BLOCKED_EXTERNAL for missing/mismatched images without accepting another image', async () => {
    const mismatch = new FakeEngine(); mismatch.imageId = `sha256:${'d'.repeat(64)}`
    await expect(create(mismatch).preflight(new AbortController().signal)).resolves.toBe('BLOCKED_EXTERNAL')
    const down = new FakeEngine(); down.pingFailure = true
    await expect(create(down).preflight(new AbortController().signal)).resolves.toBe('BLOCKED_EXTERNAL')
  })

  it('rolls back volume and stager after staging failure', async () => {
    const engine = new FakeEngine(); engine.archiveFailure = true
    await expect(create(engine).prepare(buildRef, 'run', artifact, new AbortController().signal)).rejects.toThrow('archive failed')
    expect(engine.volumes).toHaveLength(0)
    expect(engine.containers).toHaveLength(0)
  })

  it('enforces timeout, removes the container and reports no successful exit', async () => {
    const engine = new FakeEngine(); engine.waitForAbort = true
    const adapter = create(engine, 10); const signal = new AbortController().signal
    await adapter.prepare(buildRef, 'run', artifact, signal)
    await expect(adapter.execute(buildRef, 'build', signal)).resolves.toMatchObject({ exit_code: -1, timed_out: true })
    expect(engine.containers).toHaveLength(0)
  })

  it('bounds logs and marks output-limited results', async () => {
    const engine = new FakeEngine(); engine.logs = Buffer.alloc(512 * 1024 + 1, 0x61)
    const adapter = create(engine); const signal = new AbortController().signal
    await adapter.prepare(buildRef, 'run', artifact, signal)
    const result = await adapter.execute(buildRef, 'unit', signal)
    expect(result).toMatchObject({ exit_code: -1, output_limited: true })
    expect(Buffer.byteLength(result.stdout)).toBe(512 * 1024)
  })

  it('fails closed when cleanup leaves a managed survivor', async () => {
    const engine = new FakeEngine(); const adapter = create(engine); const signal = new AbortController().signal
    await adapter.prepare(buildRef, 'run', artifact, signal)
    engine.keepVolume = true
    await expect(adapter.finish(buildRef, 'FAILED', signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
  })

  it('cancels an active step and cleans all resources', async () => {
    const engine = new FakeEngine(); engine.waitForAbort = true
    const adapter = create(engine, 10_000); const signal = new AbortController().signal
    await adapter.prepare(buildRef, 'run', artifact, signal)
    const pending = adapter.execute(buildRef, 'e2e', signal)
    await vi.waitFor(() => expect(engine.started).toHaveLength(1))
    await adapter.cancel(buildRef, signal)
    await expect(pending).resolves.toMatchObject({ exit_code: 137 })
    expect(engine.containers).toHaveLength(0); expect(engine.volumes).toHaveLength(0)
  })

  it('validates immutable adapter configuration', () => {
    expect(() => new DockerBuilderAdapter({ engine: new FakeEngine(), imageDigest: 'sha256:no' as never, instanceId: 'one' })).toThrow('INVALID_BUILDER_IMAGE')
    expect(() => new DockerBuilderAdapter({ engine: new FakeEngine(), imageDigest: image, instanceId: '../bad' })).toThrow('INVALID_INSTANCE_ID')
    expect(() => new DockerBuilderAdapter({ engine: new FakeEngine(), imageDigest: image, instanceId: 'one', limits: { memoryBytes: 0, nanoCpus: 1, pids: 1, timeoutMs: 1 } })).toThrow('INVALID_BUILDER_LIMIT')
  })
})

function create(engine: FakeEngine, timeoutMs = 1_000): DockerBuilderAdapter {
  return new DockerBuilderAdapter({ engine, imageDigest: image, instanceId: 'test-instance', limits: { memoryBytes: 512 * 1024 * 1024, nanoCpus: 1_000_000_000, pids: 128, timeoutMs } })
}

class FakeEngine implements DockerEnginePort {
  imageId = image; pingFailure = false; archiveFailure = false; waitForAbort = false; keepVolume = false
  logs = Buffer.from('clean output')
  readonly inspected: string[] = []; readonly archives: Array<{ destination: string; bytes: number }> = []
  readonly created: Array<{ name: string; body: Record<string, unknown> }> = []
  containers: Array<{ Id: string; Labels: Record<string, string> }> = []
  volumes: Array<{ Name: string; Labels: Record<string, string> }> = []
  readonly started: string[] = []
  readonly waitResolvers = new Map<string, (value: { readonly StatusCode: number }) => void>()
  async ping(): Promise<void> { if (this.pingFailure) throw new Error('down') }
  async inspectImage(digest: string): Promise<{ readonly Id: string }> { this.inspected.push(digest); return { Id: this.imageId } }
  async createVolume(name: string, volumeLabels: Readonly<Record<string, string>>): Promise<void> { this.volumes.push({ Name: name, Labels: { ...volumeLabels } }) }
  async removeVolume(name: string): Promise<void> { if (!this.keepVolume) this.volumes = this.volumes.filter(row => row.Name !== name) }
  async listVolumes(): Promise<readonly Record<string, unknown>[]> { return this.volumes }
  async createContainer(name: string, bodyValue: unknown): Promise<string> {
    const body = object(bodyValue); const id = `${String(this.created.length + 1).padStart(12, 'a')}`
    this.created.push({ name, body }); this.containers.push({ Id: id, Labels: labels(body) }); return id
  }
  async putArchive(_container: string, destination: string, archive: Buffer): Promise<void> {
    if (this.archiveFailure) throw new Error('archive failed')
    this.archives.push({ destination, bytes: archive.byteLength })
  }
  async startContainer(id: string): Promise<void> { this.started.push(id) }
  async waitContainer(id: string, signal: AbortSignal): Promise<{ readonly StatusCode: number }> {
    if (!this.waitForAbort) return { StatusCode: 0 }
    return new Promise((resolve, reject) => {
      this.waitResolvers.set(id, resolve)
      signal.addEventListener('abort', () => { this.waitResolvers.delete(id); reject(signal.reason) }, { once: true })
    })
  }
  async containerLogs(): Promise<Buffer> { return this.logs }
  async stopContainer(id: string): Promise<void> {
    this.waitResolvers.get(id)?.({ StatusCode: 137 }); this.waitResolvers.delete(id)
  }
  async removeContainer(id: string): Promise<void> { this.waitResolvers.delete(id); this.containers = this.containers.filter(row => row.Id !== id) }
  async listContainers(): Promise<readonly Record<string, unknown>[]> { return this.containers }
}

function assertHardened(body: unknown): void {
  expect(host(body)).toMatchObject({
    NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
    PidsLimit: 128, Memory: 512 * 1024 * 1024, NanoCpus: 1_000_000_000, PublishAllPorts: false, PortBindings: {}, IpcMode: 'private', ShmSize: 268_435_456,
  })
  expect(object(body)).not.toHaveProperty('ExposedPorts')
  expect(host(body)).not.toHaveProperty('Binds')
}
function host(value: unknown): Record<string, unknown> { return object(object(value).HostConfig) }
function labels(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(object(object(value).Labels)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}
function object(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {} }
