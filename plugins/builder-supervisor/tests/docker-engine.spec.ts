import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { demultiplexDockerStream, DockerEngine } from '../src/docker-engine.js'

const linux = process.platform === 'linux' ? describe : describe.skip
const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))))

linux('Docker Engine Unix transport', () => {
  it('uses the real Unix HTTP transport, fixed paths and JSON bodies', async () => {
    const calls: Array<{ method?: string; url?: string; body: string }> = []
    const fixture = await daemon(async (request, response) => {
      const body = await collect(request); calls.push({ method: request.method, url: request.url, body: body.toString() })
      if (request.url === '/_ping') return reply(response, 200, 'OK')
      if (request.url?.startsWith('/volumes/create')) return reply(response, 201, '{}')
      if (request.url?.startsWith('/containers/create')) return reply(response, 201, JSON.stringify({ Id: 'a'.repeat(64) }))
      return reply(response, 204, '')
    })
    const engine = new DockerEngine(fixture.socket, 500); const signal = new AbortController().signal
    await engine.ping(signal); await engine.createVolume('safe', { a: 'b' }, { type: 'tmpfs', o: 'size=1' }, signal)
    await expect(engine.createContainer('safe', { Image: 'sha256:x' }, signal)).resolves.toBe('a'.repeat(64))
    expect(calls[1]).toMatchObject({ method: 'POST', url: '/volumes/create' }); expect(JSON.parse(calls[1]!.body)).toMatchObject({ Driver: 'local', DriverOpts: { type: 'tmpfs', o: 'size=1' } })
    await fixture.close()
  })

  it('streams archive to an exclusive descriptor, hashes it and removes partial files on cap/timeout', async () => {
    const payload = Buffer.from('streamed-archive')
    const fixture = await daemon(async (request, response) => {
      if (request.url?.includes('slow')) return
      response.writeHead(200); response.write(payload.subarray(0, 3)); setImmediate(() => response.end(payload.subarray(3)))
    })
    const root = await mkdtemp(join(tmpdir(), 'dz23-engine-')); roots.push(root); const engine = new DockerEngine(fixture.socket, 1_000)
    const target = join(root, 'ok.tar'); await expect(engine.downloadArchive('id', '/workspace/.', target, 100, new AbortController().signal)).resolves.toEqual({ bytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex') })
    expect(await readFile(target)).toEqual(payload)
    const capped = join(root, 'capped.tar'); await expect(engine.downloadArchive('id', '/workspace/.', capped, 2, new AbortController().signal)).rejects.toThrow('DOCKER_RESPONSE_TOO_LARGE'); await expect(access(capped)).rejects.toThrow()
    const slow = join(root, 'slow.tar'); await expect(new DockerEngine(fixture.socket, 30).downloadArchive('slow', '/slow', slow, 100, new AbortController().signal)).rejects.toThrow(); await expect(access(slow)).rejects.toThrow()
    await fixture.close()
  })

  it('demultiplexes stdout/stderr and rejects truncated, oversized or alien frames', () => {
    const stream = Buffer.concat([frame(1, 'out'), frame(2, 'err')]); expect(demultiplexDockerStream(stream)).toEqual({ stdout: Buffer.from('out'), stderr: Buffer.from('err') })
    expect(() => demultiplexDockerStream(stream.subarray(0, -1))).toThrow('INVALID_DOCKER_LOG_STREAM')
    expect(() => demultiplexDockerStream(Buffer.from([3, 0, 0, 0, 0, 0, 0, 0]))).toThrow('INVALID_DOCKER_LOG_STREAM')
    expect(() => demultiplexDockerStream(frame(1, 'long'), 3)).toThrow('INVALID_DOCKER_LOG_STREAM')
    expect(() => demultiplexDockerStream(Buffer.concat([frame(1, 'abc'), frame(2, 'def')]), 5)).toThrow('DOCKER_RESPONSE_TOO_LARGE')
  })

  it('covers every bounded Docker operation and rejects malformed daemon responses', async () => {
    const fixture = await daemon(async (request, response) => {
      if (request.url?.startsWith('/images/')) return reply(response, 200, JSON.stringify({ Id: `sha256:${'a'.repeat(64)}` }))
      if (request.url?.startsWith('/volumes?')) return reply(response, 200, JSON.stringify({ Volumes: [{ Name: 'one' }] }))
      if (request.url?.startsWith('/containers/json')) return reply(response, 200, JSON.stringify([{ Id: 'a'.repeat(12) }]))
      if (request.url?.includes('/wait')) return reply(response, 200, JSON.stringify({ StatusCode: 0 }))
      if (request.url?.includes('/logs')) { response.writeHead(200); response.end(Buffer.concat([frame(1, 'out'), frame(2, 'err')])); return }
      if (request.url?.startsWith('/containers/create')) return reply(response, 201, JSON.stringify({ Id: 'b'.repeat(12) }))
      if (request.method === 'PUT') return reply(response, 200, '')
      return reply(response, request.method === 'DELETE' ? 204 : 204, '')
    })
    const engine = new DockerEngine(fixture.socket, 1_000); const signal = new AbortController().signal
    await expect(engine.inspectImage(`sha256:${'a'.repeat(64)}`, signal)).resolves.toMatchObject({ Id: expect.stringMatching(/^sha256:/u) })
    await expect(engine.listVolumes({ label: ['x=y'] }, signal)).resolves.toHaveLength(1)
    await expect(engine.listContainers({ label: ['x=y'] }, signal)).resolves.toHaveLength(1)
    const id = await engine.createContainer('one', {}, signal); await engine.putArchive(id, '/workspace', Buffer.alloc(512), signal); await engine.startContainer(id, signal)
    await expect(engine.waitContainer(id, signal)).resolves.toEqual({ StatusCode: 0 }); await expect(engine.containerLogs(id, signal)).resolves.toEqual({ stdout: Buffer.from('out'), stderr: Buffer.from('err') })
    await engine.stopContainer(id, signal); await engine.removeContainer(id, signal); await engine.removeVolume('one', signal); await fixture.close()
    expect(() => new DockerEngine('relative')).toThrow('INVALID_DOCKER_SOCKET'); expect(() => new DockerEngine('/tmp/docker.sock', 0)).toThrow('INVALID_DOCKER_TIMEOUT')
  })
})

async function daemon(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void) {
  const root = await mkdtemp(join(tmpdir(), 'dz23-docker-engine-')); roots.push(root); const socket = join(root, 'docker.sock'); const server = createServer((request, response) => { void handler(request, response) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
  return { socket, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}
function frame(channel: 1 | 2, value: string): Buffer { const data = Buffer.from(value); const header = Buffer.alloc(8); header[0] = channel; header.writeUInt32BE(data.length, 4); return Buffer.concat([header, data]) }
async function collect(request: IncomingMessage): Promise<Buffer> { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks) }
function reply(response: ServerResponse, status: number, body: string): void { response.writeHead(status); response.end(body) }
