import { randomBytes } from 'node:crypto'
import { constants, lstatSync } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, posix } from 'node:path'
import type { BuilderRpcMethods } from './protocol.js'
import { BUILDER_RPC_MAX_BODY_BYTES, createBuilderRpcHandler } from './protocol.js'
import { FileRpcReplayGuard } from './persistent-replay.js'
import { BUILDER_UNIX_SOCKET_MAX_BYTES, isBuilderRuntimeScopeId, type BuilderRuntimeScopeId } from './runtime-scope.js'

const CREDENTIAL_REFERENCE = 'file:/run/secrets/dz23-builder-supervisor-token'
interface LockMetadata { readonly nonce: string; readonly pid: number; readonly process_start_ticks: string; readonly uid: number; readonly socket_dev: number | null; readonly socket_ino: number | null }
interface LifecycleMethods extends BuilderRpcMethods { initialize?(signal: AbortSignal): Promise<void> }
export interface BuilderUnixRuntime {
  readonly platform: NodeJS.Platform; readonly pid: number; readonly getuid: (() => number) | undefined; readonly kill: typeof process.kill; readonly umask: typeof process.umask
  readonly lstatSync: typeof lstatSync; readonly chmod: typeof chmod; readonly lstat: typeof lstat; readonly mkdir: typeof mkdir; readonly open: typeof open
  readonly readFile: typeof readFile; readonly realpath: typeof realpath; readonly rename: typeof rename; readonly remove: typeof rm; readonly unlink: typeof unlink; readonly writeFile: typeof writeFile
  readonly createServer: typeof createServer; readonly request: typeof httpRequest; readonly setTimeout: typeof setTimeout; readonly clearTimeout: typeof clearTimeout
}
const DEFAULT_RUNTIME: BuilderUnixRuntime = { platform: process.platform, pid: process.pid, getuid: process.getuid, kill: process.kill.bind(process), umask: process.umask.bind(process), lstatSync, chmod, lstat, mkdir, open, readFile, realpath, rename, remove: rm, unlink, writeFile, createServer, request: httpRequest, setTimeout, clearTimeout }
export interface BuilderUnixServerOptions {
  readonly socketPath: string; readonly bearerToken: string; readonly methods: LifecycleMethods
  readonly scopeId: BuilderRuntimeScopeId; readonly policySha256: string; readonly replayRoot: string
  readonly signal?: AbortSignal; readonly operationTimeoutMs?: number; readonly stepTimeoutMs?: number; readonly cleanupTimeoutMs?: number; readonly runtime?: BuilderUnixRuntime
}

