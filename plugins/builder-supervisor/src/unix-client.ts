import { request as httpRequest, type IncomingMessage } from 'node:http'
import { posix } from 'node:path'
import type {
  BuilderAttestation,
  BuilderErrorCode,
  BuildState,
  BuildStep,
  FinishResult,
  ManagedBuild,
  StepResult,
} from './model.js'
import {
  BUILDER_RPC_MAX_BODY_BYTES,
  BUILDER_RPC_MAX_RESPONSE_BYTES,
  BUILDER_RPC_PATH,
  isBuilderCredentialReference,
  isValidBuilderRpcResult,
  parseBuilderRpcRequest,
  type BuildReferenceRequest,
  type BuilderRpcRequest,
  type ExecuteRequest,
  type ListManagedRequest,
  type PreflightRequest,
  type PrepareRequest,
} from './protocol.js'

const DEFAULT_TIMEOUT_MS = 240_000
const MAX_TIMEOUT_MS = 600_000

export interface BuilderUnixClientCallOptions {
  readonly signal?: AbortSignal
}

export interface BuilderUnixClientCredentials {
  resolve(reference: string, signal: AbortSignal): Promise<string | undefined>
}

export interface BuilderUnixClientOptions {
  readonly socketPath: string
  readonly credentialRef: string
  readonly credentials: BuilderUnixClientCredentials
  readonly timeoutMs?: number
  readonly maxRequestBytes?: number
  readonly maxResponseBytes?: number
  readonly transport?: BuilderUnixClientTransport
}

export interface BuilderUnixClient {
  preflight(body: PreflightRequest, options?: BuilderUnixClientCallOptions): Promise<BuilderAttestation>
  prepare(body: PrepareRequest, options?: BuilderUnixClientCallOptions): Promise<{ readonly build_ref: string; readonly state: 'PREPARED' }>
  execute(body: ExecuteRequest, options?: BuilderUnixClientCallOptions): Promise<{ readonly build_ref: string; readonly state: BuildState; readonly step: BuildStep; readonly result: StepResult }>
  cancel(body: BuildReferenceRequest, options?: BuilderUnixClientCallOptions): Promise<{ readonly build_ref: string; readonly state: 'CANCELLED' }>
  finish(body: BuildReferenceRequest, options?: BuilderUnixClientCallOptions): Promise<FinishResult>
  listManaged(body: ListManagedRequest, options?: BuilderUnixClientCallOptions): Promise<{ readonly builds: readonly ManagedBuild[] }>
}

export interface BuilderUnixClientTransportRequest {
  readonly socketPath: string
  readonly path: string
  readonly method: 'POST'
  readonly headers: Readonly<Record<string, string>>
  readonly signal: AbortSignal
}

export interface BuilderUnixClientTransport {
  request(
    options: BuilderUnixClientTransportRequest,
    onResponse: (response: IncomingMessage) => void,
  ): ReturnType<typeof httpRequest>
}

export type BuilderUnixClientErrorCode =
  | 'ABORTED'
  | 'CREDENTIAL_UNAVAILABLE'
  | 'DEADLINE_EXCEEDED'
  | 'INVALID_CONFIGURATION'
  | 'INVALID_REQUEST'
  | 'INVALID_RESPONSE'
  | 'REQUEST_TOO_LARGE'
  | 'RESPONSE_TOO_LARGE'
  | 'SOCKET_UNAVAILABLE'
  | 'TRANSPORT_ERROR'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'INTERNAL'
  | 'SUPERVISOR_UNAVAILABLE'
  | 'SUPERVISOR_SHUTTING_DOWN'
  | BuilderErrorCode

export class BuilderUnixClientError extends Error {
  readonly status: number | undefined

  constructor(readonly code: BuilderUnixClientErrorCode, status?: number) {
    super(code)
    this.name = 'BuilderUnixClientError'
    this.status = status
  }
}

export type BuilderUnixClientFailureState = 'BLOCKED_EXTERNAL' | 'BUILD_FAILED' | 'CANCELLED' | 'INTERNAL'

export interface BuilderUnixClientFailureClassification {
  readonly state: BuilderUnixClientFailureState
  readonly code: BuilderUnixClientErrorCode | 'UNKNOWN'
}

