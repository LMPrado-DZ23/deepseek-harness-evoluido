import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { ClientRequest, IncomingMessage, request as httpRequest } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { createArtifactIngressUnixClient, ArtifactIngressUnixClientError } from '../src/artifact-ingress-client.js'

const token = 'A'.repeat(43)
const uploadRef = `upload_${'b'.repeat(32)}`
const requestId = `req_${'c'.repeat(32)}`

describe('artifact ingress Unix client', () => {
  it('rejects unsafe construction and caller inputs before transport', async () => {
    for (const options of [
      { socketPath: 'relative' }, { socketPath: '/run/../bad' }, { socketPath: '/run/bad\\socket' }, { socketPath: `/${'a'.repeat(108)}` }, { credentialRef: 'env:TOKEN' }, { timeoutMs: 0 }, { timeoutMs: 3_600_001 },
    ]) expect(() => client(undefined, options)).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }))
    const request = vi.fn(); const instance = client(request as never)
    await expect(instance.begin({ requestId: 'bad', buildId: 'run', contentLength: 1, wireSha256: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(instance.begin({ requestId, buildId: '../bad', contentLength: 1, wireSha256: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(instance.begin({ requestId, buildId: 'run', contentLength: 0, wireSha256: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(instance.begin({ requestId, buildId: 'run', contentLength: 1, wireSha256: 'bad' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(instance.upload({ uploadRef: 'bad', contentLength: 1, source: bytes('x') })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(instance.upload({ uploadRef, contentLength: 0, source: bytes('') })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(instance.abort({ requestId: 'bad', uploadRef })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(instance.abort({ requestId, uploadRef: 'bad' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(request).not.toHaveBeenCalled()
  })

  it('streams begin, PUT with backpressure and abort over one socket without retries', async () => {
    const wire = fakeTransport([
      response(200, { ok: true, upload_ref: uploadRef, state: 'RECEIVING', idempotent: false }),
      response(200, { ok: true, upload_ref: uploadRef, state: 'READY', idempotent: false }),
      response(200, { ok: true, state: 'FAILED' }),
    ], true)
    const instance = client(wire.request)
    await expect(instance.begin({ requestId, buildId: 'run', contentLength: 3, wireSha256: 'a'.repeat(64) })).resolves.toMatchObject({ state: 'RECEIVING' })
    await expect(instance.upload({ uploadRef, contentLength: 3, source: pieces(['a', 'bc']) })).resolves.toMatchObject({ state: 'READY' })
    await expect(instance.abort({ requestId, uploadRef })).resolves.toBeUndefined()
    expect(wire.calls.map(call => [call.method, call.path])).toEqual([['POST', '/v1/artifacts/rpc'], ['PUT', `/v1/artifacts/${uploadRef}`], ['POST', '/v1/artifacts/rpc']])
    expect(Buffer.concat(wire.bodies).toString()).toContain('artifact.begin')
    expect(wire.calls[1]?.headers).toMatchObject({ authorization: `Bearer ${token}`, 'content-length': '3', 'content-type': 'application/x-tar' })
  })

  it('rejects an authority-expanding abort response', async () => {
    const instance = client(fakeTransport([response(200, { ok: true, state: 'FAILED', extra: true })]).request)
    await expect(instance.abort({ requestId, uploadRef })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('bounds streamed bytes and rejects early EOF without ending a valid request', async () => {
    const wire = fakeTransport([])
    const instance = client(wire.request)
    await expect(instance.upload({ uploadRef, contentLength: 1, source: bytes('xx') })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(instance.upload({ uploadRef, contentLength: 2, source: bytes('x') })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    async function* rejecting(): AsyncGenerator<Uint8Array> { throw new Error('private source') }
    await expect(instance.upload({ uploadRef, contentLength: 1, source: rejecting() })).rejects.toMatchObject({ code: 'TRANSPORT_ERROR' })
    const uintWire = fakeTransport([response(200, { ok: true, upload_ref: uploadRef, state: 'READY', idempotent: false })])
    await expect(client(uintWire.request).upload({ uploadRef, contentLength: 1, source: uintBytes([120]) })).resolves.toMatchObject({ state: 'READY' })
  })

  it('never accepts an early READY response before the request body settles successfully', async () => {
    const premature = ((options: Record<string, unknown>, callback: (response: IncomingMessage) => void) => {
      const emitter = new EventEmitter() as ClientRequest
      emitter.write = vi.fn(() => true) as never
      emitter.end = vi.fn(() => emitter) as never
      emitter.destroy = vi.fn(() => emitter) as never
      const encoded = Buffer.from(JSON.stringify({ ok: true, upload_ref: uploadRef, state: 'READY', idempotent: false }))
      const response = Readable.from([encoded]) as IncomingMessage
      response.statusCode = 200
      response.headers = { 'content-type': 'application/json; charset=utf-8', 'content-length': String(encoded.byteLength) }
      queueMicrotask(() => callback(response))
      const signal = options.signal as AbortSignal | undefined
      signal?.addEventListener('abort', () => emitter.emit('error', signal.reason), { once: true })
      return emitter
    }) as typeof httpRequest
    async function* lateFailure(): AsyncGenerator<Uint8Array> { yield Buffer.from('x'); throw new Error('private late source failure') }
    await expect(client(premature).upload({ uploadRef, contentLength: 2, source: lateFailure() })).rejects.toMatchObject({ code: 'TRANSPORT_ERROR' })
    async function* nonErrorFailure(): AsyncGenerator<Uint8Array> { yield Buffer.from('x'); throw 'private non-error source failure' }
    await expect(client(premature).upload({ uploadRef, contentLength: 2, source: nonErrorFailure() })).rejects.toMatchObject({ code: 'TRANSPORT_ERROR' })
  })

  it('sanitizes missing, malformed, throwing and rejected credentials', async () => {
    for (const resolve of [
      async () => undefined, async () => 'short', async () => { throw new Error('private async') }, () => { throw new Error('private sync') },
    ]) {
      const instance = createArtifactIngressUnixClient({ socketPath: '/run/test.sock', credentialRef: 'file:/run/token', credentials: { resolve } })
      await expect(instance.begin({ requestId, buildId: 'run', contentLength: 1, wireSha256: 'a'.repeat(64) })).rejects.toEqual(expect.objectContaining({ code: 'CREDENTIAL_UNAVAILABLE', message: 'CREDENTIAL_UNAVAILABLE' }))
    }
    const controller = new AbortController()
    let resolveLate!: (value: string) => void
    const lateCredential = new Promise<string>(resolve => { resolveLate = resolve })
    const pending = createArtifactIngressUnixClient({ socketPath: '/run/test.sock', credentialRef: 'file:/run/token', credentials: { resolve: async () => lateCredential } }).begin({ requestId, buildId: 'run', contentLength: 1, wireSha256: 'a'.repeat(64) }, controller.signal)
    controller.abort(new Error('private'))
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    resolveLate(token)
    await Promise.resolve()

    const rejectedController = new AbortController()
    let rejectLate!: (reason: Error) => void
    const rejectedCredential = new Promise<string>((_resolve, reject) => { rejectLate = reject })
    const rejected = createArtifactIngressUnixClient({ socketPath: '/run/test.sock', credentialRef: 'file:/run/token', credentials: { resolve: async () => rejectedCredential } }).begin({ requestId, buildId: 'run', contentLength: 1, wireSha256: 'a'.repeat(64) }, rejectedController.signal)
    rejectedController.abort(new Error('private'))
    await expect(rejected).rejects.toMatchObject({ code: 'ABORTED' })
    rejectLate(new Error('private late'))
    await Promise.resolve()

    vi.useFakeTimers()
    try {
      const timed = createArtifactIngressUnixClient({ socketPath: '/run/test.sock', credentialRef: 'file:/run/token', timeoutMs: 10, credentials: { resolve: async () => new Promise<string>(() => undefined) } }).begin({ requestId, buildId: 'run', contentLength: 1, wireSha256: 'a'.repeat(64) })
      await vi.advanceTimersByTimeAsync(10)
      await expect(timed).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' })
    } finally { vi.useRealTimers() }
  })

  it.each([
    response(200, { ok: true, upload_ref: 'bad', state: 'READY', idempotent: false }),
    response(200, { ok: true, upload_ref: uploadRef, state: 'FAILED', idempotent: false }),
    response(200, { ok: true, state: 'FAILED', extra: true }),
    response(200, '{', 'application/json'),
    response(200, {}, 'text/plain'),
    response(200, {}, 'application/json', '99999'),
    response(200, {}, 'application/json', '1'),
    response(200, null),
    response(200, []),
    response(200, '1', 'application/json'),
    response(200, { ok: true, upload_ref: uploadRef, state: 'READY', idempotent: false }, 'application/json', '1000'),
  ])('rejects malformed authenticated responses %#', async fixture => {
    const instance = client(fakeTransport([fixture]).request)
    await expect(instance.begin({ requestId, buildId: 'run', contentLength: 1, wireSha256: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('maps closed remote errors and transport failures without leaking detail', async () => {
    const remote = client(fakeTransport([response(409, { ok: false, error: { code: 'ARTIFACT_CONFLICT' } })]).request)
    await expect(remote.begin({ requestId, buildId: 'run', contentLength: 1, wireSha256: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT', status: 409 })
    const malformed = client(fakeTransport([response(500, { unexpected: 'private' })]).request)
    await expect(malformed.begin({ requestId, buildId: 'run', contentLength: 1, wireSha256: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    const unknown = client(fakeTransport([response(409, { ok: false, error: { code: 'PRIVATE_UNKNOWN' } })]).request)
    await expect(unknown.begin({ requestId, buildId: 'run', contentLength: 1, wireSha256: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    const direct = client(fakeTransport([response(404, { error: 'NOT_FOUND' })]).request)
    await expect(direct.begin({ requestId, buildId: 'run', contentLength: 1, wireSha256: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const throwing = client((() => { throw new Error('private') }) as typeof httpRequest)
    await expect(throwing.begin({ requestId, buildId: 'run', contentLength: 1, wireSha256: 'a'.repeat(64) })).rejects.toEqual(expect.objectContaining({ code: 'TRANSPORT_ERROR', message: 'TRANSPORT_ERROR' }))
    const missingStatus = client(fakeTransport([response(undefined, { error: 'NOT_FOUND' })]).request)
    await expect(missingStatus.begin({ requestId, buildId: 'run', contentLength: 1, wireSha256: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const uintResponse = client(fakeTransport([response(200, { ok: true, upload_ref: uploadRef, state: 'READY', idempotent: false }, 'application/json', undefined, true)]).request)
    await expect(uintResponse.begin({ requestId, buildId: 'run', contentLength: 1, wireSha256: 'a'.repeat(64) })).resolves.toMatchObject({ state: 'READY' })
  })

  it('classifies caller abort and deadline while streaming', async () => {
    const controller = new AbortController(); controller.abort(new Error('private'))
    await expect(client(fakeTransport([]).request).upload({ uploadRef, contentLength: 1, source: bytes('x') }, controller.signal)).rejects.toMatchObject({ code: 'ABORTED' })
    const wire = fakeTransport([]); const live = new AbortController(); let entered = false; let returned = false
    const aborted = client(wire.request).upload({ uploadRef, contentLength: 1, source: hangingSource(() => { entered = true }, () => { returned = true }) }, live.signal); await vi.waitFor(() => expect(entered).toBe(true)); live.abort(new Error('private'))
    await expect(aborted).rejects.toMatchObject({ code: 'ABORTED' }); expect(returned).toBe(true)
    const resolveController = new AbortController(); let resolveNext!: (value: IteratorResult<Uint8Array>) => void
    const lateResolve = client(fakeTransport([]).request).upload({ uploadRef, contentLength: 1, source: pendingSource(resolve => { resolveNext = resolve }) }, resolveController.signal)
    await vi.waitFor(() => expect(resolveNext).toBeTypeOf('function'))
    resolveController.abort(new Error('private')); await expect(lateResolve).rejects.toMatchObject({ code: 'ABORTED' }); resolveNext({ done: true, value: undefined }); await Promise.resolve()
    const rejectController = new AbortController(); let rejectNext!: (reason: Error) => void
    const lateReject = client(fakeTransport([]).request).upload({ uploadRef, contentLength: 1, source: pendingSource((_resolve, reject) => { rejectNext = reject }) }, rejectController.signal)
    await vi.waitFor(() => expect(rejectNext).toBeTypeOf('function'))
    rejectController.abort(new Error('private')); await expect(lateReject).rejects.toMatchObject({ code: 'ABORTED' }); rejectNext(new Error('private late')); await Promise.resolve()
    const drainController = new AbortController(); const stalled = fakeTransport([], 'stall')
    const waitingDrain = client(stalled.request).upload({ uploadRef, contentLength: 1, source: bytes('x') }, drainController.signal)
    await vi.waitFor(() => expect(stalled.bodies).toHaveLength(1)); drainController.abort(new Error('private'))
    await expect(waitingDrain).rejects.toMatchObject({ code: 'ABORTED' })
    for (const mode of ['missing', 'rejecting', 'throwing'] as const) {
      const specialController = new AbortController(); let specialEntered = false
      const special = client(fakeTransport([]).request).upload({ uploadRef, contentLength: 1, source: abortReturnSource(mode, () => { specialEntered = true }) }, specialController.signal)
      await vi.waitFor(() => expect(specialEntered).toBe(true)); specialController.abort(new Error('private'))
      await expect(special).rejects.toMatchObject({ code: 'ABORTED' }); await Promise.resolve()
    }
    vi.useFakeTimers()
    try {
      const instance = client(fakeTransport([]).request, { timeoutMs: 10 })
      const pending = instance.upload({ uploadRef, contentLength: 1, source: bytes('x') })
      await vi.advanceTimersByTimeAsync(10)
      await expect(pending).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' })
    } finally { vi.useRealTimers() }
  })

  it('exports a typed error with a stable sanitized message', () => {
    expect(new ArtifactIngressUnixClientError('CODE', 409)).toMatchObject({ name: 'ArtifactIngressUnixClientError', code: 'CODE', message: 'CODE', status: 409 })
  })
})

function client(request?: typeof httpRequest, overrides: Record<string, unknown> = {}) {
  return createArtifactIngressUnixClient({ socketPath: '/run/test.sock', credentialRef: 'file:/run/token', credentials: { resolve: async () => token }, ...(request === undefined ? {} : { request }), ...overrides })
}

interface ResponseFixture { readonly status: number | undefined; readonly value: unknown; readonly contentType: string; readonly declared?: string; readonly uint?: boolean }
function response(status: number | undefined, value: unknown, contentType = 'application/json; charset=utf-8', declared?: string, uint = false): ResponseFixture { return { status, value, contentType, uint, ...(declared === undefined ? {} : { declared }) } }
function fakeTransport(fixtures: ResponseFixture[], backpressure: boolean | 'stall' = false) {
  const calls: Array<Record<string, unknown>> = []; const bodies: Buffer[] = []
  const request = ((options: Record<string, unknown>, callback: (response: IncomingMessage) => void) => {
    calls.push(options)
    const emitter = new EventEmitter() as ClientRequest
    let first = true
    emitter.write = ((chunk: Uint8Array) => { bodies.push(Buffer.from(chunk)); if (backpressure && first) { first = false; if (backpressure !== 'stall') queueMicrotask(() => emitter.emit('drain')); return false } return true }) as typeof emitter.write
    emitter.destroy = vi.fn(() => emitter) as never
    emitter.end = vi.fn(() => {
      const fixture = fixtures.shift()
      if (fixture === undefined) return emitter
      const encoded = typeof fixture.value === 'string' ? Buffer.from(fixture.value) : Buffer.from(JSON.stringify(fixture.value))
      const response = Readable.from([fixture.uint ? new Uint8Array(encoded) : encoded]) as IncomingMessage
      response.statusCode = fixture.status
      response.headers = { 'content-type': fixture.contentType, 'content-length': fixture.declared ?? String(encoded.byteLength) }
      queueMicrotask(() => callback(response))
      return emitter
    }) as typeof emitter.end
    const signal = options.signal as AbortSignal | undefined
    signal?.addEventListener('abort', () => emitter.emit('error', signal.reason), { once: true })
    return emitter
  }) as typeof httpRequest
  return { request, calls, bodies }
}
async function* bytes(value: string): AsyncGenerator<Uint8Array> { yield Buffer.from(value) }
async function* uintBytes(value: readonly number[]): AsyncGenerator<Uint8Array> { yield Uint8Array.from(value) }
async function* pieces(values: readonly string[]): AsyncGenerator<Uint8Array> { for (const value of values) yield Buffer.from(value) }
function hangingSource(onNext: () => void, onReturn: () => void): AsyncIterable<Uint8Array> { return { [Symbol.asyncIterator]: () => ({ next: async () => { onNext(); return new Promise<IteratorResult<Uint8Array>>(() => undefined) }, return: async () => { onReturn(); return { done: true, value: undefined } } }) } }
function pendingSource(register: (resolve: (value: IteratorResult<Uint8Array>) => void, reject: (reason: Error) => void) => void): AsyncIterable<Uint8Array> { return { [Symbol.asyncIterator]: () => ({ next: async () => new Promise<IteratorResult<Uint8Array>>(register), return: async () => ({ done: true, value: undefined }) }) } }
function abortReturnSource(mode: 'missing' | 'rejecting' | 'throwing', entered: () => void): AsyncIterable<Uint8Array> {
  return { [Symbol.asyncIterator]: () => {
    const iterator: AsyncIterator<Uint8Array> = { next: async () => { entered(); return new Promise<IteratorResult<Uint8Array>>(() => undefined) } }
    if (mode === 'rejecting') iterator.return = async () => { throw new Error('private return rejection') }
    if (mode === 'throwing') Object.defineProperty(iterator, 'return', { get: () => { throw new Error('private return getter') } })
    return iterator
  } }
}
