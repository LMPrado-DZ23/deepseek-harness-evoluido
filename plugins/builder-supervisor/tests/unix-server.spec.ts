import { lstatSync } from 'node:fs'
import { request as httpRequest, createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { createConnection, createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVerifiedBuildArchive } from '../src/artifact.js'
import { ArtifactIngressStore } from '../src/artifact-ingress.js'
import { createArtifactIngressUnixClient } from '../src/artifact-ingress-client.js'
import type { BuilderRpcMethods } from '../src/protocol.js'
import { BuilderUnixListenerCleanupError, listenBuilderUnix as listenBuilderUnixActual, type BuilderUnixRuntime, type BuilderUnixServerOptions } from '../src/unix-server.js'

const roots: string[] = []; const listeners: Array<{ close(): Promise<void> }> = []
const token = 'A'.repeat(43)
const replayNamespace = { policySha256: 'b'.repeat(64), scopeId: `s_${'a'.repeat(48)}` }
type HttpHandler = (request: IncomingMessage, response: ServerResponse) => void
afterEach(async () => {
  await Promise.all(listeners.splice(0).map(item => item.close().catch(() => undefined)))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe.skipIf(process.platform === 'win32')('authenticated Unix builder socket', () => {
  it('streams an authenticated TAR through the production socket without a shared source path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-ingress-wire-')); roots.push(root)
    const source = join(root, 'source'); await mkdir(source); await writeFile(join(source, 'package.json'), '{}')
    const archive = await createVerifiedBuildArchive(root, 'source')
    const socketPath = join(root, 'builder.sock').replaceAll('\\', '/')
    const ingress = new ArtifactIngressStore({ spoolRoot: join(root, 'spool'), scopeId: replayNamespace.scopeId, imageDigest: `sha256:${'a'.repeat(64)}`, policySha256: replayNamespace.policySha256 })
    const listener = await listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace, artifactIngress: ingress }); listeners.push(listener)
    const client = createArtifactIngressUnixClient({ socketPath, credentialRef: 'file:/run/token', credentials: { resolve: async () => token } })
    const bytes = await readFile(archive.archivePath)
    const begun = await client.begin({ requestId: `req_${'1'.repeat(32)}`, buildId: 'wire-build', contentLength: bytes.byteLength, wireSha256: archive.wireSha256 })
    async function* chunks(): AsyncGenerator<Uint8Array> { yield bytes.subarray(0, 513); yield bytes.subarray(513) }
    await expect(client.upload({ uploadRef: begun.uploadRef, contentLength: bytes.byteLength, source: chunks() })).resolves.toMatchObject({ state: 'READY' })
    const claimed = await ingress.claim(begun.uploadRef, { buildId: 'wire-build', attestation: { state: 'OK', protocol_version: 1, scope_id: replayNamespace.scopeId as `s_${string}`, image_id: `sha256:${'a'.repeat(64)}`, policy_sha256: replayNamespace.policySha256 } })
    expect(claimed.artifact).toMatchObject({ files: 1, bytes: 2, archiveBytes: bytes.byteLength })
    await claimed.fail(); await archive.dispose()
  })

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
    await expect(sendArtifactRaw(socketPath, Buffer.from('not-a-tar'))).resolves.toEqual({ status: 503, body: { error: 'ARTIFACT_INGRESS_UNAVAILABLE' }, connection: 'close' })
    await listener.close(); listeners.splice(0, 1)
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed when an artifact request has no HTTP method', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-methodless-')); roots.push(root)
    const socketPath = join(root, 'builder.sock').replaceAll('\\', '/')
    const ingress = new ArtifactIngressStore({ spoolRoot: join(root, 'spool'), scopeId: replayNamespace.scopeId, imageDigest: `sha256:${'a'.repeat(64)}`, policySha256: replayNamespace.policySha256 })
    const createServer = ((handler: HttpHandler) => createHttpServer((request, response) => {
      const methodless = new Proxy(request, { get(target, property, receiver) { if (property === 'method') return undefined; const value = Reflect.get(target, property, receiver); return typeof value === 'function' ? value.bind(target) : value } })
      handler(methodless, response)
    })) as typeof createHttpServer
    const listener = await listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace, artifactIngress: ingress, runtime: unixRuntime({ createServer }) }); listeners.push(listener)
    await expect(sendArtifactRaw(socketPath, Buffer.from('not-a-tar'))).resolves.toMatchObject({ status: 405, body: { error: 'METHOD_NOT_ALLOWED' } })
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
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-persisted-wire-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/'); const replayRoot = join(root, 'persistent-state').replaceAll('\\', '/')
    const firstMethods = fakeMethods(); const first = await listenBuilderUnix({ socketPath, bearerToken: token, methods: firstMethods, replayNamespace, replayRoot })
    const request = { operation: 'preflight', body: { request_id: `req_${'c'.repeat(32)}` } }
    const expected = await sendValue(socketPath, token, request); await first.close()
    expect((await lstat(join(replayRoot, replayNamespace.scopeId, replayNamespace.policySha256))).mode & 0o777).toBe(0o700)
    await expect(lstat(`${socketPath}.requests`)).rejects.toMatchObject({ code: 'ENOENT' })
    const secondMethods = fakeMethods(); const second = await listenBuilderUnix({ socketPath, bearerToken: token, methods: secondMethods, replayNamespace, replayRoot }); listeners.push(second)
    expect(await sendValue(socketPath, token, request)).toEqual(expected); expect(secondMethods.preflight).not.toHaveBeenCalled()
    await second.close(); listeners.splice(0, 1)
    const changedMethods = fakeMethods(); const changed = await listenBuilderUnix({ socketPath, bearerToken: token, methods: changedMethods, replayNamespace: { ...replayNamespace, policySha256: 'c'.repeat(64) }, replayRoot }); listeners.push(changed)
    expect(await sendValue(socketPath, token, request)).toEqual(expected); expect(changedMethods.preflight).toHaveBeenCalledTimes(1)
  })

  it('fails closed before binding when the configured persistent replay root is not private', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-replay-mode-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/'); const replayRoot = join(root, 'persistent-state').replaceAll('\\', '/')
    await mkdir(replayRoot, { mode: 0o755 })
    await expect(listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace, replayRoot })).rejects.toThrow('UNSAFE_REPLAY_DIRECTORY')
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never replays one physical scope request inside another scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-cross-scope-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/'); const replayRoot = join(root, 'persistent-state').replaceAll('\\', '/')
    const request = { operation: 'preflight', body: { request_id: `req_${'d'.repeat(32)}` } }
    const firstMethods = fakeMethods(); const first = await listenBuilderUnix({ socketPath, bearerToken: token, methods: firstMethods, replayNamespace, replayRoot })
    await sendValue(socketPath, token, request); await first.close()
    const other = { ...replayNamespace, scopeId: `s_${'b'.repeat(48)}` }
    const secondMethods = fakeMethods(); const second = await listenBuilderUnix({ socketPath, bearerToken: token, methods: secondMethods, replayNamespace: other, replayRoot }); listeners.push(second)

    await expect(sendValue(socketPath, token, request)).resolves.toMatchObject({ status: 200 })
    expect(firstMethods.preflight).toHaveBeenCalledTimes(1)
    expect(secondMethods.preflight).toHaveBeenCalledTimes(1)
    expect((await lstat(join(replayRoot, replayNamespace.scopeId))).isDirectory()).toBe(true)
    expect((await lstat(join(replayRoot, other.scopeId))).isDirectory()).toBe(true)
  })

  it('does not strand the exclusive lease when initialization fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-init-fail-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/')
    await expect(listenBuilderUnix({ socketPath, bearerToken: token, methods: { ...fakeMethods(), initialize: async () => { throw new Error('init failed') } }, replayNamespace })).rejects.toThrow('init failed')
    await expect(lstat(`${socketPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
    const listener = await listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace }); listeners.push(listener)
  })

  it('never publishes a socket when startup is cancelled before or during listener binding', async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), 'dz23-builder-pre-abort-')); roots.push(firstRoot); const firstPath = join(firstRoot, 'builder.sock').replaceAll('\\', '/')
    const before = new AbortController(); before.abort(new Error('startup-cancelled'))
    const initialize = vi.fn(async () => undefined)
    await expect(listenBuilderUnix({ socketPath: firstPath, bearerToken: token, methods: { ...fakeMethods(), initialize }, replayNamespace, signal: before.signal })).rejects.toThrow('startup-cancelled')
    expect(initialize).not.toHaveBeenCalled()
    await expect(lstat(firstPath)).rejects.toMatchObject({ code: 'ENOENT' }); await expect(lstat(`${firstPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })

    const secondRoot = await mkdtemp(join(tmpdir(), 'dz23-builder-bind-abort-')); roots.push(secondRoot); const secondPath = join(secondRoot, 'builder.sock').replaceAll('\\', '/'); const during = new AbortController()
    const createServer = ((handler: HttpHandler) => {
      const server = createHttpServer(handler); const listen = server.listen.bind(server)
      server.listen = ((path: string, callback: () => void) => listen(path, () => { during.abort(new Error('binding-cancelled')); callback() })) as typeof server.listen
      return server
    }) as typeof createHttpServer
    await expect(listenBuilderUnix({ socketPath: secondPath, bearerToken: token, methods: fakeMethods(), replayNamespace, signal: during.signal, runtime: unixRuntime({ createServer }) })).rejects.toThrow('binding-cancelled')
    await expect(lstat(secondPath)).rejects.toMatchObject({ code: 'ENOENT' }); await expect(lstat(`${secondPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
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
    await expect(listenBuilderUnix({ socketPath: '/tmp/builder.sock', bearerToken: token, methods, replayNamespace: { policySha256: 'x', scopeId: replayNamespace.scopeId } })).rejects.toThrow('INVALID_REPLAY_NAMESPACE')
    await expect(listenBuilderUnix({ socketPath: '/tmp/builder.sock', bearerToken: token, methods, replayNamespace: { ...replayNamespace, scopeId: '../bad' } })).rejects.toThrow('INVALID_REPLAY_NAMESPACE')
    await expect(listenBuilderUnix({ socketPath: '/tmp/builder.sock', bearerToken: token, methods, replayNamespace, replayRoot: 'relative' })).rejects.toThrow('INVALID_REPLAY_ROOT')
    for (const replayRoot of ['/', '/tmp/replay\\bad', '/tmp/replay\0bad', 'http://localhost/replay', '/tmp/replay/', '/tmp/../tmp/replay']) {
      await expect(listenBuilderUnix({ socketPath: '/tmp/builder.sock', bearerToken: token, methods, replayNamespace, replayRoot })).rejects.toThrow('INVALID_REPLAY_ROOT')
    }
    await expect(listenBuilderUnix({ socketPath: '/tmp/bad\\socket', bearerToken: token, methods, replayNamespace })).rejects.toThrow('INVALID_SOCKET_PATH')
    await expect(listenBuilderUnix({ socketPath: '/tmp/bad\0socket', bearerToken: token, methods, replayNamespace })).rejects.toThrow('INVALID_SOCKET_PATH')
    await expect(listenBuilderUnix({ socketPath: 'http://localhost/socket', bearerToken: token, methods, replayNamespace })).rejects.toThrow('INVALID_SOCKET_PATH')
    const oversizedSocketPath = `/tmp/${'a'.repeat(103)}`
    expect(Buffer.byteLength(oversizedSocketPath, 'utf8')).toBe(108)
    await expect(listenBuilderUnix({ socketPath: oversizedSocketPath, bearerToken: token, methods, replayNamespace })).rejects.toThrow('INVALID_SOCKET_PATH')
    await expect(listenBuilderUnix({ socketPath: '/tmp/builder.sock', bearerToken: token, methods, replayNamespace, operationTimeoutMs: 0 })).rejects.toThrow('INVALID_OPERATION_TIMEOUT')
    await expect(listenBuilderUnix({ socketPath: '/tmp/builder.sock', bearerToken: token, methods, replayNamespace, operationTimeoutMs: 100, stepTimeoutMs: 80, cleanupTimeoutMs: 30 })).rejects.toThrow('INVALID_OPERATION_TIMEOUT')
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
    let slow = true; const methods = { ...fakeMethods(), preflight: vi.fn(async (_body: unknown, signal: AbortSignal) => { if (!slow) return { state: 'OK' as const, protocol_version: 1 as const, scope_id: replayNamespace.scopeId as `s_${string}`, image_id: `sha256:${'a'.repeat(64)}` as const, policy_sha256: 'b'.repeat(64) }; signal.throwIfAborted(); return new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) }) }
    const listener = await listenBuilderUnix({ socketPath, bearerToken: token, methods, replayNamespace, operationTimeoutMs: 50, stepTimeoutMs: 20, cleanupTimeoutMs: 20 }); listeners.push(listener)
    await expect(send(socketPath, token)).resolves.toMatchObject({ status: 504, body: { ok: false, error: { code: 'DEADLINE_EXCEEDED' } } })
    slow = false; await expect(send(socketPath, token)).resolves.toMatchObject({ status: 200 }); expect(methods.preflight).toHaveBeenCalledTimes(2)
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
    await expect(listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace, runtime: unixRuntime({ mkdir: (async (path, options) => { if (String(path).endsWith('.lock')) throw denied; return mkdir(path) }) as typeof mkdir }) })).rejects.toThrow('denied')
    let removed = false
    await expect(listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace, runtime: unixRuntime({ writeFile: (async (path, options) => { if (String(path).endsWith('owner.json')) throw new Error('write failed'); return writeFile(path, '') }) as typeof writeFile, remove: (async (path, options) => { removed = true; return rm(path, { recursive: true, force: true }) }) as typeof rm }) })).rejects.toThrow('write failed')
    expect(removed).toBe(true)
  })

  it('routes unexpected handler failures through the bounded 500 response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-handler-fail-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/')
    const methods = fakeMethods(); const createServer = ((handler: HttpHandler) => createHttpServer((request, response) => { const original = response.writeHead.bind(response); let first = true; response.writeHead = ((...args: Parameters<typeof response.writeHead>) => { if (first) { first = false; throw new Error('wire failed') } return original(...args) }) as typeof response.writeHead; handler(request, response) })) as typeof createHttpServer
    const listener = await listenBuilderUnix({ socketPath, bearerToken: token, methods, replayNamespace, runtime: unixRuntime({ createServer }) }); listeners.push(listener)
    await expect(send(socketPath, token)).resolves.toMatchObject({ status: 500, body: { error: 'SUPERVISOR_UNAVAILABLE' } })
  })

  it('recovers a dead lease only when its socket identity matches and probe transport throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-runtime-recover-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/'); const lock = `${socketPath}.lock`; const uid = process.getuid!(); await writeFile(socketPath, 'stale'); const stat = await lstat(socketPath); const born = await lstat(socketPath, { bigint: true })
    await mkdir(lock, { mode: 0o700 }); await writeFile(join(lock, 'owner.json'), JSON.stringify({ nonce: 'a'.repeat(32), pid: 2_147_483_647, process_start_ticks: '1', uid, socket_dev: stat.dev, socket_ino: stat.ino, socket_birthtime_ns: born.birthtimeNs.toString() }), { mode: 0o600 })
    let staleRead = false; const runtime = unixRuntime({ request: (() => { throw new Error('probe failed') }) as typeof httpRequest, lstat: (async (path, options) => { if (path === socketPath && !staleRead) { staleRead = true; return { ...(options === undefined ? stat : born), isSocket: () => true } as never } return lstat(path, options as never) }) as typeof lstat })
    const listener = await listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace, runtime }); listeners.push(listener)
    expect((await lstat(socketPath)).isSocket()).toBe(true)
  })

  it('uses bounded close to destroy a held connection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-close-bound-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/'); let timerCalled = false
    const runtime = unixRuntime({ setTimeout: ((callback: (...args: unknown[]) => void) => setTimeout(() => { timerCalled = true; callback() }, 5)) as typeof setTimeout })
    const listener = await listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace, operationTimeoutMs: 10, stepTimeoutMs: 4, cleanupTimeoutMs: 4, runtime })
    const client = await new Promise<import('node:net').Socket>((resolve, reject) => { const socket = createConnection(socketPath, () => resolve(socket)); socket.once('error', reject) })
    await listener.close(); client.destroy(); expect(timerCalled).toBe(true)
  })

  it('closes and unlinks a bound server when post-listen socket attestation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-bound-fail-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/'); let socketReads = 0
    const runtime = unixRuntime({ lstat: (async (path, options) => { const stat = await lstat(path, options as never); if (path === socketPath && ++socketReads === 1) return { ...stat, isSocket: () => false } as never; return stat }) as typeof lstat })
    await expect(listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace, runtime })).rejects.toThrow('UNSAFE_SOCKET')
    await expect(lstat(`${socketPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('surfaces cleanup failures without leaving a live server after setup rejection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-cleanup-fail-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/'); const realCreate = createHttpServer
    const createServer = ((handler: Parameters<typeof realCreate>[0]) => { const server = realCreate(handler); const close = server.close.bind(server); server.close = ((callback?: (error?: Error) => void) => close(() => callback?.(new Error('close failed')))) as typeof server.close; return server }) as typeof realCreate
    const runtime = unixRuntime({ createServer, lstat: (async (path, options) => { const stat = await lstat(path, options as never); return path === socketPath ? { ...stat, isSocket: () => false } as never : stat }) as typeof lstat })
    const closeFailure = listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace, runtime })
    await expect(closeFailure).rejects.toBeInstanceOf(BuilderUnixListenerCleanupError)
    await expect(closeFailure).rejects.toMatchObject({ code: 'LISTENER_CLEANUP_INCOMPLETE', message: 'LISTENER_CLEANUP_INCOMPLETE' })
    const lockRoot = await mkdtemp(join(tmpdir(), 'dz23-builder-release-fail-')); roots.push(lockRoot); const lockSocket = join(lockRoot, 'builder.sock').replaceAll('\\', '/'); const remove = (async (path, options) => { if (String(path).endsWith('.lock')) throw new Error('release failed'); return rm(path, { recursive: true, force: true }) }) as typeof rm
    const releaseFailure = listenBuilderUnix({ socketPath: lockSocket, bearerToken: token, methods: { ...fakeMethods(), initialize: async () => { throw new Error('init failed') } }, replayNamespace, runtime: unixRuntime({ remove }) })
    await expect(releaseFailure).rejects.toBeInstanceOf(BuilderUnixListenerCleanupError)
    await expect(releaseFailure).rejects.toMatchObject({ code: 'LISTENER_CLEANUP_INCOMPLETE', message: 'LISTENER_CLEANUP_INCOMPLETE' })
    await rm(`${lockSocket}.lock`, { recursive: true, force: true })
  })

  it('applies shutdown signals and treats a missing lock during close as already released', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-shutdown-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/'); const controller = new AbortController()
    const listener = await listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace, signal: controller.signal }); controller.abort(new Error('shutdown')); expect(await send(socketPath, token)).toMatchObject({ status: 503, body: { ok: false, error: { code: 'SUPERVISOR_SHUTTING_DOWN' } } })
    await rm(`${socketPath}.lock`, { recursive: true }); await expect(listener.close()).resolves.toBeUndefined()
  })

  it('fails closed for non-ENOENT directory walks and unsafe ancestor identities', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-directory-runtime-')); roots.push(root); const socketPath = join(root, 'nested', 'builder.sock').replaceAll('\\', '/'); const denied = new Error('denied') as NodeJS.ErrnoException; denied.code = 'EACCES'
    await expect(listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace, runtime: unixRuntime({ lstat: (async (path, options) => { if (path === join(root, 'nested')) throw denied; return lstat(path, options as never) }) as typeof lstat }) })).rejects.toThrow('denied')
    const stat = await lstat(root)
    await expect(listenBuilderUnix({ socketPath: join(root, 'bad-owner.sock').replaceAll('\\', '/'), bearerToken: token, methods: fakeMethods(), replayNamespace, runtime: unixRuntime({ lstat: (async (path, options) => path === root ? statWith(stat, { uid: 0, mode: 0o40777 }) : lstat(path, options as never)) as typeof lstat }) })).rejects.toThrow('UNSAFE_SOCKET_DIRECTORY')
    await expect(listenBuilderUnix({ socketPath: join(root, 'not-dir.sock').replaceAll('\\', '/'), bearerToken: token, methods: fakeMethods(), replayNamespace, runtime: unixRuntime({ lstat: (async (path, options) => path === root ? { ...stat, isDirectory: () => false } as never : lstat(path, options as never)) as typeof lstat }) })).rejects.toThrow('UNSAFE_SOCKET_DIRECTORY')
    await expect(listenBuilderUnix({ socketPath: join(root, 'realpath.sock').replaceAll('\\', '/'), bearerToken: token, methods: fakeMethods(), replayNamespace, runtime: unixRuntime({ realpath: (async (path, options) => path === root ? `${root}-other` : realpath(path)) as typeof realpath }) })).rejects.toThrow('UNSAFE_SOCKET_DIRECTORY')
  })

  it('distinguishes missing and unexpected process-probe failures for a stale lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-process-probe-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/'); const lock = `${socketPath}.lock`; const uid = process.getuid!(); const start = await processStartTicks(process.pid)
    const metadata = { nonce: 'a'.repeat(32), pid: process.pid, process_start_ticks: `${Number(start) + 1}`, uid, socket_dev: null, socket_ino: null }
    await mkdir(lock, { mode: 0o700 }); await writeFile(join(lock, 'owner.json'), JSON.stringify(metadata), { mode: 0o600 })
    const missing = new Error('missing') as NodeJS.ErrnoException; missing.code = 'ENOENT'; let reads = 0; const runtime = unixRuntime({ readFile: (async (path, options) => ++reads === 1 ? readFile(path, 'utf8') : Promise.reject(missing)) as typeof readFile })
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
      lstat: (async (path, options) => { const stat = await lstat(path, options as never); if (path === cleanupPath && ++reads === 2) return { ...stat, isSocket: () => false } as never; return stat }) as typeof lstat,
      unlink: (async path => { if (path === cleanupPath) throw new Error('unlink failed'); return unlink(path) }) as typeof unlink,
    })
    await expect(listenBuilderUnix({ socketPath: cleanupPath, bearerToken: token, methods: fakeMethods(), replayNamespace, runtime: cleanupRuntime })).rejects.toMatchObject({ code: 'LISTENER_CLEANUP_INCOMPLETE', message: 'LISTENER_CLEANUP_INCOMPLETE' })
    await new Promise<void>(resolve => realClose!(() => resolve())); await unlink(cleanupPath).catch(() => undefined); await rm(`${cleanupPath}.lock`, { recursive: true, force: true })
  })

  it('aborts a live RPC when its client disconnects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-disconnect-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/'); let aborted = false
    const methods = { ...fakeMethods(), preflight: vi.fn(async (_body: unknown, signal: AbortSignal) => new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason) }, { once: true }))) }
    const listener = await listenBuilderUnix({ socketPath, bearerToken: token, methods, replayNamespace, operationTimeoutMs: 1_000, stepTimeoutMs: 400, cleanupTimeoutMs: 400 }); listeners.push(listener)
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
      const runtime = unixRuntime({ createServer, lstat: (async (path, options) => { const stat = await lstat(path, options as never); if (interceptClose && path === socketPath && ++closeReads === 2) return mutate(stat) as never; return stat }) as typeof lstat })
      const listener = await listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace, runtime }); interceptClose = true
      await expect(listener.close()).rejects.toThrow('SOCKET_IDENTITY_MISMATCH'); interceptClose = false; await new Promise<void>(resolve => realClose!(() => resolve())); await unlink(socketPath).catch(() => undefined); await rm(`${socketPath}.lock`, { recursive: true, force: true })
    }
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-unlink-missing-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/'); let interceptClose = false; let closeReads = 0; let realClose: typeof import('node:http').Server.prototype.close | undefined
    const missing = new Error('missing') as NodeJS.ErrnoException; missing.code = 'ENOENT'
    const createServer = ((handler: HttpHandler) => { const server = createHttpServer(handler); realClose = server.close.bind(server); server.close = ((callback?: (error?: Error) => void) => interceptClose ? (callback?.(), server) : realClose!(callback)) as typeof server.close; return server }) as typeof createHttpServer
    const runtime = unixRuntime({ createServer, lstat: (async (path, options) => { if (interceptClose && path === socketPath && ++closeReads === 2) throw missing; return lstat(path, options as never) }) as typeof lstat })
    const listener = await listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace, runtime }); interceptClose = true; await expect(listener.close()).resolves.toBeUndefined(); interceptClose = false; await new Promise<void>(resolve => realClose!(() => resolve())); await rm(`${socketPath}.lock`, { recursive: true, force: true })
  })

  it('closes a live listener whose accepting path disappeared and releases its lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-close-missing-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/')
    const listener = await listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace })
    await unlink(socketPath)
    await expect(listener.close()).resolves.toBeUndefined()
    await expect(lstat(`${socketPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })

    const deniedRoot = await mkdtemp(join(tmpdir(), 'dz23-builder-close-denied-')); roots.push(deniedRoot); const deniedPath = join(deniedRoot, 'builder.sock').replaceAll('\\', '/'); let deny = false
    const denied = new Error('denied') as NodeJS.ErrnoException; denied.code = 'EACCES'
    const deniedListener = await listenBuilderUnix({ socketPath: deniedPath, bearerToken: token, methods: fakeMethods(), replayNamespace, runtime: unixRuntime({ lstat: (async (path, options) => deny && path === deniedPath ? Promise.reject(denied) : lstat(path, options as never)) as typeof lstat }) })
    deny = true; await expect(deniedListener.close()).rejects.toThrow('denied'); deny = false
    await new Promise<void>(resolve => deniedListener.server.close(() => resolve()))
    await rm(`${deniedPath}.lock`, { recursive: true, force: true })
  })

  it('preserves a foreign socket before close and one installed during close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-foreign-close-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/')
    const listener = await listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace }); await unlink(socketPath)
    const alien = createNetServer(socket => socket.destroy()); await new Promise<void>((resolve, reject) => { alien.once('error', reject); alien.listen(socketPath, resolve) }); const alienIdentity = await lstat(socketPath)
    await expect(listener.close()).rejects.toThrow('SOCKET_IDENTITY_MISMATCH')
    expect(await lstat(socketPath)).toMatchObject({ dev: alienIdentity.dev, ino: alienIdentity.ino })
    await new Promise<void>(resolve => alien.close(() => resolve())); await unlink(socketPath).catch(() => undefined); await new Promise<void>(resolve => listener.server.close(() => resolve())); await rm(`${socketPath}.lock`, { recursive: true, force: true })

    const raceRoot = await mkdtemp(join(tmpdir(), 'dz23-builder-close-race-')); roots.push(raceRoot); const racePath = join(raceRoot, 'builder.sock').replaceAll('\\', '/'); let racing: ReturnType<typeof createNetServer> | undefined
    const createServer = ((handler: HttpHandler) => { const server = createHttpServer(handler); const close = server.close.bind(server); server.close = ((callback?: (error?: Error) => void) => close(() => { racing = createNetServer(socket => socket.destroy()); racing.listen(racePath, () => callback?.()) })) as typeof server.close; return server }) as typeof createHttpServer
    const raceListener = await listenBuilderUnix({ socketPath: racePath, bearerToken: token, methods: fakeMethods(), replayNamespace, runtime: unixRuntime({ createServer }) })
    await expect(raceListener.close()).rejects.toThrow('SOCKET_IDENTITY_MISMATCH'); const racingIdentity = await lstat(racePath)
    expect(racingIdentity.isSocket()).toBe(true)
    await new Promise<void>(resolve => racing!.close(() => resolve())); await unlink(racePath).catch(() => undefined); await rm(`${racePath}.lock`, { recursive: true, force: true })
  })

  it('handles an owner that stops concurrently with shutdown identity validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-stop-during-identity-')); roots.push(root); const socketPath = join(root, 'builder.sock').replaceAll('\\', '/'); let stop = false; let captured: ReturnType<typeof createHttpServer> | undefined
    const runtime = unixRuntime({
      createServer: ((handler: HttpHandler) => { captured = createHttpServer(handler); return captured }) as typeof createHttpServer,
      lstat: (async (path, options) => { const stat = await lstat(path, options as never); if (stop && path === socketPath) { stop = false; await new Promise<void>(resolve => captured!.close(() => resolve())) } return stat }) as typeof lstat,
    })
    const listener = await listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace, runtime }); stop = true
    await expect(listener.close()).resolves.toBeUndefined()
  })

  it('handles an already-stopped server and fail-closes unusual HTTP message shapes', async () => {
    const stoppedRoot = await mkdtemp(join(tmpdir(), 'dz23-builder-stopped-')); roots.push(stoppedRoot); const stoppedPath = join(stoppedRoot, 'builder.sock').replaceAll('\\', '/'); let stopped = false; let stoppedReads = 0; let saved: Awaited<ReturnType<typeof lstat>> | undefined
    const stoppedRuntime = unixRuntime({ lstat: (async (path, options) => { if (path !== stoppedPath || !stopped) { const value = await lstat(path, options as never); if (path === stoppedPath) saved = value; return value } if (++stoppedReads === 1) return saved!; const error = new Error('missing') as NodeJS.ErrnoException; error.code = 'ENOENT'; throw error }) as typeof lstat })
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

type TestUnixServerOptions = Omit<BuilderUnixServerOptions, 'scopeId' | 'policySha256' | 'replayRoot'> & {
  readonly replayNamespace: { readonly scopeId: string; readonly policySha256: string }
  readonly replayRoot?: string
}

function listenBuilderUnix(options: TestUnixServerOptions): ReturnType<typeof listenBuilderUnixActual> {
  const { replayNamespace: namespace, replayRoot, ...rest } = options
  return listenBuilderUnixActual({
    ...rest,
    scopeId: namespace.scopeId as `s_${string}`,
    policySha256: namespace.policySha256,
    replayRoot: replayRoot ?? join(dirname(options.socketPath), 'rpc-replay').replaceAll('\\', '/'),
  })
}

function fakeMethods(): BuilderRpcMethods {
  return {
    preflight: vi.fn(async () => ({ state: 'OK' as const, protocol_version: 1 as const, scope_id: replayNamespace.scopeId as `s_${string}`, image_id: `sha256:${'a'.repeat(64)}` as const, policy_sha256: 'b'.repeat(64) })),
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
async function sendArtifactRaw(socketPath: string, body: Buffer): Promise<{ readonly status: number; readonly body: unknown; readonly connection: string | undefined }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath, path: `/v1/artifacts/upload_${'a'.repeat(32)}`, method: 'PUT', headers: {
      'content-type': 'application/x-tar', 'content-length': String(body.byteLength), authorization: `Bearer ${token}`,
    } }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown, connection: response.headers.connection }))
    })
    request.once('error', reject); request.end(body)
  })
}
async function processStartTicks(pid: number): Promise<string> { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/u)[19]! }
function unixRuntime(overrides: Partial<BuilderUnixRuntime> = {}): BuilderUnixRuntime {
  return { platform: process.platform, pid: process.pid, getuid: process.getuid, kill: process.kill.bind(process), umask: process.umask.bind(process), lstatSync, chmod, lstat, mkdir, open, readFile, realpath, rename, remove: rm, unlink, writeFile, createServer: createHttpServer, request: httpRequest, setTimeout, clearTimeout, ...overrides }
}
function statWith<T extends object>(stat: T, values: Partial<Record<PropertyKey, unknown>>): T { return new Proxy(stat, { get(target, property, receiver) { return Object.prototype.hasOwnProperty.call(values, property) ? values[property] : Reflect.get(target, property, receiver) } }) }

describe('T-23: (dev, ino) nao e identidade — o inode e reciclado', () => {
  it('um socket com o MESMO inode e nascimento diferente NAO e o nosso', async () => {
    // Esta e a causa raiz medida: o ext4 devolve o inode liberado ao proximo
    // `bind()` no mesmo diretorio, entao o socket ESTRANGEIRO criado logo apos
    // o nosso fechar nasce com exatamente o mesmo (dev, ino). Em 150 de 150
    // fechamentos o inode foi reciclado, e o produto apagava socket alheio.
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-inode-reuse-')); roots.push(root)
    const socketPath = join(root, 'builder.sock').replaceAll('\\', '/')
    // O duble devolve o MESMO dev/ino do socket real com o nascimento 1ns
    // adiante: exatamente o que o alocador de inode produz, e exatamente o que
    // a verificacao antiga aceitava como "e o meu".
    let intercept = false
    const runtime = unixRuntime({ lstat: (async (path, options) => {
      const real = await lstat(path, options as never)
      if (intercept && path === socketPath && options !== undefined) {
        const bigintStat = real as unknown as { birthtimeNs: bigint }
        return { ...real, birthtimeNs: bigintStat.birthtimeNs + 1n, isSocket: () => true } as never
      }
      return real
    }) as typeof lstat })
    const guarded = await listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace, runtime })
    intercept = true
    await expect(guarded.close()).rejects.toThrow('SOCKET_IDENTITY_MISMATCH')
    intercept = false
    await new Promise<void>(resolve => guarded.server.close(() => resolve()))
    await unlink(socketPath).catch(() => undefined)
    await rm(`${socketPath}.lock`, { recursive: true, force: true })
  })

  it('a metadata do lock guarda o nascimento, e sem ele a recuperacao RECUSA apagar', async () => {
    // Aqui a janela e de minutos ou de um reinicio - o lugar em que o reuso de
    // inode e MAIS provavel. Metadata escrita por uma versao anterior nao tem o
    // nascimento; recusar e falhar fechado, e e melhor que apagar o socket de
    // outro processo com base num endereco reciclado.
    const root = await mkdtemp(join(tmpdir(), 'dz23-builder-old-metadata-')); roots.push(root)
    const socketPath = join(root, 'builder.sock').replaceAll('\\', '/'); const lock = `${socketPath}.lock`
    const uid = process.getuid!()
    await writeFile(socketPath, 'stale'); const stat = await lstat(socketPath)
    await mkdir(lock, { mode: 0o700 })
    // Sem `socket_birthtime_ns`: e a forma ANTIGA, e ela continua sendo lida.
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ nonce: 'a'.repeat(32), pid: 2_147_483_647, process_start_ticks: '1', uid, socket_dev: stat.dev, socket_ino: stat.ino }), { mode: 0o600 })
    // O duble faz o arquivo obsoleto PARECER socket na leitura da recuperacao.
    // Sem isto o teste passaria pelo motivo errado - um arquivo comum ja e
    // recusado por nao ser socket, e a regra do nascimento nunca seria
    // exercitada. (Descoberto por falsificacao: a sabotagem da regra nao
    // reprovava o teste.)
    let staleRead = false
    const runtime = unixRuntime({
      request: (() => { throw new Error('probe failed') }) as typeof httpRequest,
      lstat: (async (path, options) => {
        const real = await lstat(path, options as never)
        if (path === socketPath && !staleRead) { staleRead = true; return { ...real, isSocket: () => true } as never }
        return real
      }) as typeof lstat,
    })
    await expect(listenBuilderUnix({ socketPath, bearerToken: token, methods: fakeMethods(), replayNamespace, runtime })).rejects.toThrow('SOCKET_IDENTITY_MISMATCH')
    // E o arquivo continua la: recusar nao e apagar.
    await expect(readFile(socketPath, 'utf8')).resolves.toBe('stale')
  })
})