const FAILURE_STATES = {
  ABORTED: 'CANCELLED',
  CREDENTIAL_UNAVAILABLE: 'BLOCKED_EXTERNAL',
  DEADLINE_EXCEEDED: 'BLOCKED_EXTERNAL',
  INVALID_CONFIGURATION: 'INTERNAL',
  INVALID_REQUEST: 'INTERNAL',
  INVALID_RESPONSE: 'BLOCKED_EXTERNAL',
  REQUEST_TOO_LARGE: 'INTERNAL',
  RESPONSE_TOO_LARGE: 'BLOCKED_EXTERNAL',
  SOCKET_UNAVAILABLE: 'BLOCKED_EXTERNAL',
  TRANSPORT_ERROR: 'BLOCKED_EXTERNAL',
  UNAUTHORIZED: 'BLOCKED_EXTERNAL',
  NOT_FOUND: 'BLOCKED_EXTERNAL',
  METHOD_NOT_ALLOWED: 'BLOCKED_EXTERNAL',
  INTERNAL: 'BLOCKED_EXTERNAL',
  SUPERVISOR_UNAVAILABLE: 'BLOCKED_EXTERNAL',
  SUPERVISOR_SHUTTING_DOWN: 'BLOCKED_EXTERNAL',
  ARTIFACT_CHANGED_DURING_STAGE: 'BUILD_FAILED',
  ARTIFACT_HASH_MISMATCH: 'BUILD_FAILED',
  ARTIFACT_OUTSIDE_ROOT: 'BUILD_FAILED',
  ARTIFACT_UNSAFE_ENTRY: 'BUILD_FAILED',
  BUILD_ALREADY_EXISTS: 'INTERNAL',
  BUILD_NOT_FOUND: 'INTERNAL',
  BUILD_NOT_TERMINAL: 'INTERNAL',
  CAPACITY_EXCEEDED: 'BLOCKED_EXTERNAL',
  CLEANUP_INCOMPLETE: 'BLOCKED_EXTERNAL',
  EXPORT_INVALID: 'BLOCKED_EXTERNAL',
  RECOVERY_FAILED: 'BLOCKED_EXTERNAL',
  INVALID_STEP_ORDER: 'INTERNAL',
  REQUEST_REPLAY: 'INTERNAL',
  REQUEST_ID_CONFLICT: 'INTERNAL',
  REPLAY_CAPACITY: 'BLOCKED_EXTERNAL',
} as const satisfies Readonly<Record<BuilderUnixClientErrorCode, BuilderUnixClientFailureState>>

/**
 * Classifies the closed client error union for the future Prompt-to-App adapter.
 * This function is deliberately not wired to any call site in the foundation.
 */
export function classifyBuilderUnixClientFailure(error: unknown): BuilderUnixClientFailureClassification {
  if (!(error instanceof BuilderUnixClientError)) return { state: 'INTERNAL', code: 'UNKNOWN' }
  return { state: FAILURE_STATES[error.code], code: error.code }
}

const DEFAULT_TRANSPORT: BuilderUnixClientTransport = {
  request: (options, onResponse) => httpRequest(options, onResponse),
}