export async function listenBuilderUnix(options: BuilderUnixServerOptions): Promise<{ readonly server: Server; close(afterStopAccepting?: () => void): Promise<void> }> {
  const runtime = options.runtime ?? DEFAULT_RUNTIME
  if (runtime.platform === 'win32' || runtime.getuid === undefined) throw new Error('UNIX_SOCKET_REQUIRED')
  const socketPath = validSocketPath(options.socketPath); const parent = dirname(socketPath); const lockPath = `${socketPath}.lock`; const uid = runtime.getuid(); const nonce = randomBytes(16).toString('hex')
  if (!/^[A-Za-z0-9_-]{43,200}$/u.test(options.bearerToken)) throw new Error('INVALID_SUPERVISOR_TOKEN')
  if (!isBuilderRuntimeScopeId(options.scopeId) || !/^[a-f0-9]{64}$/u.test(options.policySha256)) throw new Error('INVALID_REPLAY_NAMESPACE')
  const replayRoot = validReplayRoot(options.replayRoot)
  const stepTimeoutMs = options.stepTimeoutMs ?? 180_000; const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 30_000; const timeoutMs = options.operationTimeoutMs ?? 240_000
  if (![stepTimeoutMs, cleanupTimeoutMs, timeoutMs].every(value => Number.isSafeInteger(value) && value > 0) || timeoutMs < stepTimeoutMs + cleanupTimeoutMs) throw new Error('INVALID_OPERATION_TIMEOUT')
  const processStartTicks = await processStartIdentity(runtime.pid, runtime)
  await ensureSocketDirectory(parent, uid, runtime)
  let socketIdentity: { readonly dev: number; readonly ino: number } | undefined; let server: Server | undefined; let lockHeld = false; let listenSucceeded = false
  try {
    await acquireLock(lockPath, socketPath, options.bearerToken, uid, nonce, processStartTicks, runtime); lockHeld = true
    await options.methods.initialize?.(AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(timeoutMs)]))
    await assertAbsent(socketPath, runtime)
    const replayScopeRoot = posix.join(replayRoot, options.scopeId)
    const replayDirectory = posix.join(replayScopeRoot, options.policySha256)
    for (const directory of [replayRoot, replayScopeRoot]) await new FileRpcReplayGuard(directory).initialize()
    const replay = new FileRpcReplayGuard(replayDirectory); await replay.initialize()
    const rpc = createBuilderRpcHandler({ credentialRef: CREDENTIAL_REFERENCE, credentials: { resolve: async () => options.bearerToken }, methods: options.methods, replay })
    server = runtime.createServer((request, response) => { void handle(request, response, options, timeoutMs, rpc).catch(() => failure(response)) })
    server.requestTimeout = timeoutMs; server.headersTimeout = Math.min(timeoutMs, 10_000); server.maxHeadersCount = 64
    const previousUmask = runtime.umask(0o117)
    try { await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(socketPath, () => { server!.off('error', reject); const bound = runtime.lstatSync(socketPath); socketIdentity = { dev: bound.dev, ino: bound.ino }; listenSucceeded = true; resolve() }) }) }
    finally { runtime.umask(previousUmask) }
    const bound = await runtime.lstat(socketPath)
    if (!bound.isSocket() || bound.uid !== uid) throw new Error('UNSAFE_SOCKET')
    if (socketIdentity!.dev !== bound.dev || socketIdentity!.ino !== bound.ino) throw new Error('SOCKET_IDENTITY_MISMATCH')
    await runtime.chmod(socketPath, 0o660); await assertSocketIdentity(socketPath, socketIdentity!, uid, runtime)
    await replaceMetadata(lockPath, { nonce, pid: runtime.pid, process_start_ticks: processStartTicks, uid, socket_dev: bound.dev, socket_ino: bound.ino }, runtime)
  } catch (error) {
    let cleanupError: unknown
    if (server !== undefined) await closeServerBounded(server, timeoutMs, runtime).catch(item => { cleanupError ??= item })
    if (listenSucceeded) await safeUnlinkSocket(socketPath, socketIdentity!, uid, runtime).catch(item => { cleanupError ??= item })
    if (lockHeld) await releaseLock(lockPath, nonce, runtime).catch(item => { cleanupError ??= item })
    if (cleanupError !== undefined) throw cleanupError
    throw error
  }
  const activeServer = server
  return { server: activeServer, close: async afterStopAccepting => {
    await closeOwnedSocket(socketPath, socketIdentity!, uid, activeServer, timeoutMs, runtime, afterStopAccepting)
    await releaseLock(lockPath, nonce, runtime)
  } }
}

