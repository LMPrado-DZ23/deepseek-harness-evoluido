import { describe, expect, it, vi } from 'vitest'
import { ArtifactIngressError, type ArtifactIngressPort } from '../src/artifact-ingress.js'
import { createArtifactIngressHttpHandler, type ArtifactIngressHttpInput } from '../src/artifact-ingress-http.js'

const token = 'A'.repeat(43)
const uploadRef = `upload_${'b'.repeat(32)}`
const requestId = `req_${'c'.repeat(32)}`
const active = new AbortController().signal

describe('artifact ingress HTTP adapter (NOT_WIRED)', () => {
  it('validates configuration before exposing a handler', () => {
    expect(() => createArtifactIngressHttpHandler({ bearerToken: 'short', ingress: fake() })).toThrow('INVALID_SUPERVISOR_TOKEN')
    for (const options of [{ idleTimeoutMs: 0 }, { totalTimeoutMs: 3_600_001 }, { idleTimeoutMs: 20, totalTimeoutMs: 10 }]) expect(() => createArtifactIngressHttpHandler({ bearerToken: token, ingress: fake(), ...options })).toThrow('INVALID_ARTIFACT_TIMEOUT')
  })

  it('authenticates before routing or consuming bytes', async () => {
    const ingress = fake(); const next = vi.fn(async function* () { yield Buffer.from('{}') })
    const handler = createArtifactIngressHttpHandler({ bearerToken: token, ingress })
    const missing = await handler.handle(input({ body: { [Symbol.asyncIterator]: next } }))
    const wrong = await handler.handle(input({ headers: { authorization: `Bearer ${'B'.repeat(43)}`, 'content-length': '2' }, body: { [Symbol.asyncIterator]: next } }))
    expect(missing.status).toBe(401); expect(wrong.body).toEqual(missing.body); expect(next).not.toHaveBeenCalled(); expect(ingress.begin).not.toHaveBeenCalled()
  })

  it('dispatches idempotent begin and abort controls with exact schemas', async () => {
    const ingress = fake(); const handler = createArtifactIngressHttpHandler({ bearerToken: token, ingress })
    const begin = { operation: 'artifact.begin', request_id: requestId, build_id: 'run-one', content_length: 1024, wire_sha256: 'd'.repeat(64) }
    const begun = await handler.handle(control(begin))
    expect(decode(begun)).toEqual({ ok: true, upload_ref: uploadRef, state: 'RECEIVING', idempotent: false })
    expect(ingress.begin).toHaveBeenCalledWith({ buildId: 'run-one', contentLength: 1024, wireSha256: 'd'.repeat(64) })
    const aborted = await handler.handle(control({ operation: 'artifact.abort', request_id: requestId, upload_ref: uploadRef }))
    expect(decode(aborted)).toEqual({ ok: true, state: 'FAILED' }); expect(ingress.abort).toHaveBeenCalledWith(uploadRef)
  })

  it.each([
    null,
    { operation: 'artifact.begin', request_id: 'bad', build_id: 'run', content_length: 1, wire_sha256: 'd'.repeat(64) },
    { operation: 'artifact.begin', request_id: requestId, build_id: '../bad', content_length: 1, wire_sha256: 'd'.repeat(64) },
    { operation: 'artifact.begin', request_id: requestId, build_id: 'run', content_length: 0, wire_sha256: 'd'.repeat(64) },
    { operation: 'artifact.begin', request_id: requestId, build_id: 'run', content_length: 1, wire_sha256: 'bad' },
    { operation: 'artifact.begin', request_id: requestId, build_id: 'run', content_length: 1, wire_sha256: 'd'.repeat(64), extra: true },
    { operation: 'artifact.abort', request_id: 'bad', upload_ref: uploadRef },
    { operation: 'artifact.abort', request_id: requestId, upload_ref: 'bad' },
    { operation: 'artifact.abort', request_id: requestId, upload_ref: uploadRef, extra: true },
    { operation: 'unknown' },
  ])('rejects malformed or authority-expanding control %j', async body => {
    const result = await createArtifactIngressHttpHandler({ bearerToken: token, ingress: fake() }).handle(control(body))
    expect(result.status).toBe(409); expect(decode(result)).toEqual({ ok: false, error: { code: 'ARTIFACT_INVALID' } })
  })

  it('rejects malformed JSON, UTF-8, length and transfer metadata before dispatch', async () => {
    const ingress = fake(); const handler = createArtifactIngressHttpHandler({ bearerToken: token, ingress })
    for (const fixture of [
      controlRaw(Buffer.from('{')),
      controlRaw(Buffer.from([0xff])),
      input({ method: 'GET', headers: auth() }),
      input({ path: '/v1/artifacts/missing', headers: auth() }),
      input({ headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' } }),
      controlRaw(Buffer.from('{}'), { 'transfer-encoding': 'chunked' }),
      controlRaw(Buffer.from('{}'), { 'content-encoding': 'gzip' }),
      input({ headers: auth() }),
      controlRaw(Buffer.from('{}'), { 'content-type': 'text/plain' }),
      input({ headers: { ...auth(), 'content-length': ['2', '2'] } }),
      input({ headers: { ...auth(), 'content-length': '01' } }),
      controlRaw(Buffer.from('{}'), { 'content-length': '0' }),
      input({ headers: { ...auth(), 'content-length': '999999999999999999999999999999' } }),
      input({ headers: { ...auth(), 'content-length': '4097' } }),
      controlRaw(Buffer.from('{}x'), { 'content-length': '2' }),
      controlRaw(Buffer.from('{}'), { 'content-length': '3' }),
    ]) expect((await handler.handle(fixture)).status).not.toBe(200)
    expect(ingress.begin).not.toHaveBeenCalled()
  })

  it('streams PUT bytes to the core and rejects unsafe framing/media types', async () => {
    const ingress = fake(); const handler = createArtifactIngressHttpHandler({ bearerToken: token, ingress })
    const body = Buffer.from('tar bytes')
    const result = await handler.handle(upload(body))
    expect(decode(result)).toEqual({ ok: true, upload_ref: uploadRef, state: 'READY', idempotent: false })
    const call = vi.mocked(ingress.upload).mock.calls[0]!
    expect(call[0]).toBe(uploadRef); expect(call[2]).toBe(body.byteLength); expect(Buffer.from((await collect(call[1])))).toEqual(body)
    for (const fixture of [
      upload(body, { method: 'POST' }), upload(body, { path: `/v1/artifacts/${uploadRef}/extra` }), upload(body, { headers: { 'content-type': 'text/plain' } }),
      upload(body, { headers: { 'transfer-encoding': 'chunked' } }), upload(body, { headers: { 'content-encoding': 'gzip' } }), upload(body, { headers: { 'content-length': String(320 * 1024 * 1024 + 1) } }),
    ]) expect((await handler.handle(fixture)).status).not.toBe(200)
  })

  it.each([
    ['ARTIFACT_NOT_FOUND', 404], ['ARTIFACT_QUOTA_EXCEEDED', 413], ['ARTIFACT_TIMEOUT', 503], ['CLEANUP_INCOMPLETE', 503], ['ARTIFACT_CONFLICT', 409],
  ] as const)('maps the closed core error %s to %s without details', async (code, status) => {
    const ingress = fake(); vi.mocked(ingress.begin).mockRejectedValueOnce(new ArtifactIngressError(code))
    const result = await createArtifactIngressHttpHandler({ bearerToken: token, ingress }).handle(control({ operation: 'artifact.begin', request_id: requestId, build_id: 'run', content_length: 1, wire_sha256: 'd'.repeat(64) }))
    expect(result.status).toBe(status); expect(Buffer.from(result.body).toString()).not.toContain('private')
  })

  it('bounds idle/total time, aborts the upload and maps shutdown distinctly', async () => {
    vi.useFakeTimers()
    try {
      const ingress = fake()
      vi.mocked(ingress.upload).mockImplementation(async (_ref, source, _length, signal) => { for await (const _chunk of source) await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new ArtifactIngressError('ARTIFACT_TIMEOUT')), { once: true })); throw new ArtifactIngressError('ARTIFACT_TIMEOUT') })
      const handler = createArtifactIngressHttpHandler({ bearerToken: token, ingress, idleTimeoutMs: 10, totalTimeoutMs: 20 })
      const pending = handler.handle(upload(Buffer.from('x')))
      await vi.advanceTimersByTimeAsync(10)
      await expect(pending).resolves.toMatchObject({ status: 503 })
      expect(ingress.abort).toHaveBeenCalledWith(uploadRef)
    } finally { vi.useRealTimers() }
    vi.useFakeTimers()
    try {
      const totalIngress = fake()
      vi.mocked(totalIngress.upload).mockImplementation(async (_ref, source) => { for await (const _chunk of source) { /* consume */ } return { uploadRef, state: 'READY', idempotent: false } })
      const totalHandler = createArtifactIngressHttpHandler({ bearerToken: token, ingress: totalIngress, idleTimeoutMs: 10, totalTimeoutMs: 10 })
      const totalPending = totalHandler.handle(upload(Buffer.from('x'), { body: hangingSource() }))
      await vi.advanceTimersByTimeAsync(10)
      await expect(totalPending).resolves.toMatchObject({ status: 503 })
    } finally { vi.useRealTimers() }
    const rejectingIngress = fake(); vi.mocked(rejectingIngress.upload).mockImplementation(async (_ref, source) => { for await (const _chunk of source) { /* consume */ } return { uploadRef, state: 'READY', idempotent: false } })
    async function* rejecting(): AsyncGenerator<Uint8Array> { throw new Error('private source') }
    expect((await createArtifactIngressHttpHandler({ bearerToken: token, ingress: rejectingIngress }).handle(upload(Buffer.from('x'), { body: rejecting() }))).status).toBe(500)
    vi.useFakeTimers()
    try {
      const hangingIngress = fake()
      vi.mocked(hangingIngress.upload).mockImplementation(async (_ref, source) => { for await (const _chunk of source) { /* consume */ } return { uploadRef, state: 'READY', idempotent: false } })
      const handler = createArtifactIngressHttpHandler({ bearerToken: token, ingress: hangingIngress, idleTimeoutMs: 10, totalTimeoutMs: 20 })
      const pending = handler.handle(upload(Buffer.from('x'), { body: hangingSource() }))
      await vi.advanceTimersByTimeAsync(10)
      await expect(pending).resolves.toMatchObject({ status: 503 })
      expect(hangingIngress.abort).toHaveBeenCalledWith(uploadRef)
    } finally { vi.useRealTimers() }
    const ingress = fake(); vi.mocked(ingress.begin).mockRejectedValueOnce(new Error('private'))
    expect((await createArtifactIngressHttpHandler({ bearerToken: token, ingress }).handle(control({ operation: 'artifact.begin', request_id: requestId, build_id: 'run', content_length: 1, wire_sha256: 'd'.repeat(64) }))).status).toBe(500)
    const controller = new AbortController(); controller.abort()
    const shutdown = control({ operation: 'artifact.begin', request_id: requestId, build_id: 'run', content_length: 1, wire_sha256: 'd'.repeat(64) }, { signal: controller.signal })
    vi.mocked(ingress.begin).mockRejectedValueOnce(controller.signal.reason)
    expect((await createArtifactIngressHttpHandler({ bearerToken: token, ingress }).handle(shutdown)).status).toBe(503)
    const uploadIngress = fake(); const uploadController = new AbortController(); uploadController.abort(new Error('private')); vi.mocked(uploadIngress.upload).mockRejectedValueOnce(uploadController.signal.reason)
    expect((await createArtifactIngressHttpHandler({ bearerToken: token, ingress: uploadIngress }).handle(upload(Buffer.from('x'), { signal: uploadController.signal }))).status).toBe(503)
    const resolveController = new AbortController(); let resolveNext!: (value: IteratorResult<Uint8Array>) => void
    const resolveIngress = fake(); vi.mocked(resolveIngress.upload).mockImplementation(async (_ref, source) => { for await (const _chunk of source) { /* consume */ } return { uploadRef, state: 'READY', idempotent: false } })
    const lateResolve = createArtifactIngressHttpHandler({ bearerToken: token, ingress: resolveIngress }).handle(upload(Buffer.from('x'), { body: pendingSource(resolve => { resolveNext = resolve }), signal: resolveController.signal }))
    await vi.waitFor(() => expect(resolveNext).toBeTypeOf('function')); resolveController.abort(); await expect(lateResolve).resolves.toMatchObject({ status: 503 }); resolveNext({ done: true, value: undefined }); await Promise.resolve()
    const rejectController = new AbortController(); let rejectNext!: (reason: Error) => void
    const rejectIngress = fake(); vi.mocked(rejectIngress.upload).mockImplementation(async (_ref, source) => { for await (const _chunk of source) { /* consume */ } return { uploadRef, state: 'READY', idempotent: false } })
    const lateReject = createArtifactIngressHttpHandler({ bearerToken: token, ingress: rejectIngress }).handle(upload(Buffer.from('x'), { body: pendingSource((_resolve, reject) => { rejectNext = reject }), signal: rejectController.signal }))
    await vi.waitFor(() => expect(rejectNext).toBeTypeOf('function')); rejectController.abort(); await expect(lateReject).resolves.toMatchObject({ status: 503 }); rejectNext(new Error('private late')); await Promise.resolve()
    for (const mode of ['missing', 'rejecting', 'throwing'] as const) {
      const specialController = new AbortController(); let specialEntered = false
      const specialIngress = fake(); vi.mocked(specialIngress.upload).mockImplementation(async (_ref, source) => { for await (const _chunk of source) { /* consume */ } return { uploadRef, state: 'READY', idempotent: false } })
      const special = createArtifactIngressHttpHandler({ bearerToken: token, ingress: specialIngress }).handle(upload(Buffer.from('x'), { body: abortReturnSource(mode, () => { specialEntered = true }), signal: specialController.signal }))
      await vi.waitFor(() => expect(specialEntered).toBe(true)); specialController.abort(new Error('private'))
      await expect(special).resolves.toMatchObject({ status: 503 }); await Promise.resolve()
    }
  })
})