export function createBuilderUnixClient(options: BuilderUnixClientOptions): BuilderUnixClient {
  const socketPath = socketPathValue(options.socketPath)
  if (!isBuilderCredentialReference(options.credentialRef)) throw new BuilderUnixClientError('INVALID_CONFIGURATION')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw new BuilderUnixClientError('INVALID_CONFIGURATION')
  const maxRequestBytes = options.maxRequestBytes ?? BUILDER_RPC_MAX_BODY_BYTES
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1 || maxRequestBytes > BUILDER_RPC_MAX_BODY_BYTES) throw new BuilderUnixClientError('INVALID_CONFIGURATION')
  const maxResponseBytes = options.maxResponseBytes ?? BUILDER_RPC_MAX_RESPONSE_BYTES
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > BUILDER_RPC_MAX_RESPONSE_BYTES) throw new BuilderUnixClientError('INVALID_CONFIGURATION')
  const transport = options.transport ?? DEFAULT_TRANSPORT

  const call = async <T>(request: BuilderRpcRequest, callOptions?: BuilderUnixClientCallOptions): Promise<T> => {
    let parsed: BuilderRpcRequest
    try { parsed = parseBuilderRpcRequest(request) }
    catch { throw new BuilderUnixClientError('INVALID_REQUEST') }
    const body = Buffer.from(JSON.stringify(parsed), 'utf8')
    if (body.byteLength > maxRequestBytes) throw new BuilderUnixClientError('REQUEST_TOO_LARGE')

    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = callOptions?.signal === undefined ? timeout : AbortSignal.any([callOptions.signal, timeout])
    try {
      signal.throwIfAborted()
      let token: string | undefined
      try { token = await resolveCredential(options.credentials, options.credentialRef, signal) }
      catch (error) {
        if (signal.aborted) throw error
        throw new BuilderUnixClientError('CREDENTIAL_UNAVAILABLE')
      }
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43,200}$/u.test(token)) throw new BuilderUnixClientError('CREDENTIAL_UNAVAILABLE')
      const wire = await exchange({ socketPath, token, body, signal, maxResponseBytes, transport })
      const value = decodeJson(wire.body)
      if (wire.status === 200) {
        const envelope = exactRecord(value, ['ok', 'result'])
        if (envelope === undefined || envelope.ok !== true || !isValidBuilderRpcResult(parsed, envelope.result)) throw new BuilderUnixClientError('INVALID_RESPONSE')
        return envelope.result as T
      }
      throw parseRemoteError(wire.status, value)
    } catch (error) {
      if (callOptions?.signal?.aborted === true) throw new BuilderUnixClientError('ABORTED')
      if (timeout.aborted) throw new BuilderUnixClientError('DEADLINE_EXCEEDED')
      if (error instanceof BuilderUnixClientError) throw error
      throw transportError(error)
    }
  }

  return {
    preflight: (body, callOptions) => call({ operation: 'preflight', body }, callOptions),
    prepare: (body, callOptions) => call({ operation: 'prepare', body }, callOptions),
    execute: (body, callOptions) => call({ operation: 'execute', body }, callOptions),
    cancel: (body, callOptions) => call({ operation: 'cancel', body }, callOptions),
    finish: (body, callOptions) => call({ operation: 'finish', body }, callOptions),
    listManaged: (body, callOptions) => call({ operation: 'listManaged', body }, callOptions),
  }
}

async function resolveCredential(credentials: BuilderUnixClientCredentials, reference: string, signal: AbortSignal): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    let settled = false
    const abort = () => { if (!settled) { settled = true; reject(signal.reason) } }
    signal.addEventListener('abort', abort, { once: true })
    let pending: Promise<string | undefined>
    try { pending = credentials.resolve(reference, signal) }
    catch (error) {
      settled = true
      signal.removeEventListener('abort', abort)
      reject(error)
      return
    }
    void pending.then(value => {
      if (!settled) { settled = true; signal.removeEventListener('abort', abort); resolve(value) }
    }, error => {
      if (!settled) { settled = true; signal.removeEventListener('abort', abort); reject(error) }
    })
  })
}

async function exchange(options: {
  readonly socketPath: string
  readonly token: string
  readonly body: Buffer
  readonly signal: AbortSignal
  readonly maxResponseBytes: number
  readonly transport: BuilderUnixClientTransport
}): Promise<{ readonly status: number; readonly body: Buffer }> {
  return new Promise((resolve, reject) => {
    let responseStarted = false
    let settled = false
    const finish = <T>(action: (value: T) => void, value: T) => { if (!settled) { settled = true; action(value) } }
    let request: ReturnType<typeof httpRequest>
    try {
      request = options.transport.request({
        socketPath: options.socketPath,
        path: BUILDER_RPC_PATH,
        method: 'POST',
        signal: options.signal,
        headers: {
          authorization: `Bearer ${options.token}`,
          'cache-control': 'no-store',
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(options.body.byteLength),
        },
      }, response => {
        responseStarted = true
        void readResponse(response, options.maxResponseBytes).then(
          body => finish(resolve, { status: response.statusCode ?? 0, body }),
          error => finish(reject, error),
        )
      })
    } catch (error) { finish(reject, error); return }
    request.once('error', error => { if (!responseStarted) finish(reject, error) })
    request.end(options.body)
  })
}

