import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileBuildIdGuard, FileReplayGuard } from '../src/persistent-replay.js'
import { ReplayGuard } from '../src/replay.js'
import { Semaphore } from '../src/semaphore.js'
import { beginStep, completeStep } from '../src/state-machine.js'

describe('builder state machine', () => {
  it('allows only install -> build -> unit -> e2e', () => {
    let state = beginStep('PREPARED', 'install')
    state = completeStep(state, 'install', true)
    state = beginStep(state, 'build')
    state = completeStep(state, 'build', true)
    state = beginStep(state, 'unit')
    state = completeStep(state, 'unit', true)
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
})
