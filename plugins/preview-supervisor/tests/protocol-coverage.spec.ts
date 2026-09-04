import { describe, expect, it, vi } from 'vitest'
import {
  createSupervisorRpcHandler, decodeForwardBody, parseSupervisorDataRequest,
  parseSupervisorRpcRequest, type SupervisorRpcMethods, type SupervisorRpcRequestInput,
} from '../src/protocol.js'

const TOKEN = 'coverage-only-token'
const TOKEN_REF = 'file:/run/secrets/preview-token'
const runtime = { runtime_ref: 'pv_0123456789abcdef0123456789abcdef' }
const start = { preview_id: 'preview-01', artifact_relative_path: 'runs/preview', artifact_sha256: 'a'.repeat(64), owner_email: 'owner@example.test' }

describe('supervisor data protocol adversarial coverage', () => {
  it.each(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const)('accepts canonical %s forwarding', method => {
    expect(parseSupervisorDataRequest({ operation: 'forward', body: {
      ...runtime, method, path: '/path?ok=1', headers: { accept: 'text/html' }, body_base64: Buffer.from('body').toString('base64'),
    } })).toMatchObject({ operation: 'forward', body: { method, path: '/path?ok=1' } })
  })

  it('accepts the exact verification request and decodes a bounded canonical body', () => {
    expect(parseSupervisorDataRequest({ operation: 'verification-messages', body: runtime })).toEqual({ operation: 'verification-messages', body: runtime })
    const forward = parseSupervisorDataRequest({ operation: 'forward', body: { ...runtime, method: 'POST', path: '/', headers: {}, body_base64: 'aGVsbG8=' } })
    if (forward.operation !== 'forward') throw new Error('unexpected operation')
    expect(decodeForwardBody(forward.body).toString('utf8')).toBe('hello')
  })

  it.each([
    { operation: 'unknown', body: runtime },
    { operation: 'forward', body: { ...runtime, method: 'TRACE', path: '/', headers: {}, body_base64: '' } },
    { operation: 'forward', body: { ...runtime, method: 'GET', path: '//host', headers: {}, body_base64: '' } },
    { operation: 'forward', body: { ...runtime, method: 'GET', path: '/bad\\path', headers: {}, body_base64: '' } },
    { operation: 'forward', body: { ...runtime, method: 'GET', path: '/bad\npath', headers: {}, body_base64: '' } },
    { operation: 'forward', body: { ...runtime, method: 'GET', path: `/${'x'.repeat(8_192)}`, headers: {}, body_base64: '' } },
    { operation: 'forward', body: { ...runtime, method: 'GET', path: '/', headers: { Bad: 'value' }, body_base64: '' } },
    { operation: 'forward', body: { ...runtime, method: 'GET', path: '/', headers: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`x-${index}`, 'v'])), body_base64: '' } },
    { operation: 'forward', body: { ...runtime, method: 'GET', path: '/', headers: { accept: `x${'y'.repeat(4_096)}` }, body_base64: '' } },
    { operation: 'forward', body: { ...runtime, method: 'GET', path: '/', headers: { accept: 'x\0y' }, body_base64: '' } },
    { operation: 'forward', body: { ...runtime, method: 'GET', path: '/', headers: {}, body_base64: 'not canonical' } },
    { operation: 'forward', body: { ...runtime, method: 'GET', path: '/', headers: {}, body_base64: 'A'.repeat(2_796_209) } },
  ])('rejects malformed data request %#', value => {
    expect(() => parseSupervisorDataRequest(value)).toThrow('INVALID_REQUEST')
  })

  it('rejects decoded bodies above 2 MiB even when their base64 is canonical', () => {
    expect(() => decodeForwardBody({ ...runtime, method: 'POST', path: '/', headers: {}, body_base64: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64') })).toThrow('INVALID_FORWARD_BODY')
  })
})

describe('supervisor RPC result validation and dispatch coverage', () => {
  it.each([
    ['start', start, { runtime_ref: runtime.runtime_ref }],
    ['stop', runtime, { stopped: false }],
    ['health', runtime, { health: 'DOWN' }],
    ['logs', { ...runtime, limit: 1 }, { events: [{ at: '2030-01-01T00:00:00.000Z', level: 'warn', event: 'HEALTH_DOWN' }] }],
    ['verification-messages', runtime, { messages: [{ kind: 'code', email: 'owner@example.test', code: '123456', expiresAt: '2030-01-01T00:00:00.000Z' }] }],
    ['list-managed', {}, { runtimes: [{ runtime_ref: runtime.runtime_ref, preview_id: 'preview-01' }] }],
  ] as const)('dispatches and validates %s result', async (operation, body, result) => {
    const fixture = rpcFixture({ [operation]: vi.fn(async () => result) })
    const response = await fixture.send({ operation, body })
    expect(response.status).toBe(200)
    expect(decode(response)).toEqual({ ok: true, result })
    expect(fixture.methods[operation]).toHaveBeenCalledOnce()
  })

  it('accepts every public diagnostic event and each supported severity', async () => {
    const events = [
      'ARTIFACT_VERIFIED', 'HEALTH_DOWN', 'HEALTH_OK', 'NETWORK_EGRESS_BLOCKED',
      'PREVIEW_STARTED', 'PREVIEW_STOPPED', 'PROCESS_EXITED', 'RUNTIME_RESTARTED',
    ].map((event, index) => ({ at: '2030-01-01T00:00:00.000Z', level: ['info', 'warn', 'error'][index % 3], event }))
    const fixture = rpcFixture({ logs: vi.fn(async () => ({ events })) })

    expect((await fixture.send({ operation: 'logs', body: { ...runtime, limit: 8 } })).status).toBe(200)
  })

  it.each([
    ['start', start, { runtime_ref: '../bad' }],
    ['stop', runtime, { stopped: 'yes' }],
    ['health', runtime, { health: 'MAYBE' }],
    ['logs', { ...runtime, limit: 1 }, { events: [{ at: 'bad-date', level: 'debug', event: 'SECRET_EVENT' }] }],
    ['logs', { ...runtime, limit: 1 }, { events: Array.from({ length: 101 }, () => ({ at: '2030-01-01T00:00:00Z', level: 'info', event: 'HEALTH_OK' })) }],
    ['verification-messages', runtime, { messages: [{ kind: 'secret', email: 'bad', code: '123', expiresAt: 'never' }] }],
    ['verification-messages', runtime, { messages: Array.from({ length: 21 }, () => ({ kind: 'code', email: 'a@b.test', code: '123456', expiresAt: '2030-01-01T00:00:00Z' })) }],
    ['list-managed', {}, { runtimes: [{ runtime_ref: '../bad', preview_id: 'bad/id' }] }],
    ['list-managed', {}, { runtimes: Array.from({ length: 1_001 }, () => ({ runtime_ref: 'ok', preview_id: 'ok' })) }],
  ] as const)('fails closed for adversarial %s result %#', async (operation, body, result) => {
    const fixture = rpcFixture({ [operation]: vi.fn(async () => result) })
    const response = await fixture.send({ operation, body })
    expect(response.status).toBe(500)
    expect(decode(response)).toEqual({ ok: false, error: { code: 'INTERNAL', message: 'O supervisor não conseguiu concluir a operação.' } })
  })

  it('rejects invalid UTF-8 and invalid JSON before dispatch', async () => {
    const fixture = rpcFixture()
    const utf8 = await fixture.send(undefined, Buffer.from([0xc3, 0x28]))
    const json = await fixture.send(undefined, Buffer.from('{broken'))
    expect(utf8.status).toBe(400)
    expect(json.status).toBe(400)
    expect(Object.values(fixture.methods).every(method => method.mock.calls.length === 0)).toBe(true)
  })

  it('short-circuits wrong path, method and unavailable credentials without dispatch', async () => {
    const fixture = rpcFixture()
    expect((await fixture.send({ operation: 'list-managed', body: {} }, undefined, { path: '/other' })).status).toBe(404)
    expect((await fixture.send({ operation: 'list-managed', body: {} }, undefined, { method: 'GET' })).status).toBe(405)
    fixture.secret = undefined
    expect((await fixture.send({ operation: 'list-managed', body: {} })).status).toBe(401)
    expect(Object.values(fixture.methods).every(method => method.mock.calls.length === 0)).toBe(true)
  })

  it('rejects invalid credential references at construction', () => {
    const fixture = rpcFixture()
    expect(() => createSupervisorRpcHandler({ credentialRef: 'env:TOKEN', credentials: fixture.credentials, methods: fixture.methods as unknown as SupervisorRpcMethods })).toThrow('INVALID_CREDENTIAL_REFERENCE')
  })

  it('strictly rejects non-object envelopes, unknown operations and extra list-managed fields', () => {
    expect(() => parseSupervisorRpcRequest(null)).toThrow('INVALID_REQUEST')
    expect(() => parseSupervisorRpcRequest({ operation: 'destroy', body: {} })).toThrow('INVALID_REQUEST')
    expect(() => parseSupervisorRpcRequest({ operation: 'list-managed', body: { all: true } })).toThrow('INVALID_REQUEST')
  })
})

function rpcFixture(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  let secret: string | undefined = TOKEN
  const methods = {
    start: vi.fn(async () => ({ runtime_ref: runtime.runtime_ref })), stop: vi.fn(async () => ({ stopped: true })),
    health: vi.fn(async () => ({ health: 'OK' })), logs: vi.fn(async () => ({ events: [] })),
    'verification-messages': vi.fn(async () => ({ messages: [] })), 'list-managed': vi.fn(async () => ({ runtimes: [] })),
    ...overrides,
  }
  const credentials = { resolve: vi.fn(async () => secret) }
  const handler = createSupervisorRpcHandler({ credentialRef: TOKEN_REF, credentials, methods: methods as unknown as SupervisorRpcMethods })
  return {
    methods, credentials,
    get secret() { return secret }, set secret(value: string | undefined) { secret = value },
    send: async (value: unknown, raw?: Uint8Array, request: { path?: string; method?: string } = {}) => handler.handle({
      path: request.path ?? '/v1/rpc', method: request.method ?? 'POST', headers: { authorization: `Bearer ${TOKEN}` },
      body: raw ?? Buffer.from(JSON.stringify(value)), signal: new AbortController().signal,
    } satisfies SupervisorRpcRequestInput),
  }
}

function decode(response: { body: Uint8Array }): unknown { return JSON.parse(Buffer.from(response.body).toString('utf8')) as unknown }
