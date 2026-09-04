import { timingSafeEqual } from 'node:crypto'

export const SUPERVISOR_RPC_PATH = '/v1/rpc'
export const SUPERVISOR_RPC_MAX_BODY_BYTES = 64 * 1024

export interface SupervisorStartRequest { readonly preview_id: string; readonly artifact_relative_path: string; readonly artifact_sha256: string; readonly owner_email: string }
interface RuntimeRequest { readonly runtime_ref: string }
interface LogsRequest extends RuntimeRequest { readonly limit: number }
export interface SupervisorForwardRequest extends RuntimeRequest {
  readonly method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS'
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body_base64: string
}
export type SupervisorRpcRequest =
  | { readonly operation: 'start'; readonly body: SupervisorStartRequest }
  | { readonly operation: 'stop' | 'health' | 'verification-messages'; readonly body: RuntimeRequest }
  | { readonly operation: 'logs'; readonly body: LogsRequest }
  | { readonly operation: 'list-managed'; readonly body: Record<string, never> }
export type SupervisorDataRequest =
  | { readonly operation: 'forward'; readonly body: SupervisorForwardRequest }
  | { readonly operation: 'verification-messages'; readonly body: RuntimeRequest }

export function parseSupervisorRpcRequest(value: unknown): SupervisorRpcRequest {
  const envelope = strictRecord(value, ['operation', 'body'])
  const operation = envelope.operation
  if (operation === 'start') return { operation, body: parseStart(envelope.body) }
  if (operation === 'stop' || operation === 'health' || operation === 'verification-messages') return { operation, body: parseRuntime(envelope.body) }
  if (operation === 'logs') {
    const body = strictRecord(envelope.body, ['runtime_ref', 'limit'])
    if (!Number.isInteger(body.limit) || Number(body.limit) < 1 || Number(body.limit) > 100) invalid()
    return { operation, body: { runtime_ref: runtimeReference(body.runtime_ref), limit: Number(body.limit) } }
  }
  if (operation === 'list-managed') { strictRecord(envelope.body, []); return { operation, body: {} } }
  return invalid()
}

export function parseSupervisorDataRequest(value: unknown): SupervisorDataRequest {
  const envelope = strictRecord(value, ['operation', 'body'])
  if (envelope.operation === 'verification-messages') return { operation: 'verification-messages', body: parseRuntime(envelope.body) }
  if (envelope.operation !== 'forward') return invalid()
  const body = strictRecord(envelope.body, ['runtime_ref', 'method', 'path', 'headers', 'body_base64'])
  if (typeof body.method !== 'string' || !/^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/u.test(body.method)) invalid()
  if (typeof body.path !== 'string' || body.path.length > 8_192 || !body.path.startsWith('/') || body.path.startsWith('//') || body.path.includes('\\') || /[\u0000-\u001f\u007f]/u.test(body.path)) invalid()
  const headers = strictStringMap(body.headers, 16, 4_096)
  if (typeof body.body_base64 !== 'string' || body.body_base64.length > 2_796_208 || !canonicalBase64(body.body_base64)) invalid()
  return { operation: 'forward', body: {
    runtime_ref: runtimeReference(body.runtime_ref), method: body.method as SupervisorForwardRequest['method'],
    path: body.path, headers, body_base64: body.body_base64,
  } }
}

export function decodeForwardBody(value: SupervisorForwardRequest): Buffer {
  const body = Buffer.from(value.body_base64, 'base64')
  if (body.toString('base64') !== value.body_base64 || body.byteLength > 2 * 1024 * 1024) throw new Error('INVALID_FORWARD_BODY')
  return body
}

