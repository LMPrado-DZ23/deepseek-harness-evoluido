import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { DockerBuilderAdapter } from '../src/docker-adapter.js'
import type { DockerEnginePort } from '../src/docker-engine.js'

const image = `sha256:${'a'.repeat(64)}` as const
const templateVersion = 'nextjs-app@1'
const templateStoreSha256 = 'd'.repeat(64)
const buildRef = `build_${'b'.repeat(32)}`
const artifact = { archivePath: '/tmp/dz23-input.tar', archiveBytes: 1_024, sha256: 'c'.repeat(64), files: 1, bytes: 1 }

describe('server-authoritative Docker builder adapter', () => {
  it('uses only its pinned image and creates an isolated, read-only-rootfs step', async () => {
    const engine = new FakeEngine()
    const adapter = create(engine)
    const signal = new AbortController().signal

    await expect(adapter.preflight(signal)).resolves.toMatchObject({ state: 'OK', protocol_version: 1, instance_id: 'test-instance', image_id: image, policy_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    await adapter.prepare(buildRef, 'run-1', { ...artifact, command: 'curl attacker', image: 'evil', mount: '/', env: ['SECRET'] } as never, signal)
    const result = await adapter.execute(buildRef, 'install', signal)

    expect(result).toEqual({ exit_code: 0, stdout: 'clean output', stderr: '', timed_out: false, termination_reason: null, output_limit_exceeded: false })
    expect(engine.inspected).toEqual([image])
    expect(engine.archives).toEqual([{ destination: '/workspace', bytes: 1_024 }])
    expect(engine.volumeOptions).toEqual([{ type: 'tmpfs', device: 'tmpfs', o: 'size=67108864,uid=10001,gid=10001,mode=0700' }])
    const stager = engine.created.find(row => labels(row.body)['dz23.role'] === 'anchor')?.body
    const step = engine.created.find(row => labels(row.body)['dz23.role'] === 'step')?.body
    expect(stager).toMatchObject({ Image: image, Cmd: ['sleep', 'infinity'], User: '10001:10001', NetworkDisabled: true })
    expect(step).toMatchObject({
      Image: image,
      Cmd: ['pnpm', 'install', '--offline', '--frozen-store', '--frozen-lockfile', '--trust-lockfile', '--ignore-scripts', '--store-dir', '/template-store'],
      WorkingDir: '/workspace', User: '10001:10001', NetworkDisabled: true,
      Env: ['CI=true', 'HOME=/tmp', 'XDG_CONFIG_HOME=/tmp/.config', 'NEXT_TELEMETRY_DISABLED=1'],
    })
    expect(JSON.stringify(engine.created)).not.toMatch(/curl attacker|SECRET|"evil"/u)
    assertHardened(stager); assertHardened(step)
    expect(host(step).Mounts).toEqual([
      expect.objectContaining({ Type: 'volume', Target: '/workspace', ReadOnly: false }),
      { Type: 'volume', Source: templateVolume(), Target: '/template-store', ReadOnly: true },
    ])
    expect(await adapter.listManaged(signal)).toEqual([buildRef])
    expect(JSON.stringify(engine.created)).not.toContain('"Type":"bind"')
    await adapter.cleanup(buildRef, signal)
    expect(await adapter.listManaged(signal)).toEqual([])
  })

  it.each([
    ['build', ['pnpm', 'run', 'build']],
    ['test', ['pnpm', 'run', 'test']],
    ['e2e', ['pnpm', 'run', 'test:e2e']],
  ] as const)('maps %s to one fixed argv', async (stepName, command) => {
    const engine = new FakeEngine(); const adapter = create(engine); const signal = new AbortController().signal
    await adapter.prepare(buildRef, 'run', artifact, signal)
    await adapter.execute(buildRef, stepName, signal)
    expect(engine.created.at(-1)?.body).toMatchObject({ Cmd: command })
    expect(host(engine.created.at(-1)?.body).Mounts).toEqual([{ Type: 'volume', Source: expect.any(String), Target: '/workspace', ReadOnly: false }])
  })

  it('returns BLOCKED_EXTERNAL for missing/mismatched images without accepting another image', async () => {
    const mismatch = new FakeEngine(); mismatch.imageId = `sha256:${'d'.repeat(64)}`
    await expect(create(mismatch).preflight(new AbortController().signal)).resolves.toMatchObject({ state: 'BLOCKED_EXTERNAL' })
    const down = new FakeEngine(); down.pingFailure = true
    await expect(create(down).preflight(new AbortController().signal)).resolves.toMatchObject({ state: 'BLOCKED_EXTERNAL' })
    const missingStore = new FakeEngine(); missingStore.volumes = []
    await expect(create(missingStore).preflight(new AbortController().signal)).resolves.toMatchObject({ state: 'BLOCKED_EXTERNAL' })
  })

  it('binds the attested policy hash to immutable limits and template identity', async () => {
    const engine = new FakeEngine(); const signal = new AbortController().signal
    const normal = await create(engine).preflight(signal)
    const changed = await new DockerBuilderAdapter({ engine, imageDigest: image, instanceId: 'test-instance', exportRoot: join(tmpdir(), 'changed'), templateStoreVersion: templateVersion, templateStoreSha256, limits: limits({ memoryBytes: 512 * 1024 * 1024, nanoCpus: 1_000_000_000, pids: 64, timeoutMs: 1_000, workspaceBytes: 64 * 1024 * 1024, concurrentContainers: 2 }) }).preflight(signal)
    expect(changed.policy_sha256).not.toBe(normal.policy_sha256)
  })

  it('rolls back volume and stager after staging failure', async () => {
    const engine = new FakeEngine(); engine.archiveFailure = true
    await expect(create(engine).prepare(buildRef, 'run', artifact, new AbortController().signal)).rejects.toThrow('archive failed')
    expect(engine.volumes).toHaveLength(1)
    expect(engine.containers).toHaveLength(0)
  })

  it('prioritizes incomplete rollback evidence over the original staging error', async () => {
    const engine = new FakeEngine(); engine.archiveFailure = true; engine.keepVolume = true
    await expect(create(engine).prepare(buildRef, 'run', artifact, new AbortController().signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
  })

  it('fails closed when rollback cannot prove both Engine inventories are empty', async () => {
    const engine = new FakeEngine(); engine.archiveFailure = true; engine.failRollbackInventory = true
    await expect(create(engine).prepare(buildRef, 'run', artifact, new AbortController().signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
  })

  it('enforces timeout, removes the container and reports no successful exit', async () => {
    const engine = new FakeEngine(); engine.waitForAbort = true
    const adapter = create(engine, 10); const signal = new AbortController().signal
    await adapter.prepare(buildRef, 'run', artifact, signal)
    await expect(adapter.execute(buildRef, 'build', signal)).resolves.toMatchObject({ exit_code: -1, timed_out: true, termination_reason: 'timeout', output_limit_exceeded: false })
    expect(engine.containers).toHaveLength(1)
  })

  it('bounds logs and marks output-limited results', async () => {
    const engine = new FakeEngine(); engine.logs = { stdout: Buffer.alloc(512 * 1024 + 1, 0x61), stderr: Buffer.alloc(0) }
    const adapter = create(engine); const signal = new AbortController().signal
    await adapter.prepare(buildRef, 'run', artifact, signal)
    const result = await adapter.execute(buildRef, 'test', signal)
    expect(result).toMatchObject({ exit_code: -1, termination_reason: 'output_limit', output_limit_exceeded: true })
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(512 * 1024)
  })

  it('fails closed when cleanup leaves a managed survivor', async () => {
    const engine = new FakeEngine(); const adapter = create(engine); const signal = new AbortController().signal
    await adapter.prepare(buildRef, 'run', artifact, signal)
    engine.keepVolume = true
    await expect(adapter.cleanup(buildRef, signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
  })

  it('cancels an active step and cleans all resources', async () => {
    const engine = new FakeEngine(); engine.waitForAbort = true
    const adapter = create(engine, 10_000); const signal = new AbortController().signal
    await adapter.prepare(buildRef, 'run', artifact, signal)
    const pending = adapter.execute(buildRef, 'e2e', signal)
    await vi.waitFor(() => expect(engine.started).toHaveLength(2))
    await adapter.cancel(buildRef, signal)
    await expect(pending).resolves.toMatchObject({ exit_code: 137 })
    await adapter.cleanup(buildRef, signal)
    expect(engine.containers).toHaveLength(0); expect(engine.volumes).toHaveLength(1)
  })

  it('validates immutable adapter configuration', () => {
    expect(() => new DockerBuilderAdapter({ engine: new FakeEngine(), imageDigest: 'sha256:no' as never, instanceId: 'one', exportRoot: tmpdir(), templateStoreVersion: templateVersion, templateStoreSha256 })).toThrow('INVALID_BUILDER_IMAGE')
    expect(() => new DockerBuilderAdapter({ engine: new FakeEngine(), imageDigest: image, instanceId: '../bad', exportRoot: tmpdir(), templateStoreVersion: templateVersion, templateStoreSha256 })).toThrow('INVALID_INSTANCE_ID')
    expect(() => new DockerBuilderAdapter({ engine: new FakeEngine(), imageDigest: image, instanceId: 'one', exportRoot: tmpdir(), templateStoreVersion: templateVersion, templateStoreSha256, limits: limits({ memoryBytes: 0, nanoCpus: 1, pids: 1, timeoutMs: 1, workspaceBytes: 1, concurrentContainers: 1 }) })).toThrow('INVALID_BUILDER_LIMIT')
    expect(() => new DockerBuilderAdapter({ engine: new FakeEngine(), imageDigest: image, instanceId: 'one', exportRoot: tmpdir(), templateStoreVersion: '../bad', templateStoreSha256 })).toThrow('INVALID_TEMPLATE_STORE')
  })

  it('reconciles labeled orphan containers and quota volumes before accepting work', async () => {
    const engine = new FakeEngine(); const signal = new AbortController().signal; await create(engine).prepare(buildRef, 'orphan-run', artifact, signal)
    const restarted = create(engine); await expect(restarted.reconcile(signal)).resolves.toEqual([{ build_ref: buildRef, build_id: 'orphan-run' }])
    expect(engine.containers).toHaveLength(0); expect(engine.volumes).toHaveLength(1)
    engine.volumes.push({ Name: 'alien', Labels: { 'dz23.managed': 'builder', 'dz23.instance_id': 'test-instance' } })
    await expect(create(engine).reconcile(signal)).rejects.toThrow('RECOVERY_FAILED')
  })

  it('exports only through bounded Docker archive streaming and returns the revalidated tree SHA', async () => {
    const engine = new FakeEngine(); engine.downloadPayload = exportTar(); const root = await mkdtemp(join(tmpdir(), 'dz23-adapter-export-')); const signal = new AbortController().signal
    try {
      const adapter = new DockerBuilderAdapter({ engine, imageDigest: image, instanceId: 'test-instance', exportRoot: root, templateStoreVersion: templateVersion, templateStoreSha256 }); await adapter.prepare(buildRef, 'export-run', artifact, signal)
      await expect(adapter.exportArtifact(buildRef, signal)).resolves.toMatchObject({ relative_path: `exports/${buildRef}`, files: 3 })
      expect(JSON.stringify(engine.created)).not.toMatch(/"Type":"bind"|cp","-a/u)
      const exporter = engine.created.find(row => labels(row.body)['dz23.role'] === 'export')?.body
      expect(exporter).toMatchObject({ Cmd: ['node', '-e', expect.stringContaining("evidence/appspec-report.json")] })
      expect(engine.containers.filter(row => row.Labels['dz23.role'] === 'export')).toHaveLength(0)
      expect(engine.volumes.filter(row => row.Labels['dz23.resource'] === 'export')).toHaveLength(0)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('removes exporter resources even when the downloaded archive is invalid', async () => {
    const engine = new FakeEngine(); engine.downloadPayload = Buffer.from('not a tar'); const root = await mkdtemp(join(tmpdir(), 'dz23-adapter-export-fail-')); const signal = new AbortController().signal
    try {
      const adapter = new DockerBuilderAdapter({ engine, imageDigest: image, instanceId: 'test-instance', exportRoot: root, templateStoreVersion: templateVersion, templateStoreSha256 }); await adapter.prepare(buildRef, 'export-fail', artifact, signal)
      await expect(adapter.exportArtifact(buildRef, signal)).rejects.toThrow('EXPORT_INVALID')
      expect(engine.containers.filter(row => row.Labels['dz23.role'] === 'export')).toHaveLength(0); expect(engine.volumes.filter(row => row.Labels['dz23.resource'] === 'export')).toHaveLength(0)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('fails closed on every exporter cleanup error while releasing the global export permit', async () => {
    const engine = new FakeEngine(); engine.downloadPayload = Buffer.from('not a tar'); engine.failExporterCleanup = true
    const root = await mkdtemp(join(tmpdir(), 'dz23-adapter-export-cleanup-')); const signal = new AbortController().signal
    try {
      const adapter = new DockerBuilderAdapter({ engine, imageDigest: image, instanceId: 'test-instance', exportRoot: root, templateStoreVersion: templateVersion, templateStoreSha256 }); await adapter.prepare(buildRef, 'export-cleanup', artifact, signal)
      await expect(adapter.exportArtifact(buildRef, signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
      engine.failExporterCleanup = false; engine.containers = engine.containers.filter(row => row.Labels['dz23.role'] !== 'export'); engine.volumes = engine.volumes.filter(row => row.Labels['dz23.resource'] !== 'export')
      await expect(adapter.exportArtifact(buildRef, signal)).rejects.toThrow('EXPORT_INVALID')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('releases the execution permit even when removal of a step container fails', async () => {
    const engine = new FakeEngine(); const adapter = create(engine); const signal = new AbortController().signal
    await adapter.prepare(buildRef, 'step-cleanup', artifact, signal); engine.failStepRemoval = true
    await expect(adapter.execute(buildRef, 'install', signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
    engine.failStepRemoval = false
    await expect(adapter.execute(buildRef, 'install', signal)).resolves.toMatchObject({ exit_code: 0 })
  })

  it('enforces the aggregate workspace quota across builds and frees it only after observed cleanup', async () => {
    const engine = new FakeEngine(); const adapter = new DockerBuilderAdapter({ engine, imageDigest: image, instanceId: 'test-instance', exportRoot: join(tmpdir(), 'quota'), templateStoreVersion: templateVersion, templateStoreSha256, limits: limits({ workspaceBytes: 64 * 1024 * 1024, maxWorkspaceBytes: 64 * 1024 * 1024 }) }); const signal = new AbortController().signal
    await adapter.prepare(buildRef, 'one', artifact, signal)
    const second = `build_${'c'.repeat(32)}`; await expect(adapter.prepare(second, 'two', artifact, signal)).rejects.toThrow('CAPACITY_EXCEEDED')
    await adapter.cleanup(buildRef, signal); await expect(adapter.prepare(second, 'two', artifact, signal)).resolves.toBeUndefined()
  })
})

function create(engine: FakeEngine, timeoutMs = 1_000): DockerBuilderAdapter {
  return new DockerBuilderAdapter({ engine, imageDigest: image, instanceId: 'test-instance', exportRoot: join(tmpdir(), 'dz23-builder-exports'), templateStoreVersion: templateVersion, templateStoreSha256, limits: limits({ memoryBytes: 512 * 1024 * 1024, nanoCpus: 1_000_000_000, pids: 128, timeoutMs, workspaceBytes: 64 * 1024 * 1024, concurrentContainers: 2 }) })
}

class FakeEngine implements DockerEnginePort {
  imageId = image; pingFailure = false; archiveFailure = false; waitForAbort = false; keepVolume = false; failExporterCleanup = false; failStepRemoval = false; failRollbackInventory = false
  logs = { stdout: Buffer.from('clean output'), stderr: Buffer.alloc(0) }
  readonly inspected: string[] = []; readonly archives: Array<{ destination: string; bytes: number }> = []
  readonly volumeOptions: Array<Readonly<Record<string, string>>> = []
  readonly created: Array<{ name: string; body: Record<string, unknown> }> = []
  containers: Array<{ Id: string; Labels: Record<string, string> }> = []
  volumes: Array<{ Name: string; Labels: Record<string, string> }> = [{ Name: templateVolume(), Labels: { 'dz23.managed': 'builder-template-store', 'dz23.instance_id': 'test-instance', 'dz23.template_version': templateVersion, 'dz23.template_sha256': templateStoreSha256 } }]
  readonly started: string[] = []
  readonly waitResolvers = new Map<string, (value: { readonly StatusCode: number }) => void>()
  downloadPayload: Buffer = Buffer.alloc(0)
  async ping(): Promise<void> { if (this.pingFailure) throw new Error('down') }
  async inspectImage(digest: string): Promise<{ readonly Id: string }> { this.inspected.push(digest); return { Id: this.imageId } }
  async createVolume(name: string, volumeLabels: Readonly<Record<string, string>>, driverOpts: Readonly<Record<string, string>>): Promise<void> { this.volumes.push({ Name: name, Labels: { ...volumeLabels } }); this.volumeOptions.push({ ...driverOpts }) }
  async removeVolume(name: string): Promise<void> { if (this.failExporterCleanup && this.volumes.find(row => row.Name === name)?.Labels['dz23.resource'] === 'export') throw new Error('remove export volume failed'); if (!this.keepVolume) this.volumes = this.volumes.filter(row => row.Name !== name) }
  async listVolumes(filters: Readonly<Record<string, readonly string[]>> = {}): Promise<readonly Record<string, unknown>[]> { const wanted = filters.label ?? []; if (this.failExporterCleanup && wanted.includes('dz23.resource=export')) throw new Error('list export volumes failed'); if (this.failRollbackInventory && wanted.some(item => item.startsWith('dz23.build_ref='))) throw new Error('list rollback volumes failed'); return this.volumes.filter(row => wanted.every(item => { const index = item.indexOf('='); return row.Labels[item.slice(0, index)] === item.slice(index + 1) })) }
  async createContainer(name: string, bodyValue: unknown): Promise<string> {
    const body = object(bodyValue); const id = `${String(this.created.length + 1).padStart(12, 'a')}`
    this.created.push({ name, body }); this.containers.push({ Id: id, Labels: labels(body) }); return id
  }
  async putArchive(_container: string, destination: string, _archivePath: string, archiveBytes: number): Promise<void> {
    if (this.archiveFailure) throw new Error('archive failed')
    this.archives.push({ destination, bytes: archiveBytes })
  }
  async startContainer(id: string): Promise<void> { this.started.push(id) }
  async waitContainer(id: string, signal: AbortSignal): Promise<{ readonly StatusCode: number }> {
    if (!this.waitForAbort) return { StatusCode: 0 }
    return new Promise((resolve, reject) => {
      this.waitResolvers.set(id, resolve)
      signal.addEventListener('abort', () => { this.waitResolvers.delete(id); reject(signal.reason) }, { once: true })
    })
  }
  async containerLogs(_id: string, maximumBytes: number): Promise<{ readonly stdout: Buffer; readonly stderr: Buffer }> {
    if (this.logs.stdout.byteLength + this.logs.stderr.byteLength > maximumBytes) throw new Error('DOCKER_RESPONSE_TOO_LARGE')
    return this.logs
  }
  async downloadArchive(_container: string, _source: string, destination: string): Promise<{ readonly bytes: number; readonly sha256: string }> { await writeFile(destination, this.downloadPayload, { flag: 'wx' }); return { bytes: this.downloadPayload.length, sha256: createHash('sha256').update(this.downloadPayload).digest('hex') } }
  async stopContainer(id: string): Promise<void> {
    if (this.failExporterCleanup && this.containers.find(row => row.Id === id)?.Labels['dz23.role'] === 'export') throw new Error('stop exporter failed')
    this.waitResolvers.get(id)?.({ StatusCode: 137 }); this.waitResolvers.delete(id)
  }
  async removeContainer(id: string): Promise<void> { const role = this.containers.find(row => row.Id === id)?.Labels['dz23.role']; if ((this.failExporterCleanup && role === 'export') || (this.failStepRemoval && role === 'step')) throw new Error('remove container failed'); this.waitResolvers.delete(id); this.containers = this.containers.filter(row => row.Id !== id) }
  async listContainers(filters: Readonly<Record<string, readonly string[]>> = {}): Promise<readonly Record<string, unknown>[]> { const wanted = filters.label ?? []; if (this.failExporterCleanup && wanted.includes('dz23.role=export')) throw new Error('list export containers failed'); if (this.failRollbackInventory && wanted.some(item => item.startsWith('dz23.build_ref='))) throw new Error('list rollback containers failed'); return this.containers.filter(row => wanted.every(item => { const index = item.indexOf('='); return row.Labels[item.slice(0, index)] === item.slice(index + 1) })) }
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
function tarSingle(name: string, value: string): Buffer {
  const data = Buffer.from(value); const header = Buffer.alloc(512); header.write(name, 0, 100, 'utf8')
  const octal = (offset: number, length: number, number: number) => header.write(`${number.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii')
  octal(100, 8, 0o644); octal(108, 8, 10_001); octal(116, 8, 10_001); octal(124, 12, data.length); octal(136, 12, 0); header.fill(0x20, 148, 156); header[156] = 48; header.write('ustar', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii'); octal(148, 8, header.reduce((sum, byte) => sum + byte, 0))
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512), Buffer.alloc(1024)])
}
function exportTar(): Buffer { return Buffer.concat([tarSingle('.next/standalone/server.js', 'server').subarray(0, -1024), tarSingle('.next/static/chunk.js', 'chunk').subarray(0, -1024), tarSingle('evidence/appspec-report.json', '{}').subarray(0, -1024), Buffer.alloc(1024)]) }
function templateVolume(): string { return `dz23-template-${createHash('sha256').update(`test-instance:${templateVersion}:${templateStoreSha256}`).digest('hex').slice(0, 24)}` }
function limits(overrides: Partial<import('../src/docker-adapter.js').BuilderLimits> = {}): import('../src/docker-adapter.js').BuilderLimits { return { memoryBytes: 512 * 1024 * 1024, nanoCpus: 1_000_000_000, pids: 128, timeoutMs: 1_000, workspaceBytes: 64 * 1024 * 1024, maxWorkspaceBytes: 128 * 1024 * 1024, concurrentContainers: 2, maxExportBytes: 128 * 1024 * 1024, maxRetainedExports: 5, ...overrides } }
