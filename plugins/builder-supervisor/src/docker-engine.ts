import { request as httpRequest } from 'node:http'

const DEFAULT_RESPONSE_LIMIT = 8 * 1024 * 1024

export interface DockerEnginePort {
  ping(signal: AbortSignal): Promise<void>
  inspectImage(digest: string, signal: AbortSignal): Promise<{ readonly Id: string }>
  createVolume(name: string, labels: Readonly<Record<string, string>>, signal: AbortSignal): Promise<void>
  removeVolume(name: string, signal: AbortSignal): Promise<void>
  listVolumes(filters: Readonly<Record<string, readonly string[]>>, signal: AbortSignal): Promise<readonly Record<string, unknown>[]>
  createContainer(name: string, body: unknown, signal: AbortSignal): Promise<string>
  putArchive(container: string, destination: string, archive: Buffer, signal: AbortSignal): Promise<void>
  startContainer(id: string, signal: AbortSignal): Promise<void>
  waitContainer(id: string, signal: AbortSignal): Promise<{ readonly StatusCode: number }>
  containerLogs(id: string, signal: AbortSignal): Promise<Buffer>
  stopContainer(id: string, signal: AbortSignal): Promise<void>
  removeContainer(id: string, signal: AbortSignal): Promise<void>
  listContainers(filters: Readonly<Record<string, readonly string[]>>, signal: AbortSignal): Promise<readonly Record<string, unknown>[]>
}

export class DockerEngine implements DockerEnginePort {
  constructor(private readonly socketPath: string) {
    if (!socketPath.startsWith('/') || socketPath.includes('\\') || socketPath.includes('\0')) throw new Error('INVALID_DOCKER_SOCKET')
  }

  async ping(signal: AbortSignal): Promise<void> { await this.#request('GET', '/_ping', undefined, signal, [200]) }
  async inspectImage(digest: string, signal: AbortSignal): Promise<{ readonly Id: string }> { return this.#json('GET', `/images/${encodeURIComponent(digest)}/json`, undefined, signal, [200]) }
  async createVolume(name: string, labels: Readonly<Record<string, string>>, signal: AbortSignal): Promise<void> { await this.#request('POST', '/volumes/create', { Name: name, Labels: labels }, signal, [201]) }
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
  async putArchive(container: string, destination: string, archive: Buffer, signal: AbortSignal): Promise<void> {
    await this.#request('PUT', `/containers/${encodeURIComponent(container)}/archive?path=${encodeURIComponent(destination)}`, archive, signal, [200])
  }
  async startContainer(id: string, signal: AbortSignal): Promise<void> { await this.#request('POST', `/containers/${encodeURIComponent(id)}/start`, undefined, signal, [204, 304]) }
  async waitContainer(id: string, signal: AbortSignal): Promise<{ readonly StatusCode: number }> {
    const result = await this.#json<{ readonly StatusCode: unknown }>('POST', `/containers/${encodeURIComponent(id)}/wait?condition=not-running`, undefined, signal, [200])
    if (!Number.isSafeInteger(result.StatusCode)) throw new Error('INVALID_DOCKER_RESPONSE')
    return { StatusCode: Number(result.StatusCode) }
  }
  async containerLogs(id: string, signal: AbortSignal): Promise<Buffer> { return this.#request('GET', `/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1`, undefined, signal, [200, 404], 1024 * 1024 + 64 * 1024) }
  async stopContainer(id: string, signal: AbortSignal): Promise<void> { await this.#request('POST', `/containers/${encodeURIComponent(id)}/stop?t=3`, undefined, signal, [204, 304, 404]) }
  async removeContainer(id: string, signal: AbortSignal): Promise<void> { await this.#request('DELETE', `/containers/${encodeURIComponent(id)}?force=1&v=0`, undefined, signal, [204, 404]) }
  async listContainers(filters: Readonly<Record<string, readonly string[]>>, signal: AbortSignal): Promise<readonly Record<string, unknown>[]> {
    const result = await this.#json<unknown>('GET', `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify(filters))}`, undefined, signal, [200])
    return Array.isArray(result) ? result.filter(isRecord) : []
  }

  async #json<T>(method: string, path: string, body: unknown, signal: AbortSignal, statuses: readonly number[]): Promise<T> {
    const bytes = await this.#request(method, path, body, signal, statuses)
    try { return JSON.parse(bytes.toString('utf8')) as T } catch { throw new Error('INVALID_DOCKER_RESPONSE') }
  }

  async #request(method: string, path: string, body: unknown, signal: AbortSignal, statuses: readonly number[], limit = DEFAULT_RESPONSE_LIMIT): Promise<Buffer> {
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8')
    return new Promise((resolve, reject) => {
      const request = httpRequest({
        socketPath: this.socketPath, method, path, signal,
        headers: payload === undefined ? {} : {
          'content-type': Buffer.isBuffer(body) ? 'application/x-tar' : 'application/json',
          'content-length': String(payload.byteLength),
        },
      }, response => {
        const chunks: Buffer[] = []; let size = 0
        response.on('data', chunk => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.byteLength
          if (size > limit) request.destroy(new Error('DOCKER_RESPONSE_TOO_LARGE')); else chunks.push(bytes)
        })
        response.once('end', () => {
          if (!statuses.includes(response.statusCode ?? 0)) { reject(new Error(`DOCKER_STATUS_${response.statusCode ?? 0}`)); return }
          resolve(Buffer.concat(chunks))
        })
      })
      request.once('error', reject)
      request.end(payload)
    })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
