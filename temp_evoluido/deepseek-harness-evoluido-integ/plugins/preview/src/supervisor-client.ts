import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { posix } from 'node:path'
import type { PreviewForwardPort, PreviewForwardRequest, PreviewForwardResponse } from './gateway.js'
import { PreviewError, type PreviewRuntimePort } from './service.js'
import { t } from './i18n.js'

const METADATA_RESPONSE_LIMIT = 32 * 1024
const FORWARD_RESPONSE_LIMIT = 12 * 1024 * 1024
const FORWARD_BODY_LIMIT = 2 * 1024 * 1024
const MAX_LOG_EVENTS = 100
const MAX_MESSAGES = 20
const MAX_MANAGED = 1_000

export type SupervisorOperation = 'start' | 'stop' | 'health' | 'logs' | 'verification-messages' | 'list-managed' | 'forward'

export interface SupervisorExchangeRequest {
  readonly operation: SupervisorOperation
  readonly body: Readonly<Record<string, unknown>>
  readonly signal: AbortSignal
  readonly maxResponseBytes: number
}

export interface SupervisorTransport {
  exchange(request: SupervisorExchangeRequest): Promise<Uint8Array>
}

export interface SupervisorRuntimeClientOptions {
  readonly artifactRoot: string
  readonly transport: SupervisorTransport
  readonly dataTransport?: SupervisorTransport
}

/**
 * Closed adapter between the Harness and the privileged preview supervisor.
 * Docker configuration is deliberately absent from the wire contract.
 */
export class SupervisorPreviewRuntime implements PreviewRuntimePort, PreviewForwardPort {
  readonly #artifactRoot: string

  constructor(private readonly options: SupervisorRuntimeClientOptions) {
    this.#artifactRoot = absoluteUnixPath(options.artifactRoot, 'artifactRoot').replace(/\/$/u, '')
  }

