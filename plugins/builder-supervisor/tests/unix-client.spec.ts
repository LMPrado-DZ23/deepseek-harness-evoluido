import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BUILDER_RPC_MAX_BODY_BYTES,
  BUILDER_RPC_MAX_RESPONSE_BYTES,
  BuilderUnixClientError,
  classifyBuilderUnixClientFailure,
  createBuilderUnixClient,
  type BuilderUnixClientTransport,
} from '../src/index.js'

const roots: string[] = []
const servers: Server[] = []
const token = 'A'.repeat(43)
const credentialRef = 'file:/run/secrets/dz23-builder-supervisor-token'
const requestId = (digit: string) => `req_${digit.repeat(32)}`
const buildRef = `build_${'a'.repeat(32)}`

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('builder Unix client configuration and local validation', () => {
  it.each([
    { socketPath: 'relative.sock', credentialRef },
    { socketPath: '/run/../bad.sock', credentialRef },
    { socketPath: '/run/bad\\socket', credentialRef },
    { socketPath: `/${'a'.repeat(108)}`, credentialRef },
    { socketPath: '/run/builder.sock', credentialRef: 'env:TOKEN' },
    { socketPath: '/run/builder.sock', credentialRef: 'file:/run/../token' },
  ])('rejects unsafe construction without contacting a transport: %j', options => {
    const request = vi.fn()
    expect(() => client({ ...options, transport: { request } as never })).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }))
    expect(request).not.toHaveBeenCalled()
  })

  it.each([0, 600_001, 1.5])('rejects unbounded or invalid timeout %s', timeoutMs => {
    expect(() => client({ timeoutMs })).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }))
  })

  it.each([0, BUILDER_RPC_MAX_RESPONSE_BYTES + 1, 1.5])('rejects unbounded or invalid response limit %s', maxResponseBytes => {
    expect(() => client({ maxResponseBytes })).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }))
  })

  it.each([0, BUILDER_RPC_MAX_BODY_BYTES + 1, 1.5])('rejects an invalid request limit %s', maxRequestBytes => {
    expect(() => client({ maxRequestBytes })).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }))
  })

  it('enforces a caller-lowered request ceiling before credentials or transport', async () => {
    const resolve = vi.fn(async () => token)
    const request = vi.fn()
    await expect(client({ maxRequestBytes: 1, credentials: { resolve }, transport: { request } as never }).preflight({ request_id: requestId('1') })).rejects.toMatchObject({ code: 'REQUEST_TOO_LARGE' })
    expect(resolve).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('rejects malformed caller IDs and bodies before resolving a credential or opening a socket', async () => {
    const resolve = vi.fn(async () => token)
    const request = vi.fn()
    const instance = client({ credentials: { resolve }, transport: { request } as never })
    await expect(instance.preflight({ request_id: 'generated-for-me' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(instance.prepare({ request_id: requestId('1'), build_id: '../outside', artifact_relative_path: 'runs/one', artifact_sha256: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(resolve).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('requires a valid token from the caller-owned reference resolver', async () => {
    const request = vi.fn()
    for (const resolved of [undefined, '', 'short token', 'A'.repeat(42), 'A'.repeat(201)]) {
      const resolve = vi.fn(async () => resolved)
      await expect(client({ credentials: { resolve }, transport: { request } as never }).preflight({ request_id: requestId('2') })).rejects.toMatchObject({ code: 'CREDENTIAL_UNAVAILABLE' })
      expect(resolve).toHaveBeenCalledWith(credentialRef, expect.any(AbortSignal))
    }
    expect(request).not.toHaveBeenCalled()
  })

  it('maps resolver exceptions without leaking their message', async () => {
    for (const resolve of [
      async () => { throw new Error('/secret/async/token/path') },
      () => { throw new Error('/secret/sync/token/path') },
    ]) {
      const instance = client({ credentials: { resolve } })
      await expect(instance.preflight({ request_id: requestId('3') })).rejects.toEqual(expect.objectContaining({ code: 'CREDENTIAL_UNAVAILABLE', message: 'CREDENTIAL_UNAVAILABLE' }))
    }
  })

  it('bounds credential resolution with the same deadline and caller abort', async () => {
    const credentials = { resolve: vi.fn(async (_reference: string, _signal: AbortSignal) => new Promise<string>(() => undefined)) }
    await expect(client({ credentials, timeoutMs: 20 }).preflight({ request_id: requestId('4') })).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' })

    const controller = new AbortController()
    const pending = client({ credentials, timeoutMs: 1_000 }).preflight({ request_id: requestId('5') }, { signal: controller.signal })
    controller.abort(new BuilderUnixClientError('INTERNAL'))
    await expect(pending).rejects.toEqual(expect.objectContaining({ code: 'ABORTED', message: 'ABORTED' }))
  })

  it('propagates caller abort synchronously to the transport on every platform', async () => {
    let transportSignal: AbortSignal | undefined
    const request = new EventEmitter() as ReturnType<typeof httpRequest>
    request.end = vi.fn(() => request) as typeof request.end
    const transport: BuilderUnixClientTransport = {
      request: options => {
        transportSignal = options.signal
        options.signal?.addEventListener('abort', () => request.emit('error', options.signal?.reason), { once: true })
        return request
      },
    }
    const controller = new AbortController()
    const pending = client({ timeoutMs: 10_000, transport }).preflight({ request_id: requestId('9') }, { signal: controller.signal })
    await vi.waitFor(() => expect(transportSignal).toBeDefined())
    controller.abort(new Error('/secret/caller/reason'))
    expect(transportSignal?.aborted).toBe(true)
    await expect(pending).rejects.toEqual(expect.objectContaining({ code: 'ABORTED', message: 'ABORTED' }))
  })

  it.each([
    { error: new BuilderUnixClientError('SOCKET_UNAVAILABLE'), state: 'BLOCKED_EXTERNAL', code: 'SOCKET_UNAVAILABLE' },
    { error: new BuilderUnixClientError('ARTIFACT_HASH_MISMATCH'), state: 'BUILD_FAILED', code: 'ARTIFACT_HASH_MISMATCH' },
    { error: new BuilderUnixClientError('ABORTED'), state: 'CANCELLED', code: 'ABORTED' },
    { error: new BuilderUnixClientError('INVALID_REQUEST'), state: 'INTERNAL', code: 'INVALID_REQUEST' },
    { error: new Error('/secret/unknown'), state: 'INTERNAL', code: 'UNKNOWN' },
  ])('classifies future adapter failures without leaking details: $state/$code', ({ error, state, code }) => {
    expect(classifyBuilderUnixClientFailure(error)).toEqual({ state, code })
  })
})

describe.skipIf(process.platform === 'win32')('builder Unix client wire contract', () => {
  it('executes every typed lifecycle method and listManaged over the closed protocol', async () => {
    const seen: unknown[] = []
    const socketPath = await listen(async (request, response) => {
      const envelope = JSON.parse((await read(request)).toString('utf8')) as { operation: string; body: Record<string, unknown> }
      seen.push(envelope)
      const results: Record<string, unknown> = {
        preflight: attestation(),
        prepare: { build_ref: buildRef, state: 'PREPARED' },
        execute: { build_ref: buildRef, state: 'BUILD_OK', step: 'build', result: stepResult() },
        cancel: { build_ref: buildRef, state: 'CANCELLED' },
        finish: { build_ref: buildRef, final_state: 'E2E_OK', exported: { relative_path: `exports/${buildRef}`, sha256: 'c'.repeat(64), files: 2, bytes: 10 }, cleanup_pending: false, cleaned: true },
        listManaged: { builds: [{ build_ref: buildRef, build_id: 'run-1', state: 'BUILD_OK', exported: false, cleanup_pending: false }] },
      }
      json(response, 200, { ok: true, result: results[envelope.operation] })
    })
    const instance = client({ socketPath })
    await expect(instance.preflight({ request_id: requestId('1') })).resolves.toEqual(attestation())
    await expect(instance.prepare({ request_id: requestId('2'), build_id: 'run-1', artifact_relative_path: 'runs/run-1', artifact_sha256: 'a'.repeat(64) })).resolves.toMatchObject({ state: 'PREPARED' })
    await expect(instance.execute({ request_id: requestId('3'), build_ref: buildRef, step: 'build' })).resolves.toMatchObject({ state: 'BUILD_OK', step: 'build' })
    await expect(instance.cancel({ request_id: requestId('4'), build_ref: buildRef })).resolves.toMatchObject({ state: 'CANCELLED' })
    await expect(instance.finish({ request_id: requestId('5'), build_ref: buildRef })).resolves.toMatchObject({ final_state: 'E2E_OK', cleaned: true })
    await expect(instance.listManaged({ request_id: requestId('6'), build_id: 'run-1' })).resolves.toMatchObject({ builds: [{ build_id: 'run-1' }] })
    expect(seen.map(value => (value as { operation: string }).operation)).toEqual(['preflight', 'prepare', 'execute', 'cancel', 'finish', 'listManaged'])
  })

  it.each([
    { name: 'failed build carrying an export', final_state: 'FAILED', exported: { relative_path: `exports/${buildRef}`, sha256: 'c'.repeat(64), files: 1, bytes: 1 }, cleanup_pending: false, cleaned: true },
    { name: 'cancelled build carrying an export', final_state: 'CANCELLED', exported: { relative_path: `exports/${buildRef}`, sha256: 'c'.repeat(64), files: 1, bytes: 1 }, cleanup_pending: false, cleaned: true },
    { name: 'successful build without an export', final_state: 'E2E_OK', exported: null, cleanup_pending: false, cleaned: true },
    { name: 'successful build carrying another build export', final_state: 'E2E_OK', exported: { relative_path: `exports/build_${'9'.repeat(32)}`, sha256: 'c'.repeat(64), files: 1, bytes: 1 }, cleanup_pending: false, cleaned: true },
  ])('rejects hostile finish result: $name', async ({ name: _name, ...result }) => {
    const socketPath = await listen((_request, response) => json(response, 200, { ok: true, result: { build_ref: buildRef, ...result } }))
    await expect(client({ socketPath }).finish({ request_id: requestId('6'), build_ref: buildRef })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('preserves caller request IDs and bytes across explicit retries and never retries itself', async () => {
    const bodies: Buffer[] = []
    const resolve = vi.fn(async () => token)
    const socketPath = await listen(async (request, response) => {
      bodies.push(await read(request))
      json(response, 200, { ok: true, result: attestation() })
    })
    const instance = client({ socketPath, credentials: { resolve } })
    const body = { request_id: requestId('7') }
    await instance.preflight(body)
    await instance.preflight(body)
    expect(bodies).toHaveLength(2)
    expect(bodies[0]?.equals(bodies[1]!)).toBe(true)
    expect(JSON.parse(bodies[0]!.toString('utf8'))).toEqual({ operation: 'preflight', body })
    expect(resolve).toHaveBeenNthCalledWith(1, credentialRef, expect.any(AbortSignal))
    expect(resolve).toHaveBeenNthCalledWith(2, credentialRef, expect.any(AbortSignal))
  })

  it('handles fragmented request writes and fragmented response reads', async () => {
    const received: Buffer[] = []
    const socketPath = await listen(async (request, response) => {
      received.push(await read(request))
      const payload = Buffer.from(JSON.stringify({ ok: true, result: attestation() }), 'utf8')
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      for (let offset = 0; offset < payload.length; offset += 3) response.write(payload.subarray(offset, offset + 3))
      response.end()
    })
    const transport: BuilderUnixClientTransport = {
      request: (options, onResponse) => {
        const request = httpRequest(options, onResponse)
        const end = request.end.bind(request)
        request.end = ((chunk?: unknown) => {
          const body = Buffer.from(chunk as Uint8Array)
          for (let offset = 0; offset < body.length; offset += 2) request.write(body.subarray(offset, offset + 2))
          return end()
        }) as typeof request.end
        return request
      },
    }
    await expect(client({ socketPath, transport }).preflight({ request_id: requestId('8') })).resolves.toEqual(attestation())
    expect(JSON.parse(received[0]!.toString('utf8'))).toMatchObject({ body: { request_id: requestId('8') } })
  })

  it.each([
    { name: 'invalid JSON', status: 200, value: '{', contentType: 'application/json', code: 'INVALID_RESPONSE' },
    { name: 'wrong media type', status: 200, value: JSON.stringify({ ok: true, result: attestation() }), contentType: 'text/plain', code: 'INVALID_RESPONSE' },
    { name: 'success flag is not true', status: 200, value: JSON.stringify({ ok: false, result: attestation() }), contentType: 'application/json', code: 'INVALID_RESPONSE' },
    { name: 'extra success authority', status: 200, value: JSON.stringify({ ok: true, result: attestation(), socket: '/run/docker.sock' }), contentType: 'application/json', code: 'INVALID_RESPONSE' },
    { name: 'invalid success result', status: 200, value: JSON.stringify({ ok: true, result: { ...attestation(), image_id: 'latest' } }), contentType: 'application/json', code: 'INVALID_RESPONSE' },
    { name: 'unknown remote error', status: 409, value: JSON.stringify({ ok: false, error: { code: 'SHELL_FAILED' } }), contentType: 'application/json', code: 'INVALID_RESPONSE' },
    { name: 'status and code mismatch', status: 500, value: JSON.stringify({ ok: false, error: { code: 'BUILD_NOT_FOUND' } }), contentType: 'application/json', code: 'INVALID_RESPONSE' },
  ])('fails closed on $name', async fixture => {
    const socketPath = await listen((_request, response) => {
      response.writeHead(fixture.status, { 'content-type': fixture.contentType })
      response.end(fixture.value)
    })
    await expect(client({ socketPath }).preflight({ request_id: requestId('9') })).rejects.toMatchObject({ code: fixture.code })
  })

  it('rejects declared and streamed oversized responses before parsing', async () => {
    const declaredPath = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': '129' })
      response.end('{}')
    })
    await expect(client({ socketPath: declaredPath, maxResponseBytes: 128 }).preflight({ request_id: requestId('a') })).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' })

    const streamedPath = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('x'.repeat(129))
    })
    await expect(client({ socketPath: streamedPath, maxResponseBytes: 128 }).preflight({ request_id: requestId('b') })).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' })
  })

  it('rejects a content-length that differs from bytes read before decoding a valid envelope', async () => {
    const payload = Buffer.from(JSON.stringify({ ok: true, result: attestation() }), 'utf8')
    const transport = responseTransport(payload, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(payload.byteLength + 1),
    })
    await expect(client({ transport }).preflight({ request_id: requestId('b') })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('distinguishes deadline, caller abort and socket availability without leaking transport details', async () => {
    const waiting: Array<() => void> = []
    const socketPath = await listen((_request, response) => { waiting.push(() => json(response, 200, { ok: true, result: attestation() })) })
    await expect(client({ socketPath, timeoutMs: 20 }).preflight({ request_id: requestId('c') })).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' })

    let transportSignal: AbortSignal | undefined
    const transport: BuilderUnixClientTransport = {
      request: (options, onResponse) => {
        transportSignal = options.signal
        return httpRequest(options, onResponse)
      },
    }
    const controller = new AbortController()
    const pending = client({ socketPath, timeoutMs: 10_000, transport }).preflight({ request_id: requestId('d') }, { signal: controller.signal })
    await vi.waitFor(() => expect(waiting.length).toBeGreaterThanOrEqual(2))
    controller.abort(new Error('/secret/caller/reason'))
    // AbortSignal.any propagates synchronously. Assert before awaiting the request so
    // a later deadline cannot disguise a dropped caller signal.
    expect(transportSignal?.aborted).toBe(true)
    await expect(pending).rejects.toEqual(expect.objectContaining({ code: 'ABORTED', message: 'ABORTED' }))
    waiting.splice(0).forEach(finish => finish())

    const missing = join(tmpdir(), `missing-${Date.now()}.sock`).replaceAll('\\', '/')
    await expect(client({ socketPath: missing }).preflight({ request_id: requestId('e') })).rejects.toEqual(expect.objectContaining({ code: 'SOCKET_UNAVAILABLE', message: 'SOCKET_UNAVAILABLE' }))
  })

  it('maps only authenticated server error allowlists with status preserved', async () => {
    const fixtures = [
      { status: 401, body: { error: 'UNAUTHORIZED' }, code: 'UNAUTHORIZED' },
      { status: 409, body: { ok: false, error: { code: 'BUILD_NOT_FOUND' } }, code: 'BUILD_NOT_FOUND' },
      { status: 503, body: { ok: false, error: { code: 'SUPERVISOR_SHUTTING_DOWN' } }, code: 'SUPERVISOR_SHUTTING_DOWN' },
      { status: 504, body: { ok: false, error: { code: 'DEADLINE_EXCEEDED' } }, code: 'DEADLINE_EXCEEDED' },
    ] as const
    let index = 0
    const socketPath = await listen((_request, response) => {
      const fixture = fixtures[index++]!
      json(response, fixture.status, fixture.body)
    })
    const instance = client({ socketPath })
    for (const [fixtureIndex, fixture] of fixtures.entries()) {
      const error = await instance.preflight({ request_id: requestId(String(fixtureIndex + 1)) }).catch(value => value as BuilderUnixClientError)
      expect(error).toMatchObject({ code: fixture.code, status: fixture.status, message: fixture.code })
    }
  })

  it('does not retry a socket failure', async () => {
    const request = vi.fn<BuilderUnixClientTransport['request']>((options, onResponse) => httpRequest(options, onResponse))
    const transport: BuilderUnixClientTransport = { request }
    const missing = join(tmpdir(), `missing-once-${Date.now()}.sock`).replaceAll('\\', '/')
    await expect(client({ socketPath: missing, transport }).preflight({ request_id: requestId('f') })).rejects.toMatchObject({ code: 'SOCKET_UNAVAILABLE' })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('maps synchronous and asynchronous unknown transport failures without leaking details', async () => {
    const synchronous: BuilderUnixClientTransport = { request: () => { throw new Error('/secret/synchronous') } }
    await expect(client({ transport: synchronous }).preflight({ request_id: requestId('1') })).rejects.toEqual(expect.objectContaining({ code: 'TRANSPORT_ERROR', message: 'TRANSPORT_ERROR' }))

    const asyncFailure = new Error('/secret/asynchronous') as NodeJS.ErrnoException
    asyncFailure.code = 'EPIPE'
    const request = vi.fn<BuilderUnixClientTransport['request']>((options, onResponse) => {
      const pending = httpRequest(options, onResponse)
      queueMicrotask(() => pending.emit('error', asyncFailure))
      return pending
    })
    await expect(client({ transport: { request } }).preflight({ request_id: requestId('2') })).rejects.toEqual(expect.objectContaining({ code: 'TRANSPORT_ERROR', message: 'TRANSPORT_ERROR' }))
    expect(request).toHaveBeenCalledTimes(1)
  })
})

function client(overrides: Partial<Parameters<typeof createBuilderUnixClient>[0]> = {}) {
  return createBuilderUnixClient({
    socketPath: '/run/dz23-builder-supervisor.sock',
    credentialRef,
    credentials: { resolve: async () => token },
    ...overrides,
  })
}

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dz23-builder-client-'))
  roots.push(root)
  const socketPath = join(root, 'builder.sock').replaceAll('\\', '/')
  const server = createServer((request, response) => { void Promise.resolve(handler(request, response)).catch(() => response.destroy()) })
  servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
  return socketPath
}

async function read(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

function attestation() {
  return { state: 'OK' as const, protocol_version: 1 as const, scope_id: `s_${'c'.repeat(48)}` as const, image_id: `sha256:${'a'.repeat(64)}` as const, policy_sha256: 'b'.repeat(64) }
}

function stepResult() {
  return { exit_code: 0, stdout: '', stderr: '', timed_out: false, termination_reason: null, output_limit_exceeded: false }
}

function responseTransport(body: Buffer, headers: Readonly<Record<string, string>>): BuilderUnixClientTransport {
  return {
    request: (_options, onResponse) => {
      const request = new EventEmitter() as ReturnType<typeof httpRequest>
      request.end = vi.fn(() => request) as typeof request.end
      queueMicrotask(() => {
        const response = Readable.from([body]) as IncomingMessage
        response.statusCode = 200
        response.headers = { ...headers }
        onResponse(response)
      })
      return request
    },
  }
}
