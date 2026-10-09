import { describe, expect, it, vi } from 'vitest'
import * as protocol from '../src/protocol.js'

const TOKEN_REFERENCE = 'file:/run/secrets/dz23-preview-supervisor-token'
const TOKEN = 'test-only-opaque-bearer-token'
type RpcMethod = 'start' | 'stop' | 'health' | 'logs' | 'verification-messages' | 'list-managed'

const validCases = [
  {
    operation: 'start',
    body: { preview_id: 'preview-01', artifact_relative_path: 'runs/run-01/app.tar', artifact_sha256: 'a'.repeat(64), owner_email: 'owner@example.test' },
  },
  { operation: 'stop', body: { runtime_ref: 'container:preview-01' } },
  { operation: 'health', body: { runtime_ref: 'container:preview-01' } },
  { operation: 'logs', body: { runtime_ref: 'container:preview-01', limit: 50 } },
  { operation: 'verification-messages', body: { runtime_ref: 'container:preview-01' } },
  { operation: 'list-managed', body: {} },
] as const satisfies readonly { readonly operation: RpcMethod; readonly body: Readonly<Record<string, unknown>> }[]

const expectedProtocol = protocol as unknown as {
  readonly SUPERVISOR_RPC_PATH?: string
  readonly SUPERVISOR_RPC_MAX_BODY_BYTES?: number
  readonly createSupervisorRpcHandler?: (options: {
    readonly credentialRef: string
    readonly credentials: { resolve(reference: string): Promise<string | undefined> }
    readonly methods: Record<RpcMethod, (params: Readonly<Record<string, unknown>>, signal: AbortSignal) => Promise<unknown>>
  }) => {
    handle(request: {
      readonly path: string
      readonly method: string
      readonly headers: Readonly<Record<string, string>>
      readonly body: Uint8Array
      readonly signal: AbortSignal
    }): Promise<{ readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: Uint8Array }>
  }
}

describe('preview supervisor strict RPC request DTOs', () => {
  it.each(validCases)('accepts the exact $operation DTO', ({ operation, body }) => {
    expect(protocol.parseSupervisorRpcRequest({ operation, body })).toEqual({ operation, body })
  })

  it.each(validCases)('rejects an extra field in the $operation DTO', ({ operation, body }) => {
    expect(() => protocol.parseSupervisorRpcRequest({ operation, body: { ...body, unexpected: true } })).toThrow()
  })

  it.each(validCases)('rejects an extra field in the $operation envelope', ({ operation, body }) => {
    expect(() => protocol.parseSupervisorRpcRequest({ operation, body, unexpected: true })).toThrow()
  })

  it.each(['image', 'command', 'mount', 'mounts', 'network', 'port', 'env', 'labels'])('never accepts caller-controlled start field %s', field => {
    expect(() => protocol.parseSupervisorRpcRequest({
      operation: 'start',
      body: { ...validCases[0].body, [field]: field === 'port' ? 3000 : 'attacker-controlled' },
    })).toThrow()
  })

  it.each([
    '../app.tar',
    '/absolute/app.tar',
    'runs/../../secret',
    'runs\\escape\\app.tar',
    './runs/app.tar',
    'runs//app.tar',
    'runs/app.tar\0hidden',
  ])('rejects unsafe artifact_relative_path %j', artifact_relative_path => {
    expect(() => protocol.parseSupervisorRpcRequest({
      operation: 'start', body: { ...validCases[0].body, artifact_relative_path },
    })).toThrow()
  })

  it.each([
    ['preview_id', ''], ['preview_id', '../preview'], ['preview_id', 'preview/id'], ['preview_id', 'x'.repeat(101)],
    ['artifact_sha256', 'A'.repeat(64)], ['artifact_sha256', 'a'.repeat(63)],
    ['owner_email', 'Owner@Example.test'], ['owner_email', '../owner'], ['owner_email', 'x'.repeat(255)],
  ])('rejects invalid start identifier %s=%j', (field, value) => {
    expect(() => protocol.parseSupervisorRpcRequest({
      operation: 'start', body: { ...validCases[0].body, [field]: value },
    })).toThrow()
  })

  it.each(['', '../runtime', 'runtime/ref', 'runtime ref', 'x'.repeat(201)])('rejects invalid runtime_ref %j', runtime_ref => {
    expect(() => protocol.parseSupervisorRpcRequest({ operation: 'health', body: { runtime_ref } })).toThrow()
  })

  it.each([0, -1, 101, 1.5, Number.NaN])('rejects an unsafe logs limit %j', limit => {
    expect(() => protocol.parseSupervisorRpcRequest({
      operation: 'logs', body: { runtime_ref: 'container:preview-01', limit },
    })).toThrow()
  })
})

const hasHttpProtocol = typeof expectedProtocol.createSupervisorRpcHandler === 'function'