  async start(input: Parameters<PreviewRuntimePort['start']>[0], signal: AbortSignal): Promise<{ readonly runtimeRef: string }> {
    assertNotAborted(signal)
    const previewId = validPreviewId(input.previewId)
    validateCoreOwnedStartFields(input, previewId)
    const ownerEmail = validEmail(input.ownerEmail)
    const artifactRelativePath = this.#artifactRelativePath(input.artifactPath)
    const artifactSha256 = validHash(input.artifactSha256)
    const response = await this.#request('start', {
      preview_id: previewId,
      artifact_relative_path: artifactRelativePath,
      artifact_sha256: artifactSha256,
      owner_email: ownerEmail,
    }, signal)
    return strictObject(response, ['runtime_ref'], value => ({ runtimeRef: validRuntimeRef(value.runtime_ref, true) }))
  }

  async stop(runtimeRef: string, signal: AbortSignal): Promise<void> {
    const response = await this.#request('stop', { runtime_ref: validRuntimeRef(runtimeRef) }, signal)
    strictObject(response, ['stopped'], value => {
      if (value.stopped !== true) invalidResponse()
      return undefined
    })
  }

  async health(runtimeRef: string, signal: AbortSignal): Promise<'OK' | 'DOWN'> {
    const response = await this.#request('health', { runtime_ref: validRuntimeRef(runtimeRef) }, signal)
    return strictObject(response, ['health'], value => {
      if (value.health !== 'OK' && value.health !== 'DOWN') invalidResponse()
      return value.health
    })
  }

  async logs(runtimeRef: string, limit: number, signal: AbortSignal): Promise<readonly unknown[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LOG_EVENTS) throw invalid(t('supervisor.invalidEventLimit'))
    const response = await this.#request('logs', { runtime_ref: validRuntimeRef(runtimeRef), limit }, signal)
    return strictArrayResponse(response, 'events', MAX_LOG_EVENTS)
  }

  async verificationMessages(runtimeRef: string, signal: AbortSignal): Promise<readonly unknown[]> {
    const response = await this.#request('verification-messages', { runtime_ref: validRuntimeRef(runtimeRef) }, signal, METADATA_RESPONSE_LIMIT, true)
    return strictArrayResponse(response, 'messages', MAX_MESSAGES)
  }

  async listManaged(signal: AbortSignal): Promise<readonly { readonly runtimeRef: string; readonly previewId: string }[]> {
    const response = await this.#request('list-managed', {}, signal)
    return strictArrayResponse(response, 'runtimes', MAX_MANAGED).map(row => strictObject(row, ['runtime_ref', 'preview_id'], value => ({
      runtimeRef: validRuntimeRef(value.runtime_ref, true),
      previewId: validPreviewId(value.preview_id, true),
    })))
  }

  async forward(runtimeRef: string, request: PreviewForwardRequest): Promise<PreviewForwardResponse> {
    const body = Buffer.from(request.body)
    if (body.byteLength > FORWARD_BODY_LIMIT) throw invalid(t('supervisor.bodyTooLarge'))
    const method = validMethod(request.method)
    const path = validOriginForm(request.path)
    const headers = validForwardHeaders(request.headers)
    const signal = AbortSignal.timeout(15_000)
    const response = await this.#request('forward', {
      runtime_ref: validRuntimeRef(runtimeRef), method, path, headers, body_base64: body.toString('base64'),
    }, signal, FORWARD_RESPONSE_LIMIT, true)
    return strictObject(response, ['status', 'headers', 'body_base64'], value => {
      if (!Number.isInteger(value.status) || Number(value.status) < 200 || Number(value.status) > 599) invalidResponse()
      const encoded = value.body_base64
      if (typeof encoded !== 'string' || !isCanonicalBase64(encoded)) invalidResponse()
      const decoded = Buffer.from(encoded, 'base64')
      if (decoded.byteLength > FORWARD_BODY_LIMIT * 4) invalidResponse()
      return {
        status: Number(value.status),
        headers: responseHeaders(value.headers),
        body: decoded,
      }
    })
  }

  async #request(operation: SupervisorOperation, body: Readonly<Record<string, unknown>>, signal: AbortSignal, maxResponseBytes = METADATA_RESPONSE_LIMIT, dataPlane = false): Promise<unknown> {
    assertNotAborted(signal)
    let bytes: Uint8Array
    try {
      const transport = dataPlane ? this.options.dataTransport ?? this.options.transport : this.options.transport
      bytes = await transport.exchange({ operation, body, signal, maxResponseBytes })
    } catch {
      if (signal.aborted) throw abortError()
      throw new PreviewError('UNAVAILABLE', t('supervisor.unavailable'))
    }
    assertNotAborted(signal)
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > maxResponseBytes) invalidResponse()
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown }
    catch { invalidResponse() }
  }

  #artifactRelativePath(value: string): string {
    if (typeof value !== 'string' || value.includes('\\') || value.includes('\0')) throw invalid(t('supervisor.invalidArtifactPath'))
    const normalized = posix.normalize(value)
    const relative = posix.relative(this.#artifactRoot, normalized)
    if (!posix.isAbsolute(value) || normalized === this.#artifactRoot || relative.startsWith('../') || relative === '..' || posix.isAbsolute(relative)) {
      throw invalid(t('supervisor.artifactOutsideRoot'))
    }
    return relative
  }
}

export interface UnixHttpSupervisorTransportOptions {
  readonly socketPath: string
  readonly tokenFile: string
}

/** HTTP/1.1 transport over an authenticated Unix socket; it never opens TCP. */
export class UnixHttpSupervisorTransport implements SupervisorTransport {
  readonly #socketPath: string
  readonly #tokenFile: string

  constructor(options: UnixHttpSupervisorTransportOptions) {
    this.#socketPath = absoluteUnixPath(options.socketPath, 'socketPath')
    this.#tokenFile = absoluteUnixPath(options.tokenFile, 'tokenFile')
  }

