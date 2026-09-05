import { lstatSync } from 'node:fs'
import { request as httpRequest, createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { createConnection, createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BuilderRpcMethods } from '../src/protocol.js'
import { listenBuilderUnix, type BuilderUnixRuntime } from '../src/unix-server.js'

const roots: string[] = []; const listeners: Array<{ close(): Promise<void> }> = []
const token = 'A'.repeat(43)
const replayNamespace = { instanceId: 'test-instance', policySha256: 'b'.repeat(64) }
type HttpHandler = (request: IncomingMessage, response: ServerResponse) => void
afterEach(async () => {
  await Promise.all(listeners.splice(0).map(item => item.close().catch(() => undefined)))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe.skipIf(process.platform === 'win32')('authenticated Unix builder socket', () => {
  it('creates mode 0660, rejects unauthenticated input and removes the socket', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-unix-')); roots.push(root)
    const socketPath = join(root, 'builder.sock').replaceAll('\\', '/')
    const initialize = vi.fn(async () => undefined); const methods = { ...fakeMethods(), initialize }
    const listener = await listenBuilderUnix({ socketPath, bearerToken: token, methods, replayNamespace }); listeners.push(listener)
    expect(initialize).toHaveBeenCalledTimes(1)
    expect((await lstat(socketPath)).mode & 0o777).toBe(0o660)
    expect(await send(socketPath, undefined)).toMatchObject({ status: 401 })
    expect(methods.preflight).not.toHaveBeenCalled()
    expect(await send(socketPath, token)).toMatchObject({ status: 200, body: { ok: true, result: { state: 'OK', protocol_version: 1 } } })
    await listener.close(); listeners.splice(0, 1)
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('carries the public test step and bounded termination fields over the real Unix wire', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-wire-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/')
    const methods = fakeMethods(); const listener = await listenBuilderUnix({ socketPath, bearerToken: token, methods, replayNamespace }); listeners.push(listener)
    const value = { operation: 'execute', body: { request_id: `req_${'b'.repeat(32)}`, build_ref: `build_${'a'.repeat(32)}`, step: 'test' } }
    const result = await sendValue(socketPath, token, value)
    expect(result).toEqual({ status: 200, body: { ok: true, result: { build_ref: `build_${'a'.repeat(32)}`, state: 'TEST_OK', step: 'test', result: { exit_code: 0, stdout: '', stderr: '', timed_out: false, termination_reason: null, output_limit_exceeded: false } } } })
    expect(methods.execute).toHaveBeenCalledWith(value.body, expect.any(AbortSignal))
  })

  it('replays the exact persisted response after a server restart without redispatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-persisted-wire-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/')
    const firstMethods = fakeMethods(); const first = await listenBuilderUnix({ socketPath, bearerToken: token, methods: firstMethods, replayNamespace })
    const request = { operation: 'preflight', body: { request_id: `req_${'c'.repeat(32)}` } }
    const expected = await sendValue(socketPath, token, request); await first.close()
    const secondMethods = fakeMethods(); const second = await listenBuilderUnix({ socketPath, bearerToken: token, methods: secondMethods, replayNamespace }); listeners.push(second)
    expect(await sendValue(socketPath, token, request)).toEqual(expected); expect(secondMethods.preflight).not.toHaveBeenCalled()
    await second.close(); listeners.splice(0, 1)
    const changedMethods = fakeMethods(); const changed = await listenBuilderUnix({ socketPath, bearerToken: token, methods: changedMethods, replayNamespace: { ...replayNamespace, policySha256: 'c'.repeat(64) } }); listeners.push(changed)
    expect(await sendValue(socketPath, token, request)).toEqual(expected); expect(changedMethods.preflight).toHaveBeenCalledTimes(1)
  })

  it('does not strand the exclusive lease when initialization fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-init-fail-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/')
    await expect(listenBuilderUnix({ socketPath, bearerToken: token, methods: { ...fakeMethods(), initialize: async () => { throw new Error('init failed') } }, replayNamespace })).rejects.toThrow('init failed')
    await expect(lstat(`${socketPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
    const listener = await listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace }); listeners.push(listener)
  })

  it('uses an authenticated probe and exclusive lease to reject split-brain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-lock-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/')
    const first = await listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace }); listeners.push(first)
    await expect(listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace })).rejects.toThrow('SUPERVISOR_ALREADY_RUNNING')
    expect(await send(socketPath, token)).toMatchObject({ status: 200 })
  })

  it('rejects invalid server authority before listening', async () => {
    const methods = fakeMethods()
    await expect(listenBuilderUnix({ socketPath: 'relative.sock', bearerToken: token, methods, replayNamespace })).rejects.toThrow('INVALID_SOCKET_PATH')
    await expect(listenBuilderUnix({ socketPath: '/tmp/../tmp/builder.sock', bearerToken: token, methods, replayNamespace })).rejects.toThrow('INVALID_SOCKET_PATH')
    await expect(listenBuilderUnix({ socketPath: '/tmp/builder.sock', bearerToken: 'short', methods, replayNamespace })).rejects.toThrow('INVALID_SUPERVISOR_TOKEN')
    await expect(listenBuilderUnix({ socketPath: '/tmp/builder.sock', bearerToken: token, methods, replayNamespace: { instanceId: '../bad', policySha256: 'x' } })).rejects.toThrow('INVALID_REPLAY_NAMESPACE')
    await expect(listenBuilderUnix({ socketPath: '/tmp/builder.sock', bearerToken: token, methods, replayNamespace: { instanceId: 'ok', policySha256: 'x' } })).rejects.toThrow('INVALID_REPLAY_NAMESPACE')
    await expect(listenBuilderUnix({ socketPath: '/tmp/bad\\socket', bearerToken: token, methods, replayNamespace })).rejects.toThrow('INVALID_SOCKET_PATH')
    await expect(listenBuilderUnix({ socketPath: '/tmp/bad\0socket', bearerToken: token, methods, replayNamespace })).rejects.toThrow('INVALID_SOCKET_PATH')
    await expect(listenBuilderUnix({ socketPath: 'http://localhost/socket', bearerToken: token, methods, replayNamespace })).rejects.toThrow('INVALID_SOCKET_PATH')
    await expect(listenBuilderUnix({ socketPath: '/tmp/builder.sock', bearerToken: token, methods, replayNamespace, operationTimeoutMs: 0 })).rejects.toThrow('INVALID_OPERATION_TIMEOUT')
  })

  it('rejects unsupported runtimes and unavailable process identity before acquiring authority', async () => {
    const methods = fakeMethods()
    await expect(listenBuilderUnix({ socketPath: '/tmp/builder.sock', bearerToken: token, methods, replayNamespace, runtime: unixRuntime({ platform: 'win32' }) })).rejects.toThrow('UNIX_SOCKET_REQUIRED')
    await expect(listenBuilderUnix({ socketPath: '/tmp/builder.sock', bearerToken: token, methods, replayNamespace, runtime: unixRuntime({ getuid: undefined }) })).rejects.toThrow('UNIX_SOCKET_REQUIRED')
    await expect(listenBuilderUnix({ socketPath: '/tmp/builder.sock', bearerToken: token, methods, replayNamespace, runtime: unixRuntime({ readFile: (async () => 'invalid') as unknown as typeof readFile }) })).rejects.toThrow('PROCESS_IDENTITY_UNAVAILABLE')
    await expect(listenBuilderUnix({ socketPath: '/tmp/builder.sock', bearerToken: token, methods, replayNamespace, runtime: unixRuntime({ readFile: (async () => '1 (x) S 1') as unknown as typeof readFile }) })).rejects.toThrow('PROCESS_IDENTITY_UNAVAILABLE')
  })

  it('creates and validates missing nested socket directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-nested-')); roots.push(root); const socketPath = join(root, 'one', 'two', 'builder.sock').replaceAll('\\', '/')
    const listener = await listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace }); listeners.push(listener)
    expect((await lstat(join(root, 'one', 'two'))).isDirectory()).toBe(true)
  })

  it('fails closed for occupied paths and unsafe writable socket directories', async () => {
    const occupiedRoot = await mkdtemp(join(tmpdir(), 'dz23-builder-occupied-')); roots.push(occupiedRoot); const occupied = join(occupiedRoot, 'builder.sock').replaceAll('\\', '/'); await writeFile(occupied, 'alien')
    await expect(listenBuilderUnix({ socketPath: occupied, bearerToken: token, methods: fakeMethods(), replayNamespace })).rejects.toThrow('SOCKET_PATH_OCCUPIED')
    const unsafeRoot = await mkdtemp(join(tmpdir(), 'dz23-builder-unsafe-')); roots.push(unsafeRoot); await chmod(unsafeRoot, 0o777)
    await expect(listenBuilderUnix({ socketPath: join(unsafeRoot, 'builder.sock').replaceAll('\\', '/'), bearerToken: token, methods: fakeMethods(), replayNamespace })).rejects.toThrow('UNSAFE_SOCKET_DIRECTORY')
  })

  it('bounds request bodies and aborts a cooperative slow RPC at the operation deadline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-deadline-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/')
    const methods = { ...fakeMethods(), preflight: vi.fn(async (_body: unknown, signal: AbortSignal) => { signal.throwIfAborted(); return new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) }) }
    const listener = await listenBuilderUnix({ socketPath, bearerToken: token, methods, replayNamespace, operationTimeoutMs: 50 }); listeners.push(listener)
    await expect(send(socketPath, token)).resolves.toMatchObject({ status: 500 })
    await expect(sendRaw(socketPath, token, Buffer.alloc(64 * 1024 + 1, 0x61))).resolves.toMatchObject({ status: 413 })
  })

  it('rejects corrupt or weak lock metadata without removing its evidence', async () => {
    const uid = process.getuid!(); const base = { nonce: 'a'.repeat(32), pid: 2_147_483_647, process_start_ticks: '1', uid, socket_dev: null, socket_ino: null }
    const invalid: unknown[] = [
      { ...base, extra: true }, { ...base, nonce: 'bad' }, { ...base, pid: 0 }, { ...base, process_start_ticks: 'bad' }, { ...base, uid: -1 }, { ...base, socket_dev: -1 }, { ...base, socket_ino: 'bad' },
    ]
    for (const [index, metadata] of invalid.entries()) {
      const root = await mkdtemp(join(tmpdir(), `dz23-builder-meta-${index}-`)); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/'); const lock = `${socketPath}.lock`
      await mkdir(lock, { mode: 0o700 }); await writeFile(join(lock, 'owner.json'), JSON.stringify(metadata), { mode: 0o600 })
      await expect(listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace })).rejects.toThrow('INVALID_LOCK_METADATA')
    }
    const weakRoot = await mkdtemp(join(tmpdir(), 'dz23-builder-meta-mode-')); roots.push(weakRoot); const weakSocket = join(weakRoot, 'builder.sock').replaceAll('\\', '/'); const weakLock = `${weakSocket}.lock`; await mkdir(weakLock, { mode: 0o700 }); await writeFile(join(weakLock, 'owner.json'), JSON.stringify(base), { mode: 0o666 }); await chmod(join(weakLock, 'owner.json'), 0o666)
    await expect(listenBuilderUnix({ socketPath: weakSocket, bearerToken: token, methods: fakeMethods(), replayNamespace })).rejects.toThrow('INVALID_LOCK_METADATA')
    const hardRoot = await mkdtemp(join(tmpdir(), 'dz23-builder-meta-link-')); roots.push(hardRoot); const hardSocket = join(hardRoot, 'builder.sock').replaceAll('\\', '/'); const hardLock = `${hardSocket}.lock`; await mkdir(hardLock, { mode: 0o700 }); const owner = join(hardLock, 'owner.json'); await writeFile(owner, JSON.stringify(base), { mode: 0o600 }); await link(owner, join(hardLock, 'copy.json'))
    await expect(listenBuilderUnix({ socketPath: hardSocket, bearerToken: token, methods: fakeMethods(), replayNamespace })).rejects.toThrow('INVALID_LOCK_METADATA')
  })

  it('detects lock ownership replacement during close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-lock-replace-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/'); const listener = await listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace })
    const owner = `${socketPath}.lock/owner.json`; const metadata = JSON.parse(await readFile(owner, 'utf8')) as Record<string, unknown>; metadata.nonce = 'f'.repeat(32); await writeFile(owner, JSON.stringify(metadata))
    await expect(listener.close()).rejects.toThrow('LOCK_IDENTITY_MISMATCH')
    await rm(`${socketPath}.lock`, { recursive: true, force: true })
  })

  it('fails closed and releases the lease when lock creation or owner persistence fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-runtime-lock-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/')
    const denied = new Error('denied') as NodeJS.ErrnoException; denied.code = 'EACCES'
    await expect(listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace, runtime: unixRuntime({ mkdir: (async path => { if (String(path).endsWith('.lock')) throw denied; return mkdir(path) }) as typeof mkdir }) })).rejects.toThrow('denied')
    let removed = false
    await expect(listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace, runtime: unixRuntime({ writeFile: (async path => { if (String(path).endsWith('owner.json')) throw new Error('write failed'); return writeFile(path, '') }) as typeof writeFile, remove: (async path => { removed = true; return rm(path, { recursive: true, force: true }) }) as typeof rm }) })).rejects.toThrow('write failed')
    expect(removed).toBe(true)
  })

  it('routes unexpected handler failures through the bounded 500 response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-handler-fail-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/')
    const methods = fakeMethods(); const createServer = ((handler: HttpHandler) => createHttpServer((request, response) => { const original = response.writeHead.bind(response); let first = true; response.writeHead = ((...args: Parameters<typeof response.writeHead>) => { if (first) { first = false; throw new Error('wire failed') } return original(...args) }) as typeof response.writeHead; handler(request, response) })) as typeof createHttpServer
    const listener = await listenBuilderUnix({ socketPath, bearerToken: token, methods, replayNamespace, runtime: unixRuntime({ createServer }) }); listeners.push(listener)
    await expect(send(socketPath, token)).resolves.toMatchObject({ status: 500, body: { error: 'SUPERVISOR_UNAVAILABLE' } })
  })

  it('recovers a dead lease only when its socket identity matches and probe transport throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-runtime-recover-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/'); const lock = `${socketPath}.lock`; const uid = process.getuid!(); await writeFile(socketPath, 'stale'); const stat = await lstat(socketPath)
    await mkdir(lock, { mode: 0o700 }); await writeFile(join(lock, 'owner.json'), JSON.stringify({ nonce: 'a'.repeat(32), pid: 2_147_483_647, process_start_ticks: '1', uid, socket_dev: stat.dev, socket_ino: stat.ino }), { mode: 0o600 })
    let staleRead = false; const runtime = unixRuntime({ request: (() => { throw new Error('probe failed') }) as typeof httpRequest, lstat: (async path => { if (path === socketPath && !staleRead) { staleRead = true; return { ...stat, isSocket: () => true } as never } return lstat(path) }) as typeof lstat })
    const listener = await listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace, runtime }); listeners.push(listener)
    expect((await lstat(socketPath)).isSocket()).toBe(true)
  })

  it('uses bounded close to destroy a held connection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-close-bound-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/'); let timerCalled = false
    const runtime = unixRuntime({ setTimeout: ((callback: (...args: unknown[]) => void) => setTimeout(() => { timerCalled = true; callback() }, 5)) as typeof setTimeout })
    const listener = await listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace, operationTimeoutMs: 10, runtime })
    const client = await new Promise<import('node:net').Socket>((resolve, reject) => { const socket = createConnection(socketPath, () => resolve(socket)); socket.once('error', reject) })
    await listener.close(); client.destroy(); expect(timerCalled).toBe(true)
  })

  it('closes and unlinks a bound server when post-listen socket attestation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-bound-fail-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/'); let socketReads = 0
    const runtime = unixRuntime({ lstat: (async path => { const stat = await lstat(path); if (path === socketPath && ++socketReads === 1) return { ...stat, isSocket: () => false } as never; return stat }) as typeof lstat })
    await expect(listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace, runtime })).rejects.toThrow('UNSAFE_SOCKET')
    await expect(lstat(`${socketPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('surfaces cleanup failures without leaving a live server after setup rejection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-cleanup-fail-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/'); const realCreate = createHttpServer
    const createServer = ((handler: Parameters<typeof realCreate>[0]) => { const server = realCreate(handler); const close = server.close.bind(server); server.close = ((callback?: (error?: Error) => void) => close(() => callback?.(new Error('close failed')))) as typeof server.close; return server }) as typeof realCreate
    const runtime = unixRuntime({ createServer, lstat: (async path => { const stat = await lstat(path); return path === socketPath ? { ...stat, isSocket: () => false } as never : stat }) as typeof lstat })
    await expect(listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace, runtime })).rejects.toThrow('close failed')
    const lockRoot = await mkdtemp(join(tmpdir(), 'dz23-builder-release-fail-')); roots.push(lockRoot); const lockSocket = join(lockRoot, 'builder.sock').replaceAll('\\', '/'); const remove = (async path => { if (String(path).endsWith('.lock')) throw new Error('release failed'); return rm(path, { recursive: true, force: true }) }) as typeof rm
    await expect(listenBuilderUnix({ socketPath: lockSocket, bearerToken: token, methods: { ...fakeMethods(), initialize: async () => { throw new Error('init failed') } }, replayNamespace, runtime: unixRuntime({ remove }) })).rejects.toThrow('release failed')
    await rm(`${lockSocket}.lock`, { recursive: true, force: true })
  })

  it('applies shutdown signals and treats a missing lock during close as already released', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-shutdown-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/'); const controller = new AbortController(); controller.abort(new Error('shutdown'))
    const listener = await listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace, signal: controller.signal }); expect(await send(socketPath, token)).toMatchObject({ status: 500 })
    await rm(`${socketPath}.lock`, { recursive: true }); await expect(listener.close()).resolves.toBeUndefined()
  })

  it('fails closed for non-ENOENT directory walks and unsafe ancestor identities', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-directory-runtime-')); roots.push(root); const socketPath = join(root, 'nested', 'builder.sock').replaceAll('\\', '/'); const denied = new Error('denied') as NodeJS.ErrnoException; denied.code = 'EACCES'
    await expect(listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace, runtime: unixRuntime({ lstat: (async path => { if (path === join(root, 'nested')) throw denied; return lstat(path) }) as typeof lstat }) })).rejects.toThrow('denied')
    const stat = await lstat(root)
    await expect(listenBuilderUnix({ socketPath: join(root, 'bad-owner.sock').replaceAll('\\', '/'), bearerToken: token, methods: fakeMethods(), replayNamespace, runtime: unixRuntime({ lstat: (async path => path === root ? statWith(stat, { uid: 0, mode: 0o40777 }) : lstat(path)) as typeof lstat }) })).rejects.toThrow('UNSAFE_SOCKET_DIRECTORY')
    await expect(listenBuilderUnix({ socketPath: join(root, 'not-dir.sock').replaceAll('\\', '/'), bearerToken: token, methods: fakeMethods(), replayNamespace, runtime: unixRuntime({ lstat: (async path => path === root ? { ...stat, isDirectory: () => false } as never : lstat(path)) as typeof lstat }) })).rejects.toThrow('UNSAFE_SOCKET_DIRECTORY')
    await expect(listenBuilderUnix({ socketPath: join(root, 'realpath.sock').replaceAll('\\', '/'), bearerToken: token, methods: fakeMethods(), replayNamespace, runtime: unixRuntime({ realpath: (async path => path === root ? `${root}-other` : realpath(path)) as typeof realpath }) })).rejects.toThrow('UNSAFE_SOCKET_DIRECTORY')
  })

  it('distinguishes missing and unexpected process-probe failures for a stale lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-process-probe-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/'); const lock = `${socketPath}.lock`; const uid = process.getuid!(); const start = await processStartTicks(process.pid)
    const metadata = { nonce: 'a'.repeat(32), pid: process.pid, process_start_ticks: `${Number(start) + 1}`, uid, socket_dev: null, socket_ino: null }
    await mkdir(lock, { mode: 0o700 }); await writeFile(join(lock, 'owner.json'), JSON.stringify(metadata), { mode: 0o600 })
    const missing = new Error('missing') as NodeJS.ErrnoException; missing.code = 'ENOENT'; let reads = 0; const runtime = unixRuntime({ readFile: (async path => ++reads === 1 ? readFile(path, 'utf8') : Promise.reject(missing)) as typeof readFile })
    const recovered = await listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace, runtime }); listeners.push(recovered); await recovered.close(); listeners.splice(0, 1)
    await mkdir(lock, { mode: 0o700 }); await writeFile(join(lock, 'owner.json'), JSON.stringify(metadata), { mode: 0o600 })
    const denied = new Error('denied') as NodeJS.ErrnoException; denied.code = 'EPERM'; await expect(listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace, runtime: unixRuntime({ kill: (() => { throw denied }) as typeof process.kill }) })).rejects.toThrow('denied')
  })

  it('recovers only a dead owned lease and refuses a live owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-recover-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/'); const lock = `${socketPath}.lock`; const uid = process.getuid!()
    await mkdir(lock, { mode: 0o700 }); await writeFile(join(lock, 'owner.json'), JSON.stringify({ nonce: 'a'.repeat(32), pid: 2_147_483_647, process_start_ticks: '1', uid, socket_dev: null, socket_ino: null }), { mode: 0o600 })
    const recovered = await listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace }); listeners.push(recovered); await recovered.close(); listeners.splice(0, 1)
    const start = await processStartTicks(process.pid)
    await mkdir(lock, { mode: 0o700 }); await writeFile(join(lock, 'owner.json'), JSON.stringify({ nonce: 'b'.repeat(32), pid: process.pid, process_start_ticks: start, uid, socket_dev: null, socket_ino: null }), { mode: 0o600 })
    await expect(listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace })).rejects.toThrow('SUPERVISOR_LOCKED')
    await rm(lock, { recursive: true }); await mkdir(lock, { mode: 0o700 }); await writeFile(join(lock, 'owner.json'), JSON.stringify({ nonce: 'd'.repeat(32), pid: process.pid, process_start_ticks: `${Number(start) + 1}`, uid, socket_dev: null, socket_ino: null }), { mode: 0o600 })
    const reused = await listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace }); listeners.push(reused)
  })

  it('preserves an alien socket when stale metadata or close-time inode does not match', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-inode-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/'); const lock = `${socketPath}.lock`; const uid = process.getuid!()
    await mkdir(lock, { mode: 0o700 }); await writeFile(join(lock, 'owner.json'), JSON.stringify({ nonce: 'c'.repeat(32), pid: 2_147_483_647, process_start_ticks: '1', uid, socket_dev: 1, socket_ino: 1 }), { mode: 0o600 })
    const alien = createNetServer(socket => socket.destroy()); await new Promise<void>((resolve, reject) => { alien.once('error', reject); alien.listen(socketPath, resolve) })
    await expect(listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace })).rejects.toThrow('SOCKET_IDENTITY_MISMATCH'); expect((await lstat(socketPath)).isSocket()).toBe(true)
    await new Promise<void>(resolve => alien.close(() => resolve())); await unlink(socketPath).catch(() => undefined); await rm(lock, { recursive: true, force: true })
    const listener = await listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace }); const original = await lstat(socketPath); await unlink(socketPath)
    const replacement = createNetServer(socket => socket.destroy()); await new Promise<void>((resolve, reject) => { replacement.once('error', reject); replacement.listen(socketPath, resolve) }); expect((await lstat(socketPath)).ino).not.toBe(original.ino)
    await expect(listener.close()).rejects.toThrow('SOCKET_IDENTITY_MISMATCH'); expect((await lstat(socketPath)).isSocket()).toBe(true); await new Promise<void>(resolve => replacement.close(() => resolve())); await new Promise<void>(resolve => listener.server.close(() => resolve())); await rm(lock, { recursive: true, force: true })
  })

  it('fails closed when the synchronous and asynchronous bound socket identities disagree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-bind-race-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/'); let boundStat: ReturnType<typeof lstatSync> | undefined
    const runtime = unixRuntime({
      lstatSync: ((path: string) => { boundStat = lstatSync(path); return { ...boundStat, dev: boundStat.dev + 1 } }) as typeof lstatSync,
    })
    await expect(listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace, runtime })).rejects.toThrow('SOCKET_IDENTITY_MISMATCH')
    expect(boundStat).toBeDefined(); await unlink(socketPath).catch(() => undefined); await rm(`${socketPath}.lock`, { recursive: true, force: true })

    const cleanupRoot = await mkdtemp(join(tmpdir(), 'dz23-builder-unlink-fail-')); roots.push(cleanupRoot); const cleanupPath = join(cleanupRoot, 'builder.sock').replaceAll('\\', '/'); let reads = 0; let realClose: typeof import('node:http').Server.prototype.close | undefined
    const createServer = ((handler: HttpHandler) => { const server = createHttpServer(handler); realClose = server.close.bind(server); server.close = ((callback?: (error?: Error) => void) => (callback?.(), server)) as typeof server.close; return server }) as typeof createHttpServer
    const cleanupRuntime = unixRuntime({
      createServer,
      lstat: (async path => { const stat = await lstat(path); if (path === cleanupPath && ++reads === 2) return { ...stat, isSocket: () => false } as never; return stat }) as typeof lstat,
      unlink: (async path => { if (path === cleanupPath) throw new Error('unlink failed'); return unlink(path) }) as typeof unlink,
    })
    await expect(listenBuilderUnix({ socketPath: cleanupPath, bearerToken: token, methods: fakeMethods(), replayNamespace, runtime: cleanupRuntime })).rejects.toThrow('unlink failed')
    await new Promise<void>(resolve => realClose!(() => resolve())); await unlink(cleanupPath).catch(() => undefined); await rm(`${cleanupPath}.lock`, { recursive: true, force: true })
  })

  it('aborts a live RPC when its client disconnects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-disconnect-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/'); let aborted = false
    const methods = { ...fakeMethods(), preflight: vi.fn(async (_body: unknown, signal: AbortSignal) => new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason) }, { once: true }))) }
    const listener = await listenBuilderUnix({ socketPath, bearerToken: token, methods, replayNamespace, operationTimeoutMs: 1_000 }); listeners.push(listener)
    const client = createConnection(socketPath); await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('error', reject) })
    const body = JSON.stringify({ operation: 'preflight', body: { request_id: `req_${'7'.repeat(32)}` } })
    client.write(`POST /v1/rpc HTTP/1.1\r\nHost: local\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
    await vi.waitFor(() => expect(methods.preflight).toHaveBeenCalledTimes(1)); client.destroy()
    await vi.waitFor(() => expect(aborted).toBe(true))
  })

  it('accepts a conflict response as proof of a live authenticated supervisor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-probe-conflict-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/'); const lock = `${socketPath}.lock`
    const foreign = createHttpServer((_request, response) => { response.writeHead(409); response.end() }); await new Promise<void>((resolve, reject) => { foreign.once('error', reject); foreign.listen(socketPath, resolve) })
    await mkdir(lock, { mode: 0o700 })
    await expect(listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace })).rejects.toThrow('SUPERVISOR_ALREADY_RUNNING')
    await new Promise<void>(resolve => foreign.close(() => resolve())); await unlink(socketPath).catch(() => undefined); await rm(lock, { recursive: true, force: true })
  })

  it('fails closed when no safe ancestor exists for a socket directory', async () => {
    const missing = new Error('missing') as NodeJS.ErrnoException; missing.code = 'ENOENT'
    await expect(listenBuilderUnix({ socketPath: '/builder.sock', bearerToken: token, methods: fakeMethods(), replayNamespace, runtime: unixRuntime({ lstat: (async () => { throw missing }) as typeof lstat }) })).rejects.toThrow('missing')
  })

  it('revalidates every socket identity component before unlink and tolerates an absent owned socket', async () => {
    const variants = [
      (stat: Awaited<ReturnType<typeof lstat>>) => statWith(stat, { isSocket: () => false }),
      (stat: Awaited<ReturnType<typeof lstat>>) => statWith(stat, { uid: Number(stat.uid) + 1 }),
      (stat: Awaited<ReturnType<typeof lstat>>) => statWith(stat, { dev: Number(stat.dev) + 1 }),
      (stat: Awaited<ReturnType<typeof lstat>>) => statWith(stat, { ino: Number(stat.ino) + 1 }),
    ]
    for (const [index, mutate] of variants.entries()) {
      const root = await mkdtemp(join(tmpdir(), `dz23-builder-unlink-${index}-`)); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/'); let interceptClose = false; let closeReads = 0; let realClose: typeof import('node:http').Server.prototype.close | undefined
      const createServer = ((handler: HttpHandler) => { const server = createHttpServer(handler); realClose = server.close.bind(server); server.close = ((callback?: (error?: Error) => void) => interceptClose ? (callback?.(), server) : realClose!(callback)) as typeof server.close; return server }) as typeof createHttpServer
      const runtime = unixRuntime({ createServer, lstat: (async path => { const stat = await lstat(path); if (interceptClose && path === socketPath && ++closeReads === 2) return mutate(stat) as never; return stat }) as typeof lstat })
      const listener = await listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace, runtime }); interceptClose = true
      await expect(listener.close()).rejects.toThrow('SOCKET_IDENTITY_MISMATCH'); interceptClose = false; await new Promise<void>(resolve => realClose!(() => resolve())); await unlink(socketPath).catch(() => undefined); await rm(`${socketPath}.lock`, { recursive: true, force: true })
    }
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-unlink-missing-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/'); let interceptClose = false; let closeReads = 0; let realClose: typeof import('node:http').Server.prototype.close | undefined
    const missing = new Error('missing') as NodeJS.ErrnoException; missing.code = 'ENOENT'
    const createServer = ((handler: HttpHandler) => { const server = createHttpServer(handler); realClose = server.close.bind(server); server.close = ((callback?: (error?: Error) => void) => interceptClose ? (callback?.(), server) : realClose!(callback)) as typeof server.close; return server }) as typeof createHttpServer
    const runtime = unixRuntime({ createServer, lstat: (async path => { if (interceptClose && path === socketPath && ++closeReads === 2) throw missing; return lstat(path) }) as typeof lstat })
    const listener = await listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace, runtime }); interceptClose = true; await expect(listener.close()).resolves.toBeUndefined(); interceptClose = false; await new Promise<void>(resolve => realClose!(() => resolve())); await rm(`${socketPath}.lock`, { recursive: true, force: true })
  })

  it('handles an already-stopped server and fail-closes unusual HTTP message shapes', async () => {
    const stoppedRoot = await mkdtemp(join(tmpdir(), 'dz23-builder-stopped-')); roots.push(stoppedRoot); const stoppedPath = join(stoppedRoot, 'builder.sock').replaceAll('\\', '/'); let stopped = false; let stoppedReads = 0; let saved: Awaited<ReturnType<typeof lstat>> | undefined
    const stoppedRuntime = unixRuntime({ lstat: (async path => { if (path !== stoppedPath || !stopped) { const value = await lstat(path); if (path === stoppedPath) saved = value; return value } if (++stoppedReads === 1) return saved!; const error = new Error('missing') as NodeJS.ErrnoException; error.code = 'ENOENT'; throw error }) as typeof lstat })
    const stoppedListener = await listenBuilderUnix({ socketPath: stoppedPath, bearerToken: token, methods: fakeMethods(), replayNamespace, runtime: stoppedRuntime })
    await new Promise<void>(resolve => stoppedListener.server.close(() => resolve())); stopped = true; await expect(stoppedListener.close()).resolves.toBeUndefined()

    const proxyRoot = await mkdtemp(join(tmpdir(), 'dz23-builder-http-shape-')); roots.push(proxyRoot); const proxyPath = join(proxyRoot, 'builder.sock').replaceAll('\\', '/')
    const createServer = ((handler: HttpHandler) => createHttpServer((request, response) => {
      const wrapped = new Proxy(request, { get(target, property, receiver) {
        if (property === 'url' || property === 'method') return undefined
        if (property === Symbol.asyncIterator) return async function* () { yield JSON.stringify({ operation: 'preflight', body: { request_id: `req_${'8'.repeat(32)}` } }) }
        const value = Reflect.get(target, property, receiver); return typeof value === 'function' ? value.bind(target) : value
      } })
      const originalEnd = response.end.bind(response); let throwOnce = true
      response.end = ((...args: Parameters<typeof response.end>) => { const result = originalEnd(...args); if (throwOnce) { throwOnce = false; throw new Error('after end') } return result }) as typeof response.end
      handler(wrapped, response)
    })) as typeof createHttpServer
    const proxied = await listenBuilderUnix({ socketPath: proxyPath, bearerToken: token, methods: fakeMethods(), replayNamespace, runtime: unixRuntime({ createServer }) }); listeners.push(proxied)
    await expect(send(proxyPath, token)).resolves.toMatchObject({ status: 404 })
  })
})

function fakeMethods(): BuilderRpcMethods {
  return {
    preflight: vi.fn(async () => ({ state: 'OK' as const, protocol_version: 1 as const, instance_id: 'test-instance', image_id: `sha256:${'a'.repeat(64)}` as const, policy_sha256: 'b'.repeat(64) })),
    prepare: vi.fn(async () => ({ build_ref: `build_${'a'.repeat(32)}`, state: 'PREPARED' as const })),
    execute: vi.fn(async (body: Parameters<BuilderRpcMethods['execute']>[0]) => ({ build_ref: body.build_ref, state: ({ install: 'INSTALL_OK', build: 'BUILD_OK', test: 'TEST_OK', e2e: 'E2E_OK' } as const)[body.step], step: body.step, result: { exit_code: 0, stdout: '', stderr: '', timed_out: false, termination_reason: null, output_limit_exceeded: false } })),
    cancel: vi.fn(async body => ({ build_ref: body.build_ref, state: 'CANCELLED' as const })),
    finish: vi.fn(async body => ({ build_ref: body.build_ref, final_state: 'E2E_OK' as const, exported: null, cleanup_pending: false, cleaned: true })),
    listManaged: vi.fn(async () => ({ builds: [] })),
  }
}

async function send(socketPath: string, bearer: string | undefined): Promise<{ readonly status: number; readonly body: unknown }> {
  const body = Buffer.from(JSON.stringify({ operation: 'preflight', body: { request_id: `req_${'a'.repeat(32)}` } }))
  return sendRaw(socketPath, bearer, body)
}
async function sendValue(socketPath: string, bearer: string | undefined, value: unknown): Promise<{ readonly status: number; readonly body: unknown }> {
  return sendRaw(socketPath, bearer, Buffer.from(JSON.stringify(value)))
}
async function sendRaw(socketPath: string, bearer: string | undefined, body: Buffer): Promise<{ readonly status: number; readonly body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath, path: '/v1/rpc', method: 'POST', headers: {
      'content-type': 'application/json', 'content-length': String(body.byteLength), ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
    } }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }))
    })
    request.once('error', reject); request.end(body)
  })
}
async function processStartTicks(pid: number): Promise<string> { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/u)[19]! }
function unixRuntime(overrides: Partial<BuilderUnixRuntime> = {}): BuilderUnixRuntime {
  return { platform: process.platform, pid: process.pid, getuid: process.getuid, kill: process.kill.bind(process), umask: process.umask.bind(process), lstatSync, chmod, lstat, mkdir, open, readFile, realpath, rename, remove: rm, unlink, writeFile, createServer: createHttpServer, request: httpRequest, setTimeout, clearTimeout, ...overrides }
}
function statWith<T extends object>(stat: T, values: Partial<Record<PropertyKey, unknown>>): T { return new Proxy(stat, { get(target, property, receiver) { return Object.prototype.hasOwnProperty.call(values, property) ? values[property] : Reflect.get(target, property, receiver) } }) }
