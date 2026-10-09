import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hashTree } from '../../prompt-to-app/src/runner.js'
import type { DockerEngine } from '../src/docker-engine.js'
import { DockerPreviewSupervisor, type DockerPreviewSupervisorOptions } from '../src/docker-manager.js'

const RUNTIME_IMAGE = `sha256:${'a'.repeat(64)}` as const
const PROXY_IMAGE = `sha256:${'b'.repeat(64)}` as const
const onUnix = process.platform !== 'win32'
const temporaryRoots: string[] = []
const engines: SocketDockerEngine[] = []

afterEach(async () => {
  await Promise.all(engines.splice(0).map(engine => engine.close()))
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
}, 30_000)

describe.skipIf(!onUnix)('DockerPreviewSupervisor complete lifecycle', () => {
  it('serializes duplicate start, serves health/messages/forward/list/logs and removes the runtime completely', async () => {
    const fixture = await artifactFixture()
    const sockets = await temporaryDirectory('sockets')
    const engine = track(new SocketDockerEngine(sockets))
    engine.extraRows = [
      { Labels: null },
      { Labels: { 'dz23.runtime_ref': 'incomplete' } },
      { Labels: { 'dz23.runtime_ref': 23, 'dz23.preview_id': [] } },
    ]
    const supervisor = createSupervisor(engine, fixture.root, sockets)
    const input = {
      preview_id: 'preview-03', artifact_relative_path: 'run', artifact_sha256: await hashTree(fixture.source), owner_email: 'owner@example.test',
    }
    const signal = new AbortController().signal

    const [first, duplicate] = await Promise.all([supervisor.start(input, signal), supervisor.start(input, signal)])

    expect(duplicate).toEqual(first)
    expect(engine.containers).toHaveLength(3)
    expect(await supervisor.listManaged(signal)).toEqual([{ runtime_ref: first.runtime_ref, preview_id: 'preview-03' }])
    expect(await supervisor.health(first.runtime_ref, signal)).toBe('OK')

    const messages = await supervisor.verificationMessages(first.runtime_ref, signal)
    expect(messages).toHaveLength(20)
    expect(messages[0]).toMatchObject({ code: '000005', email: 'owner@example.test' })
    expect(messages[19]).toMatchObject({ code: '000024' })

    const forwarded = await supervisor.forward({
      runtime_ref: first.runtime_ref, method: 'POST', path: '/echo', headers: { 'content-type': 'text/plain' }, body_base64: Buffer.from('hello').toString('base64'),
    }, signal)
    expect(forwarded).toEqual({ status: 201, headers: { 'content-type': 'text/plain' }, body_base64: Buffer.from('ok').toString('base64') })
    expect(engine.dataRequests.some(request => request.operation === 'forward' && asRecord(request.body).path === '/echo')).toBe(true)

    const lastTwo = await supervisor.logs(first.runtime_ref, 2)
    expect(lastTwo).toHaveLength(2)
    expect(lastTwo.every(event => asRecord(event).event === 'HEALTH_OK')).toBe(true)

    await supervisor.stop(first.runtime_ref, signal)
    expect(await supervisor.listManaged(signal)).toEqual([])
    expect(await supervisor.health(first.runtime_ref, signal)).toBe('DOWN')
    expect(await supervisor.verificationMessages(first.runtime_ref, signal)).toEqual([])
    await expect(supervisor.forward({ runtime_ref: first.runtime_ref, method: 'GET', path: '/', headers: {}, body_base64: '' }, signal)).rejects.toThrow('RUNTIME_NOT_FOUND')
    expect(((await supervisor.logs(first.runtime_ref, 1))[0] as { event: string }).event).toBe('PREVIEW_STOPPED')
  })

  it('records DOWN for an unhealthy, malformed or non-200 proxy response without exposing the failure', async () => {
    const sockets = await temporaryDirectory('unhealthy')
    const engine = track(new SocketDockerEngine(sockets))
    const runtimeRef = 'pv_0123456789abcdef0123456789abcdef'
    engine.seedRuntime('preview-04', runtimeRef)
    await engine.openProxy(runtimeRef)
    const supervisor = createSupervisor(engine, '/srv/artifacts', sockets)
    const signal = new AbortController().signal

    engine.forwardHealth = 503
    expect(await supervisor.health(runtimeRef, signal)).toBe('DOWN')
    engine.rawResponse = Buffer.from('{not-json')
    expect(await supervisor.health(runtimeRef, signal)).toBe('DOWN')
    engine.rawResponse = undefined
    engine.httpStatus = 503
    expect(await supervisor.health(runtimeRef, signal)).toBe('DOWN')
    expect((await supervisor.logs(runtimeRef, 10)).map(event => asRecord(event).event)).toEqual(['HEALTH_DOWN', 'HEALTH_DOWN', 'HEALTH_DOWN'])
  })

  it('returns no verification messages when the isolated proxy sends a non-array payload', async () => {
    const sockets = await temporaryDirectory('messages')
    const engine = track(new SocketDockerEngine(sockets))
    const runtimeRef = 'pv_1123456789abcdef0123456789abcdef'
    engine.seedRuntime('preview-05', runtimeRef)
    engine.messagePayload = { messages: 'not-an-array' }
    await engine.openProxy(runtimeRef)
    const supervisor = createSupervisor(engine, '/srv/artifacts', sockets)

    await expect(supervisor.verificationMessages(runtimeRef, new AbortController().signal)).resolves.toEqual([])
  })

  it('reports both container states after readiness expires and tolerates an unavailable inspection', async () => {
    const fixture = await artifactFixture()
    const sockets = await temporaryDirectory('readiness')
    const engine = track(new SocketDockerEngine(sockets))
    engine.forwardHealth = 503
    engine.inspectProxyFailure = true
    const supervisor = createSupervisor(engine, fixture.root, sockets)
    const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(30_001)

    try {
      await expect(supervisor.start({
        preview_id: 'preview-timeout', artifact_relative_path: 'run', artifact_sha256: await hashTree(fixture.source), owner_email: 'owner@example.test',
      }, new AbortController().signal)).rejects.toThrow('RUNTIME_READINESS_TIMEOUT:runtime=exited/1;proxy=unavailable')
    } finally { clock.mockRestore() }
  })

  it('honors cancellation while entering readiness and still removes partial resources', async () => {
    const fixture = await artifactFixture()
    const sockets = await temporaryDirectory('cancelled')
    const engine = track(new SocketDockerEngine(sockets))
    const supervisor = createSupervisor(engine, fixture.root, sockets)
    const controller = new AbortController()
    controller.abort(new Error('CALLER_CANCELLED'))

    await expect(supervisor.start({
      preview_id: 'preview-cancelled', artifact_relative_path: 'run', artifact_sha256: await hashTree(fixture.source), owner_email: 'owner@example.test',
    }, controller.signal)).rejects.toThrow('CALLER_CANCELLED')
    expect(engine.managedRow).toBeUndefined()
  })

  it('redacts diagnostic email and access code when startup fails, even if one log source is unavailable', async () => {
    const fixture = await artifactFixture()
    const sockets = await temporaryDirectory('diagnostics')
    const engine = track(new SocketDockerEngine(sockets))
    engine.failRuntimeStart = true
    engine.failProxyLogs = true
    const diagnostics: Array<{ role: 'runtime' | 'proxy'; output: string }> = []
    const supervisor = createSupervisor(engine, fixture.root, sockets, { diagnosticSink: entry => diagnostics.push(entry) })

    await expect(supervisor.start({
      preview_id: 'preview-06', artifact_relative_path: 'run', artifact_sha256: await hashTree(fixture.source), owner_email: 'owner@example.test',
    }, new AbortController().signal)).rejects.toThrow('RUNTIME_START_FAILED')
    expect(diagnostics).toEqual([{ role: 'runtime', output: 'owner=[email] code=[code]' }])
  })

  it('fails closed when cleanup reports any error even after all known resources disappear', async () => {
    const sockets = await temporaryDirectory('cleanup')
    const engine = track(new SocketDockerEngine(sockets))
    const runtimeRef = 'pv_2123456789abcdef0123456789abcdef'
    engine.seedRuntime('preview-07', runtimeRef)
    engine.failStopOnce = true
    const supervisor = createSupervisor(engine, '/srv/artifacts', sockets)

    await expect(supervisor.stop(runtimeRef, new AbortController().signal)).rejects.toThrow('RUNTIME_CLEANUP_INCOMPLETE')
    expect(engine.managedRow).toBeUndefined()
  })

  it('rejects unpinned images, unsafe roots/mounts/users and out-of-range resource limits', async () => {
    const sockets = '/run/dz23-preview-proxies'
    const engine = new SocketDockerEngine(sockets)
    engine.wrongImage = true
    const supervisor = createSupervisor(engine, '/srv/artifacts', sockets)
    await expect(supervisor.preflight(new AbortController().signal)).rejects.toThrow('PINNED_IMAGE_NOT_PRESENT')

    const base = options(engine, '/srv/artifacts', sockets)
    for (const override of [
      { runtimeImageDigest: 'sha256:no' }, { instanceId: 'UPPER' }, { artifactRoot: 'relative' },
      { proxySocketMount: { type: 'volume', source: '..' } }, { proxySocketMount: { type: 'bind', source: 'relative' } },
      { proxyUser: 'root' }, { limits: { memoryBytes: 1 } }, { limits: { nanoCpus: Number.NaN } }, { limits: { pids: 1_025 } },
    ] as const) {
      expect(() => new DockerPreviewSupervisor({ ...base, ...override } as DockerPreviewSupervisorOptions)).toThrow()
    }
  })
})

