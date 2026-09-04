import { request as httpRequest } from 'node:http'
import { chmod, lstat, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BuilderRpcMethods } from '../src/protocol.js'
import { listenBuilderUnix } from '../src/unix-server.js'

const roots: string[] = []; const listeners: Array<{ close(): Promise<void> }> = []
const token = 'A'.repeat(43)
afterEach(async () => {
  await Promise.all(listeners.splice(0).map(item => item.close().catch(() => undefined)))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe.skipIf(process.platform === 'win32')('authenticated Unix builder socket', () => {
  it('creates mode 0660, rejects unauthenticated input and removes the socket', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-unix-')); roots.push(root)
    const socketPath = join(root, 'builder.sock').replaceAll('\\', '/')
    const initialize = vi.fn(async () => undefined); const methods = { ...fakeMethods(), initialize }
    const listener = await listenBuilderUnix({ socketPath, bearerToken: token, methods }); listeners.push(listener)
    expect(initialize).toHaveBeenCalledTimes(1)
    expect((await lstat(socketPath)).mode & 0o777).toBe(0o660)
    expect(await send(socketPath, undefined)).toMatchObject({ status: 401 })
    expect(methods.preflight).not.toHaveBeenCalled()
    expect(await send(socketPath, token)).toEqual({ status: 200, body: { ok: true, result: { state: 'OK' } } })
    await listener.close(); listeners.splice(0, 1)
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uses an authenticated probe and exclusive lease to reject split-brain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-lock-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/')
    const first = await listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods() }); listeners.push(first)
    await expect(listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods() })).rejects.toThrow('SUPERVISOR_ALREADY_RUNNING')
    expect(await send(socketPath, token)).toMatchObject({ status: 200 })
  })

  it('rejects invalid server authority before listening', async () => {
    const methods = fakeMethods()
    await expect(listenBuilderUnix({ socketPath: 'relative.sock', bearerToken: token, methods })).rejects.toThrow('INVALID_SOCKET_PATH')
    await expect(listenBuilderUnix({ socketPath: '/tmp/../tmp/builder.sock', bearerToken: token, methods })).rejects.toThrow('INVALID_SOCKET_PATH')
    await expect(listenBuilderUnix({ socketPath: '/tmp/builder.sock', bearerToken: 'short', methods })).rejects.toThrow('INVALID_SUPERVISOR_TOKEN')
  })

  it('fails closed for occupied paths and unsafe writable socket directories', async () => {
    const occupiedRoot = await mkdtemp(join(tmpdir(), 'dz23-builder-occupied-')); roots.push(occupiedRoot); const occupied = join(occupiedRoot, 'builder.sock').replaceAll('\\', '/'); await writeFile(occupied, 'alien')
    await expect(listenBuilderUnix({ socketPath: occupied, bearerToken: token, methods: fakeMethods() })).rejects.toThrow('SOCKET_PATH_OCCUPIED')
    const unsafeRoot = await mkdtemp(join(tmpdir(), 'dz23-builder-unsafe-')); roots.push(unsafeRoot); await chmod(unsafeRoot, 0o777)
    await expect(listenBuilderUnix({ socketPath: join(unsafeRoot, 'builder.sock').replaceAll('\\', '/'), bearerToken: token, methods: fakeMethods() })).rejects.toThrow('UNSAFE_SOCKET_DIRECTORY')
  })

  it('bounds request bodies and aborts a cooperative slow RPC at the operation deadline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-deadline-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/')
    const methods = { ...fakeMethods(), preflight: vi.fn(async (_body: unknown, signal: AbortSignal) => new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))) }
    const listener = await listenBuilderUnix({ socketPath, bearerToken: token, methods, operationTimeoutMs: 50 }); listeners.push(listener)
    await expect(send(socketPath, token)).resolves.toMatchObject({ status: 500 })
  })

  it('recovers only a dead owned lease and refuses a live owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-recover-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/'); const lock = `${socketPath}.lock`; const uid = process.getuid!()
    await mkdir(lock, { mode: 0o700 }); await writeFile(join(lock, 'owner.json'), JSON.stringify({ nonce: 'a'.repeat(32), pid: 2_147_483_647, uid, socket_dev: null, socket_ino: null }), { mode: 0o600 })
    const recovered = await listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods() }); listeners.push(recovered); await recovered.close(); listeners.splice(0, 1)
    await mkdir(lock, { mode: 0o700 }); await writeFile(join(lock, 'owner.json'), JSON.stringify({ nonce: 'b'.repeat(32), pid: process.pid, uid, socket_dev: null, socket_ino: null }), { mode: 0o600 })
    await expect(listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods() })).rejects.toThrow('SUPERVISOR_LOCKED')
  })

  it('preserves an alien socket when stale metadata or close-time inode does not match', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-inode-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/'); const lock = `${socketPath}.lock`; const uid = process.getuid!()
    await mkdir(lock, { mode: 0o700 }); await writeFile(join(lock, 'owner.json'), JSON.stringify({ nonce: 'c'.repeat(32), pid: 2_147_483_647, uid, socket_dev: 1, socket_ino: 1 }), { mode: 0o600 })
    const alien = createNetServer(socket => socket.destroy()); await new Promise<void>((resolve, reject) => { alien.once('error', reject); alien.listen(socketPath, resolve) })
    await expect(listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods() })).rejects.toThrow('SOCKET_IDENTITY_MISMATCH'); expect((await lstat(socketPath)).isSocket()).toBe(true)
    await new Promise<void>(resolve => alien.close(() => resolve())); await unlink(socketPath).catch(() => undefined); await rm(lock, { recursive: true, force: true })
    const listener = await listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods() }); const original = await lstat(socketPath); await unlink(socketPath)
    const replacement = createNetServer(socket => socket.destroy()); await new Promise<void>((resolve, reject) => { replacement.once('error', reject); replacement.listen(socketPath, resolve) }); expect((await lstat(socketPath)).ino).not.toBe(original.ino)
    await expect(listener.close()).rejects.toThrow('SOCKET_IDENTITY_MISMATCH'); expect((await lstat(socketPath)).isSocket()).toBe(true); await new Promise<void>(resolve => replacement.close(() => resolve())); await new Promise<void>(resolve => listener.server.close(() => resolve())); await rm(lock, { recursive: true, force: true })
  })
})

function fakeMethods(): BuilderRpcMethods {
  return {
    preflight: vi.fn(async () => ({ state: 'OK' as const })),
    prepare: vi.fn(async () => ({ build_ref: `build_${'a'.repeat(32)}`, state: 'PREPARED' as const })),
    execute: vi.fn(async body => ({ build_ref: body.build_ref, state: 'INSTALL_OK' as const, step: body.step, result: { exit_code: 0, stdout: '', stderr: '', timed_out: false, output_limited: false } })),
    cancel: vi.fn(async body => ({ build_ref: body.build_ref, state: 'CANCELLED' as const })),
    finish: vi.fn(async body => ({ build_ref: body.build_ref, final_state: 'E2E_OK' as const, exported: null, cleanup_pending: false, cleaned: true })),
    listManaged: vi.fn(async () => ({ builds: [] })),
  }
}

async function send(socketPath: string, bearer: string | undefined): Promise<{ readonly status: number; readonly body: unknown }> {
  const body = Buffer.from(JSON.stringify({ operation: 'preflight', body: { request_id: `req_${'a'.repeat(32)}` } }))
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
