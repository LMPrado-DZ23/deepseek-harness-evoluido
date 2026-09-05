import { describe, expect, it, vi } from 'vitest'
import { BuilderSupervisorError } from '../src/model.js'
import { BUILDER_CREDENTIAL_REFERENCE_MAX_BYTES, BUILDER_RPC_MAX_BODY_BYTES, createBuilderRpcHandler, isBuilderCredentialReference, parseBuilderRpcRequest, type BuilderRpcMethods } from '../src/protocol.js'

const requestId = (digit: string) => `req_${digit.repeat(32)}`
const buildRef = `build_${'a'.repeat(32)}`
const valid = [
  { operation: 'preflight', body: { request_id: requestId('1') } },
  { operation: 'prepare', body: { request_id: requestId('2'), build_id: 'run-1', artifact_relative_path: 'runs/run-1', artifact_sha256: 'a'.repeat(64) } },
  { operation: 'execute', body: { request_id: requestId('3'), build_ref: buildRef, step: 'install' } },
  { operation: 'cancel', body: { request_id: requestId('4'), build_ref: buildRef } },
  { operation: 'finish', body: { request_id: requestId('5'), build_ref: buildRef } },
  { operation: 'listManaged', body: { request_id: requestId('6') } },
] as const

describe('builder supervisor closed RPC schema', () => {
  it.each(valid)('accepts the exact $operation request', request => {
    expect(parseBuilderRpcRequest(request)).toEqual(request)
  })

  it.each(valid)('rejects extra fields in $operation envelope and body', request => {
    expect(() => parseBuilderRpcRequest({ ...request, attacker: true })).toThrow('INVALID_REQUEST')
    expect(() => parseBuilderRpcRequest({ operation: request.operation, body: { ...request.body, attacker: true } })).toThrow('INVALID_REQUEST')
  })

  it.each(['command', 'argv', 'image', 'mount', 'mounts', 'env', 'network', 'privileged', 'user'])('never accepts client Docker authority %s', field => {
    expect(() => parseBuilderRpcRequest({ operation: 'prepare', body: { ...valid[1].body, [field]: 'attacker' } })).toThrow('INVALID_REQUEST')
    expect(() => parseBuilderRpcRequest({ operation: 'execute', body: { ...valid[2].body, [field]: 'attacker' } })).toThrow('INVALID_REQUEST')
  })

  it.each(['org_id', 'tenant_id', 'instance_id', 'scope_id', 'socket_path'])('never accepts caller-selected routing authority %s', field => {
    for (const request of valid) expect(() => parseBuilderRpcRequest({ operation: request.operation, body: { ...request.body, [field]: 'attacker' } })).toThrow('INVALID_REQUEST')
  })

  it.each(['../outside', '/absolute', './run', 'runs//one', 'runs\\one', 'runs/../../outside', 'runs/one\0hidden', 'runs/line\nfeed', 'runs/colon:value'])('rejects traversal or non-canonical path %j', artifact_relative_path => {
    expect(() => parseBuilderRpcRequest({ operation: 'prepare', body: { ...valid[1].body, artifact_relative_path } })).toThrow('INVALID_REQUEST')
  })

  it.each(['shell', 'lint', 'deploy', '', 'INSTALL'])('rejects caller-defined or unknown step %j', step => {
    expect(() => parseBuilderRpcRequest({ operation: 'execute', body: { ...valid[2].body, step } })).toThrow('INVALID_REQUEST')
  })

  it('rejects invalid ids, hashes, operations and scalar bodies', () => {
    expect(() => parseBuilderRpcRequest({ operation: 'preflight', body: { request_id: 'no' } })).toThrow()
    expect(() => parseBuilderRpcRequest({ operation: 'prepare', body: { ...valid[1].body, build_id: '../bad' } })).toThrow()
    expect(() => parseBuilderRpcRequest({ operation: 'prepare', body: { ...valid[1].body, artifact_sha256: 'A'.repeat(64) } })).toThrow()
    expect(() => parseBuilderRpcRequest({ operation: 'execute', body: { ...valid[2].body, build_ref: 'bad' } })).toThrow()
    expect(() => parseBuilderRpcRequest({ operation: 'unknown', body: {} })).toThrow()
    expect(() => parseBuilderRpcRequest(null)).toThrow()
    expect(parseBuilderRpcRequest({ operation: 'listManaged', body: { request_id: requestId('7'), build_id: 'run-1' } })).toEqual({ operation: 'listManaged', body: { request_id: requestId('7'), build_id: 'run-1' } })
    expect(() => parseBuilderRpcRequest({ operation: 'listManaged', body: { request_id: requestId('7'), build_id: '../bad' } })).toThrow()
    expect(() => parseBuilderRpcRequest({ operation: 'listManaged', body: null })).toThrow()
  })

  it('bounds file credential references by bytes while keeping the check syntactic', () => {
    expect(BUILDER_CREDENTIAL_REFERENCE_MAX_BYTES).toBe(4_096)
    const prefix = 'file:/'
    expect(isBuilderCredentialReference(`${prefix}${'a'.repeat(BUILDER_CREDENTIAL_REFERENCE_MAX_BYTES - prefix.length)}`)).toBe(true)
    expect(isBuilderCredentialReference(`${prefix}${'a'.repeat(BUILDER_CREDENTIAL_REFERENCE_MAX_BYTES - prefix.length + 1)}`)).toBe(false)
    expect(isBuilderCredentialReference('file:/proc/self/environ')).toBe(true)
  })

  it('keeps the absolute authenticated request ceiling at 64 KiB', () => {
    expect(BUILDER_RPC_MAX_BODY_BYTES).toBe(65_536)
  })
})

