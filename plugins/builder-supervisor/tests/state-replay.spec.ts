import { link, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileBuildIdGuard, FileReplayGuard, FileRpcReplayGuard, type PersistentReplayRuntime } from '../src/persistent-replay.js'
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
  it('validates every persistent guard configuration and public identifier', async () => {
    const filesystemRoot = parse(tmpdir()).root
    expect(() => new FileRpcReplayGuard(filesystemRoot)).toThrow('INVALID_REPLAY_CONFIGURATION')
    expect(() => new FileRpcReplayGuard(join(tmpdir(), 'rpc'), 0)).toThrow('INVALID_REPLAY_CONFIGURATION')
    expect(() => new FileRpcReplayGuard(join(tmpdir(), 'rpc'), 1, 0)).toThrow('INVALID_REPLAY_CONFIGURATION')
    expect(() => new FileReplayGuard(filesystemRoot)).toThrow('INVALID_REPLAY_CONFIGURATION')
    expect(() => new FileReplayGuard(join(tmpdir(), 'claim'), 0)).toThrow('INVALID_REPLAY_CONFIGURATION')
    expect(() => new FileReplayGuard(join(tmpdir(), 'claim'), 1, 0)).toThrow('INVALID_REPLAY_CONFIGURATION')
    expect(() => new FileBuildIdGuard(join(tmpdir(), 'build'), 0)).toThrow('INVALID_BUILD_CLAIM_CONFIGURATION')
    expect(() => new FileBuildIdGuard(join(tmpdir(), 'build'), 1, 0)).toThrow('INVALID_BUILD_CLAIM_CONFIGURATION')
    const root = await mkdtemp(join(tmpdir(), 'dz23-invalid-replay-'))
    try {
      await expect(new FileRpcReplayGuard(root).run('bad', 'a'.repeat(64), rpcOperation)).rejects.toThrow('REQUEST_REPLAY')
      await expect(new FileRpcReplayGuard(root).run(`req_${'a'.repeat(32)}`, 'bad', rpcOperation)).rejects.toThrow('REQUEST_REPLAY')
      await expect(new FileReplayGuard(root).claim('../bad')).rejects.toThrow('REQUEST_REPLAY')
      await expect(new FileReplayGuard(root).claim('bad!')).rejects.toThrow('REQUEST_REPLAY')
      for (const action of ['claim', 'release', 'complete'] as const) await expect(new FileBuildIdGuard(root)[action]('../bad')).rejects.toThrow('BUILD_ALREADY_EXISTS')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('covers capacity and concurrent same-request ownership for persistent guards', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-replay-capacity-')); let release!: () => void; let started!: () => void; let calls = 0
    try {
      await writeFile(join(root, 'ignored-name'), 'ignored')
      const rpcRoot = join(root, 'rpc'); await mkdir(rpcRoot, { mode: 0o700 }); await writeFile(join(rpcRoot, 'ignored-name'), 'ignored')
      const rpc = new FileRpcReplayGuard(rpcRoot, 1)
      const operationStarted = new Promise<void>(resolve => { started = resolve })
      const id = `req_${'a'.repeat(32)}`; const running = rpc.run(id, 'a'.repeat(64), async () => { calls += 1; started(); await new Promise<void>(resolve => { release = resolve }); return rpcValue('same') })
      await operationStarted
      const replay = rpc.run(id, 'a'.repeat(64), async () => { calls += 1; return rpcValue('wrong') })
      await expect(rpc.run(id, 'b'.repeat(64), rpcOperation)).rejects.toThrow('REQUEST_ID_CONFLICT')
      release(); await expect(Promise.all([running, replay])).resolves.toHaveLength(2); expect(calls).toBe(1)
      await expect(rpc.run(`req_${'b'.repeat(32)}`, 'b'.repeat(64), rpcOperation)).rejects.toThrow('REPLAY_CAPACITY')

      const builds = new FileBuildIdGuard(join(root, 'builds'), 1); await builds.claim('one')
      await expect(builds.claim('two')).rejects.toThrow('REPLAY_CAPACITY')
      const claimRoot = join(root, 'claims'); await mkdir(claimRoot, { mode: 0o700 }); await writeFile(join(claimRoot, 'ignored-name'), 'ignored')
      await new FileReplayGuard(claimRoot).claim(`req_${'f'.repeat(32)}`)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('uses injected runtime authority for both platform paths and directory safety', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-replay-runtime-'))
    try {
      const win = replayRuntime({ platform: 'win32', getuid: undefined, randomHex: () => '1'.repeat(16) })
      await expect(new FileRpcReplayGuard(join(root, 'rpc'), 2, 10, () => 0, win).run(`req_${'a'.repeat(32)}`, 'a'.repeat(64), rpcOperation)).resolves.toMatchObject({ status: 200 })
      await expect(new FileReplayGuard(join(root, 'claims'), 2, 10, () => 0, win).claim(`req_${'b'.repeat(32)}`)).resolves.toBeUndefined()
      const builds = new FileBuildIdGuard(join(root, 'builds'), 2, 10, () => 0, win); await builds.claim('one'); await builds.complete('one')

      const variants = [
        { resolved: resolve(root, 'elsewhere'), directory: true, symbolicLink: false, mode: 0o700, uid: 0 },
        { resolved: resolve(root, 'unsafe'), directory: false, symbolicLink: false, mode: 0o700, uid: 0 },
        { resolved: resolve(root, 'unsafe'), directory: true, symbolicLink: true, mode: 0o700, uid: 0 },
      ]
      for (const [index, inspected] of variants.entries()) {
        const directory = resolve(root, `unsafe-${index}`); inspected.resolved = index === 0 ? inspected.resolved : directory
        const runtime = replayRuntime({ inspectDirectory: async () => inspected })
        await expect(new FileRpcReplayGuard(directory, 2, 10, () => 0, runtime).run(`req_${String(index).repeat(32)}`, 'a'.repeat(64), rpcOperation)).rejects.toThrow('UNSAFE_REPLAY_DIRECTORY')
      }
      const directory = resolve(root, 'wrong-owner')
      const wrongOwner = replayRuntime({ platform: 'linux', getuid: () => 7, inspectDirectory: async path => ({ resolved: path, directory: true, symbolicLink: false, mode: 0o700, uid: 8 }) })
      await expect(new FileRpcReplayGuard(directory, 2, 10, () => 0, wrongOwner).run(`req_${'d'.repeat(32)}`, 'a'.repeat(64), rpcOperation)).rejects.toThrow('UNSAFE_REPLAY_DIRECTORY')
      const writable = resolve(root, 'writable')
      const writableRuntime = replayRuntime({ platform: 'linux', getuid: undefined, inspectDirectory: async path => ({ resolved: path, directory: true, symbolicLink: false, mode: 0o777, uid: 0 }) })
      await expect(new FileRpcReplayGuard(writable, 2, 10, () => 0, writableRuntime).run(`req_${'e'.repeat(32)}`, 'a'.repeat(64), rpcOperation)).rejects.toThrow('UNSAFE_REPLAY_DIRECTORY')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rejects every malformed persisted RPC record field', async () => {
    const fingerprint = 'a'.repeat(64)
    const complete = { state: 'complete', fingerprint, status: 200, headers: {}, body: '', completed_at: 0 }
    const malformed: unknown[] = [
      '{',
      { ...complete, extra: true },
      { ...complete, fingerprint: 7 },
      { ...complete, fingerprint: 'bad' },
      { ...complete, state: 'unknown' },
      { ...complete, completed_at: 0.5 },
      { ...complete, completed_at: -1 },
      { ...complete, status: '200' },
      { ...complete, status: 99 },
      { ...complete, status: 600 },
      { ...complete, body: 7 },
      { ...complete, body: 'x'.repeat(700_001) },
      { ...complete, body: '*' },
      { ...complete, headers: 'bad' },
      { ...complete, headers: null },
      { ...complete, headers: [] },
      { ...complete, headers: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`x-${index}`, 'ok'])) },
      { ...complete, headers: { 'Bad Key': 'ok' } },
      { ...complete, headers: { good: 7 } },
      { ...complete, headers: { good: 'x'.repeat(8_193) } },
      { state: 'pending', fingerprint, created_at: 0, extra: true },
      { state: 'pending', fingerprint, created_at: -1 },
    ]
    for (const [index, value] of malformed.entries()) {
      const root = await mkdtemp(join(tmpdir(), `dz23-rpc-corrupt-${index}-`)); const id = `req_${index.toString(16).padStart(32, '0')}`
      try {
        await writeFile(join(root, `${id}.json`), typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 })
        await expect(new FileRpcReplayGuard(root).run(id, fingerprint, rpcOperation)).rejects.toThrow('RECOVERY_FAILED')
      } finally { await rm(root, { recursive: true, force: true }) }
    }

    for (const [index, kind] of (['directory', 'hardlink', 'oversize'] as const).entries()) {
      const root = await mkdtemp(join(tmpdir(), `dz23-rpc-node-${kind}-`)); const id = `req_${['a', 'b', 'c'][index]!.repeat(32)}`; const path = join(root, `${id}.json`)
      try {
        if (kind === 'directory') await mkdir(path)
        else if (kind === 'hardlink') { const source = join(root, 'source'); await writeFile(source, JSON.stringify(complete), { mode: 0o600 }); await link(source, path) }
        else await writeFile(path, 'x'.repeat(768 * 1024 + 1), { mode: 0o600 })
        await expect(new FileRpcReplayGuard(root).run(id, fingerprint, rpcOperation)).rejects.toThrow('RECOVERY_FAILED')
      } finally { await rm(root, { recursive: true, force: true }) }
    }
  })

  it('rejects malformed expiry and build-claim records', async () => {
    const expiryRows: unknown[] = ['{', {}, { expires_at: 1, extra: true }, { expires_at: '1' }, { expires_at: -1 }]
    for (const [index, value] of expiryRows.entries()) {
      const root = await mkdtemp(join(tmpdir(), `dz23-expiry-corrupt-${index}-`)); const stale = `req_${'a'.repeat(32)}`
      try {
        await writeFile(join(root, stale), typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 })
        await expect(new FileReplayGuard(root).claim(`req_${'b'.repeat(32)}`)).rejects.toBeDefined()
      } finally { await rm(root, { recursive: true, force: true }) }
    }
    for (const kind of ['directory', 'hardlink', 'oversize'] as const) {
      const root = await mkdtemp(join(tmpdir(), `dz23-expiry-node-${kind}-`)); const path = join(root, `req_${'a'.repeat(32)}`)
      try {
        if (kind === 'directory') await mkdir(path)
        else if (kind === 'hardlink') { const source = join(root, 'source'); await writeFile(source, '{"expires_at":1}', { mode: 0o600 }); await link(source, path) }
        else await writeFile(path, 'x'.repeat(129), { mode: 0o600 })
        await expect(new FileReplayGuard(root).claim(`req_${'b'.repeat(32)}`)).rejects.toBeDefined()
      } finally { await rm(root, { recursive: true, force: true }) }
    }

    const hash = 'a'.repeat(64)
    const buildRows: unknown[] = ['{', { state: 'active' }, { state: 'active', build_id_hash: 7 }, { state: 'active', build_id_hash: 'bad' }, { state: 'unknown', build_id_hash: hash, completed_at: 0 }, { state: 'complete', build_id_hash: hash, completed_at: 'now' }, { state: 'complete', build_id_hash: hash, completed_at: -1 }]
    for (const [index, value] of buildRows.entries()) {
      const root = await mkdtemp(join(tmpdir(), `dz23-build-corrupt-${index}-`)); const path = join(root, `build_${index.toString(16).padStart(64, '0')}.json`)
      try {
        await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 })
        await expect(new FileBuildIdGuard(root).claim('next')).rejects.toThrow('RECOVERY_FAILED')
      } finally { await rm(root, { recursive: true, force: true }) }
    }
    for (const kind of ['directory', 'hardlink', 'oversize'] as const) {
      const root = await mkdtemp(join(tmpdir(), `dz23-build-node-${kind}-`)); const path = join(root, `build_${'a'.repeat(64)}.json`)
      try {
        if (kind === 'directory') await mkdir(path)
        else if (kind === 'hardlink') { const source = join(root, 'source'); await writeFile(source, JSON.stringify({ state: 'active', build_id_hash: hash }), { mode: 0o600 }); await link(source, path) }
        else await writeFile(path, 'x'.repeat(257), { mode: 0o600 })
        await expect(new FileBuildIdGuard(root).claim('next')).rejects.toThrow('RECOVERY_FAILED')
      } finally { await rm(root, { recursive: true, force: true }) }
    }
  })

  it('fails closed when persisted ownership changes during an RPC or build completion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-persisted-races-')); const fingerprint = 'a'.repeat(64)
    try {
      for (const [index, replacement] of [
        { state: 'complete', fingerprint, status: 200, headers: {}, body: '', completed_at: 0 },
        { state: 'pending', fingerprint: 'b'.repeat(64), created_at: 0 },
      ].entries()) {
        const id = `req_${String(index).repeat(32)}`; const path = join(root, `${id}.json`)
        await expect(new FileRpcReplayGuard(root).run(id, fingerprint, async () => { await writeFile(path, JSON.stringify(replacement)); return rpcValue('changed') })).rejects.toThrow('RECOVERY_FAILED')
      }
      const failedId = `req_${'c'.repeat(32)}`; const failedPath = join(root, `${failedId}.json`)
      await expect(new FileRpcReplayGuard(root).run(failedId, fingerprint, async () => { await writeFile(failedPath, JSON.stringify({ state: 'pending', fingerprint: 'b'.repeat(64), created_at: 0 })); throw new Error('operation failed') })).rejects.toThrow('operation failed')

      const fixed = 'f'.repeat(16); const runtime = replayRuntime({ randomHex: () => fixed }); const id = `req_${'d'.repeat(32)}`
      await expect(new FileRpcReplayGuard(join(root, 'temp-rpc'), 2, 10, () => 0, runtime).run(id, fingerprint, async () => {
        await writeFile(join(root, 'temp-rpc', `.${id}-${process.pid}-${fixed}`), 'occupied'); return rpcValue('never persisted')
      })).rejects.toMatchObject({ code: 'EEXIST' })

      const buildRoot = join(root, 'temp-build'); const builds = new FileBuildIdGuard(buildRoot, 2, 10, () => 0, runtime); await builds.claim('one')
      const [claimName] = (await readdir(buildRoot)).filter(name => name.startsWith('build_'))
      await writeFile(join(buildRoot, `.${claimName}-${process.pid}-${fixed}`), 'occupied')
      await expect(builds.complete('one')).rejects.toMatchObject({ code: 'EEXIST' })
      await writeFile(join(buildRoot, claimName!), JSON.stringify({ state: 'active', build_id_hash: 'b'.repeat(64) }))
      await expect(builds.complete('one')).rejects.toThrow('RECOVERY_FAILED')
      await writeFile(join(buildRoot, claimName!), JSON.stringify({ state: 'complete', build_id_hash: 'a'.repeat(64), completed_at: 0 }))
      await expect(builds.complete('one')).rejects.toThrow('RECOVERY_FAILED')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
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

  it('collects expired disk claims before enforcing capacity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-replay-expiry-')); let now = 0
    try {
      await new FileReplayGuard(root, 1, 10, () => now).claim(`req_${'a'.repeat(32)}`)
      now = 10
      await expect(new FileReplayGuard(root, 1, 10, () => now).claim(`req_${'b'.repeat(32)}`)).resolves.toBeUndefined()
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

  it('retains completed build ids until the audit window expires', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-build-claim-complete-')); let now = 0
    try {
      const guard = new FileBuildIdGuard(root, 1, 10, () => now); await guard.claim('customer-run-complete'); await guard.complete('customer-run-complete')
      await expect(guard.claim('customer-run-complete')).rejects.toThrow('BUILD_ALREADY_EXISTS')
      now = 10
      await expect(guard.claim('customer-run-next')).resolves.toBeUndefined()
    } finally { await rm(root, { recursive: true, force: true }) }
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

  it('does not hold the metadata lock while a different request is running and releases transient failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-rpc-concurrent-')); let release!: () => void
    try {
      const guard = new FileRpcReplayGuard(root)
      const slow = guard.run(`req_${'a'.repeat(32)}`, 'a'.repeat(64), async () => { await new Promise<void>(resolve => { release = resolve }); return { status: 200, headers: {}, body: Buffer.from('slow') } })
      await new Promise(resolve => setImmediate(resolve))
      await expect(guard.run(`req_${'b'.repeat(32)}`, 'b'.repeat(64), async () => ({ status: 200, headers: {}, body: Buffer.from('fast') }))).resolves.toMatchObject({ status: 200 })
      release(); await slow
      const transient = `req_${'e'.repeat(32)}`
      await expect(guard.run(transient, 'e'.repeat(64), async () => { throw new Error('transient') })).rejects.toThrow('transient')
      await expect(guard.run(transient, 'e'.repeat(64), async () => ({ status: 204, headers: {}, body: Buffer.alloc(0) }))).resolves.toMatchObject({ status: 204 })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('collects expired persisted RPC responses without deleting in-doubt requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-rpc-expiry-')); let now = 0; const response = { status: 200, headers: {}, body: Buffer.alloc(0) }
    try {
      await new FileRpcReplayGuard(root, 1, 10, () => now).run(`req_${'a'.repeat(32)}`, 'a'.repeat(64), async () => response)
      now = 10
      await expect(new FileRpcReplayGuard(root, 1, 10, () => now).run(`req_${'b'.repeat(32)}`, 'b'.repeat(64), async () => response)).resolves.toMatchObject({ status: 200 })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('never redispatches a request left in doubt by a previous process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-rpc-pending-')); const id = `req_${'d'.repeat(32)}`; let called = false
    try {
      await writeFile(join(root, `${id}.json`), JSON.stringify({ state: 'pending', fingerprint: 'a'.repeat(64), created_at: 0 }), { mode: 0o600 })
      await expect(new FileRpcReplayGuard(root).run(id, 'a'.repeat(64), async () => { called = true; return { status: 200, headers: {}, body: Buffer.alloc(0) } })).rejects.toThrow('RECOVERY_FAILED')
      expect(called).toBe(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

function rpcValue(body = 'ok') { return { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from(body) } }
async function rpcOperation() { return rpcValue() }
function replayRuntime(overrides: Partial<PersistentReplayRuntime> = {}): PersistentReplayRuntime {
  return {
    platform: process.platform,
    getuid: typeof process.getuid === 'function' ? () => process.getuid!() : undefined,
    randomHex: bytes => 'a'.repeat(bytes * 2),
    ...overrides,
  }
}