  async exchange(input: SupervisorExchangeRequest): Promise<Uint8Array> {
    assertNotAborted(input.signal)
    const token = (await readFile(this.#tokenFile, 'utf8')).trim()
    if (!/^[A-Za-z0-9_-]{43,200}$/u.test(token)) throw new Error('invalid supervisor credential')
    if (input.operation === 'forward') throw new Error('forward requires the isolated data plane')
    const payload = Buffer.from(JSON.stringify({ operation: input.operation, body: input.body }), 'utf8')
    if (payload.byteLength > 64 * 1024) throw new Error('supervisor request too large')
    return new Promise<Uint8Array>((resolve, reject) => {
      let settled = false
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        reject(error)
      }
      const request = httpRequest({
        socketPath: this.#socketPath,
        path: '/v1/rpc',
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': String(payload.byteLength),
        },
        signal: input.signal,
      }, response => {
        const chunks: Buffer[] = []
        let size = 0
        response.once('error', fail)
        response.once('aborted', () => fail(new Error('supervisor response aborted')))
        response.on('data', chunk => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          size += bytes.byteLength
          if (size > input.maxResponseBytes) {
            fail(new Error('supervisor response too large'))
            response.destroy()
            request.destroy()
          }
          else chunks.push(bytes)
        })
        response.once('end', () => {
          if (settled) return
          if (response.statusCode !== 200) { fail(new Error('supervisor rejected request')); return }
          try {
            const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
            if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) throw new Error('invalid envelope')
            const row = envelope as Record<string, unknown>
            if (row.ok !== true || !('result' in row) || Object.keys(row).sort().join(',') !== 'ok,result') throw new Error('invalid envelope')
            settled = true
            resolve(Buffer.from(JSON.stringify(row.result), 'utf8'))
          } catch { fail(new Error('invalid supervisor response')) }
        })
      })
      request.once('error', fail)
      request.end(payload)
    })
  }
}

export class UnixProxySupervisorTransport implements SupervisorTransport {
  readonly #socketRoot: string

  constructor(options: { readonly socketRoot: string }) {
    this.#socketRoot = absoluteUnixPath(options.socketRoot, 'socketRoot').replace(/\/$/u, '')
  }

  async exchange(input: SupervisorExchangeRequest): Promise<Uint8Array> {
    if (input.operation !== 'forward' && input.operation !== 'verification-messages') throw new Error('invalid data-plane operation')
    const runtimeRef = validRuntimeRef(input.body.runtime_ref)
    const socketPath = `${this.#socketRoot}/${runtimeRef}.sock`
    if (Buffer.byteLength(socketPath) > 100) throw new Error('proxy socket path too long')
    const payload = Buffer.from(JSON.stringify({ operation: input.operation, body: input.body }), 'utf8')
    if (payload.byteLength > 3 * 1024 * 1024) throw new Error('proxy request too large')
    return new Promise<Uint8Array>((resolve, reject) => {
      let settled = false
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        reject(error)
      }
      const request = httpRequest({
        socketPath, path: '/v1/data', method: 'POST', signal: input.signal,
        headers: { 'content-type': 'application/json', 'content-length': String(payload.byteLength) },
      }, response => {
        const chunks: Buffer[] = []; let size = 0
        response.once('error', fail)
        response.once('aborted', () => fail(new Error('proxy response aborted')))
        response.on('data', chunk => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.byteLength
          if (size > input.maxResponseBytes) {
            fail(new Error('proxy response too large'))
            response.destroy()
            request.destroy()
          } else chunks.push(bytes)
        })
        response.once('end', () => {
          if (settled) return
          if (response.statusCode !== 200) { fail(new Error('proxy rejected request')); return }
          settled = true
          resolve(Buffer.concat(chunks))
        })
      })
      request.once('error', fail)
      request.end(payload)
    })
  }
}

function validateCoreOwnedStartFields(input: Parameters<PreviewRuntimePort['start']>[0], previewId: string): void {
  const expectedLabels = { 'dz23.managed': 'preview', 'dz23.preview_id': previewId }
  const expectedEnvironment = { APP_EMAIL_MODE: 'studio-preview', APP_OWNER_EMAIL: validEmail(input.ownerEmail), DZ23_PREVIEW_ID: previewId, DATA_DIR: '/preview-storage/data' }
  if (!equalStringMap(input.labels, expectedLabels) || !equalStringMap(input.environment, expectedEnvironment)) {
    throw invalid(t('supervisor.runtimePolicyViolation'))
  }
}

