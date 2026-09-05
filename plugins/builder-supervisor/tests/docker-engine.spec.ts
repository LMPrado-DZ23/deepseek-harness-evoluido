import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { link, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { demultiplexDockerStream, DockerEngine } from '../src/docker-engine.js'

const linux = process.platform === 'linux' ? describe : describe.skip
const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))))

linux('Docker Engine Unix transport', () => {
  it('uses the real Unix HTTP transport, fixed paths and JSON bodies', async () => {
    const calls: Array<{ method: string | undefined; url: string | undefined; body: string }> = []
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

  it('streams archive to a caller-owned descriptor and hashes it under cap/deadline', async () => {
    const payload = Buffer.from('streamed-archive')
    const fixture = await daemon(async (request, response) => {
      if (request.url?.includes('slow')) return
      response.writeHead(200); response.write(payload.subarray(0, 3)); setImmediate(() => response.end(payload.subarray(3)))
    })
    const root = await mkdtemp(join(tmpdir(), 'dz23-engine-')); roots.push(root); const engine = new DockerEngine(fixture.socket, 1_000)
    const target = join(root, 'ok.tar'); await expect(download(engine, 'id', '/workspace/.', target, 100, new AbortController().signal)).resolves.toEqual({ bytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex') })
    expect(await readFile(target)).toEqual(payload)
    const capped = join(root, 'capped.tar'); await expect(download(engine, 'id', '/workspace/.', capped, 2, new AbortController().signal)).rejects.toThrow('DOCKER_RESPONSE_TOO_LARGE')
    const slow = join(root, 'slow.tar'); await expect(download(new DockerEngine(fixture.socket, 5), 'slow', '/slow', slow, 100, AbortSignal.timeout(30))).rejects.toThrow()
    const occupied = await open(join(root, 'occupied.tar'), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600); await occupied.writeFile('x'); await expect(engine.downloadArchive('id', '/', occupied, 100, new AbortController().signal)).rejects.toThrow('INVALID_ARCHIVE'); await occupied.close()
    const actual = await open(join(root, 'identity.tar'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); let stats = 0
    const changed = new Proxy(actual, { get(target, property) { if (property === 'stat') return async () => { const value = await target.stat(); return ++stats === 1 ? value : new Proxy(value, { get(row, key) { return key === 'ino' ? row.ino + 1 : Reflect.get(row, key, row) } }) }; const member = Reflect.get(target, property, target); return typeof member === 'function' ? member.bind(target) : member } }) as FileHandle
    await expect(engine.downloadArchive('id', '/', changed, 100, new AbortController().signal)).rejects.toThrow('INVALID_ARCHIVE'); await actual.close()
    await fixture.close()
  })

  it('demultiplexes stdout/stderr and rejects truncated, oversized or alien frames', () => {
    const stream = Buffer.concat([frame(1, 'out'), frame(2, 'err')]); expect(demultiplexDockerStream(stream)).toEqual({ stdout: Buffer.from('out'), stderr: Buffer.from('err') })
    expect(() => demultiplexDockerStream(stream.subarray(0, -1))).toThrow('INVALID_DOCKER_LOG_STREAM')
    expect(() => demultiplexDockerStream(Buffer.from([3, 0, 0, 0, 0, 0, 0, 0]))).toThrow('INVALID_DOCKER_LOG_STREAM')
    expect(() => demultiplexDockerStream(frame(1, 'long'), 3)).toThrow('INVALID_DOCKER_LOG_STREAM')
    expect(() => demultiplexDockerStream(Buffer.concat([frame(1, 'abc'), frame(2, 'def')]), 5)).toThrow('DOCKER_RESPONSE_TOO_LARGE')
    expect(() => demultiplexDockerStream(Buffer.alloc(7))).toThrow('INVALID_DOCKER_LOG_STREAM')
    const reserved = frame(1, 'x'); reserved[1] = 1; expect(() => demultiplexDockerStream(reserved)).toThrow('INVALID_DOCKER_LOG_STREAM')
  })

  it('enforces the combined output budget while the Docker log stream is still live', async () => {
    const fixture = await daemon((_request, response) => { response.writeHead(200); response.write(frame(1, '123456')); /* deliberately never ends */ })
    const engine = new DockerEngine(fixture.socket, 1_000)
    await expect(engine.containerLogs('live', 5, new AbortController().signal)).rejects.toThrow('DOCKER_RESPONSE_TOO_LARGE')
    await fixture.close()
  })

  it('decodes Docker frames split across transport chunks', async () => {
    const payload = Buffer.concat([frame(1, 'out'), frame(2, 'err')])
    const fixture = await daemon((_request, response) => { response.writeHead(200); for (const byte of payload) response.write(Buffer.from([byte])); response.end() })
    await expect(new DockerEngine(fixture.socket, 1_000).containerLogs('split', 100, new AbortController().signal)).resolves.toEqual({ stdout: Buffer.from('out'), stderr: Buffer.from('err') })
    await fixture.close()
  })

  it('lets caller deadlines govern long wait, log and archive streams instead of the short control timeout', async () => {
    const archive = Buffer.from('delayed archive'); const fixture = await daemon((request, response) => {
      response.writeHead(200)
      setTimeout(() => response.end(request.url?.includes('/wait') ? JSON.stringify({ StatusCode: 0 }) : request.url?.includes('/logs') ? frame(1, 'late') : archive), 30)
    })
    const root = await mkdtemp(join(tmpdir(), 'dz23-engine-long-')); roots.push(root); const engine = new DockerEngine(fixture.socket, 5); const signal = AbortSignal.timeout(250)
    await expect(engine.waitContainer('long', signal)).resolves.toEqual({ StatusCode: 0 })
    await expect(engine.containerLogs('long', 100, signal)).resolves.toEqual({ stdout: Buffer.from('late'), stderr: Buffer.alloc(0) })
    await expect(download(engine, 'long', '/workspace/.', join(root, 'long.tar'), 100, signal)).resolves.toMatchObject({ bytes: archive.byteLength })
    await fixture.close()
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
    const engine = new DockerEngine(fixture.socket, 1_000); const signal = new AbortController().signal; const archiveRoot = await mkdtemp(join(tmpdir(), 'dz23-put-')); roots.push(archiveRoot); const archive = join(archiveRoot, 'input.tar'); await writeFile(archive, Buffer.alloc(512))
    await expect(engine.inspectImage(`sha256:${'a'.repeat(64)}`, signal)).resolves.toMatchObject({ Id: expect.stringMatching(/^sha256:/u) })
    await expect(engine.listVolumes({ label: ['x=y'] }, signal)).resolves.toHaveLength(1)
    await expect(engine.listContainers({ label: ['x=y'] }, signal)).resolves.toHaveLength(1)
    const id = await engine.createContainer('one', {}, signal); await engine.putArchive(id, '/workspace', archive, 512, signal); await engine.startContainer(id, signal)
    await expect(engine.waitContainer(id, signal)).resolves.toEqual({ StatusCode: 0 }); await expect(engine.containerLogs(id, 100, signal)).resolves.toEqual({ stdout: Buffer.from('out'), stderr: Buffer.from('err') })
    await engine.stopContainer(id, signal); await engine.removeContainer(id, signal); await engine.removeVolume('one', signal); await fixture.close()
    expect(() => new DockerEngine('relative')).toThrow('INVALID_DOCKER_SOCKET'); expect(() => new DockerEngine('/tmp/docker.sock', 0)).toThrow('INVALID_DOCKER_TIMEOUT')
  })

  it('fails closed for invalid limits, files, statuses, JSON and daemon DTOs', async () => {
    const fixture = await daemon((request, response) => {
      if (request.url === '/_ping') return reply(response, 500, 'bad')
      if (request.url?.includes('bad-status')) return reply(response, 500, 'bad')
      if (request.url?.includes('bad-json')) return reply(response, 200, '{')
      if (request.url?.includes('bad-create')) return reply(response, 201, JSON.stringify({ Id: '../bad' }))
      if (request.url?.includes('bad-wait')) return reply(response, 200, JSON.stringify({ StatusCode: 'zero' }))
      if (request.url?.includes('/logs')) return reply(response, 503, '')
      if (request.url?.includes('/archive')) return reply(response, 503, '')
      return reply(response, 200, JSON.stringify({ Volumes: null }))
    })
    const root = await mkdtemp(join(tmpdir(), 'dz23-engine-invalid-')); roots.push(root); const engine = new DockerEngine(fixture.socket, 100); const signal = new AbortController().signal
    const empty = join(root, 'empty.tar'); await writeFile(empty, '')
    await expect(engine.putArchive('one', '/', empty, 0, signal)).rejects.toThrow('INVALID_ARCHIVE_LIMIT')
    await expect(engine.putArchive('one', '/', empty, 1, signal)).rejects.toThrow('INVALID_ARCHIVE')
    await expect(engine.containerLogs('one', 0, signal)).rejects.toThrow('INVALID_LOG_LIMIT')
    await expect(engine.containerLogs('one', 1, signal)).rejects.toThrow('DOCKER_STATUS_503')
    await expect(download(engine, 'one', '/', join(root, 'bad-limit'), 0, signal)).rejects.toThrow('INVALID_ARCHIVE_LIMIT')
    await expect(download(engine, 'one', '/', join(root, 'bad-download'), 1, signal)).rejects.toThrow('DOCKER_STATUS_503')
    await expect(engine.ping(AbortSignal.timeout(100))).rejects.toThrow('DOCKER_STATUS_500')
    await expect(engine.inspectImage('bad-json', signal)).rejects.toThrow('INVALID_DOCKER_RESPONSE')
    await expect(engine.createContainer('bad-create', {}, signal)).rejects.toThrow('INVALID_DOCKER_RESPONSE')
    await expect(engine.waitContainer('bad-wait', signal)).rejects.toThrow('INVALID_DOCKER_RESPONSE')
    await expect(engine.listVolumes({}, signal)).resolves.toEqual([])
    await expect(engine.listContainers({}, signal)).resolves.toEqual([])
    await fixture.close()
    expect(() => new DockerEngine('\\bad')).toThrow('INVALID_DOCKER_SOCKET')
    expect(() => new DockerEngine('/tmp/bad\0sock')).toThrow('INVALID_DOCKER_SOCKET')
  })

  it('validates every archive source invariant and Docker upload response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-put-invalid-')); roots.push(root); const file = join(root, 'one.tar'); const upload = join(root, 'upload.tar'); await writeFile(file, '12'); await writeFile(upload, '12')
    const directory = join(root, 'directory'); await mkdir(directory); const linked = join(root, 'linked.tar'); await link(file, linked); const symbolic = join(root, 'symbolic.tar'); await symlink(file, symbolic)
    const signal = new AbortController().signal
    const ok = await daemon((_request, response) => reply(response, 200, ''))
    const engine = new DockerEngine(ok.socket, 100)
    await expect(engine.putArchive('one', '/', directory, 10, signal)).rejects.toThrow('INVALID_ARCHIVE')
    await expect(engine.putArchive('one', '/', linked, 10, signal)).rejects.toThrow('INVALID_ARCHIVE')
    await expect(engine.putArchive('one', '/', symbolic, 10, signal)).rejects.toThrow()
    await expect(engine.putArchive('one', '/', upload, 1, signal)).rejects.toThrow('INVALID_ARCHIVE')
    await ok.close()
    const badStatus = await daemon((_request, response) => reply(response, 503, ''))
    await expect(new DockerEngine(badStatus.socket, 100).putArchive('one', '/', upload, 10, signal)).rejects.toThrow('DOCKER_STATUS_503'); await badStatus.close()
    const incomplete = await daemon((_request, response) => { response.writeHead(200); response.write('x'); response.socket?.destroy() })
    await expect(new DockerEngine(incomplete.socket, 100).putArchive('one', '/', upload, 10, signal)).rejects.toThrow(); await incomplete.close()
  })

  it('rejects malformed live frames, incomplete streams and oversized control responses', async () => {
    const invalidFrame = await daemon((_request, response) => { const value = frame(1, 'x'); value[2] = 1; response.writeHead(200); response.end(value) })
    await expect(new DockerEngine(invalidFrame.socket, 100).containerLogs('one', 10, new AbortController().signal)).rejects.toThrow('INVALID_DOCKER_LOG_STREAM'); await invalidFrame.close()
    const incompleteLogs = await daemon((_request, response) => { response.writeHead(200); response.write(frame(1, 'x')); response.socket?.destroy() })
    await expect(new DockerEngine(incompleteLogs.socket, 100).containerLogs('one', 10, new AbortController().signal)).rejects.toThrow(); await incompleteLogs.close()
    const huge = await daemon((_request, response) => { response.writeHead(200); response.end(Buffer.alloc(8 * 1024 * 1024 + 1)) })
    await expect(new DockerEngine(huge.socket, 1_000).ping(new AbortController().signal)).rejects.toThrow('DOCKER_RESPONSE_TOO_LARGE'); await huge.close()
  })

  it('fails closed on zero-byte archive writes to the caller-owned descriptor', async () => {
    const fixture = await daemon((_request, response) => { response.writeHead(200); response.end('archive') })
    const runtime = {
      request: httpRequest,
      open: (async () => ({
        write: async () => ({ bytesWritten: 0, buffer: Buffer.alloc(0) }), sync: async () => undefined, close: async () => undefined,
      })) as unknown as typeof open,
      remove: rm,
      noFollowFlag: constants.O_NOFOLLOW,
    }
    const handle = { stat: async () => ({ isFile: () => true, nlink: 1, size: 0, dev: 1, ino: 1 }), write: async () => ({ bytesWritten: 0, buffer: Buffer.alloc(0) }), sync: async () => undefined } as unknown as FileHandle
    await expect(new DockerEngine(fixture.socket, 100, runtime).downloadArchive('one', '/', handle, 100, new AbortController().signal)).rejects.toThrow('DOCKER_ARCHIVE_WRITE_FAILED')
    await fixture.close()
  })

  it('rejects truncated and aborted live Docker responses', async () => {
    const fixture = await daemon((request, response) => {
      response.writeHead(200)
      if (request.url?.includes('/logs')) response.end(frame(1, 'x').subarray(0, -1))
      else { response.write('partial'); response.socket?.destroy() }
    })
    const root = await mkdtemp(join(tmpdir(), 'dz23-engine-abort-')); roots.push(root); const engine = new DockerEngine(fixture.socket, 100); const signal = new AbortController().signal
    await expect(engine.containerLogs('one', 100, signal)).rejects.toThrow('INVALID_DOCKER_LOG_STREAM')
    await expect(download(engine, 'one', '/', join(root, 'partial'), 100, signal)).rejects.toThrow()
    await expect(engine.ping(signal)).rejects.toThrow()
    await fixture.close()
  })

  it('fails closed for every adversarial Docker transport event ordering', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-engine-events-')); roots.push(root); const archive = join(root, 'input.tar'); await writeFile(archive, 'archive')
    const signal = new AbortController().signal
    const attempt = async (operation: (engine: DockerEngine) => Promise<unknown>, status: number | undefined, events: (response: PassThrough, request: PassThrough) => void, expected: string) => {
      const runtime = dockerRuntime(status, events)
      await expect(operation(new DockerEngine('/tmp/fake-docker.sock', 100, runtime))).rejects.toThrow(expected)
    }

    await attempt(engine => engine.putArchive('one', '/', archive, 100, signal), 200, (response) => { markComplete(response, false); response.emit('end') }, 'DOCKER_RESPONSE_ABORTED')
    await attempt(engine => engine.putArchive('one', '/', archive, 100, signal), undefined, (response) => { markComplete(response, true); response.emit('end') }, 'DOCKER_STATUS_0')
    await attempt(engine => engine.putArchive('one', '/', archive, 100, signal), 200, (response) => { markComplete(response, true); response.emit('error', 'transport'); response.emit('end'); response.emit('aborted') }, 'transport')

    await attempt(engine => engine.containerLogs('one', 100, signal), undefined, response => response.emit('end'), 'DOCKER_STATUS_0')
    await attempt(engine => engine.containerLogs('one', 100, signal), 200, response => { response.emit('data', new Uint8Array(frame(1, 'text'))); markComplete(response, false); response.emit('end') }, 'DOCKER_RESPONSE_ABORTED')
    await attempt(engine => engine.containerLogs('one', 100, signal), 200, response => { markComplete(response, true); response.emit('error', new Error('log failed')); response.emit('data', frame(1, 'ignored')); response.emit('end'); response.emit('aborted') }, 'log failed')

    await attempt(engine => download(engine, 'one', '/', join(root, 'incomplete.tar'), 100, signal), 200, response => { markComplete(response, false); response.emit('end') }, 'DOCKER_RESPONSE_ABORTED')
    await attempt(engine => download(engine, 'one', '/', join(root, 'status.tar'), 100, signal), undefined, response => response.emit('end'), 'DOCKER_STATUS_0')
    await attempt(engine => download(engine, 'one', '/', join(root, 'aborted.tar'), 100, signal), 200, response => { response.emit('data', 'text'); response.emit('aborted'); response.emit('error', new Error('later')) }, 'DOCKER_RESPONSE_ABORTED')
    await attempt(engine => download(engine, 'one', '/', join(root, 'race.tar'), 100, signal), 200, response => { markComplete(response, true); response.emit('end'); response.emit('error', new Error('race')) }, 'race')

    await attempt(engine => engine.ping(signal), 200, response => { markComplete(response, false); response.emit('end') }, 'DOCKER_RESPONSE_ABORTED')
    await attempt(engine => engine.ping(signal), undefined, response => { markComplete(response, true); response.emit('end') }, 'DOCKER_STATUS_0')
    await attempt(engine => engine.ping(signal), 200, response => { response.emit('data', 'text'); response.emit('aborted'); response.emit('error', new Error('later')); markComplete(response, true); response.emit('end') }, 'DOCKER_RESPONSE_ABORTED')
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
function markComplete(response: PassThrough, complete: boolean): void { Object.defineProperty(response, 'complete', { configurable: true, value: complete }) }
function dockerRuntime(status: number | undefined, events: (response: PassThrough, request: PassThrough) => void) {
  return {
    request: ((options: unknown, callback: (response: IncomingMessage) => void) => {
      void options
      const request = new PassThrough(); request.on('error', () => undefined)
      const response = new PassThrough(); Object.defineProperty(response, 'statusCode', { configurable: true, value: status }); markComplete(response, true)
      callback(response as unknown as IncomingMessage); setImmediate(() => events(response, request))
      return request
    }) as unknown as typeof httpRequest,
    open,
    remove: rm,
    noFollowFlag: constants.O_NOFOLLOW,
  }
}

async function download(engine: DockerEngine, container: string, source: string, path: string, maximumBytes: number, signal: AbortSignal) {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try { return await engine.downloadArchive(container, source, handle, maximumBytes, signal) } finally { await handle.close() }
}