async function handle(request: IncomingMessage, response: ServerResponse, options: BuilderUnixServerOptions, timeoutMs: number, rpc: ReturnType<typeof createBuilderRpcHandler>): Promise<void> {
  const controller = new AbortController(); const timeout = AbortSignal.timeout(timeoutMs); let cause: 'timeout' | 'disconnect' | 'shutdown' | undefined
  const abort = (next: typeof cause) => { cause ??= next; controller.abort(new Error(`SUPERVISOR_${next?.toUpperCase()}`)) }
  const shutdown = () => abort('shutdown'); const deadline = () => abort('timeout'); const disconnect = () => abort('disconnect')
  if (options.signal?.aborted === true) shutdown(); else options.signal?.addEventListener('abort', shutdown, { once: true })
  timeout.addEventListener('abort', deadline, { once: true }); request.once('aborted', disconnect); response.once('close', () => { if (!response.writableEnded) disconnect() })
  try {
    let body: Buffer; try { body = await readBounded(request) } catch { body = Buffer.alloc(BUILDER_RPC_MAX_BODY_BYTES + 1) }
    let result
    try { result = await rpc.handle({ path: request.url ?? '/', method: request.method ?? '', headers: { authorization: typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined }, body, signal: controller.signal }) }
    catch {
      if (cause === 'disconnect') return
      const status = cause === 'timeout' ? 504 : 503; const code = cause === 'timeout' ? 'DEADLINE_EXCEEDED' : 'SUPERVISOR_SHUTTING_DOWN'
      const body = Buffer.from(JSON.stringify({ ok: false, error: { code } }), 'utf8'); response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.byteLength), 'cache-control': 'no-store' }); response.end(body); return
    }
    response.writeHead(result.status, result.headers); response.end(result.body)
  } finally { options.signal?.removeEventListener('abort', shutdown); timeout.removeEventListener('abort', deadline) }
}