async function readResponse(response: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const contentType = response.headers['content-type']
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
    response.destroy()
    throw new BuilderUnixClientError('INVALID_RESPONSE')
  }
  const declared = response.headers['content-length']
  if (declared !== undefined && (Array.isArray(declared) || !/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > maxBytes)) {
    response.destroy()
    throw new BuilderUnixClientError(Number(declared) > maxBytes ? 'RESPONSE_TOO_LARGE' : 'INVALID_RESPONSE')
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of response) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += next.byteLength
    if (bytes > maxBytes) {
      response.destroy()
      throw new BuilderUnixClientError('RESPONSE_TOO_LARGE')
    }
    chunks.push(next)
  }
  if (declared !== undefined && Number(declared) !== bytes) throw new BuilderUnixClientError('INVALID_RESPONSE')
  return Buffer.concat(chunks, bytes)
}

function decodeJson(body: Buffer): unknown {
  try {
    const text = new TextDecoder('utf8', { fatal: true }).decode(body)
    return JSON.parse(text) as unknown
  } catch { throw new BuilderUnixClientError('INVALID_RESPONSE') }
}

function parseRemoteError(status: number, value: unknown): BuilderUnixClientError {
  const direct = exactRecord(value, ['error'])
  if (direct !== undefined && typeof direct.error === 'string' && directErrorMatches(status, direct.error)) return new BuilderUnixClientError(direct.error as BuilderUnixClientErrorCode, status)
  const envelope = exactRecord(value, ['ok', 'error'])
  const error = envelope === undefined ? undefined : exactRecord(envelope.error, ['code'])
  if (envelope?.ok !== false || error === undefined || typeof error.code !== 'string' || !rpcErrorMatches(status, error.code)) throw new BuilderUnixClientError('INVALID_RESPONSE', status)
  return new BuilderUnixClientError(error.code as BuilderUnixClientErrorCode, status)
}

function directErrorMatches(status: number, code: string): boolean {
  return (status === 401 && code === 'UNAUTHORIZED') ||
    (status === 404 && code === 'NOT_FOUND') ||
    (status === 405 && code === 'METHOD_NOT_ALLOWED') ||
    (status === 413 && code === 'REQUEST_TOO_LARGE') ||
    (status === 500 && code === 'SUPERVISOR_UNAVAILABLE')
}

function rpcErrorMatches(status: number, code: string): boolean {
  if (status === 400) return code === 'INVALID_REQUEST'
  if (status === 500) return code === 'INTERNAL'
  if (status === 503) return code === 'SUPERVISOR_SHUTTING_DOWN'
  if (status === 504) return code === 'DEADLINE_EXCEEDED'
  if (status !== 409) return false
  return BUILDER_CONFLICT_CODES.has(code)
}

const BUILDER_CONFLICT_CODES: ReadonlySet<string> = new Set<BuilderErrorCode>([
  'ARTIFACT_CHANGED_DURING_STAGE', 'ARTIFACT_HASH_MISMATCH', 'ARTIFACT_OUTSIDE_ROOT', 'ARTIFACT_UNSAFE_ENTRY',
  'BUILD_ALREADY_EXISTS', 'BUILD_NOT_FOUND', 'BUILD_NOT_TERMINAL', 'CAPACITY_EXCEEDED', 'CLEANUP_INCOMPLETE',
  'EXPORT_INVALID', 'RECOVERY_FAILED', 'INVALID_STEP_ORDER', 'REQUEST_REPLAY', 'REQUEST_ID_CONFLICT', 'REPLAY_CAPACITY',
])

function transportError(error: unknown): BuilderUnixClientError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'EACCES' || code === 'ENOTSOCK') return new BuilderUnixClientError('SOCKET_UNAVAILABLE')
  return new BuilderUnixClientError('TRANSPORT_ERROR')
}

function socketPathValue(value: string): string {
  if (typeof value !== 'string' || !posix.isAbsolute(value) || posix.normalize(value) !== value || value.includes('\\') || value.includes('\0') || value.includes('://') || Buffer.byteLength(value, 'utf8') > 107) throw new BuilderUnixClientError('INVALID_CONFIGURATION')
  return value
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  return Object.keys(row).sort().join('\0') === [...keys].sort().join('\0') ? row : undefined
}