describe('builder supervisor authenticated HTTP contract', () => {
  const token = 'A'.repeat(43)
  const credentialRef = 'file:/run/secrets/dz23-builder-supervisor-token'

  function fixture(overrides: Partial<BuilderRpcMethods> = {}) {
    const methods: BuilderRpcMethods = {
      preflight: vi.fn(async () => attestation()),
      prepare: vi.fn(async () => ({ build_ref: buildRef, state: 'PREPARED' as const })),
      execute: vi.fn(async (body: Parameters<BuilderRpcMethods['execute']>[0]) => ({ build_ref: body.build_ref, state: ({ install: 'INSTALL_OK', build: 'BUILD_OK', test: 'TEST_OK', e2e: 'E2E_OK' } as const)[body.step], step: body.step, result: { exit_code: 0, stdout: '', stderr: '', timed_out: false, termination_reason: null, output_limit_exceeded: false } })),
      cancel: vi.fn(async (body: Parameters<BuilderRpcMethods['cancel']>[0]) => ({ build_ref: body.build_ref, state: 'CANCELLED' as const })),
      finish: vi.fn(async (body: Parameters<BuilderRpcMethods['finish']>[0]) => ({ build_ref: body.build_ref, final_state: 'E2E_OK' as const, exported: { relative_path: `exports/${body.build_ref}`, sha256: 'a'.repeat(64), files: 1, bytes: 0 }, cleanup_pending: false, cleaned: true })),
      listManaged: vi.fn(async () => ({ builds: [] })),
      ...overrides,
    }
    const resolve = vi.fn(async () => token)
    return { methods, resolve, handler: createBuilderRpcHandler({ credentialRef, credentials: { resolve }, methods }) }
  }

  async function send(handler: ReturnType<typeof createBuilderRpcHandler>, value: unknown, options: { token?: string; path?: string; method?: string; raw?: Buffer } = {}) {
    return handler.handle({
      path: options.path ?? '/v1/rpc', method: options.method ?? 'POST',
      headers: { ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }) },
      body: options.raw ?? Buffer.from(JSON.stringify(value)), signal: new AbortController().signal,
    })
  }
  const decode = (result: { readonly body: Uint8Array }) => JSON.parse(Buffer.from(result.body).toString('utf8')) as unknown

  it('authenticates before parsing and gives the same denial for missing and wrong credentials', async () => {
    const f = fixture()
    const missing = await send(f.handler, valid[0])
    const wrong = await send(f.handler, valid[0], { token: 'B'.repeat(43) })
    expect(missing.status).toBe(401); expect(decode(wrong)).toEqual(decode(missing))
    expect(f.methods.preflight).not.toHaveBeenCalled()
    expect(f.resolve).toHaveBeenCalledTimes(2)
  })

  it('rejects path, method, oversized and malformed input without dispatch', async () => {
    const f = fixture()
    expect((await send(f.handler, valid[0], { token, path: '/wrong' })).status).toBe(404)
    expect((await send(f.handler, valid[0], { token, method: 'GET' })).status).toBe(405)
    expect((await send(f.handler, valid[0], { token, raw: Buffer.alloc(BUILDER_RPC_MAX_BODY_BYTES + 1) })).status).toBe(413)
    expect((await send(f.handler, valid[0], { token, raw: Buffer.from('{') })).status).toBe(400)
    expect(f.methods.preflight).not.toHaveBeenCalled()
  })

  it.each(valid)('dispatches $operation and validates its response allowlist', async request => {
    const f = fixture()
    const result = await send(f.handler, request, { token })
    expect(result.status).toBe(200)
    expect(decode(result)).toMatchObject({ ok: true })
  })

  it('returns the same response for the same request id and body, and conflicts on body reuse', async () => {
    const f = fixture()
    const first = await send(f.handler, valid[0], { token }); const same = await send(f.handler, valid[0], { token })
    expect(decode(same)).toEqual(decode(first)); expect(f.methods.preflight).toHaveBeenCalledTimes(1)
    const conflict = await send(f.handler, { operation: 'listManaged', body: { request_id: valid[0].body.request_id } }, { token })
    expect(conflict.status).toBe(409); expect(decode(conflict)).toEqual({ ok: false, error: { code: 'REQUEST_ID_CONFLICT' } })
  })

  it('returns only safe error codes and refuses extra response authority', async () => {
    const failed = fixture({ preflight: vi.fn(async () => { throw new BuilderSupervisorError('REQUEST_REPLAY') }) })
    expect(decode(await send(failed.handler, valid[0], { token }))).toEqual({ ok: false, error: { code: 'REQUEST_REPLAY' } })
    const invalid = fixture({ preflight: vi.fn(async () => ({ ...attestation(), socket: '/var/run/docker.sock' }) as never) })
    expect(decode(await send(invalid.handler, valid[0], { token }))).toEqual({ ok: false, error: { code: 'INTERNAL' } })
    for (const field of ['org_id', 'tenant_id', 'instance_id']) {
      const logicalIdentity = fixture({ preflight: vi.fn(async () => ({ ...attestation(), [field]: 'logical-value' }) as never) })
      expect(decode(await send(logicalIdentity.handler, valid[0], { token }))).toEqual({ ok: false, error: { code: 'INTERNAL' } })
    }
    const unexpected = fixture({ preflight: vi.fn(async () => { throw new Error('/secret/path') }) })
    expect(JSON.stringify(decode(await send(unexpected.handler, valid[0], { token })))).not.toContain('secret')
    expect(JSON.stringify(decode(await send(unexpected.handler, valid[0], { token })))).not.toContain('secret')
    expect(unexpected.methods.preflight).toHaveBeenCalledTimes(2)
    const replayFailure = fixture()
    const guarded = createBuilderRpcHandler({ credentialRef, credentials: { resolve: async () => token }, methods: replayFailure.methods, replay: { run: async () => { throw new Error('/secret/replay') } } })
    expect(decode(await send(guarded, valid[0], { token }))).toEqual({ ok: false, error: { code: 'INTERNAL' } })
  })

  it('allows only strictly shaped managed-build and step results', async () => {
    const listed = fixture({ listManaged: vi.fn(async () => ({ builds: [{ build_ref: buildRef, build_id: 'run-1', state: 'PREPARED' as const, exported: false, cleanup_pending: false }] })) })
    expect((await send(listed.handler, valid[5], { token })).status).toBe(200)
    const leakingList = fixture({ listManaged: vi.fn(async () => ({ builds: [{ build_ref: buildRef, build_id: 'run-1', state: 'PREPARED', image: 'attacker' }] })) as never })
    expect((await send(leakingList.handler, valid[5], { token })).status).toBe(500)
    const leakingStep = fixture({ execute: vi.fn(async body => ({ build_ref: body.build_ref, state: 'INSTALL_OK', step: body.step, result: { exit_code: 0, stdout: '', stderr: '', timed_out: false, termination_reason: null, output_limit_exceeded: false, command: 'secret' } })) as never })
    expect((await send(leakingStep.handler, valid[2], { token })).status).toBe(500)
    const wrongStep = fixture({ execute: vi.fn(async body => ({ build_ref: body.build_ref, state: 'TEST_OK', step: 'test', result: { exit_code: 0, stdout: '', stderr: '', timed_out: false, termination_reason: null, output_limit_exceeded: false } })) as never })
    expect((await send(wrongStep.handler, valid[2], { token })).status).toBe(500)
    const incoherent = fixture({ execute: vi.fn(async body => ({ build_ref: body.build_ref, state: 'FAILED', step: body.step, result: { exit_code: -1, stdout: '', stderr: '', timed_out: false, termination_reason: 'timeout', output_limit_exceeded: false } })) as never })
    expect((await send(incoherent.handler, valid[2], { token })).status).toBe(500)
    const tooLarge = fixture({ execute: vi.fn(async body => ({ build_ref: body.build_ref, state: 'FAILED', step: body.step, result: { exit_code: -1, stdout: 'é'.repeat(262_145), stderr: '', timed_out: false, termination_reason: 'output_limit', output_limit_exceeded: true } })) as never })
    expect((await send(tooLarge.handler, valid[2], { token })).status).toBe(500)
    const unknownReason = fixture({ execute: vi.fn(async body => ({ build_ref: body.build_ref, state: 'FAILED', step: body.step, result: { exit_code: -1, stdout: '', stderr: '', timed_out: false, termination_reason: 'signal', output_limit_exceeded: false } })) as never })
    expect((await send(unknownReason.handler, valid[2], { token })).status).toBe(500)
    const timedOut = fixture({ execute: vi.fn(async body => ({ build_ref: body.build_ref, state: 'FAILED', step: body.step, result: { exit_code: -1, stdout: '', stderr: '', timed_out: true, termination_reason: 'timeout', output_limit_exceeded: false } })) as never })
    expect((await send(timedOut.handler, valid[2], { token })).status).toBe(200)
    const outputLimited = fixture({ execute: vi.fn(async body => ({ build_ref: body.build_ref, state: 'FAILED', step: body.step, result: { exit_code: -1, stdout: '', stderr: '', timed_out: false, termination_reason: 'output_limit', output_limit_exceeded: true } })) as never })
    expect((await send(outputLimited.handler, valid[2], { token })).status).toBe(200)
    const cancelled = fixture({ execute: vi.fn(async body => ({ build_ref: body.build_ref, state: 'CANCELLED', step: body.step, result: { exit_code: -1, stdout: '', stderr: '', timed_out: false, termination_reason: null, output_limit_exceeded: false } })) as never })
    expect((await send(cancelled.handler, valid[2], { token })).status).toBe(200)
    const wrongCancelled = fixture({ execute: vi.fn(async body => ({ build_ref: body.build_ref, state: 'CANCELLED', step: body.step, result: { exit_code: 1, stdout: '', stderr: '', timed_out: false, termination_reason: null, output_limit_exceeded: false } })) as never })
    expect((await send(wrongCancelled.handler, valid[2], { token })).status).toBe(500)
    const failedZero = fixture({ execute: vi.fn(async body => ({ build_ref: body.build_ref, state: 'FAILED', step: body.step, result: { exit_code: 0, stdout: '', stderr: '', timed_out: false, termination_reason: null, output_limit_exceeded: false } })) as never })
    expect((await send(failedZero.handler, valid[2], { token })).status).toBe(500)
    const blocked = fixture({ preflight: vi.fn(async () => ({ ...attestation(), state: 'BLOCKED_EXTERNAL' as const })) })
    expect((await send(blocked.handler, valid[0], { token })).status).toBe(200)
    const filteredRequest = { operation: 'listManaged' as const, body: { request_id: requestId('8'), build_id: 'run-1' } }
    const wrongFiltered = fixture({ listManaged: vi.fn(async () => ({ builds: [{ build_ref: buildRef, build_id: 'run-2', state: 'PREPARED' as const, exported: false, cleanup_pending: false }] })) })
    expect((await send(wrongFiltered.handler, filteredRequest, { token })).status).toBe(500)
    const oversizedList = fixture({ listManaged: vi.fn(async () => ({ builds: Array.from({ length: 1_001 }, () => ({ build_ref: buildRef, build_id: 'run-1', state: 'PREPARED' as const, exported: false, cleanup_pending: false })) })) })
    expect((await send(oversizedList.handler, valid[5], { token })).status).toBe(500)
  })

  it.each(['E2E_OK', 'FAILED', 'CANCELLED'] as const)('allows the closed terminal result %s', async final_state => {
    const f = fixture({ finish: vi.fn(async body => ({ build_ref: body.build_ref, final_state, exported: final_state === 'E2E_OK' ? { relative_path: `exports/${buildRef}`, sha256: 'a'.repeat(64), files: 1, bytes: 0 } : null, cleanup_pending: false, cleaned: true })) })
    expect((await send(f.handler, valid[4], { token })).status).toBe(200)
  })

  it('rejects nonterminal and not-cleaned finish results', async () => {
    const running = fixture({ finish: vi.fn(async body => ({ build_ref: body.build_ref, final_state: 'BUILD_OK', exported: null, cleanup_pending: false, cleaned: true })) as never })
    expect((await send(running.handler, valid[4], { token })).status).toBe(500)
    const dirty = fixture({ finish: vi.fn(async body => ({ build_ref: body.build_ref, final_state: 'FAILED', exported: null, cleanup_pending: false, cleaned: false })) as never })
    expect((await send(dirty.handler, valid[4], { token })).status).toBe(500)
  })

  it.each([
    { name: 'failed result with an export', final_state: 'FAILED', exported: { relative_path: `exports/${buildRef}`, sha256: 'a'.repeat(64), files: 1, bytes: 0 }, cleanup_pending: false, cleaned: true },
    { name: 'cancelled result with an export', final_state: 'CANCELLED', exported: { relative_path: `exports/${buildRef}`, sha256: 'a'.repeat(64), files: 1, bytes: 0 }, cleanup_pending: false, cleaned: true },
    { name: 'successful result without an export', final_state: 'E2E_OK', exported: null, cleanup_pending: false, cleaned: true },
    { name: 'successful result with another build export', final_state: 'E2E_OK', exported: { relative_path: `exports/build_${'9'.repeat(32)}`, sha256: 'a'.repeat(64), files: 1, bytes: 0 }, cleanup_pending: false, cleaned: true },
    { name: 'successful result with cleanup pending', final_state: 'E2E_OK', exported: { relative_path: `exports/${buildRef}`, sha256: 'a'.repeat(64), files: 1, bytes: 0 }, cleanup_pending: true, cleaned: false },
  ])('rejects impossible finish contract: $name', async ({ name: _name, ...result }) => {
    const f = fixture({ finish: vi.fn(async body => ({ build_ref: body.build_ref, ...result })) as never })
    expect((await send(f.handler, valid[4], { token })).status).toBe(500)
  })

  it('rejects unsafe credential references at construction', () => {
    expect(() => createBuilderRpcHandler({ credentialRef: 'env:TOKEN', credentials: { resolve: async () => token }, methods: fixture().methods })).toThrow('INVALID_CREDENTIAL_REFERENCE')
    expect(() => createBuilderRpcHandler({ credentialRef: 'file:/run/../secret', credentials: { resolve: async () => token }, methods: fixture().methods })).toThrow('INVALID_CREDENTIAL_REFERENCE')
    expect(() => createBuilderRpcHandler({ credentialRef: `file:/${'a'.repeat(4_096)}`, credentials: { resolve: async () => token }, methods: fixture().methods })).toThrow('INVALID_CREDENTIAL_REFERENCE')
  })
})

function attestation() { return { state: 'OK' as const, protocol_version: 1 as const, scope_id: `s_${'c'.repeat(48)}` as const, image_id: `sha256:${'a'.repeat(64)}` as const, policy_sha256: 'b'.repeat(64) } }