function fake(): ArtifactIngressPort {
  return {
    begin: vi.fn(async () => ({ uploadRef, state: 'RECEIVING' as const, idempotent: false })),
    upload: vi.fn(async () => ({ uploadRef, state: 'READY' as const, idempotent: false })),
    abort: vi.fn(async () => undefined), claim: vi.fn(), sweep: vi.fn(async () => 0),
  }
}
function auth() { return { authorization: `Bearer ${token}`, 'content-length': '0' } }
function input(overrides: Partial<ArtifactIngressHttpInput> = {}): ArtifactIngressHttpInput { return { method: 'POST', path: '/v1/artifacts/rpc', headers: {}, body: bytes(Buffer.alloc(0)), signal: active, ...overrides } }
function control(value: unknown, overrides: Partial<ArtifactIngressHttpInput> = {}): ArtifactIngressHttpInput { const body = Buffer.from(JSON.stringify(value)); return input({ headers: { authorization: `Bearer ${token}`, 'content-length': String(body.byteLength), 'content-type': 'application/json; charset=utf-8' }, body: bytes(body), ...overrides }) }
function controlRaw(body: Buffer, headers: Record<string, string> = {}): ArtifactIngressHttpInput { return input({ headers: { authorization: `Bearer ${token}`, 'content-length': String(body.byteLength), 'content-type': 'application/json; charset=utf-8', ...headers }, body: bytes(body) }) }
function upload(body: Buffer, overrides: { method?: string; path?: string; headers?: Record<string, string>; body?: AsyncIterable<Uint8Array>; signal?: AbortSignal } = {}): ArtifactIngressHttpInput { return input({ method: overrides.method ?? 'PUT', path: overrides.path ?? `/v1/artifacts/${uploadRef}`, headers: { authorization: `Bearer ${token}`, 'content-length': String(body.byteLength), 'content-type': 'application/x-tar', ...overrides.headers }, body: overrides.body ?? bytes(body), ...(overrides.signal === undefined ? {} : { signal: overrides.signal }) }) }
async function* bytes(value: Uint8Array): AsyncGenerator<Uint8Array> { yield value }
function hangingSource(): AsyncIterable<Uint8Array> { return { [Symbol.asyncIterator]: () => ({ next: async () => new Promise<IteratorResult<Uint8Array>>(() => undefined), return: async () => ({ done: true, value: undefined }) }) } }
function pendingSource(register: (resolve: (value: IteratorResult<Uint8Array>) => void, reject: (reason: Error) => void) => void): AsyncIterable<Uint8Array> { return { [Symbol.asyncIterator]: () => ({ next: async () => new Promise<IteratorResult<Uint8Array>>(register), return: async () => ({ done: true, value: undefined }) }) } }
function abortReturnSource(mode: 'missing' | 'rejecting' | 'throwing', entered: () => void): AsyncIterable<Uint8Array> {
  return { [Symbol.asyncIterator]: () => {
    const iterator: AsyncIterator<Uint8Array> = { next: async () => { entered(); return new Promise<IteratorResult<Uint8Array>>(() => undefined) } }
    if (mode === 'rejecting') iterator.return = async () => { throw new Error('private return rejection') }
    if (mode === 'throwing') Object.defineProperty(iterator, 'return', { get: () => { throw new Error('private return getter') } })
    return iterator
  } }
}
async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> { const result: number[] = []; for await (const chunk of source) result.push(...chunk); return Uint8Array.from(result) }
function decode(value: { readonly body: Uint8Array }): unknown { return JSON.parse(Buffer.from(value.body).toString('utf8')) }