type ControlMethod = SupervisorRpcRequest['operation']
export interface SupervisorRpcMethods {
  readonly start: (params: SupervisorStartRequest, signal: AbortSignal) => Promise<unknown>
  readonly stop: (params: RuntimeRequest, signal: AbortSignal) => Promise<unknown>
  readonly health: (params: RuntimeRequest, signal: AbortSignal) => Promise<unknown>
  readonly logs: (params: LogsRequest, signal: AbortSignal) => Promise<unknown>
  readonly 'verification-messages': (params: RuntimeRequest, signal: AbortSignal) => Promise<unknown>
  readonly 'list-managed': (params: Record<string, never>, signal: AbortSignal) => Promise<unknown>
}
export interface SupervisorRpcRequestInput { readonly path: string; readonly method: string; readonly headers: Readonly<Record<string, string | undefined>>; readonly body: Uint8Array; readonly signal: AbortSignal }
export interface SupervisorRpcResponseOutput { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: Uint8Array }

export function createSupervisorRpcHandler(options: {
  readonly credentialRef: string
  readonly credentials: { resolve(reference: string): Promise<string | undefined> }
  readonly methods: SupervisorRpcMethods
}) {
  if (!/^file:\/[A-Za-z0-9_./-]{1,300}$/u.test(options.credentialRef)) throw new Error('INVALID_CREDENTIAL_REFERENCE')
  return { handle: async (input: SupervisorRpcRequestInput): Promise<SupervisorRpcResponseOutput> => {
    if (input.path !== SUPERVISOR_RPC_PATH) return response(404, { error: 'NOT_FOUND' })
    if (input.method !== 'POST') return response(405, { error: 'METHOD_NOT_ALLOWED' })
    const expected = await options.credentials.resolve(options.credentialRef)
    if (!constantBearer(input.headers.authorization, expected)) return response(401, { error: 'UNAUTHORIZED' })
    if (input.body.byteLength > SUPERVISOR_RPC_MAX_BODY_BYTES) return response(413, { error: 'REQUEST_TOO_LARGE' })
    let parsed: SupervisorRpcRequest
    try { parsed = parseSupervisorRpcRequest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.body)) as unknown) }
    catch { return rpcError(400, 'INVALID_REQUEST', 'Solicitação inválida.') }
    try {
      const result = await dispatch(options.methods, parsed, input.signal)
      if (!validResult(parsed.operation, result)) return rpcError(500, 'INTERNAL', 'O supervisor não conseguiu concluir a operação.')
      return response(200, { ok: true, result })
    } catch { return rpcError(500, 'INTERNAL', 'O supervisor não conseguiu concluir a operação.') }
  } }
}

async function dispatch(methods: SupervisorRpcMethods, request: SupervisorRpcRequest, signal: AbortSignal): Promise<unknown> {
  switch (request.operation) {
    case 'start': return methods.start(request.body, signal)
    case 'stop': return methods.stop(request.body, signal)
    case 'health': return methods.health(request.body, signal)
    case 'logs': return methods.logs(request.body, signal)
    case 'verification-messages': return methods['verification-messages'](request.body, signal)
    case 'list-managed': return methods['list-managed'](request.body, signal)
  }
}

function validResult(operation: ControlMethod, value: unknown): boolean {
  if (operation === 'start') { const row = exact(value, ['runtime_ref']); return row !== undefined && validRuntimeRef(row.runtime_ref) }
  if (operation === 'stop') { const row = exact(value, ['stopped']); return row?.stopped === true || row?.stopped === false }
  if (operation === 'health') { const row = exact(value, ['health']); return row?.health === 'OK' || row?.health === 'DOWN' }
  if (operation === 'logs') {
    const row = exact(value, ['events']); return row !== undefined && Array.isArray(row.events) && row.events.length <= 100 && row.events.every(validEvent)
  }
  if (operation === 'verification-messages') {
    const row = exact(value, ['messages']); return row !== undefined && Array.isArray(row.messages) && row.messages.length <= 20 && row.messages.every(validMessage)
  }
  const row = exact(value, ['runtimes'])
  return row !== undefined && Array.isArray(row.runtimes) && row.runtimes.length <= 1_000 && row.runtimes.every(item => {
    const entry = exact(item, ['runtime_ref', 'preview_id']); return entry !== undefined && validRuntimeRef(entry.runtime_ref) && validPreviewId(entry.preview_id)
  })
}

