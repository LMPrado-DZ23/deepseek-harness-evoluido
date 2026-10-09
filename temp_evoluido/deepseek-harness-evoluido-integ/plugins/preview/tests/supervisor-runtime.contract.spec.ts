import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { PreviewRuntimePort } from '../src/service.js'
import {
  SupervisorPreviewRuntime,
  UnixHttpSupervisorTransport,
  UnixProxySupervisorTransport,
  type SupervisorExchangeRequest,
  type SupervisorTransport,
} from '../src/supervisor-client.js'

const MAX_LOG_EVENTS = 100
const MAX_MESSAGES = 20
const MAX_MANAGED = 1_000

function encoded(value: unknown): Uint8Array { return Buffer.from(JSON.stringify(value)) }
function transportReturning(value: unknown): SupervisorTransport { return { exchange: vi.fn(() => Promise.resolve(encoded(value))) } }
function subject(transport: SupervisorTransport, dataTransport?: SupervisorTransport): SupervisorPreviewRuntime {
  return new SupervisorPreviewRuntime({ transport, ...(dataTransport === undefined ? {} : { dataTransport }), artifactRoot: '/srv/dz23/artifacts' })
}
function validStartInput(): Parameters<PreviewRuntimePort['start']>[0] {
  return {
    previewId: 'preview-01', artifactPath: '/srv/dz23/artifacts/run-01', artifactSha256: 'a'.repeat(64), ownerEmail: 'owner@example.test',
    labels: { 'dz23.managed': 'preview', 'dz23.preview_id': 'preview-01' },
    environment: { APP_EMAIL_MODE: 'studio-preview', APP_OWNER_EMAIL: 'owner@example.test', DZ23_PREVIEW_ID: 'preview-01', DATA_DIR: '/preview-storage/data' },
  }
}

