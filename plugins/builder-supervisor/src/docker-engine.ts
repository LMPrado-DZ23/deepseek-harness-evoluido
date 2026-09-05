import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import type { ReadStream } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { open, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import type { ClientRequest } from 'node:http'

const DEFAULT_RESPONSE_LIMIT = 8 * 1024 * 1024

export interface DockerEnginePort {
  ping(signal: AbortSignal): Promise<void>
  inspectImage(digest: string, signal: AbortSignal): Promise<{ readonly Id: string }>
  createVolume(name: string, labels: Readonly<Record<string, string>>, driverOpts: Readonly<Record<string, string>>, signal: AbortSignal): Promise<void>
  removeVolume(name: string, signal: AbortSignal): Promise<void>
  listVolumes(filters: Readonly<Record<string, readonly string[]>>, signal: AbortSignal): Promise<readonly Record<string, unknown>[]>
  createContainer(name: string, body: unknown, signal: AbortSignal): Promise<string>
  putArchive(container: string, destination: string, archivePath: string, maximumBytes: number, signal: AbortSignal): Promise<void>
  startContainer(id: string, signal: AbortSignal): Promise<void>
  waitContainer(id: string, signal: AbortSignal): Promise<{ readonly StatusCode: number }>
  containerLogs(id: string, maximumBytes: number, signal: AbortSignal): Promise<{ readonly stdout: Buffer; readonly stderr: Buffer }>
  downloadArchive(container: string, source: string, destination: FileHandle, maximumBytes: number, signal: AbortSignal): Promise<{ readonly bytes: number; readonly sha256: string }>
  stopContainer(id: string, signal: AbortSignal): Promise<void>
  removeContainer(id: string, signal: AbortSignal): Promise<void>
  listContainers(filters: Readonly<Record<string, readonly string[]>>, signal: AbortSignal): Promise<readonly Record<string, unknown>[]>
}

export interface DockerEngineRuntime {
  readonly request: typeof httpRequest
  readonly open: typeof open
  readonly remove: typeof rm
  readonly noFollowFlag: number
}
const DEFAULT_RUNTIME: DockerEngineRuntime = { request: httpRequest, open, remove: rm, noFollowFlag: constants.O_NOFOLLOW }

export class DockerEngine implements DockerEnginePort {
  constructor(private readonly socketPath: string, private readonly requestTimeoutMs = 30_000, private readonly runtime: DockerEngineRuntime = DEFAULT_RUNTIME) {
    if (!socketPath.startsWith('/') || socketPath.includes('\\') || socketPath.includes('\0')) throw new Error('INVALID_DOCKER_SOCKET')
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) throw new Error('INVALID_DOCKER_TIMEOUT')
  }

  async ping(signal: AbortSignal): Promise<void> { await this.#request('GET', '/_ping', undefined, signal, [200]) }
  async inspectImage(digest: string, signal: AbortSignal): Promise<{ readonly Id: string }> { return this.#json('GET', `/images/${encodeURIComponent(digest)}/json`, undefined, signal, [200]) }
  async createVolume(name: string, labels: Readonly<Record<string, string>>, driverOpts: Readonly<Record<string, string>>, signal: AbortSignal): Promise<void> { await this.#request('POST', '/volumes/create', { Name: name, Labels: labels, Driver: 'local', DriverOpts: driverOpts }, signal, [201]) }
  async removeVolume(name: string, signal: AbortSignal): Promise<void> { await this.#request('DELETE', `/volumes/${encodeURIComponent(name)}?force=1`, undefined, signal, [204, 404]) }
  async listVolumes(filters: Readonly<Record<string, readonly string[]>>, signal: AbortSignal): Promise<readonly Record<string, unknown>[]> {
    const result = await this.#json<{ readonly Volumes?: unknown }>('GET', `/volumes?filters=${encodeURIComponent(JSON.stringify(filters))}`, undefined, signal, [200])
    return Array.isArray(result.Volumes) ? result.Volumes.filter(isRecord) : []
  }
  async createContainer(name: string, body: unknown, signal: AbortSignal): Promise<string> {
    const result = await this.#json<{ readonly Id: unknown }>('POST', `/containers/create?name=${encodeURIComponent(name)}`, body, signal, [201])
    if (typeof result.Id !== 'string' || !/^[a-f0-9]{12,64}$/u.test(result.Id)) throw new Error('INVALID_DOCKER_RESPONSE')
    return result.Id
  }
  async putArchive(container: string, destination: string, archivePath: string, maximumBytes: number, signal: AbortSignal): Promise<void> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error('INVALID_ARCHIVE_LIMIT')
    const handle = await this.runtime.open(archivePath, constants.O_RDONLY | this.runtime.noFollowFlag)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > maximumBytes) throw new Error('INVALID_ARCHIVE')
      await new Promise<void>((resolve, reject) => {
        let settled = false; let request: ClientRequest | undefined; let stream: ReadStream | undefined
        const fail = (error: unknown) => {
          if (settled) return
          settled = true; stream?.destroy(); request?.destroy(error instanceof Error ? error : new Error('DOCKER_ARCHIVE_STREAM_FAILED')); reject(error)
        }
        request = this.runtime.request({
          socketPath: this.socketPath, method: 'PUT', path: `/containers/${encodeURIComponent(container)}/archive?path=${encodeURIComponent(destination)}`,
          signal, headers: { 'content-type': 'application/x-tar', 'content-length': String(stat.size) },
        }, response => {
          response.resume()
          response.once('aborted', () => fail(new Error('DOCKER_RESPONSE_ABORTED'))); response.once('error', fail)
          response.once('end', () => {
            if (!response.complete) return fail(new Error('DOCKER_RESPONSE_ABORTED'))
            if (response.statusCode !== 200) return fail(new Error(`DOCKER_STATUS_${response.statusCode ?? 0}`))
            if (!settled) { settled = true; resolve() }
          })
        })
        request.once('error', fail)
        stream = handle.createReadStream({ autoClose: false, start: 0 })
        stream.once('error', fail); stream.pipe(request)
      })
    } finally { await handle.close() }
  }
  async startContainer(id: string, signal: AbortSignal): Promise<void> { await this.#request('POST', `/containers/${encodeURIComponent(id)}/start`, undefined, signal, [204, 304]) }
  async waitContainer(id: string, signal: AbortSignal): Promise<{ readonly StatusCode: number }> {
    // Docker wait is a long poll bounded by the caller's step deadline. Applying
    // the short transport timeout here would terminate valid 180-second builds
    // after the default 30 seconds.
    const result = await this.#json<{ readonly StatusCode: unknown }>('POST', `/containers/${encodeURIComponent(id)}/wait?condition=not-running`, undefined, signal, [200], false)
    if (!Number.isSafeInteger(result.StatusCode)) throw new Error('INVALID_DOCKER_RESPONSE')
    return { StatusCode: Number(result.StatusCode) }
  }
  async containerLogs(id: string, maximumBytes: number, signal: AbortSignal): Promise<{ readonly stdout: Buffer; readonly stderr: Buffer }> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error('INVALID_LOG_LIMIT')
    return new Promise((resolve, reject) => {
      let settled = false; let pending = Buffer.alloc(0); let total = 0
      const stdout: Buffer[] = []; const stderr: Buffer[] = []
      const fail = (error: unknown) => { if (!settled) { settled = true; reject(error) } }
      const request = this.runtime.request({ socketPath: this.socketPath, method: 'GET', path: `/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&follow=1`, signal }, response => {
        if (response.statusCode !== 200) { response.resume(); fail(new Error(`DOCKER_STATUS_${response.statusCode ?? 0}`)); return }
        response.on('data', chunk => {
          if (settled) return
          pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
          try {
            while (pending.byteLength >= 8) {
              const channel = pending[0]
              if ((channel !== 1 && channel !== 2) || pending[1] !== 0 || pending[2] !== 0 || pending[3] !== 0) throw new Error('INVALID_DOCKER_LOG_STREAM')
              const length = pending.readUInt32BE(4)
              if (length > maximumBytes || total + length > maximumBytes) throw new Error('DOCKER_RESPONSE_TOO_LARGE')
              if (pending.byteLength < 8 + length) break
              const value = pending.subarray(8, 8 + length); total += length
              if (channel === 1) stdout.push(Buffer.from(value)); else stderr.push(Buffer.from(value))
              pending = pending.subarray(8 + length)
            }
          } catch (error) { fail(error); response.destroy(error as Error); request.destroy(error as Error) }
        })
        response.once('aborted', () => fail(new Error('DOCKER_RESPONSE_ABORTED'))); response.once('error', fail)
        response.once('end', () => {
          if (!response.complete) return fail(new Error('DOCKER_RESPONSE_ABORTED'))
          if (pending.byteLength !== 0) return fail(new Error('INVALID_DOCKER_LOG_STREAM'))
          if (!settled) { settled = true; resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }) }
        })
      })
      request.once('error', fail); request.end()
    })
  }
  async downloadArchive(container: string, source: string, handle: FileHandle, maximumBytes: number, signal: AbortSignal): Promise<{ readonly bytes: number; readonly sha256: string }> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error('INVALID_ARCHIVE_LIMIT')
    const before = await handle.stat(); if (!before.isFile() || before.nlink !== 1 || before.size !== 0) throw new Error('INVALID_ARCHIVE')
    const result = await new Promise<{ readonly bytes: number; readonly sha256: string }>((resolve, reject) => {
        let settled = false; let writes = Promise.resolve(); const fail = (error: unknown) => { if (!settled) { settled = true; void writes.then(() => reject(error), reject) } }
        const request = this.runtime.request({ socketPath: this.socketPath, method: 'GET', path: `/containers/${encodeURIComponent(container)}/archive?path=${encodeURIComponent(source)}`, signal }, response => {
          if (response.statusCode !== 200) { response.resume(); fail(new Error(`DOCKER_STATUS_${response.statusCode ?? 0}`)); return }
          const hash = createHash('sha256'); let bytes = 0
          response.on('data', chunk => {
            response.pause(); const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += value.byteLength
            if (bytes > maximumBytes) { request.destroy(new Error('DOCKER_RESPONSE_TOO_LARGE')); return }
            hash.update(value); writes = writes.then(() => writeAll(handle, value)).then(() => { response.resume() })
          })
          response.once('aborted', () => fail(new Error('DOCKER_RESPONSE_ABORTED'))); response.once('error', fail)
          response.once('end', () => { if (!settled) void writes.then(async () => { if (!response.complete) throw new Error('DOCKER_RESPONSE_ABORTED'); await handle.sync(); if (!settled) { settled = true; resolve({ bytes, sha256: hash.digest('hex') }) } }).catch(fail) })
        })
        request.once('error', fail); request.end()
    })
    const after = await handle.stat(); if (!after.isFile() || after.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino || after.size !== result.bytes) throw new Error('INVALID_ARCHIVE')
    return result
  }
  async stopContainer(id: string, signal: AbortSignal): Promise<void> { await this.#request('POST', `/containers/${encodeURIComponent(id)}/stop?t=3`, undefined, signal, [204, 304, 404]) }
  async removeContainer(id: string, signal: AbortSignal): Promise<void> { await this.#request('DELETE', `/containers/${encodeURIComponent(id)}?force=1&v=0`, undefined, signal, [204, 404]) }
  async listContainers(filters: Readonly<Record<string, readonly string[]>>, signal: AbortSignal): Promise<readonly Record<string, unknown>[]> {
    const result = await this.#json<unknown>('GET', `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify(filters))}`, undefined, signal, [200])
    return Array.isArray(result) ? result.filter(isRecord) : []
  }

  async #json<T>(method: string, path: string, body: unknown, signal: AbortSignal, statuses: readonly number[], applyRequestTimeout = true): Promise<T> {
    const bytes = await this.#request(method, path, body, signal, statuses, DEFAULT_RESPONSE_LIMIT, applyRequestTimeout)
    try { return JSON.parse(bytes.toString('utf8')) as T } catch { throw new Error('INVALID_DOCKER_RESPONSE') }
  }

  async #request(method: string, path: string, body: unknown, signal: AbortSignal, statuses: readonly number[], limit = DEFAULT_RESPONSE_LIMIT, applyRequestTimeout = true): Promise<Buffer> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
    const operationSignal = applyRequestTimeout ? AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)]) : signal
    return new Promise((resolve, reject) => {
      let settled = false; const fail = (error: unknown) => { if (!settled) { settled = true; reject(error) } }
      const request = this.runtime.request({
        socketPath: this.socketPath, method, path, signal: operationSignal,
        headers: payload === undefined ? {} : {
          'content-type': 'application/json',
          'content-length': String(payload.byteLength),
        },
      }, response => {
        const chunks: Buffer[] = []; let size = 0
        response.on('data', chunk => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.byteLength
          if (size > limit) request.destroy(new Error('DOCKER_RESPONSE_TOO_LARGE')); else chunks.push(bytes)
        })
        response.once('aborted', () => fail(new Error('DOCKER_RESPONSE_ABORTED'))); response.once('error', fail)
        response.once('end', () => {
          if (!response.complete) { fail(new Error('DOCKER_RESPONSE_ABORTED')); return }
          if (!statuses.includes(response.statusCode ?? 0)) { fail(new Error(`DOCKER_STATUS_${response.statusCode ?? 0}`)); return }
          if (!settled) { settled = true; resolve(Buffer.concat(chunks)) }
        })
      })
      request.once('error', fail)
      request.end(payload)
    })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
