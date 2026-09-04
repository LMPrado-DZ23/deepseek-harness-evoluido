import { timingSafeEqual } from 'node:crypto'
import { BUILD_STEPS, BuilderSupervisorError, type BuildState, type BuildStep, type FinishResult, type ManagedBuild, type StepResult } from './model.js'

export const BUILDER_RPC_PATH = '/v1/rpc'
export const BUILDER_RPC_MAX_BODY_BYTES = 64 * 1024

interface RequestIdentity { readonly request_id: string }
export interface PreflightRequest extends RequestIdentity {}
export interface PrepareRequest extends RequestIdentity {
  readonly build_id: string
  readonly artifact_relative_path: string
  readonly artifact_sha256: string
}
export interface ExecuteRequest extends RequestIdentity { readonly build_ref: string; readonly step: BuildStep }
export interface BuildReferenceRequest extends RequestIdentity { readonly build_ref: string }

export type BuilderRpcRequest =
  | { readonly operation: 'preflight'; readonly body: PreflightRequest }
  | { readonly operation: 'prepare'; readonly body: PrepareRequest }
  | { readonly operation: 'execute'; readonly body: ExecuteRequest }
  | { readonly operation: 'cancel' | 'finish'; readonly body: BuildReferenceRequest }
  | { readonly operation: 'listManaged'; readonly body: RequestIdentity }

export interface BuilderRpcMethods {
  readonly preflight: (body: PreflightRequest, signal: AbortSignal) => Promise<{ readonly state: 'OK' | 'BLOCKED_EXTERNAL' }>
  readonly prepare: (body: PrepareRequest, signal: AbortSignal) => Promise<{ readonly build_ref: string; readonly state: 'PREPARED' }>
  readonly execute: (body: ExecuteRequest, signal: AbortSignal) => Promise<{ readonly build_ref: string; readonly state: BuildState; readonly step: BuildStep; readonly result: StepResult }>
  readonly cancel: (body: BuildReferenceRequest, signal: AbortSignal) => Promise<{ readonly build_ref: string; readonly state: 'CANCELLED' }>
  readonly finish: (body: BuildReferenceRequest, signal: AbortSignal) => Promise<FinishResult>
  readonly listManaged: (body: RequestIdentity, signal: AbortSignal) => Promise<{ readonly builds: readonly ManagedBuild[] }>
}

export interface BuilderRpcInput {
  readonly path: string
  readonly method: string
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly body: Uint8Array
  readonly signal: AbortSignal
}
export interface BuilderRpcOutput { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: Uint8Array }

export function parseBuilderRpcRequest(value: unknown): BuilderRpcRequest {
  const envelope = strictRecord(value, ['operation', 'body'])
  const operation = envelope.operation
  if (operation === 'preflight' || operation === 'listManaged') return { operation, body: parseIdentity(envelope.body) }
  if (operation === 'prepare') {
    const body = strictRecord(envelope.body, ['request_id', 'build_id', 'artifact_relative_path', 'artifact_sha256'])
    const request_id = requestId(body.request_id)
    if (!validBuildId(body.build_id)) invalid()
    if (typeof body.artifact_relative_path !== 'string' || !safeRelativePath(body.artifact_relative_path)) invalid()
    if (typeof body.artifact_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(body.artifact_sha256)) invalid()
    return { operation, body: { request_id, build_id: body.build_id, artifact_relative_path: body.artifact_relative_path, artifact_sha256: body.artifact_sha256 } }
  }
  if (operation === 'execute') {
    const body = strictRecord(envelope.body, ['request_id', 'build_ref', 'step'])
    if (typeof body.step !== 'string' || !BUILD_STEPS.includes(body.step as BuildStep)) invalid()
    return { operation, body: { request_id: requestId(body.request_id), build_ref: buildReference(body.build_ref), step: body.step as BuildStep } }
  }
  if (operation === 'cancel' || operation === 'finish') {
    const body = parseBuildReference(envelope.body)
    return { operation, body }
  }
  return invalid()
}

export function createBuilderRpcHandler(options: {
  readonly credentialRef: string
  readonly credentials: { resolve(reference: string): Promise<string | undefined> }
  readonly methods: BuilderRpcMethods
}) {
  if (!/^file:\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/u.test(options.credentialRef) || options.credentialRef.split('/').includes('..')) throw new Error('INVALID_CREDENTIAL_REFERENCE')
  return { handle: async (input: BuilderRpcInput): Promise<BuilderRpcOutput> => {
    if (input.path !== BUILDER_RPC_PATH) return response(404, { error: 'NOT_FOUND' })
    if (input.method !== 'POST') return response(405, { error: 'METHOD_NOT_ALLOWED' })
    const expected = await options.credentials.resolve(options.credentialRef)
    if (!constantBearer(input.headers.authorization, expected)) return response(401, { error: 'UNAUTHORIZED' })
    if (input.body.byteLength > BUILDER_RPC_MAX_BODY_BYTES) return response(413, { error: 'REQUEST_TOO_LARGE' })
    let request: BuilderRpcRequest
    try { request = parseBuilderRpcRequest(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(input.body)) as unknown) }
    catch { return rpcError(400, 'INVALID_REQUEST') }
    try {
      const result = await dispatch(options.methods, request, input.signal)
      if (!validResult(request.operation, result)) return rpcError(500, 'INTERNAL')
      return response(200, { ok: true, result })
    } catch (error) {
      if (error instanceof BuilderSupervisorError) return rpcError(409, error.code)
      return rpcError(500, 'INTERNAL')
    }
  } }
}

