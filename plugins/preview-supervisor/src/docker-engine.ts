import { request as httpRequest } from 'node:http'

const JSON_LIMIT = 8 * 1024 * 1024

export interface DockerEngineOptions { readonly socketPath: string }

export class DockerEngine {
  constructor(private readonly options: DockerEngineOptions) {
    if (!options.socketPath.startsWith('/') || options.socketPath.includes('\0') || options.socketPath.includes('\\')) throw new Error('INVALID_DOCKER_SOCKET')
  }

  async ping(signal: AbortSignal): Promise<void> { await this.#request('GET', '/_ping', undefined, signal, [200]) }
  async inspectImage(digest: string, signal: AbortSignal): Promise<{ readonly Id: string }> {
    return this.#json('GET', `/images/${encodeURIComponent(digest)}/json`, undefined, signal, [200])
  }
  async createNetwork(name: string, labels: Readonly<Record<string, string>>, signal: AbortSignal): Promise<string> {
    const result = await this.#json<{ Id: string }>('POST', '/networks/create', { Name: name, CheckDuplicate: true, Internal: true, Attachable: false, Labels: labels }, signal, [201])
    if (!/^[a-f0-9]{12,64}$/u.test(result.Id)) throw new Error('INVALID_DOCKER_RESPONSE')
    return result.Id
  }
  async removeNetwork(id: string, signal: AbortSignal): Promise<void> { await this.#request('DELETE', `/networks/${encodeURIComponent(id)}`, undefined, signal, [204, 404]) }
  async listNetworks(filters: Readonly<Record<string, readonly string[]>>, signal: AbortSignal): Promise<readonly Record<string, unknown>[]> {
    return this.#json('GET', `/networks?filters=${encodeURIComponent(JSON.stringify(filters))}`, undefined, signal, [200])
  }
  async createVolume(name: string, labels: Readonly<Record<string, string>>, signal: AbortSignal): Promise<void> {
    await this.#request('POST', '/volumes/create', { Name: name, Labels: labels }, signal, [201])
  }
  async removeVolume(name: string, signal: AbortSignal): Promise<void> { await this.#request('DELETE', `/volumes/${encodeURIComponent(name)}?force=1`, undefined, signal, [204, 404]) }
  async listVolumes(filters: Readonly<Record<string, readonly string[]>>, signal: AbortSignal): Promise<readonly Record<string, unknown>[]> {
    const result = await this.#json<{ readonly Volumes?: unknown }>('GET', `/volumes?filters=${encodeURIComponent(JSON.stringify(filters))}`, undefined, signal, [200])
    return Array.isArray(result.Volumes) ? result.Volumes.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null) : []
  }
  async createContainer(name: string, body: unknown, signal: AbortSignal): Promise<string> {
    const result = await this.#json<{ Id: string }>('POST', `/containers/create?name=${encodeURIComponent(name)}`, body, signal, [201])
    if (!/^[a-f0-9]{12,64}$/u.test(result.Id)) throw new Error('INVALID_DOCKER_RESPONSE')
    return result.Id
  }
  async putArchive(containerId: string, destination: string, archive: Buffer, signal: AbortSignal): Promise<void> {
    await this.#request('PUT', `/containers/${encodeURIComponent(containerId)}/archive?path=${encodeURIComponent(destination)}`, archive, signal, [200])
  }
  async startContainer(id: string, signal: AbortSignal): Promise<void> { await this.#request('POST', `/containers/${encodeURIComponent(id)}/start`, undefined, signal, [204, 304]) }
  async inspectContainer<T = Record<string, unknown>>(id: string, signal: AbortSignal): Promise<T> { return this.#json('GET', `/containers/${encodeURIComponent(id)}/json`, undefined, signal, [200]) }
  async containerLogs(id: string, signal: AbortSignal): Promise<string> {
    const bytes = await this.#request('GET', `/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&tail=80`, undefined, signal, [200, 404])
    return bytes.toString('utf8').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
  }
  async stopContainer(id: string, signal: AbortSignal): Promise<void> { await this.#request('POST', `/containers/${encodeURIComponent(id)}/stop?t=5`, undefined, signal, [204, 304, 404]) }
  async removeContainer(id: string, signal: AbortSignal): Promise<void> { await this.#request('DELETE', `/containers/${encodeURIComponent(id)}?force=1&v=0`, undefined, signal, [204, 404]) }
  async listContainers(filters: Readonly<Record<string, readonly string[]>>, signal: AbortSignal): Promise<readonly Record<string, unknown>[]> {
    return this.#json('GET', `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify(filters))}`, undefined, signal, [200])
  }

  async #json<T>(method: string, path: string, body: unknown, signal: AbortSignal, statuses: readonly number[]): Promise<T> {
    const result = await this.#request(method, path, body, signal, statuses)
    try { return JSON.parse(result.toString('utf8')) as T } catch { throw new Error('INVALID_DOCKER_RESPONSE') }
  }

  async #request(method: string, path: string, body: unknown, signal: AbortSignal, statuses: readonly number[]): Promise<Buffer> {
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8')
    return new Promise<Buffer>((resolve, reject) => {
      const request = httpRequest({
        socketPath: this.options.socketPath, method, path, signal,
        headers: payload === undefined ? {} : {
          'content-type': Buffer.isBuffer(body) ? 'application/x-tar' : 'application/json',
          'content-length': String(payload.byteLength),
        },
      }, response => {
        const chunks: Buffer[] = []; let size = 0
        response.on('data', chunk => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.byteLength
          if (size > JSON_LIMIT) request.destroy(new Error('DOCKER_RESPONSE_TOO_LARGE')); else chunks.push(bytes)
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