async function writeAll(handle: Awaited<ReturnType<typeof open>>, value: Buffer): Promise<void> { let offset = 0; while (offset < value.byteLength) { const written = await handle.write(value, offset, value.byteLength - offset); if (written.bytesWritten === 0) throw new Error('DOCKER_ARCHIVE_WRITE_FAILED'); offset += written.bytesWritten } }

export function demultiplexDockerStream(value: Buffer, maximum = 576 * 1024): { readonly stdout: Buffer; readonly stderr: Buffer } {
  const stdout: Buffer[] = []; const stderr: Buffer[] = []; let out = 0; let err = 0; let offset = 0
  while (offset < value.byteLength) {
    if (value.byteLength - offset < 8) throw new Error('INVALID_DOCKER_LOG_STREAM')
    const channel = value[offset];
    if ((channel !== 1 && channel !== 2) || value[offset + 1] !== 0 || value[offset + 2] !== 0 || value[offset + 3] !== 0) throw new Error('INVALID_DOCKER_LOG_STREAM')
    const length = value.readUInt32BE(offset + 4); offset += 8
    if (length > maximum || offset + length > value.byteLength) throw new Error('INVALID_DOCKER_LOG_STREAM')
    const chunk = value.subarray(offset, offset + length); offset += length
    if (out + err + length > maximum) throw new Error('DOCKER_RESPONSE_TOO_LARGE')
    if (channel === 1) { out += length; stdout.push(chunk) }
    else { err += length; stderr.push(chunk) }
  }
  return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }
}