async function dispatch(methods: BuilderRpcMethods, request: BuilderRpcRequest, signal: AbortSignal): Promise<unknown> {
  switch (request.operation) {
    case 'preflight': return methods.preflight(request.body, signal)
    case 'prepare': return methods.prepare(request.body, signal)
    case 'execute': return methods.execute(request.body, signal)
    case 'cancel': return methods.cancel(request.body, signal)
    case 'finish': return methods.finish(request.body, signal)
    case 'listManaged': return methods.listManaged(request.body, signal)
  }
}

function validResult(operation: BuilderRpcRequest['operation'], value: unknown): boolean {
  if (operation === 'preflight') {
    const row = exact(value, ['state']); return row?.state === 'OK' || row?.state === 'BLOCKED_EXTERNAL'
  }
  if (operation === 'prepare') {
    const row = exact(value, ['build_ref', 'state']); return row?.state === 'PREPARED' && validBuildRef(row.build_ref)
  }
  if (operation === 'execute') {
    const row = exact(value, ['build_ref', 'state', 'step', 'result'])
    return row !== undefined && validBuildRef(row.build_ref) && validBuildState(row.state) && typeof row.step === 'string' && BUILD_STEPS.includes(row.step as BuildStep) && validStepResult(row.result)
  }
  if (operation === 'cancel') {
    const row = exact(value, ['build_ref', 'state']); return row?.state === 'CANCELLED' && validBuildRef(row.build_ref)
  }
  if (operation === 'finish') {
    const row = exact(value, ['build_ref', 'final_state', 'exported', 'cleanup_pending', 'cleaned'])
    return row !== undefined && validBuildRef(row.build_ref) && (row.final_state === 'E2E_OK' || row.final_state === 'FAILED' || row.final_state === 'CANCELLED') &&
      validExported(row.exported) && typeof row.cleanup_pending === 'boolean' && typeof row.cleaned === 'boolean' && row.cleanup_pending !== row.cleaned
  }
  const row = exact(value, ['builds'])
  return row !== undefined && Array.isArray(row.builds) && row.builds.length <= 1_000 && row.builds.every(validManagedBuild)
}

function validStepResult(value: unknown): boolean {
  const row = exact(value, ['exit_code', 'stdout', 'stderr', 'timed_out', 'output_limited'])
  return row !== undefined && Number.isSafeInteger(row.exit_code) && typeof row.stdout === 'string' && row.stdout.length <= 524_288 && typeof row.stderr === 'string' && row.stderr.length <= 524_288 && typeof row.timed_out === 'boolean' && typeof row.output_limited === 'boolean'
}

function validManagedBuild(value: unknown): boolean {
  const row = exact(value, ['build_ref', 'build_id', 'state', 'exported', 'cleanup_pending'])
  return row !== undefined && validBuildRef(row.build_ref) && validBuildId(row.build_id) && validBuildState(row.state) && typeof row.exported === 'boolean' && typeof row.cleanup_pending === 'boolean'
}

function validExported(value: unknown): boolean {
  if (value === null) return true
  const row = exact(value, ['relative_path', 'sha256', 'files', 'bytes'])
  return row !== undefined && typeof row.relative_path === 'string' && /^exports\/build_[a-f0-9]{32}$/u.test(row.relative_path) &&
    typeof row.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(row.sha256) && Number.isSafeInteger(row.files) && Number(row.files) > 0 && Number.isSafeInteger(row.bytes) && Number(row.bytes) >= 0
}

function validBuildState(value: unknown): value is BuildState {
  return typeof value === 'string' && new Set<BuildState>(['PREPARED', 'INSTALLING', 'INSTALL_OK', 'BUILDING', 'BUILD_OK', 'UNIT_RUNNING', 'UNIT_OK', 'E2E_RUNNING', 'E2E_OK', 'FAILED', 'CANCELLED']).has(value as BuildState)
}

function parseIdentity(value: unknown): RequestIdentity { const row = strictRecord(value, ['request_id']); return { request_id: requestId(row.request_id) } }
function parseBuildReference(value: unknown): BuildReferenceRequest {
  const row = strictRecord(value, ['request_id', 'build_ref'])
  return { request_id: requestId(row.request_id), build_ref: buildReference(row.build_ref) }
}
function requestId(value: unknown): string { if (typeof value !== 'string' || !/^req_[a-f0-9]{32}$/u.test(value)) invalid(); return value }
function buildReference(value: unknown): string { if (!validBuildRef(value)) invalid(); return value as string }
function validBuildRef(value: unknown): boolean { return typeof value === 'string' && /^build_[a-f0-9]{32}$/u.test(value) }
function validBuildId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(value) }
function safeRelativePath(value: string): boolean {
  return value.length <= 500 && /^[A-Za-z0-9._/-]+$/u.test(value) && !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}
function strictRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid()
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join('\0') !== [...keys].sort().join('\0')) return invalid()
  return row
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined { try { return strictRecord(value, keys) } catch { return undefined } }
function constantBearer(value: string | undefined, expected: string | undefined): boolean {
  if (typeof value !== 'string' || typeof expected !== 'string' || !/^[A-Za-z0-9_-]{43,200}$/u.test(expected) || !value.startsWith('Bearer ')) return false
  const supplied = Buffer.from(value.slice(7), 'utf8'); const wanted = Buffer.from(expected, 'utf8')
  return supplied.byteLength === wanted.byteLength && timingSafeEqual(supplied, wanted)
}
function rpcError(status: number, code: string): BuilderRpcOutput { return response(status, { ok: false, error: { code } }) }
function response(status: number, value: unknown): BuilderRpcOutput {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: Buffer.from(JSON.stringify(value), 'utf8') }
}
function invalid(): never { throw new Error('INVALID_REQUEST') }