function validEvent(value: unknown): boolean {
  const row = exact(value, ['at', 'level', 'event'])
  const events = new Set(['ARTIFACT_VERIFIED', 'HEALTH_DOWN', 'HEALTH_OK', 'NETWORK_EGRESS_BLOCKED', 'PREVIEW_STARTED', 'PREVIEW_STOPPED', 'PROCESS_EXITED', 'RUNTIME_RESTARTED'])
  return row !== undefined && typeof row.at === 'string' && !Number.isNaN(Date.parse(row.at)) && (row.level === 'info' || row.level === 'warn' || row.level === 'error') && typeof row.event === 'string' && events.has(row.event)
}
function validMessage(value: unknown): boolean {
  const row = exact(value, ['kind', 'email', 'code', 'expiresAt'])
  return row !== undefined && row.kind === 'code' && typeof row.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(row.email) && typeof row.code === 'string' && /^\d{6}$/u.test(row.code) && typeof row.expiresAt === 'string' && !Number.isNaN(Date.parse(row.expiresAt))
}
function parseStart(value: unknown): SupervisorStartRequest {
  const row = strictRecord(value, ['preview_id', 'artifact_relative_path', 'artifact_sha256', 'owner_email'])
  if (!validPreviewId(row.preview_id) || typeof row.artifact_relative_path !== 'string' || !safeRelativePath(row.artifact_relative_path) || typeof row.artifact_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(row.artifact_sha256) || typeof row.owner_email !== 'string' || row.owner_email.length > 254 || row.owner_email !== row.owner_email.trim().toLowerCase() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(row.owner_email)) invalid()
  return { preview_id: row.preview_id as string, artifact_relative_path: row.artifact_relative_path, artifact_sha256: row.artifact_sha256, owner_email: row.owner_email }
}
function parseRuntime(value: unknown): RuntimeRequest { const row = strictRecord(value, ['runtime_ref']); return { runtime_ref: runtimeReference(row.runtime_ref) } }
function runtimeReference(value: unknown): string { if (!validRuntimeRef(value)) invalid(); return value as string }
function validRuntimeRef(value: unknown): boolean { return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/u.test(value) }
function validPreviewId(value: unknown): boolean { return typeof value === 'string' && /^[A-Za-z0-9-]{1,100}$/u.test(value) }
function safeRelativePath(value: string): boolean { return value.length <= 500 && !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..') }
function canonicalBase64(value: string): boolean { try { return Buffer.from(value, 'base64').toString('base64') === value } catch { return false } }
function strictStringMap(value: unknown, maxEntries: number, maxLength: number): Record<string, string> {
  const row = strictRecord(value, undefined); const entries = Object.entries(row)
  if (entries.length > maxEntries || entries.some(([key, item]) => !/^[a-z0-9-]{1,100}$/u.test(key) || typeof item !== 'string' || item.length > maxLength || item.includes('\0'))) invalid()
  return Object.fromEntries(entries) as Record<string, string>
}
function strictRecord(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid()
  const row = value as Record<string, unknown>
  if (keys !== undefined && Object.keys(row).sort().join('\0') !== [...keys].sort().join('\0')) return invalid()
  return row
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined { try { return strictRecord(value, keys) } catch { return undefined } }
function constantBearer(value: string | undefined, expected: string | undefined): boolean {
  if (typeof value !== 'string' || typeof expected !== 'string' || !value.startsWith('Bearer ')) return false
  const supplied = Buffer.from(value.slice(7), 'utf8'); const wanted = Buffer.from(expected, 'utf8')
  return supplied.byteLength === wanted.byteLength && timingSafeEqual(supplied, wanted)
}
function rpcError(status: number, code: string, message: string): SupervisorRpcResponseOutput { return response(status, { ok: false, error: { code, message } }) }
function response(status: number, value: unknown): SupervisorRpcResponseOutput { return { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: Buffer.from(JSON.stringify(value), 'utf8') } }
function invalid(): never { throw new Error('INVALID_REQUEST') }