describe('preview supervisor /v1/rpc HTTP contract', () => {
  it('exports the strict handler, fixed path and bounded body limit', () => {
    expect(expectedProtocol.SUPERVISOR_RPC_PATH, 'SUPERVISOR_RPC_PATH ainda não foi exportado').toBe('/v1/rpc')
    expect(expectedProtocol.SUPERVISOR_RPC_MAX_BODY_BYTES, 'SUPERVISOR_RPC_MAX_BODY_BYTES ainda não foi exportado')
      .toBeTypeOf('number')
    expect(expectedProtocol.SUPERVISOR_RPC_MAX_BODY_BYTES!).toBeGreaterThan(0)
    expect(expectedProtocol.SUPERVISOR_RPC_MAX_BODY_BYTES!).toBeLessThanOrEqual(3 * 1024 * 1024)
    expect(expectedProtocol.createSupervisorRpcHandler, 'createSupervisorRpcHandler ainda não foi exportado').toBeTypeOf('function')
  })

  describe.skipIf(!hasHttpProtocol)('when the testable HTTP protocol export is available', () => {
    function fixture(overrides: Partial<Record<RpcMethod, ReturnType<typeof vi.fn>>> = {}) {
      const resolveCredential = vi.fn(async (reference: string) => reference === TOKEN_REFERENCE ? TOKEN : undefined)
      const methods = Object.fromEntries(validCases.map(item => [item.operation, vi.fn(async () => resultFor(item.operation))])) as Record<RpcMethod, ReturnType<typeof vi.fn>>
      Object.assign(methods, overrides)
      const callableMethods = methods as unknown as Record<
        RpcMethod,
        (params: Readonly<Record<string, unknown>>, signal: AbortSignal) => Promise<unknown>
      >
      const handler = expectedProtocol.createSupervisorRpcHandler!({
        credentialRef: TOKEN_REFERENCE,
        credentials: { resolve: resolveCredential },
        methods: callableMethods,
      })
      return { handler, methods, resolveCredential }
    }

    async function send(
      handler: ReturnType<NonNullable<typeof expectedProtocol.createSupervisorRpcHandler>>,
      value: unknown,
      options: { token?: string; path?: string; method?: string; rawBody?: Uint8Array } = {},
    ) {
      return handler.handle({
        path: options.path ?? '/v1/rpc', method: options.method ?? 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        },
        body: options.rawBody ?? Buffer.from(JSON.stringify(value)),
        signal: new AbortController().signal,
      })
    }

    function decode(response: { readonly body: Uint8Array }): unknown {
      return JSON.parse(Buffer.from(response.body).toString('utf8')) as unknown
    }

    it('resolves bearer material only by reference and returns the same generic denial for missing or wrong tokens', async () => {
      const f = fixture()
      const value = { operation: 'list-managed', body: {} }
      const missing = await send(f.handler, value)
      const wrong = await send(f.handler, value, { token: 'wrong-token' })

      expect(missing.status).toBe(401)
      expect(wrong.status).toBe(401)
      expect(decode(missing)).toEqual(decode(wrong))
      expect(JSON.stringify(decode(missing))).not.toContain(TOKEN)
      expect(f.resolveCredential).toHaveBeenNthCalledWith(1, TOKEN_REFERENCE)
      expect(f.resolveCredential).toHaveBeenNthCalledWith(2, TOKEN_REFERENCE)
      expect(f.methods['list-managed']).not.toHaveBeenCalled()
    })

    it('rejects an oversized body before parsing or dispatch', async () => {
      const f = fixture()
      const response = await send(f.handler, {}, {
        token: TOKEN,
        rawBody: Buffer.alloc(expectedProtocol.SUPERVISOR_RPC_MAX_BODY_BYTES! + 1, 0x61),
      })
      expect(response.status).toBe(413)
      expect(Object.values(f.methods).every(method => method.mock.calls.length === 0)).toBe(true)
    })

    it('fails closed when a method tries to add internal response fields', async () => {
      const leaking = vi.fn(async () => ({
        health: 'OK', internal_path: '/run/secret.sock', authorization: `Bearer ${TOKEN}`,
      }))
      const f = fixture({ health: leaking })
      const response = await send(f.handler, { operation: 'health', body: validCases[2].body }, { token: TOKEN })
      const serialized = JSON.stringify(decode(response))

      expect(response.status).toBe(500)
      expect(serialized).not.toContain('/run/secret.sock')
      expect(serialized).not.toContain(TOKEN)
    })

    it('sanitizes unexpected errors without serializing messages, stacks, paths or bearer material', async () => {
      const failing = vi.fn(() => Promise.reject(new Error(`spawn failed at /srv/private: Bearer ${TOKEN}`)))
      const f = fixture({ health: failing })
      const response = await send(f.handler, { operation: 'health', body: validCases[2].body }, { token: TOKEN })
      const serialized = JSON.stringify(decode(response))

      expect(response.status).toBe(500)
      expect(serialized).toContain('INTERNAL')
      expect(serialized).not.toContain('/srv/private')
      expect(serialized).not.toContain(TOKEN)
      expect(serialized).not.toContain('stack')
    })
  })
})

function resultFor(operation: RpcMethod): unknown {
  if (operation === 'start') return { runtime_ref: 'container:preview-01' }
  if (operation === 'stop') return { stopped: true }
  if (operation === 'health') return { health: 'OK' }
  if (operation === 'logs') return { events: [] }
  if (operation === 'verification-messages') return { messages: [] }
  return { runtimes: [] }
}
