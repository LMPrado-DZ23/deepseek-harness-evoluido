import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DockerEngine } from '../src/docker-engine.js'

interface CapturedRequest {
  readonly method: string | undefined
  readonly path: string | undefined
  readonly headers: IncomingMessage['headers']
  readonly body: Buffer
}

interface FakeDocker {
  readonly engine: DockerEngine
  readonly server: Server
  readonly socketPath: string
  readonly requests: CapturedRequest[]
}

const servers: Server[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fakeDocker(
  handler: (request: CapturedRequest, response: ServerResponse, incoming: IncomingMessage) => void | Promise<void>,
): Promise<FakeDocker> {
  const root = await mkdtemp(join(tmpdir(), 'dz23-docker-engine-'))
  roots.push(root)
  const socketPath = join(root, 'docker.sock').replaceAll('\\', '/')
  const requests: CapturedRequest[] = []
  const server = createServer((incoming, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      const captured: CapturedRequest = {
        method: incoming.method, path: incoming.url, headers: incoming.headers, body: Buffer.concat(chunks),
      }
      requests.push(captured)
      await handler(captured, response, incoming)
    })().catch(error => {
      if (!response.writableEnded) {
        response.writeHead(500)
        response.end(String(error))
      }
    })
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => { server.off('error', reject); resolve() })
  })
  return { engine: new DockerEngine({ socketPath }), server, socketPath, requests }
}

function reply(response: ServerResponse, status: number, body: string | Buffer | object = ''): void {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  response.writeHead(status, { 'content-type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json' : 'text/plain' })
  response.end(payload)
}

const describeUnix = describe.skipIf(process.platform === 'win32')

describe('DockerEngine configuration', () => {
  it.each(['', 'relative.sock', 'http://127.0.0.1/docker.sock', '/run/docker\\sock', '/run/docker.sock\0hidden'])('rejects unsafe socket path %j', socketPath => {
    expect(() => new DockerEngine({ socketPath })).toThrowError('INVALID_DOCKER_SOCKET')
  })
})

