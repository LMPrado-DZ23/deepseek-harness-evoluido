import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hashTree } from '../../prompt-to-app/src/runner.js'
import type { DockerEngine } from '../src/docker-engine.js'
import { DockerPreviewSupervisor } from '../src/docker-manager.js'

const onUnix = process.platform !== 'win32'
const RUNTIME_IMAGE = `sha256:${'a'.repeat(64)}` as const
const PROXY_IMAGE = `sha256:${'b'.repeat(64)}` as const
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe.skipIf(!onUnix)('Docker preview supervisor authority boundary', () => {
  it('derives every Docker authority server-side, hardens both containers and rolls back partial startup', async () => {
    const fixture = await artifactFixture()
    const engine = new RecordingDockerEngine({ failRuntimeStart: true })
    const supervisor = new DockerPreviewSupervisor({
      engine: engine as unknown as DockerEngine,
      artifactRoot: fixture.root,
      proxySocketRoot: '/run/dz23-preview-proxies',
      proxySocketMount: { type: 'volume', source: 'dz23-preview-proxy-sockets' },
      runtimeImageDigest: RUNTIME_IMAGE,
      proxyImageDigest: PROXY_IMAGE,
      instanceId: 'test-instance',
      limits: { memoryBytes: 256 * 1024 * 1024, nanoCpus: 500_000_000, pids: 96 },
    })
    const malicious = 'ATTACKER_CONTROLLED_VALUE'

    await expect(supervisor.start({
      preview_id: 'preview-01', artifact_relative_path: 'run', artifact_sha256: await hashTree(fixture.source), owner_email: 'owner@example.test',
      image: malicious, command: malicious, mount: malicious, network: malicious, env: [malicious],
    } as never, new AbortController().signal)).rejects.toThrow('INJECTED_RUNTIME_START_FAILURE')

    expect(engine.imageInspections).toEqual([RUNTIME_IMAGE, PROXY_IMAGE])
    expect(engine.networks).toHaveLength(0)
    expect(engine.archives).toHaveLength(2)
    expect(engine.archives[0]?.destination).toBe('/app')
    expect(engine.archives[0]?.archive.byteLength).toBeGreaterThan(1_024)
    expect(engine.archives[1]?.destination).toBe('/preview-storage')
    expect(engine.archives[1]?.archive.byteLength).toBe(1_536)

    const stager = engine.containers.find(row => role(row.body) === 'stager')?.body
    const runtime = engine.containers.find(row => role(row.body) === 'runtime')?.body
    const proxy = engine.containers.find(row => role(row.body) === 'proxy')?.body
    expect(stager).toBeDefined()
    expect(runtime).toBeDefined()
    expect(proxy).toBeDefined()
    expect(JSON.stringify(engine.containers)).not.toContain(malicious)

    expect(stager).toMatchObject({
      Image: PROXY_IMAGE, Cmd: ['node', '-e', 'process.exit(0)'], User: '10001:10001',
      HostConfig: { NetworkMode: 'none' },
    })
    expect(runtime).toMatchObject({
      Image: RUNTIME_IMAGE, Cmd: ['node', 'server.js'], WorkingDir: '/app', User: '10001:10001',
      Env: [
        'NODE_ENV=production', 'NEXT_TELEMETRY_DISABLED=1', 'HOSTNAME=127.0.0.1', 'PORT=3000', 'HOME=/tmp', 'NODE_PATH=/app/node_modules/.pnpm/node_modules',
        'APP_EMAIL_MODE=studio-preview', 'APP_OWNER_EMAIL=owner@example.test', 'DZ23_PREVIEW_ID=preview-01', 'DATA_DIR=/preview-storage/data',
      ],
    })
    expect(proxy).toMatchObject({ Image: PROXY_IMAGE, User: '10001:10001', HostConfig: { GroupAdd: ['10001'] } })
    assertHardened(runtime, 256 * 1024 * 1024, 500_000_000, 96)
    assertHardened(proxy, 128 * 1024 * 1024, 500_000_000, 64)
    assertNamedVolumeMounts(runtime, [
      ['/app', true], ['/preview-storage', false],
    ])
    assertNamedVolumeMounts(proxy, [
      ['/run/dz23-preview-proxies', false], ['/preview-storage', true],
    ])
    expect(host(runtime).NetworkMode).toBe('none')
    expect(host(proxy).NetworkMode).toBe(`container:${engine.runtimeContainerName}`)

    expect(engine.stopped).toEqual(expect.arrayContaining([
      expect.stringContaining('dz23-pv-proxy-'), expect.stringContaining('dz23-pv-app-'), expect.stringContaining('dz23-pv-stage-'),
    ]))
    expect(engine.removedContainers).toEqual(expect.arrayContaining([
      'd'.repeat(64), expect.stringContaining('dz23-pv-proxy-'), expect.stringContaining('dz23-pv-app-'), expect.stringContaining('dz23-pv-stage-'),
    ]))
    expect(engine.removedNetworks).toEqual(engine.networks.map(row => row.name))
    expect(engine.removedVolumes.sort()).toEqual(engine.volumes.map(row => row.name).sort())
  })

  it('stops known resources once and treats repeated stop as an idempotent no-op', async () => {
    const engine = new RecordingDockerEngine()
    engine.managedRow = {
      Labels: {
        'dz23.managed': 'preview', 'dz23.instance_id': 'test-instance',
        'dz23.preview_id': 'preview-02', 'dz23.runtime_ref': 'pv_0123456789abcdef0123456789abcdef', 'dz23.role': 'runtime',
      },
    }
    const supervisor = new DockerPreviewSupervisor({
      engine: engine as unknown as DockerEngine,
      artifactRoot: '/srv/dz23/runs', proxySocketRoot: '/run/dz23-preview-proxies',
      proxySocketMount: { type: 'volume', source: 'dz23-preview-proxy-sockets' }, runtimeImageDigest: RUNTIME_IMAGE,
      proxyImageDigest: PROXY_IMAGE, instanceId: 'test-instance',
    })
    const signal = new AbortController().signal

    await supervisor.stop('pv_0123456789abcdef0123456789abcdef', signal)
    const afterFirst = cleanupCount(engine)
    await supervisor.stop('pv_0123456789abcdef0123456789abcdef', signal)

    expect(afterFirst).toEqual({ stops: 3, containers: 3, networks: 0, volumes: 2 })
    expect(cleanupCount(engine)).toEqual(afterFirst)
  })

  it('drains orphan containers, legacy networks, volumes and owned sockets idempotently', async () => {
    const socketRoot = await mkdtemp(join(tmpdir(), 'dz23-preview-drain-'))
    temporaryRoots.push(socketRoot)
    const ownedSocket = join(socketRoot, `pv_${'1'.repeat(32)}.sock`)
    const unrelated = join(socketRoot, 'keep.sock')
    await writeFile(ownedSocket, 'orphan')
    await writeFile(unrelated, 'keep')
    const engine = new DrainDockerEngine()
    const supervisor = new DockerPreviewSupervisor({
      engine: engine as unknown as DockerEngine,
      artifactRoot: '/srv/dz23/runs', proxySocketRoot: socketRoot,
      proxySocketMount: { type: 'bind', source: socketRoot }, runtimeImageDigest: RUNTIME_IMAGE,
      proxyImageDigest: PROXY_IMAGE, instanceId: 'test-instance',
    })

    await expect(supervisor.drain(AbortSignal.timeout(5_000))).resolves.toEqual({ containers: 3, networks: 1, volumes: 2, sockets: 1 })
    expect(engine.stopped).toEqual(['runtime-id', 'proxy-id', 'stager-id'])
    expect(await lstat(ownedSocket).catch(() => undefined)).toBeUndefined()
    expect((await lstat(unrelated)).isFile()).toBe(true)
    await expect(supervisor.drain(AbortSignal.timeout(5_000))).resolves.toEqual({ containers: 0, networks: 0, volumes: 0, sockets: 0 })
  })

  it('fails closed when instance garbage collection leaves a survivor', async () => {
    const engine = new DrainDockerEngine(true)
    const supervisor = new DockerPreviewSupervisor({
      engine: engine as unknown as DockerEngine,
      artifactRoot: '/srv/dz23/runs', proxySocketRoot: '/run/dz23-preview-proxies',
      proxySocketMount: { type: 'volume', source: 'dz23-preview-proxy-sockets' }, runtimeImageDigest: RUNTIME_IMAGE,
      proxyImageDigest: PROXY_IMAGE, instanceId: 'test-instance',
    })

    await expect(supervisor.drain(AbortSignal.timeout(5_000))).rejects.toThrow('SUPERVISOR_DRAIN_INCOMPLETE')
  })
})