async function withUnixHttpServer(
  status: number,
  body: string,
  run: (socketPath: string, tokenFile: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dz23-supervisor-client-'))
  const socketPath = join(root, 'rpc.sock')
  const tokenFile = join(root, 'token')
  await writeFile(tokenFile, 'a'.repeat(43), { mode: 0o600 })
  const server = createServer((_request, response) => {
    response.statusCode = status
    response.end(body)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    await run(socketPath, tokenFile)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}

describe('Unix-socket preview supervisor client contract', () => {
  it('sends only an opaque id, relative artifact path and hash to the supervisor', async () => {
    const transport = transportReturning({ runtime_ref: 'runtime:preview-01' })
    const signal = new AbortController().signal
    await expect(subject(transport).start(validStartInput(), signal)).resolves.toEqual({ runtimeRef: 'runtime:preview-01' })
    expect(transport.exchange).toHaveBeenCalledWith({
      operation: 'start', signal, maxResponseBytes: 32 * 1024,
      body: { preview_id: 'preview-01', artifact_relative_path: 'run-01', artifact_sha256: 'a'.repeat(64), owner_email: 'owner@example.test' },
    })
    const sent = JSON.stringify(vi.mocked(transport.exchange).mock.calls[0])
    expect(sent).not.toMatch(/image|command|mount|network|port|environment|labels|artifactPath/u)
  })

  it.each([
    ['preview id traversal', { previewId: '../escape' }], ['relative artifact', { artifactPath: 'run/app' }],
    ['artifact traversal', { artifactPath: '/srv/dz23/artifacts/../secret/app' }], ['outside artifact', { artifactPath: '/tmp/app' }],
    ['backslash artifact', { artifactPath: '/srv/dz23/artifacts/run\\app' }], ['uppercase hash', { artifactSha256: 'A'.repeat(64) }],
    ['short hash', { artifactSha256: 'a'.repeat(63) }],
    ['uppercase owner email', { ownerEmail: 'Owner@example.test' }], ['invalid owner email', { ownerEmail: '../owner' }],
    ['forged labels', { labels: { 'dz23.managed': 'preview', 'dz23.preview_id': 'other' } }],
    ['extra environment', { environment: { ...validStartInput().environment, OPENAI_API_KEY: 'secret' } }],
  ])('rejects %s before sidecar I/O', async (_name, override) => {
    const transport = transportReturning({ runtime_ref: 'runtime:preview-01' })
    await expect(subject(transport).start({ ...validStartInput(), ...override }, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID' })
    expect(transport.exchange).not.toHaveBeenCalled()
  })

  it.each(['', '../runtime', 'runtime/ref', 'runtime ref', 'x'.repeat(201)])('rejects runtimeRef %j before I/O', async runtimeRef => {
    const transport = transportReturning({ health: 'OK' })
    await expect(subject(transport).health(runtimeRef, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID' })
    expect(transport.exchange).not.toHaveBeenCalled()
  })

  it('propagates cancellation and rejects late transport completion', async () => {
    const aborted = new AbortController(); aborted.abort()
    const transport = transportReturning({ health: 'OK' })
    await expect(subject(transport).health('runtime:one', aborted.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(transport.exchange).not.toHaveBeenCalled()
    const pending: SupervisorTransport = { exchange: vi.fn(input => new Promise<Uint8Array>((_resolve, reject) => {
      input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })
    })) }
    await expect(subject(pending).health('runtime:one', AbortSignal.timeout(20))).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects empty, oversized, invalid UTF-8 and malformed JSON responses', async () => {
    for (const bytes of [new Uint8Array(), new Uint8Array(32 * 1024 + 1), new Uint8Array([0xff]), Buffer.from('{')]) {
      const transport: SupervisorTransport = { exchange: vi.fn(() => Promise.resolve(bytes)) }
      await expect(subject(transport).health('runtime:one', new AbortController().signal)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    }
  })

  it('rejects unknown response fields, invalid enums and invalid managed identities', async () => {
    await expect(subject(transportReturning({ runtime_ref: 'runtime:one', socket: '/run/secret.sock' })).start(validStartInput(), new AbortController().signal)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await expect(subject(transportReturning({ health: 'STARTING' })).health('runtime:one', new AbortController().signal)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await expect(subject(transportReturning({ runtimes: [{ runtime_ref: '../escape', preview_id: 'preview-01' }] })).listManaged(new AbortController().signal)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it('bounds logs, messages and managed runtime collections', async () => {
    const invalidLimit = transportReturning({ events: [] })
    await expect(subject(invalidLimit).logs('runtime:one', MAX_LOG_EVENTS + 1, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID' })
    expect(invalidLimit.exchange).not.toHaveBeenCalled()
    await expect(subject(transportReturning({ events: Array.from({ length: MAX_LOG_EVENTS + 1 }) })).logs('runtime:one', MAX_LOG_EVENTS, new AbortController().signal)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await expect(subject(transportReturning({ messages: Array.from({ length: MAX_MESSAGES + 1 }) })).verificationMessages('runtime:one', new AbortController().signal)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await expect(subject(transportReturning({ runtimes: Array.from({ length: MAX_MANAGED + 1 }) })).listManaged(new AbortController().signal)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it('forwards a bounded closed DTO and decodes the closed response', async () => {
    const transport = transportReturning({ status: 200, headers: { 'content-type': 'text/plain' }, body_base64: Buffer.from('ok').toString('base64') })
    await expect(subject(transport).forward('runtime:one', { method: 'GET', path: '/items?q=one', headers: { accept: 'text/plain' }, body: Buffer.alloc(0) }))
      .resolves.toEqual({ status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('ok') })
    const request = vi.mocked(transport.exchange).mock.calls[0]?.[0] as SupervisorExchangeRequest
    expect(request.operation).toBe('forward')
    expect(request.body).toEqual({ runtime_ref: 'runtime:one', method: 'GET', path: '/items?q=one', headers: { accept: 'text/plain' }, body_base64: '' })
  })

  it('normalizes transport failures without leaking paths or secrets', async () => {
    const transport: SupervisorTransport = { exchange: vi.fn(() => Promise.reject(new Error('connect /run/secret.sock token=secret'))) }
    const error = await subject(transport).health('runtime:one', new AbortController().signal).then(
      () => { throw new Error('expected transport failure') },
      value => value as Error,
    )
    expect(error).toMatchObject({ code: 'UNAVAILABLE', message: 'O supervisor de prévias não está disponível.' })
    expect(error.message).not.toMatch(/secret|socket/u)
  })

  it('accepts each closed metadata response and selects the isolated data transport', async () => {
    const control = transportReturning({ health: 'OK' })
    const data = transportReturning({ messages: [{ kind: 'magic-code' }] })
    const runtime = subject(control, data)
    const signal = new AbortController().signal

    await expect(runtime.health('runtime:one', signal)).resolves.toBe('OK')
    await expect(subject(transportReturning({ health: 'DOWN' })).health('runtime:one', signal)).resolves.toBe('DOWN')
    await expect(subject(transportReturning({ events: [{ message: 'started' }] })).logs('runtime:one', 1, signal)).resolves.toEqual([{ message: 'started' }])
    await expect(runtime.verificationMessages('runtime:one', signal)).resolves.toEqual([{ kind: 'magic-code' }])
    await expect(subject(transportReturning({ runtimes: [{ runtime_ref: 'runtime:one', preview_id: 'preview-01' }] })).listManaged(signal))
      .resolves.toEqual([{ runtimeRef: 'runtime:one', previewId: 'preview-01' }])
    await expect(subject(transportReturning({ stopped: true })).stop('runtime:one', signal)).resolves.toBeUndefined()

    expect(data.exchange).toHaveBeenCalledWith(expect.objectContaining({ operation: 'verification-messages' }))
    expect(control.exchange).not.toHaveBeenCalledWith(expect.objectContaining({ operation: 'verification-messages' }))
  })

  it('falls back to the control transport when no data transport is configured', async () => {
    const transport = transportReturning({ messages: [] })
    await expect(subject(transport).verificationMessages('runtime:one', new AbortController().signal)).resolves.toEqual([])
    expect(transport.exchange).toHaveBeenCalledWith(expect.objectContaining({ operation: 'verification-messages' }))
  })

  it.each([
    ['non-object', 'invalid'],
    ['null', null],
    ['array', []],
    ['missing field', {}],
    ['extra field', { stopped: true, extra: true }],
    ['false stopped marker', { stopped: false }],
  ])('rejects %s stop responses', async (_name, response) => {
    await expect(subject(transportReturning(response)).stop('runtime:one', new AbortController().signal)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it.each([
    ['negative', 0],
    ['fractional', 1.5],
    ['too large', MAX_LOG_EVENTS + 1],
  ])('rejects %s log limits', async (_name, limit) => {
    const transport = transportReturning({ events: [] })
    await expect(subject(transport).logs('runtime:one', limit, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID' })
    expect(transport.exchange).not.toHaveBeenCalled()
  })

  it.each([
    ['events is not an array', { events: {} }],
    ['messages is not an array', { messages: null }],
    ['runtimes is not an array', { runtimes: 'none' }],
  ])('rejects a response whose %s', async (_name, response) => {
    const runtime = subject(transportReturning(response))
    const signal = new AbortController().signal
    if ('events' in response) await expect(runtime.logs('runtime:one', 1, signal)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    else if ('messages' in response) await expect(runtime.verificationMessages('runtime:one', signal)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    else await expect(runtime.listManaged(signal)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it.each([
    ['empty id', { previewId: '' }],
    ['long id', { previewId: 'x'.repeat(101) }],
    ['artifact root itself', { artifactPath: '/srv/dz23/artifacts' }],
    ['artifact with null byte', { artifactPath: '/srv/dz23/artifacts/run\0app' }],
    ['non-string owner', { ownerEmail: 123 }],
    ['long owner', { ownerEmail: `${'a'.repeat(250)}@x.test` }],
  ])('rejects the additional start boundary %s', async (_name, override) => {
    const transport = transportReturning({ runtime_ref: 'runtime:preview-01' })
    await expect(subject(transport).start({ ...validStartInput(), ...override } as Parameters<PreviewRuntimePort['start']>[0], new AbortController().signal))
      .rejects.toMatchObject({ code: 'INVALID' })
    expect(transport.exchange).not.toHaveBeenCalled()
  })

  it.each([
    ['body over limit', { method: 'POST', path: '/', headers: {}, body: Buffer.alloc(2 * 1024 * 1024 + 1) }],
    ['invalid method', { method: 'TRACE', path: '/', headers: {}, body: Buffer.alloc(0) }],
    ['absolute-form path', { method: 'GET', path: '//outside.test/', headers: {}, body: Buffer.alloc(0) }],
    ['relative path', { method: 'GET', path: 'relative', headers: {}, body: Buffer.alloc(0) }],
    ['backslash path', { method: 'GET', path: '/bad\\path', headers: {}, body: Buffer.alloc(0) }],
    ['control path', { method: 'GET', path: '/bad\npath', headers: {}, body: Buffer.alloc(0) }],
    ['unknown header', { method: 'GET', path: '/', headers: { authorization: 'secret' }, body: Buffer.alloc(0) }],
    ['long header', { method: 'GET', path: '/', headers: { accept: 'x'.repeat(4_097) }, body: Buffer.alloc(0) }],
    ['null header', { method: 'GET', path: '/', headers: { accept: 'x\0y' }, body: Buffer.alloc(0) }],
  ])('rejects the forward boundary %s before I/O', async (_name, request) => {
    const transport = transportReturning({})
    await expect(subject(transport).forward('runtime:one', request)).rejects.toMatchObject({ code: 'INVALID' })
    expect(transport.exchange).not.toHaveBeenCalled()
  })

  it('rejects more forwarding headers than the allowlist contains', async () => {
    const headers = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`x-${index}`, 'value']))
    const transport = transportReturning({})
    await expect(subject(transport).forward('runtime:one', { method: 'GET', path: '/', headers, body: Buffer.alloc(0) })).rejects.toMatchObject({ code: 'INVALID' })
    expect(transport.exchange).not.toHaveBeenCalled()
  })

  it.each([
    ['non-integer status', { status: 200.5, headers: {}, body_base64: '' }],
    ['low status', { status: 199, headers: {}, body_base64: '' }],
    ['high status', { status: 600, headers: {}, body_base64: '' }],
    ['non-string body', { status: 200, headers: {}, body_base64: 123 }],
    ['non-canonical body', { status: 200, headers: {}, body_base64: 'YQ' }],
    ['invalid body alphabet', { status: 200, headers: {}, body_base64: '**==' }],
    ['non-object headers', { status: 200, headers: null, body_base64: '' }],
    ['array headers', { status: 200, headers: [], body_base64: '' }],
    ['unknown response header', { status: 200, headers: { server: 'secret' }, body_base64: '' }],
    ['oversized response header', { status: 200, headers: { etag: 'x'.repeat(4_097) }, body_base64: '' }],
    ['invalid set-cookie type', { status: 200, headers: { 'set-cookie': 12 }, body_base64: '' }],
    ['too many set-cookie values', { status: 200, headers: { 'set-cookie': Array.from({ length: 11 }, () => 'a=b') }, body_base64: '' }],
    ['oversized set-cookie value', { status: 200, headers: { 'set-cookie': ['x'.repeat(4_097)] }, body_base64: '' }],
  ])('rejects the malformed forwarded response %s', async (_name, response) => {
    await expect(subject(transportReturning(response)).forward('runtime:one', { method: 'GET', path: '/', headers: {}, body: Buffer.alloc(0) }))
      .rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it('preserves the complete allowlisted response header shapes', async () => {
    const response = {
      status: 302,
      headers: { location: '/login', etag: 'v1', 'last-modified': 'today', 'set-cookie': ['one=1', 'two=2'] },
      body_base64: Buffer.from('redirect').toString('base64'),
    }
    await expect(subject(transportReturning(response)).forward('runtime:one', { method: 'HEAD', path: '/old?x=1', headers: {}, body: Buffer.alloc(0) }))
      .resolves.toEqual({ status: 302, headers: response.headers, body: Buffer.from('redirect') })
  })

  it('rejects invalid response identifiers as unavailable, not caller input', async () => {
    await expect(subject(transportReturning({ runtime_ref: '../escape' })).start(validStartInput(), new AbortController().signal)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await expect(subject(transportReturning({ runtimes: [{ runtime_ref: 'runtime:one', preview_id: '../escape' }] })).listManaged(new AbortController().signal)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it('rejects a transport result that is not bytes', async () => {
    const transport: SupervisorTransport = { exchange: vi.fn(() => Promise.resolve('not-bytes' as unknown as Uint8Array)) }
    await expect(subject(transport).health('runtime:one', new AbortController().signal)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it.each([
    ['relative socket', { socketPath: 'rpc.sock', tokenFile: '/run/token' }],
    ['relative token', { socketPath: '/run/rpc.sock', tokenFile: 'token' }],
    ['URL socket', { socketPath: 'http://host/rpc.sock', tokenFile: '/run/token' }],
    ['backslash token', { socketPath: '/run/rpc.sock', tokenFile: '/run\\token' }],
  ])('rejects invalid Unix control transport configuration: %s', (_name, options) => {
    expect(() => new UnixHttpSupervisorTransport(options)).toThrow(expect.objectContaining({ code: 'INVALID' }))
  })

  it('validates the Unix control credential and closed request before opening a socket', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-supervisor-guard-'))
    const tokenFile = join(root, 'token')
    try {
      await writeFile(tokenFile, 'short')
      const invalidToken = new UnixHttpSupervisorTransport({ socketPath: join(root, 'absent.sock'), tokenFile })
      await expect(invalidToken.exchange({ operation: 'health', body: {}, signal: new AbortController().signal, maxResponseBytes: 100 }))
        .rejects.toThrow('invalid supervisor credential')

      await writeFile(tokenFile, 'a'.repeat(43))
      const guarded = new UnixHttpSupervisorTransport({ socketPath: join(root, 'absent.sock'), tokenFile })
      await expect(guarded.exchange({ operation: 'forward', body: {}, signal: new AbortController().signal, maxResponseBytes: 100 }))
        .rejects.toThrow('forward requires the isolated data plane')
      await expect(guarded.exchange({ operation: 'logs', body: { data: 'x'.repeat(70 * 1024) }, signal: new AbortController().signal, maxResponseBytes: 100 }))
        .rejects.toThrow('supervisor request too large')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('exchanges a valid closed envelope over the authenticated Unix control socket', async () => {
    await withUnixHttpServer(200, JSON.stringify({ ok: true, result: { health: 'OK' } }), async (socketPath, tokenFile) => {
      const transport = new UnixHttpSupervisorTransport({ socketPath, tokenFile })
      const result = await transport.exchange({ operation: 'health', body: { runtime_ref: 'runtime:one' }, signal: new AbortController().signal, maxResponseBytes: 1_024 })
      expect(JSON.parse(Buffer.from(result).toString('utf8'))).toEqual({ health: 'OK' })
    })
  })

  it.skipIf(process.platform === 'win32').each([
    ['non-200 status', 503, JSON.stringify({ ok: true, result: {} }), 'supervisor rejected request'],
    ['malformed JSON', 200, '{', 'invalid supervisor response'],
    ['array envelope', 200, '[]', 'invalid supervisor response'],
    ['false envelope', 200, JSON.stringify({ ok: false, result: {} }), 'invalid supervisor response'],
    ['missing result', 200, JSON.stringify({ ok: true }), 'invalid supervisor response'],
    ['extra field', 200, JSON.stringify({ ok: true, result: {}, extra: true }), 'invalid supervisor response'],
  ])('rejects the Unix control response %s', async (_name, status, body, message) => {
    await withUnixHttpServer(status, body, async (socketPath, tokenFile) => {
      const transport = new UnixHttpSupervisorTransport({ socketPath, tokenFile })
      await expect(transport.exchange({ operation: 'health', body: {}, signal: new AbortController().signal, maxResponseBytes: 1_024 }))
        .rejects.toThrow(message)
    })
  })

  it.skipIf(process.platform === 'win32')('bounds a Unix control response without leaving an unhandled stream error', async () => {
    await withUnixHttpServer(200, 'x'.repeat(1_025), async (socketPath, tokenFile) => {
      const transport = new UnixHttpSupervisorTransport({ socketPath, tokenFile })
      await expect(transport.exchange({ operation: 'health', body: {}, signal: new AbortController().signal, maxResponseBytes: 1_024 }))
        .rejects.toThrow('supervisor response too large')
    })
  })

  it('rejects non-data operations and unsafe identifiers in the Unix proxy transport', async () => {
    const proxy = new UnixProxySupervisorTransport({ socketRoot: '/run/dz23' })
    await expect(proxy.exchange({ operation: 'health', body: {}, signal: new AbortController().signal, maxResponseBytes: 100 }))
      .rejects.toThrow('invalid data-plane operation')
    await expect(proxy.exchange({ operation: 'forward', body: { runtime_ref: '../escape' }, signal: new AbortController().signal, maxResponseBytes: 100 }))
      .rejects.toMatchObject({ code: 'INVALID' })
    const longRoot = new UnixProxySupervisorTransport({ socketRoot: `/${'x'.repeat(95)}` })
    await expect(longRoot.exchange({ operation: 'forward', body: { runtime_ref: 'runtime:one' }, signal: new AbortController().signal, maxResponseBytes: 100 }))
      .rejects.toThrow('proxy socket path too long')
    await expect(proxy.exchange({ operation: 'forward', body: { runtime_ref: 'runtime:one', data: 'x'.repeat(3 * 1024 * 1024) }, signal: new AbortController().signal, maxResponseBytes: 100 }))
      .rejects.toThrow('proxy request too large')
  })

  it.skipIf(process.platform === 'win32')('exchanges and bounds raw data-plane responses over a per-runtime Unix socket', async () => {
    await withUnixHttpServer(200, JSON.stringify({ status: 200 }), async socketPath => {
      const root = socketPath.slice(0, -'/rpc.sock'.length)
      const runtimeSocket = join(root, 'runtime:one.sock')
      await new Promise<void>((resolve, reject) => {
        const mover = createServer((_request, response) => response.end(JSON.stringify({ status: 200 })))
        mover.once('error', reject)
        mover.listen(runtimeSocket, async () => {
          try {
            const proxy = new UnixProxySupervisorTransport({ socketRoot: root })
            const result = await proxy.exchange({ operation: 'forward', body: { runtime_ref: 'runtime:one' }, signal: new AbortController().signal, maxResponseBytes: 1_024 })
            expect(JSON.parse(Buffer.from(result).toString('utf8'))).toEqual({ status: 200 })
          } finally {
            mover.close(() => resolve())
          }
        })
      })
    })
  })

  it.skipIf(process.platform === 'win32')('rejects a non-200 response from the Unix data plane', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-proxy-reject-'))
    const socketPath = join(root, 'runtime:one.sock')
    const server = createServer((_request, response) => { response.statusCode = 403; response.end('{}') })
    try {
      await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once('error', reject))
      const proxy = new UnixProxySupervisorTransport({ socketRoot: root })
      await expect(proxy.exchange({ operation: 'forward', body: { runtime_ref: 'runtime:one' }, signal: new AbortController().signal, maxResponseBytes: 1_024 }))
        .rejects.toThrow('proxy rejected request')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('bounds a Unix data-plane response without leaving an unhandled stream error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-proxy-bounded-'))
    const socketPath = join(root, 'runtime:one.sock')
    const server = createServer((_request, response) => response.end('x'.repeat(1_025)))
    try {
      await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once('error', reject))
      const proxy = new UnixProxySupervisorTransport({ socketRoot: root })
      await expect(proxy.exchange({ operation: 'forward', body: { runtime_ref: 'runtime:one' }, signal: new AbortController().signal, maxResponseBytes: 1_024 }))
        .rejects.toThrow('proxy response too large')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  })
})