class SocketDockerEngine {
  readonly containers: Array<{ name: string; body: Record<string, unknown> }> = []
  readonly dataRequests: Array<Record<string, unknown>> = []
  extraRows: Record<string, unknown>[] = []
  managedRow: Record<string, unknown> | undefined
  forwardHealth = 200
  messagePayload: unknown = { messages: Array.from({ length: 25 }, (_, index) => ({
    kind: 'code', email: 'owner@example.test', code: String(index).padStart(6, '0'), expiresAt: '2030-01-01T00:00:00.000Z',
  })) }
  rawResponse: Buffer | undefined
  httpStatus = 200
  failRuntimeStart = false
  failProxyLogs = false
  failStopOnce = false
  wrongImage = false
  inspectProxyFailure = false
  #servers = new Map<string, Server>()
  #runtimeName: string | undefined
  #proxyName: string | undefined

  constructor(readonly socketRoot: string) {}
  async ping(): Promise<void> {}
  async inspectImage(digest: string): Promise<{ Id: string }> { return { Id: this.wrongImage ? `sha256:${'f'.repeat(64)}` : digest } }
  async createVolume(): Promise<void> {}
  async createNetwork(): Promise<string> { return 'c'.repeat(64) }
  async listNetworks(): Promise<readonly Record<string, unknown>[]> { return [] }
  async removeNetwork(): Promise<void> {}
  async removeVolume(): Promise<void> {}
  async listVolumes(): Promise<readonly Record<string, unknown>[]> { return [] }
  async putArchive(): Promise<void> {}
  async createContainer(name: string, body: unknown): Promise<string> {
    const parsed = asRecord(body)
    this.containers.push({ name, body: parsed })
    const containerRole = asRecord(parsed.Labels)['dz23.role']
    if (containerRole === 'runtime') { this.#runtimeName = name; this.managedRow = { Labels: parsed.Labels } }
    if (containerRole === 'proxy') this.#proxyName = name
    return 'd'.repeat(64)
  }
  async startContainer(name: string): Promise<void> {
    if (name === this.#runtimeName && this.failRuntimeStart) throw new Error('RUNTIME_START_FAILED')
    if (name === this.#proxyName) {
      const runtimeRef = String(asRecord(this.containers.find(row => row.name === name)?.body.Labels)['dz23.runtime_ref'])
      await this.openProxy(runtimeRef)
    }
  }
  async listContainers(filters: Readonly<Record<string, readonly string[]>> = {}): Promise<readonly Record<string, unknown>[]> {
    const scopedToRuntime = (filters.label ?? []).some(label => label.startsWith('dz23.runtime_ref='))
    return [...(this.managedRow === undefined ? [] : [this.managedRow]), ...(scopedToRuntime ? [] : this.extraRows)]
  }
  async stopContainer(): Promise<void> { if (this.failStopOnce) { this.failStopOnce = false; throw new Error('STOP_FAILED') } }
  async removeContainer(name: string): Promise<void> {
    if (name === this.#runtimeName || name.startsWith('dz23-pv-app-')) this.managedRow = undefined
    if (name === this.#proxyName || name.startsWith('dz23-pv-proxy-')) await this.closeProxy()
  }
  async inspectContainer(name: string): Promise<Record<string, unknown>> {
    if (this.inspectProxyFailure && name.includes('proxy')) throw new Error('INSPECT_UNAVAILABLE')
    return { State: { Status: 'exited', ExitCode: 1 } }
  }
  async containerLogs(name: string): Promise<string> {
    if (name.includes('proxy') && this.failProxyLogs) throw new Error('LOGS_UNAVAILABLE')
    return 'owner=owner@example.test code=123456'
  }
  seedRuntime(previewId: string, runtimeRef: string): void {
    this.managedRow = { Labels: { 'dz23.preview_id': previewId, 'dz23.runtime_ref': runtimeRef, 'dz23.role': 'runtime' } }
  }
  async openProxy(runtimeRef: string): Promise<void> {
    if (this.#servers.has(runtimeRef)) return
    await mkdir(this.socketRoot, { recursive: true })
    const socketPath = join(this.socketRoot, `${runtimeRef}.sock`)
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      request.on('end', () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        this.dataRequests.push(parsed)
        response.statusCode = this.httpStatus
        if (this.rawResponse !== undefined) { response.end(this.rawResponse); return }
        if (parsed.operation === 'verification-messages') { response.end(JSON.stringify(this.messagePayload)); return }
        const body = asRecord(parsed.body)
        if (body.path === '/') { response.end(JSON.stringify({ status: this.forwardHealth, headers: {}, body_base64: '' })); return }
        response.end(JSON.stringify({ status: 201, headers: { 'content-type': 'text/plain' }, body_base64: Buffer.from('ok').toString('base64') }))
      })
    })
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => { server.off('error', reject); resolveListen() })
    })
    this.#servers.set(runtimeRef, server)
  }
  async close(): Promise<void> { await this.closeProxy() }
  async closeProxy(): Promise<void> {
    const servers = [...this.#servers.values()]
    this.#servers.clear()
    await Promise.all(servers.map(server => new Promise<void>(resolveClose => server.close(() => resolveClose()))))
  }
}