class DrainDockerEngine {
  containers = [
    { Id: 'runtime-id', Labels: { 'dz23.role': 'runtime' } },
    { Id: 'proxy-id', Labels: { 'dz23.role': 'proxy' } },
    { Id: 'stager-id', Labels: { 'dz23.role': 'stager' } },
  ]
  networks = [{ Id: 'legacy-network-id', Name: 'legacy-network' }]
  volumes = [{ Name: 'artifact-volume' }, { Name: 'data-volume' }]
  readonly stopped: string[] = []
  constructor(private readonly keepRuntime = false) {}
  async listContainers(): Promise<readonly Record<string, unknown>[]> { return this.containers }
  async listNetworks(): Promise<readonly Record<string, unknown>[]> { return this.networks }
  async listVolumes(): Promise<readonly Record<string, unknown>[]> { return this.volumes }
  async stopContainer(id: string): Promise<void> { this.stopped.push(id) }
  async removeContainer(id: string): Promise<void> {
    if (this.keepRuntime && id === 'runtime-id') throw new Error('TRANSIENT_REMOVE_FAILURE')
    this.containers = this.containers.filter(row => row.Id !== id)
  }
  async removeNetwork(id: string): Promise<void> { this.networks = this.networks.filter(row => row.Id !== id) }
  async removeVolume(name: string): Promise<void> { this.volumes = this.volumes.filter(row => row.Name !== name) }
}

