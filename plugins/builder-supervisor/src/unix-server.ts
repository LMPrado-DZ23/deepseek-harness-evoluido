import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, posix } from 'node:path'
import type { BuilderRpcMethods } from './protocol.js'
import { BUILDER_RPC_MAX_BODY_BYTES, createBuilderRpcHandler } from './protocol.js'
import { FileRpcReplayGuard } from './persistent-replay.js'

const CREDENTIAL_REFERENCE = 'file:/run/secrets/dz23-builder-supervisor-token'
interface LockMetadata { readonly nonce: string; readonly pid: number; readonly uid: number; readonly socket_dev: number | null; readonly socket_ino: number | null }
interface LifecycleMethods extends BuilderRpcMethods { initialize?(signal: AbortSignal): Promise<void> }
export interface BuilderUnixServerOptions { readonly socketPath: string; readonly bearerToken: string; readonly methods: LifecycleMethods; readonly signal?: AbortSignal; readonly operationTimeoutMs?: number }

export async function listenBuilderUnix(options: BuilderUnixServerOptions): Promise<{ readonly server: Server; close(): Promise<void> }> {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') throw new Error('UNIX_SOCKET_REQUIRED')
  const socketPath = validSocketPath(options.socketPath); const parent = dirname(socketPath); const lockPath = `${socketPath}.lock`; const uid = process.getuid(); const nonce = randomBytes(16).toString('hex')
  if (!/^[A-Za-z0-9_-]{43,200}$/u.test(options.bearerToken)) throw new Error('INVALID_SUPERVISOR_TOKEN')
  const timeoutMs = options.operationTimeoutMs ?? 30_000; if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('INVALID_OPERATION_TIMEOUT')
  await ensureSocketDirectory(parent, uid)
  let socketIdentity: { readonly dev: number; readonly ino: number } | undefined; let server: Server | undefined; let lockHeld = false
  try {
    await acquireLock(lockPath, socketPath, options.bearerToken, uid, nonce); lockHeld = true
    await options.methods.initialize?.(AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(timeoutMs)]))
    await assertAbsent(socketPath)
    const rpc = createBuilderRpcHandler({ credentialRef: CREDENTIAL_REFERENCE, credentials: { resolve: async () => options.bearerToken }, methods: options.methods, replay: new FileRpcReplayGuard(`${socketPath}.requests`) })
    server = createServer((request, response) => { void handle(request, response, options, timeoutMs, rpc).catch(() => failure(response)) })
    server.requestTimeout = timeoutMs; server.headersTimeout = Math.min(timeoutMs, 10_000); server.maxHeadersCount = 64
    const previousUmask = process.umask(0o117)
    try { await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(socketPath, () => { server!.off('error', reject); resolve() }) }) }
    finally { process.umask(previousUmask) }
    const bound = await lstat(socketPath)
    if (!bound.isSocket() || bound.uid !== uid) throw new Error('UNSAFE_SOCKET')
    socketIdentity = { dev: bound.dev, ino: bound.ino }
    await chmod(socketPath, 0o660); await assertSocketIdentity(socketPath, socketIdentity, uid)
    await replaceMetadata(lockPath, { nonce, pid: process.pid, uid, socket_dev: bound.dev, socket_ino: bound.ino })
  } catch (error) { await safeUnlinkSocket(socketPath, socketIdentity, uid); if (lockHeld) await releaseLock(lockPath, nonce); throw error }
  const activeServer = server
  return { server: activeServer, close: async () => {
    await assertSocketIdentity(socketPath, socketIdentity, uid)
    activeServer.closeIdleConnections()
    const closed = new Promise<void>(resolve => activeServer.close(() => resolve()))
    const timer = setTimeout(() => activeServer.closeAllConnections(), Math.min(timeoutMs, 5_000)); await closed.finally(() => clearTimeout(timer))
    await safeUnlinkSocket(socketPath, socketIdentity, uid); await releaseLock(lockPath, nonce)
  } }
}

