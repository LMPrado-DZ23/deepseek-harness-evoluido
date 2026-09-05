import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileBuildIdGuard, FileReplayGuard, FileRpcReplayGuard } from '../src/persistent-replay.js'
import { ReplayGuard, RpcReplayGuard } from '../src/replay.js'
import { Semaphore } from '../src/semaphore.js'
import { beginStep, completeStep } from '../src/state-machine.js'

describe('builder state machine', () => {
  it('allows only install -> build -> test -> e2e', () => {
    let state = beginStep('PREPARED', 'install')
    state = completeStep(state, 'install', true)
    state = beginStep(state, 'build')
    state = completeStep(state, 'build', true)
    state = beginStep(state, 'test')
    state = completeStep(state, 'test', true)
    state = beginStep(state, 'e2e')
    expect(completeStep(state, 'e2e', true)).toBe('E2E_OK')
  })

  it('fails closed on skipping, repeating, wrong completion and a failed command', () => {
    expect(() => beginStep('PREPARED', 'build')).toThrow('INVALID_STEP_ORDER')
    expect(() => beginStep('INSTALL_OK', 'install')).toThrow('INVALID_STEP_ORDER')
    expect(() => completeStep('PREPARED', 'install', true)).toThrow('INVALID_STEP_ORDER')
    expect(completeStep('INSTALLING', 'install', false)).toBe('FAILED')
  })
})

describe('bounded execution semaphore', () => {
  it('queues globally, releases once and removes cancelled waiters', async () => {
    const semaphore = new Semaphore(1); const signal = new AbortController().signal; const first = await semaphore.acquire(signal); expect(semaphore.active).toBe(1)
    const controller = new AbortController(); const cancelled = semaphore.acquire(controller.signal); controller.abort(new Error('cancelled')); await expect(cancelled).rejects.toThrow('cancelled')
    let granted = false; const next = semaphore.acquire(signal).then(release => { granted = true; release() }); await Promise.resolve(); expect(granted).toBe(false)
    first(); first(); await next; expect(semaphore.active).toBe(0); expect(() => new Semaphore(0)).toThrow('INVALID_CONCURRENCY_LIMIT')
  })
})

describe('replay guard', () => {
  it('keeps identical RPC responses idempotent, rejects conflicting bodies and fails closed at capacity', async () => {
    expect(() => new RpcReplayGuard(0)).toThrow('INVALID_REPLAY_CONFIGURATION')
    const guard = new RpcReplayGuard(1); const response = { status: 200, headers: { one: 'two' }, body: Buffer.from('result') }; let calls = 0
    const first = await guard.run('one', 'a', async () => { calls += 1; return response })
    ;(first.headers as Record<string, string>).one = 'changed'; first.body[0] = 0
    await expect(guard.run('one', 'a', async () => { calls += 1; return response })).resolves.toEqual(response)
    await expect(guard.run('one', 'b', async () => response)).rejects.toThrow('REQUEST_ID_CONFLICT')
    await expect(guard.run('two', 'c', async () => response)).rejects.toThrow('REPLAY_CAPACITY')
    expect(calls).toBe(1)
  })

  it('releases a failed in-memory RPC reservation for an explicit retry', async () => {
    const guard = new RpcReplayGuard(); let calls = 0
    await expect(guard.run('one', 'a', async () => { calls += 1; throw new Error('transient') })).rejects.toThrow('transient')
    await expect(guard.run('one', 'a', async () => { calls += 1; return { status: 204, headers: {}, body: Buffer.alloc(0) } })).resolves.toMatchObject({ status: 204 })
    expect(calls).toBe(2)
  })

  it('rejects replay, expires old claims and fails closed at capacity', async () => {
    let now = 0
    const guard = new ReplayGuard(() => now, 10, 1)
    await guard.claim('one')
    await expect(guard.claim('one')).rejects.toThrow('REQUEST_REPLAY')
    await expect(guard.claim('two')).rejects.toThrow('REPLAY_CAPACITY')
    now = 10
    await expect(guard.claim('two')).resolves.toBeUndefined()
  })

  it('rejects invalid limits', () => {
    expect(() => new ReplayGuard(Date.now, 0, 1)).toThrow('INVALID_REPLAY_CONFIGURATION')
    expect(() => new ReplayGuard(Date.now, 1, 0)).toThrow('INVALID_REPLAY_CONFIGURATION')
  })

  it('persists claims across process-object replacement and fails closed at disk capacity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-replay-')); const id = `req_${'a'.repeat(32)}`
    try {
      await new FileReplayGuard(root, 1).claim(id)
      await expect(new FileReplayGuard(root, 1).claim(id)).rejects.toThrow('REQUEST_REPLAY')
      await expect(new FileReplayGuard(root, 1).claim(`req_${'b'.repeat(32)}`)).rejects.toThrow('REPLAY_CAPACITY')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('persists opaque build ids as hashed, non-reusable claims', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-build-claims-'))
    try { await new FileBuildIdGuard(root).claim('customer-run-1'); await expect(new FileBuildIdGuard(root).claim('customer-run-1')).rejects.toThrow('BUILD_ALREADY_EXISTS') }
    finally { await rm(root, { recursive: true, force: true }) }
  })

  it('releases a failed build claim so the same opaque id can be prepared again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-build-claim-release-')); const guard = new FileBuildIdGuard(root)
    try { await guard.claim('customer-run-retry'); await guard.release('customer-run-retry'); await expect(guard.claim('customer-run-retry')).resolves.toBeUndefined() }
    finally { await rm(root, { recursive: true, force: true }) }
  })

  it('persists idempotent RPC results and rejects a reused id with a different body', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-rpc-replay-')); const id = `req_${'c'.repeat(32)}`; let calls = 0
    const response = { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"ok":true}') }
    try {
      await expect(new FileRpcReplayGuard(root).run(id, 'a'.repeat(64), async () => { calls += 1; return response })).resolves.toMatchObject({ status: 200 })
      await expect(new FileRpcReplayGuard(root).run(id, 'a'.repeat(64), async () => { calls += 1; return response })).resolves.toMatchObject({ status: 200 })
      expect(calls).toBe(1)
      await expect(new FileRpcReplayGuard(root).run(id, 'b'.repeat(64), async () => response)).rejects.toThrow('REQUEST_ID_CONFLICT')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('never redispatches a request left in doubt by a previous process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-rpc-pending-')); const id = `req_${'d'.repeat(32)}`; let called = false
    try {
      await writeFile(join(root, `${id}.json`), JSON.stringify({ state: 'pending', fingerprint: 'a'.repeat(64) }), { mode: 0o600 })
      await expect(new FileRpcReplayGuard(root).run(id, 'a'.repeat(64), async () => { called = true; return { status: 200, headers: {}, body: Buffer.alloc(0) } })).rejects.toThrow('RECOVERY_FAILED')
      expect(called).toBe(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
