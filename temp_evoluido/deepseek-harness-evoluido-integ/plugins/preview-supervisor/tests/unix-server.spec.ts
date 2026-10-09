import { request as httpRequest } from 'node:http'
import { spawn } from 'node:child_process'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PreviewSupervisorPort } from '../src/manager.js'
import { SUPERVISOR_RPC_MAX_BODY_BYTES } from '../src/protocol.js'
import { listenSupervisorUnix } from '../src/unix-server.js'

const onPosix = process.platform !== 'win32'
const TOKEN = 'A'.repeat(43)
const roots: string[] = []
const listeners: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(listeners.splice(0).map(listener => listener.close().catch(() => undefined)))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe.skipIf(!onPosix)('preview supervisor Unix control socket', () => {
  it('creates a 0660 socket, authenticates before dispatch and removes it on close', async () => {
    const fixture = await start()
    expect((await lstat(fixture.socketPath)).mode & 0o777).toBe(0o660)

    const missing = await request(fixture.socketPath, { operation: 'list-managed', body: {} })
    const wrong = await request(fixture.socketPath, { operation: 'list-managed', body: {} }, { token: 'B'.repeat(43) })
    expect(missing).toMatchObject({ status: 401, body: { error: 'UNAUTHORIZED' } })
    expect(wrong).toEqual(missing)
    expect(fixture.manager.listManaged).not.toHaveBeenCalled()

    const accepted = await request(fixture.socketPath, { operation: 'list-managed', body: {} }, { token: TOKEN })
    expect(accepted).toEqual({ status: 200, body: { ok: true, result: { runtimes: [] } } })
    expect(fixture.manager.listManaged).toHaveBeenCalledOnce()

    await fixture.listener.close()
    listeners.splice(listeners.indexOf(fixture.listener), 1)
    await expect(lstat(fixture.socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects wrong paths, methods, malformed JSON and oversized bodies without dispatch', async () => {
    const fixture = await start()
    const notFound = await request(fixture.socketPath, {}, { token: TOKEN, path: '/not-rpc' })
    const method = await request(fixture.socketPath, {}, { token: TOKEN, method: 'GET' })
    const malformed = await request(fixture.socketPath, {}, { token: TOKEN, rawBody: Buffer.from('{') })
    const oversized = await request(fixture.socketPath, {}, {
      token: TOKEN,
      rawBody: Buffer.alloc(SUPERVISOR_RPC_MAX_BODY_BYTES + 1, 0x61),
    })

    expect(notFound).toMatchObject({ status: 404 })
    expect(method).toMatchObject({ status: 405 })
    expect(malformed).toMatchObject({ status: 400, body: { ok: false, error: { code: 'INVALID_REQUEST' } } })
    expect(oversized).toMatchObject({ status: 413, body: { error: 'REQUEST_TOO_LARGE' } })
    expect(Object.values(fixture.manager).every(value => typeof value !== 'function' || value.mock.calls.length === 0)).toBe(true)
  })

  it('sanitizes manager failures and never returns the internal error', async () => {
    const manager = fakeManager()
    manager.health.mockRejectedValueOnce(new Error('docker socket /var/run/docker.sock token=secret'))
    const fixture = await start(manager)
    const response = await request(fixture.socketPath, {
      operation: 'health', body: { runtime_ref: 'pv_0123456789abcdef0123456789abcdef' },
    }, { token: TOKEN })

    expect(response).toMatchObject({ status: 500, body: { ok: false, error: { code: 'INTERNAL' } } })
    expect(JSON.stringify(response.body)).not.toMatch(/docker|socket|secret|var\/run/u)
  })

  it('refuses invalid paths, invalid tokens and an occupied regular file without replacing it', async () => {
    const root = await temporaryRoot()
    const occupied = join(root, 'occupied.sock').replaceAll('\\', '/')
    await writeFile(occupied, 'preserve-me')
    const manager = fakeManager()

    await expect(listenSupervisorUnix({ socketPath: 'relative.sock', bearerToken: TOKEN, manager })).rejects.toThrow('INVALID_SOCKET_PATH')
    await expect(listenSupervisorUnix({ socketPath: `${root.replaceAll('\\', '/')}/bad\\name.sock`, bearerToken: TOKEN, manager })).rejects.toThrow('INVALID_SOCKET_PATH')
    await expect(listenSupervisorUnix({ socketPath: join(root, 'short.sock').replaceAll('\\', '/'), bearerToken: 'short', manager })).rejects.toThrow('INVALID_SUPERVISOR_TOKEN')
    await expect(listenSupervisorUnix({ socketPath: occupied, bearerToken: TOKEN, manager })).rejects.toThrow('SOCKET_PATH_OCCUPIED')
    await expect(readFile(occupied, 'utf8')).resolves.toBe('preserve-me')
  })

  it('replaces a stale Unix socket and forwards every closed RPC operation', async () => {
    const root = await temporaryRoot()
    const socketPath = join(root, 'control.sock').replaceAll('\\', '/')
    await leaveStaleSocket(socketPath)
    expect((await lstat(socketPath)).isSocket()).toBe(true)

    const manager = fakeManager()
    const listener = await listenSupervisorUnix({ socketPath, bearerToken: TOKEN, manager })
    listeners.push(listener)
    const cases = [
      [{ operation: 'start', body: { preview_id: 'preview-1', artifact_relative_path: 'run-1', artifact_sha256: 'a'.repeat(64), owner_email: 'owner@example.test' } }, 'start'],
      [{ operation: 'stop', body: { runtime_ref: 'runtime:one' } }, 'stop'],
      [{ operation: 'health', body: { runtime_ref: 'runtime:one' } }, 'health'],
      [{ operation: 'logs', body: { runtime_ref: 'runtime:one', limit: 5 } }, 'logs'],
      [{ operation: 'verification-messages', body: { runtime_ref: 'runtime:one' } }, 'verificationMessages'],
    ] as const
    for (const [payload] of cases) expect((await request(socketPath, payload, { token: TOKEN })).status).toBe(200)
    for (const [, method] of cases) expect(manager[method]).toHaveBeenCalledOnce()
  })

  it('propagates supervisor shutdown to an in-flight Docker operation', async () => {
    const controller = new AbortController()
    let operationSignal: AbortSignal | undefined
    const manager = {
      ...fakeManager(),
      start: vi.fn(async (_input: Parameters<PreviewSupervisorPort['start']>[0], signal: AbortSignal) => {
        operationSignal = signal
        await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
        throw new Error('unreachable')
      }),
    } satisfies PreviewSupervisorPort
    const root = await temporaryRoot()
    const socketPath = join(root, 'control.sock').replaceAll('\\', '/')
    const listener = await listenSupervisorUnix({ socketPath, bearerToken: TOKEN, manager, signal: controller.signal })
    listeners.push(listener)

    const pending = request(socketPath, {
      operation: 'start',
      body: { preview_id: 'preview-1', artifact_relative_path: 'run-1', artifact_sha256: 'a'.repeat(64), owner_email: 'owner@example.test' },
    }, { token: TOKEN })
    await vi.waitFor(() => expect(operationSignal).toBeDefined())
    controller.abort(new Error('SUPERVISOR_SHUTDOWN'))

    await expect(pending).resolves.toMatchObject({ status: 500 })
    expect(operationSignal?.aborted).toBe(true)
  })
})

async function start(manager = fakeManager()) {
  const root = await temporaryRoot()
  const socketPath = join(root, 'control.sock').replaceAll('\\', '/')
  const listener = await listenSupervisorUnix({ socketPath, bearerToken: TOKEN, manager })
  listeners.push(listener)
  return { root, socketPath, listener, manager }
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dz23-supervisor-unix-'))
  roots.push(root)
  return root
}

async function leaveStaleSocket(socketPath: string): Promise<void> {
  const script = `const {createServer}=require('node:net');const server=createServer();server.listen(${JSON.stringify(socketPath)},()=>process.stdout.write('READY\\n'))`
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.stdout.once('data', chunk => String(chunk).includes('READY') ? resolve() : reject(new Error('STALE_SOCKET_NOT_READY')))
  })
  child.kill('SIGKILL')
  await new Promise<void>((resolve, reject) => child.once('exit', (_code, signal) => signal === 'SIGKILL' ? resolve() : reject(new Error('STALE_SOCKET_CHILD_NOT_KILLED'))))
}

function fakeManager() {
  return {
    start: vi.fn(async () => ({ runtime_ref: 'runtime:one' })),
    stop: vi.fn(async () => undefined),
    health: vi.fn(async () => 'OK' as const),
    logs: vi.fn(async () => []),
    verificationMessages: vi.fn(async () => []),
    listManaged: vi.fn(async () => []),
    forward: vi.fn(async () => ({ status: 200, headers: {}, body_base64: '' })),
  } satisfies PreviewSupervisorPort
}

async function request(
  socketPath: string,
  value: unknown,
  options: { readonly token?: string; readonly path?: string; readonly method?: string; readonly rawBody?: Buffer } = {},
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const body = options.rawBody ?? Buffer.from(JSON.stringify(value), 'utf8')
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      socketPath,
      path: options.path ?? '/v1/rpc',
      method: options.method ?? 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(body.byteLength),
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      response.once('end', () => {
        try {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> })
        } catch (error) { reject(error) }
      })
    })
    request.once('error', reject)
    request.end(body)
  })
}