describeUnix('DockerEngine over a fake Unix-socket daemon', () => {
  it('covers every public method with encoded paths, typed payloads and accepted idempotent statuses', async () => {
    const replies: Array<readonly [number, string | Buffer | object]> = [
      [200, 'OK'],
      [200, { Id: 'sha256:image-id' }],
      [201, { Id: 'a'.repeat(12) }],
      [200, [{ Id: 'network-one' }]],
      [404, 'missing'],
      [201, { Name: 'volume-one' }],
      [200, { Volumes: [{ Name: 'volume-one' }] }],
      [204, ''],
      [201, { Id: 'b'.repeat(64) }],
      [200, ''],
      [304, ''],
      [200, { Id: 'container-inspected', State: { Running: true } }],
      [404, Buffer.from([0x00, 0x41, 0x7f, 0x0a])],
      [404, ''],
      [404, ''],
      [200, [{ Id: 'managed-one', Labels: { 'dz23.managed': 'preview' } }]],
    ]
    const fake = await fakeDocker((_request, response) => {
      const next = replies.shift()
      if (next === undefined) throw new Error('unexpected request')
      reply(response, next[0], next[1])
    })
    const signal = new AbortController().signal
    const labels = { 'dz23.managed': 'preview', 'dz23.preview_id': 'preview-01' }
    const archive = Buffer.from('tar-fixture')
    const filters = { label: ['dz23.managed=preview', 'dz23.preview_id=preview-01'] }

    await expect(fake.engine.ping(signal)).resolves.toBeUndefined()
    await expect(fake.engine.inspectImage('sha256:image/with-slash', signal)).resolves.toEqual({ Id: 'sha256:image-id' })
    await expect(fake.engine.createNetwork('network-one', labels, signal)).resolves.toBe('a'.repeat(12))
    await expect(fake.engine.listNetworks(filters, signal)).resolves.toEqual([{ Id: 'network-one' }])
    await expect(fake.engine.removeNetwork('network/id', signal)).resolves.toBeUndefined()
    await expect(fake.engine.createVolume('volume-one', labels, signal)).resolves.toBeUndefined()
    await expect(fake.engine.listVolumes(filters, signal)).resolves.toEqual([{ Name: 'volume-one' }])
    await expect(fake.engine.removeVolume('volume/name', signal)).resolves.toBeUndefined()
    await expect(fake.engine.createContainer('container/name', { Image: 'pinned@sha256:digest' }, signal)).resolves.toBe('b'.repeat(64))
    await expect(fake.engine.putArchive('container/id', '/app/data', archive, signal)).resolves.toBeUndefined()
    await expect(fake.engine.startContainer('container/id', signal)).resolves.toBeUndefined()
    await expect(fake.engine.inspectContainer('container/id', signal)).resolves.toEqual({ Id: 'container-inspected', State: { Running: true } })
    await expect(fake.engine.containerLogs('container/id', signal)).resolves.toBe('A\n')
    await expect(fake.engine.stopContainer('container/id', signal)).resolves.toBeUndefined()
    await expect(fake.engine.removeContainer('container/id', signal)).resolves.toBeUndefined()
    await expect(fake.engine.listContainers(filters, signal)).resolves.toEqual([
      { Id: 'managed-one', Labels: { 'dz23.managed': 'preview' } },
    ])

    expect(replies).toEqual([])
    expect(fake.requests.map(request => [request.method, request.path])).toEqual([
      ['GET', '/_ping'],
      ['GET', '/images/sha256%3Aimage%2Fwith-slash/json'],
      ['POST', '/networks/create'],
      ['GET', `/networks?filters=${encodeURIComponent(JSON.stringify(filters))}`],
      ['DELETE', '/networks/network%2Fid'],
      ['POST', '/volumes/create'],
      ['GET', `/volumes?filters=${encodeURIComponent(JSON.stringify(filters))}`],
      ['DELETE', '/volumes/volume%2Fname?force=1'],
      ['POST', '/containers/create?name=container%2Fname'],
      ['PUT', '/containers/container%2Fid/archive?path=%2Fapp%2Fdata'],
      ['POST', '/containers/container%2Fid/start'],
      ['GET', '/containers/container%2Fid/json'],
      ['GET', '/containers/container%2Fid/logs?stdout=1&stderr=1&tail=80'],
      ['POST', '/containers/container%2Fid/stop?t=5'],
      ['DELETE', '/containers/container%2Fid?force=1&v=0'],
      ['GET', `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify(filters))}`],
    ])
    expect(JSON.parse(fake.requests[2]!.body.toString('utf8'))).toEqual({
      Name: 'network-one', CheckDuplicate: true, Internal: true, Attachable: false, Labels: labels,
    })
    expect(fake.requests[2]!.headers['content-type']).toBe('application/json')
    expect(fake.requests[9]!.headers['content-type']).toBe('application/x-tar')
    expect(fake.requests[9]!.body).toEqual(archive)
  })

  it('rejects an unexpected Docker status without exposing its response body', async () => {
    const fake = await fakeDocker((_request, response) => reply(response, 500, 'daemon secret detail'))
    const error: Error = await fake.engine.ping(new AbortController().signal).then(
      () => { throw new Error('EXPECTED_REJECTION') },
      value => value as Error,
    )
    expect(error.message).toBe('DOCKER_STATUS_500')
    expect(error.message).not.toContain('secret')
  })

  it('rejects malformed JSON and invalid daemon identifiers fail-closed', async () => {
    const replies = [
      [200, '{'] as const,
      [201, { Id: '../invalid-network' }] as const,
      [201, { Id: 'short' }] as const,
    ]
    const fake = await fakeDocker((_request, response) => {
      const next = replies.shift()
      if (next === undefined) throw new Error('unexpected request')
      reply(response, next[0], next[1])
    })
    const signal = new AbortController().signal

    await expect(fake.engine.inspectImage('sha256:image', signal)).rejects.toThrowError('INVALID_DOCKER_RESPONSE')
    await expect(fake.engine.createNetwork('network', {}, signal)).rejects.toThrowError('INVALID_DOCKER_RESPONSE')
    await expect(fake.engine.createContainer('container', {}, signal)).rejects.toThrowError('INVALID_DOCKER_RESPONSE')
  })

  it('rejects a response larger than 8 MiB without returning partial bytes', async () => {
    const fake = await fakeDocker((_request, response) => reply(response, 200, Buffer.alloc(8 * 1024 * 1024 + 1, 0x61)))
    await expect(fake.engine.containerLogs('container', new AbortController().signal)).rejects.toThrowError('DOCKER_RESPONSE_TOO_LARGE')
  }, 15_000)

  it('does not contact the daemon when already aborted', async () => {
    const hit = vi.fn()
    const fake = await fakeDocker((_request, response) => { hit(); response.end() })
    const controller = new AbortController()
    controller.abort()

    await expect(fake.engine.ping(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(hit).not.toHaveBeenCalled()
  })

  it('aborts an in-flight daemon request through the caller AbortSignal', async () => {
    let reached!: () => void
    const requestReached = new Promise<void>(resolve => { reached = resolve })
    const fake = await fakeDocker((_request, _response, incoming) => {
      reached()
      incoming.once('close', () => undefined)
    })
    const controller = new AbortController()
    const pending = fake.engine.ping(controller.signal)
    await requestReached
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