function equalStringMap(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const a = Buffer.from(JSON.stringify(Object.entries(left).sort()), 'utf8')
  const b = Buffer.from(JSON.stringify(Object.entries(right).sort()), 'utf8')
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

function absoluteUnixPath(value: string, field: string): string {
  if (typeof value !== 'string' || !posix.isAbsolute(value) || value.includes('\0') || value.includes('\\') || value.includes('://')) {
    throw invalid(t('supervisor.invalidField', { field }))
  }
  return posix.normalize(value)
}

function validRuntimeRef(value: unknown, response = false): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,200}$/u.test(value)) {
    if (response) invalidResponse()
    throw invalid(t('supervisor.invalidRuntimeRef'))
  }
  return value
}

function validPreviewId(value: unknown, response = false): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/u.test(value)) {
    if (response) invalidResponse()
    throw invalid(t('supervisor.invalidPreviewId'))
  }
  return value
}

function validHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw invalid(t('supervisor.invalidArtifactHash'))
  return value
}

function validEmail(value: unknown): string {
  if (typeof value !== 'string') throw invalid(t('supervisor.invalidOwnerEmail'))
  const normalized = value.trim().toLowerCase()
  if (normalized !== value || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) throw invalid(t('supervisor.invalidOwnerEmail'))
  return value
}

function validMethod(value: string): string {
  if (!/^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/u.test(value)) throw invalid(t('supervisor.invalidMethod'))
  return value
}

function validOriginForm(value: string): string {
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\u0000-\u001f\u007f]/u.test(value)) throw invalid(t('supervisor.invalidTarget'))
  const parsed = new URL(value, 'http://preview.invalid')
  return `${parsed.pathname}${parsed.search}`
}

function validForwardHeaders(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const allowed = new Set(['accept', 'accept-language', 'content-type', 'if-none-match', 'range', 'user-agent', 'cookie', 'next-action', 'next-router-state-tree', 'next-url', 'rsc', 'x-nextjs-data'])
  const entries = Object.entries(value)
  if (entries.length > allowed.size || entries.some(([key, item]) => !allowed.has(key) || item.length > 4_096 || item.includes('\0'))) {
    throw invalid(t('supervisor.invalidForwardHeaders'))
  }
  return Object.fromEntries(entries)
}

function responseHeaders(value: unknown): Readonly<Record<string, string | readonly string[] | undefined>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalidResponse()
  const allowed = new Set(['content-type', 'etag', 'last-modified', 'location', 'set-cookie'])
  const result: Record<string, string | readonly string[]> = {}
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.has(key)) invalidResponse()
    if (typeof item === 'string' && item.length <= 4_096) result[key] = item
    else if (key === 'set-cookie' && Array.isArray(item) && item.length <= 10 && item.every(row => typeof row === 'string' && row.length <= 4_096)) result[key] = item as string[]
    else invalidResponse()
  }
  return result
}

function isCanonicalBase64(value: string): boolean {
  if (value.length > FORWARD_RESPONSE_LIMIT || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return false
  return Buffer.from(value, 'base64').toString('base64') === value
}

function strictArrayResponse(value: unknown, key: string, maximum: number): readonly unknown[] {
  return strictObject(value, [key], object => {
    const rows = object[key]
    if (!Array.isArray(rows) || rows.length > maximum) invalidResponse()
    return rows
  })
}

function strictObject<T>(value: unknown, keys: readonly string[], parse: (value: Record<string, unknown>) => T): T {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalidResponse()
  const object = value as Record<string, unknown>
  if (Object.keys(object).sort().join('\0') !== [...keys].sort().join('\0')) invalidResponse()
  return parse(object)
}

function assertNotAborted(signal: AbortSignal): void { if (signal.aborted) throw abortError() }
function abortError(): Error { return new DOMException(t('supervisor.cancelled'), 'AbortError') }
function invalid(message: string): PreviewError { return new PreviewError('INVALID', message) }
function invalidResponse(): never { throw new PreviewError('UNAVAILABLE', t('supervisor.invalidResponse')) }