class RecordingDockerEngine {
  readonly imageInspections: string[] = []
  readonly volumes: Array<{ name: string; labels: Readonly<Record<string, string>> }> = []
  readonly networks: Array<{ name: string; labels: Readonly<Record<string, string>> }> = []
  readonly containers: Array<{ name: string; body: unknown }> = []
  readonly archives: Array<{ containerId: string; destination: string; archive: Buffer }> = []
  readonly stopped: string[] = []
  readonly removedContainers: string[] = []
  readonly removedNetworks: string[] = []
  readonly removedVolumes: string[] = []
  managedRow: Record<string, unknown> | undefined
  runtimeContainerName: string | undefined

  constructor(private readonly behavior: { readonly failRuntimeStart?: boolean } = {}) {}

  async ping(): Promise<void> {}
  async inspectImage(digest: string): Promise<{ readonly Id: string }> { this.imageInspections.push(digest); return { Id: digest } }
  async createVolume(name: string, labels: Readonly<Record<string, string>>): Promise<void> { this.volumes.push({ name, labels }) }
  async createNetwork(name: string, labels: Readonly<Record<string, string>>): Promise<string> { this.networks.push({ name, labels }); return 'c'.repeat(64) }
  async createContainer(name: string, body: unknown): Promise<string> {
    this.containers.push({ name, body })
    if (role(body) === 'runtime') { this.runtimeContainerName = name; this.managedRow = { Id: name, Labels: asBody(body).Labels } }
    return 'd'.repeat(64)
  }
  async putArchive(containerId: string, destination: string, archive: Buffer): Promise<void> { this.archives.push({ containerId, destination, archive }) }
  async startContainer(id: string): Promise<void> {
    if (this.behavior.failRuntimeStart === true && id === this.runtimeContainerName) throw new Error('INJECTED_RUNTIME_START_FAILURE')
  }
  async listContainers(): Promise<readonly Record<string, unknown>[]> { return this.managedRow === undefined ? [] : [this.managedRow] }
  async listNetworks(): Promise<readonly Record<string, unknown>[]> { return [] }
  async listVolumes(): Promise<readonly Record<string, unknown>[]> { return [] }
  async stopContainer(id: string): Promise<void> { this.stopped.push(id) }
  async removeContainer(id: string): Promise<void> {
    this.removedContainers.push(id)
    if (id === this.runtimeContainerName || id.startsWith('dz23-pv-app-')) this.managedRow = undefined
  }
  async removeNetwork(id: string): Promise<void> { this.removedNetworks.push(id) }
  async removeVolume(name: string): Promise<void> { this.removedVolumes.push(name) }
}

function assertHardened(body: unknown, memory: number, cpus: number, pids: number): void {
  expect(host(body)).toMatchObject({
    ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
    PidsLimit: pids, Memory: memory, NanoCpus: cpus, PublishAllPorts: false, PortBindings: {}, IpcMode: 'private',
  })
  expect(asBody(body)).not.toHaveProperty('ExposedPorts')
  expect(host(body)).not.toHaveProperty('Binds')
}

function assertNamedVolumeMounts(body: unknown, expected: ReadonlyArray<readonly [string, boolean]>): void {
  const mounts = host(body).Mounts as Array<Record<string, unknown>>
  expect(mounts).toHaveLength(expected.length)
  expect(mounts.every(mount => mount.Type === 'volume' && typeof mount.Source === 'string' && !String(mount.Source).startsWith('/'))).toBe(true)
  for (const [target, readOnly] of expected) expect(mounts).toContainEqual(expect.objectContaining({ Target: target, ReadOnly: readOnly }))
}

function cleanupCount(engine: RecordingDockerEngine): Record<string, number> {
  return { stops: engine.stopped.length, containers: engine.removedContainers.length, networks: engine.removedNetworks.length, volumes: engine.removedVolumes.length }
}

function role(body: unknown): string | undefined {
  const labels = asBody(body).Labels
  return typeof labels === 'object' && labels !== null ? (labels as Record<string, unknown>)['dz23.role'] as string | undefined : undefined
}

function host(body: unknown): Record<string, unknown> { return asBody(asBody(body).HostConfig) }
function asBody(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {} }

async function artifactFixture(): Promise<{ readonly root: string; readonly source: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'dz23-preview-manager-'))
  temporaryRoots.push(parent)
  const root = join(parent, 'artifacts')
  const source = join(root, 'run')
  await mkdir(join(source, '.next', 'standalone'), { recursive: true })
  await mkdir(join(source, '.next', 'static'), { recursive: true })
  await mkdir(join(source, 'public'), { recursive: true })
  await writeFile(join(source, '.next', 'standalone', 'server.js'), 'server')
  await writeFile(join(source, '.next', 'static', 'app.js'), 'static')
  await writeFile(join(source, 'public', 'logo.txt'), 'logo')
  return { root, source }
}