async function acquireLock(lockPath: string, socketPath: string, token: string, uid: number, nonce: string, processStartTicks: string, runtime: BuilderUnixRuntime): Promise<void> {
  try { await runtime.mkdir(lockPath, { mode: 0o700 }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (await authenticatedProbe(socketPath, token, runtime)) throw new Error('SUPERVISOR_ALREADY_RUNNING')
    await recoverDeadLock(lockPath, socketPath, uid, runtime); return acquireLock(lockPath, socketPath, token, uid, nonce, processStartTicks, runtime)
  }
  try { await runtime.writeFile(posix.join(lockPath, 'owner.json'), `${JSON.stringify({ nonce, pid: runtime.pid, process_start_ticks: processStartTicks, uid, socket_dev: null, socket_ino: null })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' }) }
  catch (error) { await runtime.remove(lockPath, { recursive: true, force: true }); throw error }
}

async function recoverDeadLock(lockPath: string, socketPath: string, uid: number, runtime: BuilderUnixRuntime): Promise<void> {
  await assertOwned(lockPath, uid, 0o077, runtime); const metadata = await readMetadata(lockPath, runtime)
  if (metadata.uid !== uid || await sameProcess(metadata.pid, metadata.process_start_ticks, runtime)) throw new Error('SUPERVISOR_LOCKED')
  const quarantine = `${lockPath}.stale-${randomBytes(16).toString('hex')}`
  await runtime.rename(lockPath, quarantine)
  try {
    try {
      const socket = await runtime.lstat(socketPath)
      if (!socket.isSocket() || socket.uid !== uid || metadata.socket_dev === null || metadata.socket_ino === null || socket.dev !== metadata.socket_dev || socket.ino !== metadata.socket_ino) throw new Error('SOCKET_IDENTITY_MISMATCH')
      await runtime.unlink(socketPath)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  } finally { await runtime.remove(quarantine, { recursive: true, force: true }) }
}

async function authenticatedProbe(socketPath: string, token: string, runtime: BuilderUnixRuntime): Promise<boolean> {
  const body = Buffer.from(JSON.stringify({ operation: 'preflight', body: { request_id: `req_${randomBytes(16).toString('hex')}` } }), 'utf8')
  try {
    return await new Promise(resolve => {
      const request = runtime.request({ socketPath, path: '/v1/rpc', method: 'POST', signal: AbortSignal.timeout(1_500), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': String(body.byteLength) } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode === 200 || response.statusCode === 409)) })
      request.once('error', () => resolve(false)); request.end(body)
    })
  } catch { return false }
}

async function ensureSocketDirectory(path: string, uid: number, runtime: BuilderUnixRuntime): Promise<void> {
  const missing: string[] = []; let current = path
  while (true) { try { await runtime.lstat(current); break } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; missing.push(current); const next = dirname(current); if (next === current) throw error; current = next } }
  await validateAncestors(current, uid, runtime); for (const item of missing.reverse()) await runtime.mkdir(item, { mode: 0o700 }); await assertOwned(path, uid, 0o007, runtime)
}
async function validateAncestors(path: string, uid: number, runtime: BuilderUnixRuntime): Promise<void> {
  let current = path
  while (true) {
    const stat = await runtime.lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== uid)) throw new Error('UNSAFE_SOCKET_DIRECTORY')
    const writable = (stat.mode & 0o022) !== 0; const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0
    if (writable && !stickyRoot && stat.uid !== uid) throw new Error('UNSAFE_SOCKET_DIRECTORY')
    const next = dirname(current); if (next === current) return; current = next
  }
}
async function assertOwned(path: string, uid: number, forbiddenMode: number, runtime: BuilderUnixRuntime): Promise<void> { if (await runtime.realpath(path) !== path) throw new Error('UNSAFE_SOCKET_DIRECTORY'); const stat = await runtime.lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & forbiddenMode) !== 0) throw new Error('UNSAFE_SOCKET_DIRECTORY') }
async function assertAbsent(path: string, runtime: BuilderUnixRuntime): Promise<void> { try { await runtime.lstat(path); throw new Error('SOCKET_PATH_OCCUPIED') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
async function safeUnlinkSocket(path: string, identity: { readonly dev: number; readonly ino: number }, uid: number, runtime: BuilderUnixRuntime): Promise<void> { try { const stat = await runtime.lstat(path); if (!stat.isSocket() || stat.uid !== uid || stat.dev !== identity.dev || stat.ino !== identity.ino) throw new Error('SOCKET_IDENTITY_MISMATCH'); await runtime.unlink(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
async function assertSocketIdentity(path: string, identity: { readonly dev: number; readonly ino: number }, uid: number, runtime: BuilderUnixRuntime): Promise<void> { const stat = await runtime.lstat(path); if (!stat.isSocket() || stat.uid !== uid || stat.dev !== identity.dev || stat.ino !== identity.ino) throw new Error('SOCKET_IDENTITY_MISMATCH') }
async function replaceMetadata(lockPath: string, metadata: LockMetadata, runtime: BuilderUnixRuntime): Promise<void> { const temp = posix.join(lockPath, `.owner-${metadata.nonce}`); await runtime.writeFile(temp, `${JSON.stringify(metadata)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); await runtime.rename(temp, posix.join(lockPath, 'owner.json')) }
async function readMetadata(lockPath: string, runtime: BuilderUnixRuntime): Promise<LockMetadata> { const handle = await runtime.open(posix.join(lockPath, 'owner.json'), constants.O_RDONLY | constants.O_NOFOLLOW); try { const stat = await handle.stat(); if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o177) !== 0 || stat.uid !== runtime.getuid!()) throw new Error('INVALID_LOCK_METADATA'); const value = JSON.parse(await handle.readFile('utf8')) as Record<string, unknown>; if (Object.keys(value).sort().join('\0') !== ['nonce', 'pid', 'process_start_ticks', 'socket_dev', 'socket_ino', 'uid'].join('\0') || typeof value.nonce !== 'string' || !/^[a-f0-9]{32}$/u.test(value.nonce) || !Number.isSafeInteger(value.pid) || Number(value.pid) < 1 || typeof value.process_start_ticks !== 'string' || !/^[0-9]+$/u.test(value.process_start_ticks) || !Number.isSafeInteger(value.uid) || Number(value.uid) < 0 || (value.socket_dev !== null && (!Number.isSafeInteger(value.socket_dev) || Number(value.socket_dev) < 0)) || (value.socket_ino !== null && (!Number.isSafeInteger(value.socket_ino) || Number(value.socket_ino) < 0))) throw new Error('INVALID_LOCK_METADATA'); return value as unknown as LockMetadata } finally { await handle.close() } }
async function releaseLock(lockPath: string, nonce: string, runtime: BuilderUnixRuntime): Promise<void> { try { if ((await readMetadata(lockPath, runtime)).nonce !== nonce) throw new Error('LOCK_IDENTITY_MISMATCH'); await runtime.remove(lockPath, { recursive: true }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
async function processStartIdentity(pid: number, runtime: BuilderUnixRuntime): Promise<string> { const stat = await runtime.readFile(`/proc/${pid}/stat`, 'utf8'); const end = stat.lastIndexOf(') '); const fields = end < 0 ? [] : stat.slice(end + 2).trim().split(/\s+/u); const start = fields[19]; if (start === undefined || !/^[0-9]+$/u.test(start)) throw new Error('PROCESS_IDENTITY_UNAVAILABLE'); return start }
async function sameProcess(pid: number, expectedStart: string, runtime: BuilderUnixRuntime): Promise<boolean> { try { runtime.kill(pid, 0); return await processStartIdentity(pid, runtime) === expectedStart } catch (error) { const code = (error as NodeJS.ErrnoException).code; if (code === 'ESRCH' || code === 'ENOENT') return false; throw error } }
async function closeOwnedSocket(path: string, identity: { readonly dev: number; readonly ino: number }, uid: number, server: Server, timeoutMs: number, runtime: BuilderUnixRuntime, afterStopAccepting?: () => void): Promise<void> {
  if (!server.listening) {
    afterStopAccepting?.()
    await safeUnlinkSocket(path, identity, uid, runtime)
    return
  }
  let current
  try { current = await runtime.lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await closeServerBounded(server, timeoutMs, runtime, afterStopAccepting)
      return
    }
    detachServerWithoutPathMutation(server, afterStopAccepting)
    throw error
  }
  const owned = current.isSocket() && current.uid === uid && current.dev === identity.dev && current.ino === identity.ino
  if (!owned) {
    detachServerWithoutPathMutation(server, afterStopAccepting)
    throw new Error('SOCKET_IDENTITY_MISMATCH')
  }
  await closeServerBounded(server, timeoutMs, runtime, afterStopAccepting)
  await safeUnlinkSocket(path, identity, uid, runtime)
}
function detachServerWithoutPathMutation(server: Server, afterStopAccepting?: () => void): void { server.closeIdleConnections(); server.closeAllConnections(); server.unref(); afterStopAccepting?.() }
async function closeServerBounded(server: Server, timeoutMs: number, runtime: BuilderUnixRuntime, afterStopAccepting?: () => void): Promise<void> {
  if (!server.listening) { afterStopAccepting?.(); return }
  server.closeIdleConnections()
  const closed = new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
  afterStopAccepting?.()
  const timer = runtime.setTimeout(() => server.closeAllConnections(), Math.min(timeoutMs, 5_000))
  await closed.finally(() => runtime.clearTimeout(timer))
}
async function readBounded(request: IncomingMessage): Promise<Buffer> { const chunks: Buffer[] = []; let size = 0; for await (const chunk of request) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.byteLength; if (size > BUILDER_RPC_MAX_BODY_BYTES) throw new Error('REQUEST_TOO_LARGE'); chunks.push(bytes) } return Buffer.concat(chunks) }
function validSocketPath(value: string): string { if (!posix.isAbsolute(value) || value.includes('\\') || value.includes('\0') || value.includes('://') || Buffer.byteLength(value, 'utf8') > BUILDER_UNIX_SOCKET_MAX_BYTES) throw new Error('INVALID_SOCKET_PATH'); const normalized = posix.normalize(value); if (normalized !== value) throw new Error('INVALID_SOCKET_PATH'); return normalized }
function validReplayRoot(value: string): string { if (!posix.isAbsolute(value) || value === '/' || value.includes('\\') || value.includes('\0') || value.includes('://') || value.endsWith('/')) throw new Error('INVALID_REPLAY_ROOT'); const normalized = posix.normalize(value); if (normalized !== value) throw new Error('INVALID_REPLAY_ROOT'); return normalized }
function failure(response: ServerResponse): void { if (response.writableEnded) return; const body = Buffer.from('{"error":"SUPERVISOR_UNAVAILABLE"}', 'utf8'); response.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.byteLength), 'cache-control': 'no-store' }); response.end(body) }