async function handle(request: IncomingMessage, response: ServerResponse, options: BuilderUnixServerOptions, timeoutMs: number, rpc: ReturnType<typeof createBuilderRpcHandler>): Promise<void> {
  const controller = new AbortController(); const timeout = AbortSignal.timeout(timeoutMs); const abort = (reason?: unknown) => controller.abort(reason)
  const shutdown = () => abort(options.signal?.reason); const deadline = () => abort(timeout.reason)
  if (options.signal?.aborted === true) shutdown(); else options.signal?.addEventListener('abort', shutdown, { once: true })
  timeout.addEventListener('abort', deadline, { once: true }); request.once('aborted', () => abort()); response.once('close', () => { if (!response.writableEnded) abort() })
  try {
    let body: Buffer; try { body = await readBounded(request) } catch { body = Buffer.alloc(BUILDER_RPC_MAX_BODY_BYTES + 1) }
    const result = await rpc.handle({ path: request.url ?? '/', method: request.method ?? '', headers: { authorization: typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined }, body, signal: controller.signal })
    response.writeHead(result.status, result.headers); response.end(result.body)
  } finally { options.signal?.removeEventListener('abort', shutdown); timeout.removeEventListener('abort', deadline) }
}

async function acquireLock(lockPath: string, socketPath: string, token: string, uid: number, nonce: string): Promise<void> {
  try { await mkdir(lockPath, { mode: 0o700 }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (await authenticatedProbe(socketPath, token)) throw new Error('SUPERVISOR_ALREADY_RUNNING')
    await recoverDeadLock(lockPath, socketPath, uid); return acquireLock(lockPath, socketPath, token, uid, nonce)
  }
  try { await writeFile(posix.join(lockPath, 'owner.json'), `${JSON.stringify({ nonce, pid: process.pid, uid, socket_dev: null, socket_ino: null })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' }) }
  catch (error) { await rm(lockPath, { recursive: true, force: true }); throw error }
}

async function recoverDeadLock(lockPath: string, socketPath: string, uid: number): Promise<void> {
  await assertOwned(lockPath, uid, 0o077); const metadata = await readMetadata(lockPath)
  if (metadata.uid !== uid || processAlive(metadata.pid)) throw new Error('SUPERVISOR_LOCKED')
  const quarantine = `${lockPath}.stale-${randomBytes(16).toString('hex')}`
  await rename(lockPath, quarantine)
  try {
    try {
      const socket = await lstat(socketPath)
      if (!socket.isSocket() || socket.uid !== uid || metadata.socket_dev === null || metadata.socket_ino === null || socket.dev !== metadata.socket_dev || socket.ino !== metadata.socket_ino) throw new Error('SOCKET_IDENTITY_MISMATCH')
      await unlink(socketPath)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  } finally { await rm(quarantine, { recursive: true, force: true }) }
}

async function authenticatedProbe(socketPath: string, token: string): Promise<boolean> {
  const body = Buffer.from(JSON.stringify({ operation: 'preflight', body: { request_id: `req_${randomBytes(16).toString('hex')}` } }), 'utf8')
  try {
    return await new Promise(resolve => {
      const request = httpRequest({ socketPath, path: '/v1/rpc', method: 'POST', signal: AbortSignal.timeout(1_500), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': String(body.byteLength) } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode === 200 || response.statusCode === 409)) })
      request.once('error', () => resolve(false)); request.end(body)
    })
  } catch { return false }
}

async function ensureSocketDirectory(path: string, uid: number): Promise<void> {
  const missing: string[] = []; let current = path
  while (true) { try { await lstat(current); break } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; missing.push(current); const next = dirname(current); if (next === current) throw error; current = next } }
  await validateAncestors(current, uid); for (const item of missing.reverse()) await mkdir(item, { mode: 0o700 }); await assertOwned(path, uid, 0o007)
}
async function validateAncestors(path: string, uid: number): Promise<void> {
  let current = path
  while (true) {
    const stat = await lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== uid)) throw new Error('UNSAFE_SOCKET_DIRECTORY')
    const writable = (stat.mode & 0o022) !== 0; const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0
    if (writable && !stickyRoot && stat.uid !== uid) throw new Error('UNSAFE_SOCKET_DIRECTORY')
    const next = dirname(current); if (next === current) return; current = next
  }
}
async function assertOwned(path: string, uid: number, forbiddenMode: number): Promise<void> { if (await realpath(path) !== path) throw new Error('UNSAFE_SOCKET_DIRECTORY'); const stat = await lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & forbiddenMode) !== 0) throw new Error('UNSAFE_SOCKET_DIRECTORY') }
async function assertAbsent(path: string): Promise<void> { try { await lstat(path); throw new Error('SOCKET_PATH_OCCUPIED') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
async function safeUnlinkSocket(path: string, identity: { readonly dev: number; readonly ino: number } | undefined, uid: number): Promise<void> { if (identity === undefined) return; try { const stat = await lstat(path); if (!stat.isSocket() || stat.uid !== uid || stat.dev !== identity.dev || stat.ino !== identity.ino) throw new Error('SOCKET_IDENTITY_MISMATCH'); await unlink(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
async function assertSocketIdentity(path: string, identity: { readonly dev: number; readonly ino: number } | undefined, uid: number): Promise<void> { if (identity === undefined) throw new Error('SOCKET_IDENTITY_MISMATCH'); const stat = await lstat(path); if (!stat.isSocket() || stat.uid !== uid || stat.dev !== identity.dev || stat.ino !== identity.ino) throw new Error('SOCKET_IDENTITY_MISMATCH') }
async function replaceMetadata(lockPath: string, metadata: LockMetadata): Promise<void> { const temp = posix.join(lockPath, `.owner-${metadata.nonce}`); await writeFile(temp, `${JSON.stringify(metadata)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); await rename(temp, posix.join(lockPath, 'owner.json')) }
async function readMetadata(lockPath: string): Promise<LockMetadata> { const handle = await open(posix.join(lockPath, 'owner.json'), constants.O_RDONLY | constants.O_NOFOLLOW); try { const stat = await handle.stat(); if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o177) !== 0 || stat.uid !== process.getuid!()) throw new Error('INVALID_LOCK_METADATA'); const value = JSON.parse(await handle.readFile('utf8')) as Record<string, unknown>; if (typeof value.nonce !== 'string' || !/^[a-f0-9]{32}$/u.test(value.nonce) || !Number.isSafeInteger(value.pid) || Number(value.pid) < 1 || !Number.isSafeInteger(value.uid) || Number(value.uid) < 0 || (value.socket_dev !== null && (!Number.isSafeInteger(value.socket_dev) || Number(value.socket_dev) < 0)) || (value.socket_ino !== null && (!Number.isSafeInteger(value.socket_ino) || Number(value.socket_ino) < 0))) throw new Error('INVALID_LOCK_METADATA'); return value as unknown as LockMetadata } finally { await handle.close() } }
async function releaseLock(lockPath: string, nonce: string): Promise<void> { try { if ((await readMetadata(lockPath)).nonce !== nonce) throw new Error('LOCK_IDENTITY_MISMATCH'); await rm(lockPath, { recursive: true }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' } }
async function readBounded(request: IncomingMessage): Promise<Buffer> { const chunks: Buffer[] = []; let size = 0; for await (const chunk of request) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.byteLength; if (size > BUILDER_RPC_MAX_BODY_BYTES) throw new Error('REQUEST_TOO_LARGE'); chunks.push(bytes) } return Buffer.concat(chunks) }
function validSocketPath(value: string): string { if (!posix.isAbsolute(value) || value.includes('\\') || value.includes('\0') || value.includes('://')) throw new Error('INVALID_SOCKET_PATH'); const normalized = posix.normalize(value); if (normalized !== value) throw new Error('INVALID_SOCKET_PATH'); return normalized }
function failure(response: ServerResponse): void { if (response.writableEnded) return; const body = Buffer.from('{"error":"SUPERVISOR_UNAVAILABLE"}', 'utf8'); response.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.byteLength), 'cache-control': 'no-store' }); response.end(body) }