function track(engine: SocketDockerEngine): SocketDockerEngine { engines.push(engine); return engine }
function createSupervisor(engine: SocketDockerEngine, artifactRoot: string, socketRoot: string, extra: Partial<DockerPreviewSupervisorOptions> = {}): DockerPreviewSupervisor {
  return new DockerPreviewSupervisor({ ...options(engine, artifactRoot, socketRoot), ...extra })
}
function options(engine: SocketDockerEngine, artifactRoot: string, socketRoot: string): DockerPreviewSupervisorOptions {
  return {
    engine: engine as unknown as DockerEngine, artifactRoot, proxySocketRoot: socketRoot,
    proxySocketMount: { type: 'bind', source: socketRoot }, runtimeImageDigest: RUNTIME_IMAGE,
    proxyImageDigest: PROXY_IMAGE, instanceId: 'coverage-instance', proxyUser: '10002:10003',
  }
}
function asRecord(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {} }

async function artifactFixture(): Promise<{ root: string; source: string }> {
  const parent = await temporaryDirectory('artifact')
  const root = join(parent, 'artifacts'); const source = join(root, 'run')
  await mkdir(join(source, '.next', 'standalone'), { recursive: true })
  await mkdir(join(source, '.next', 'static'), { recursive: true })
  await writeFile(join(source, '.next', 'standalone', 'server.js'), 'server')
  await writeFile(join(source, '.next', 'static', 'app.js'), 'static')
  return { root, source }
}
async function temporaryDirectory(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `dz23-manager-${name}-`)); temporaryRoots.push(path); return path
}
