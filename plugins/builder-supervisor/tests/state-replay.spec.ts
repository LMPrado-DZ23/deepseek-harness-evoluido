import { describe, expect, it } from 'vitest'
import { ReplayGuard } from '../src/replay.js'
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

describe('replay guard', () => {
  it('rejects replay, expires old claims and fails closed at capacity', () => {
    let now = 0
    const guard = new ReplayGuard(() => now, 10, 1)
    guard.claim('one')
    expect(() => guard.claim('one')).toThrow('REQUEST_REPLAY')
    expect(() => guard.claim('two')).toThrow('REPLAY_CAPACITY')
    now = 10
    expect(() => guard.claim('two')).not.toThrow()
  })

  it('rejects invalid limits', () => {
    expect(() => new ReplayGuard(Date.now, 0, 1)).toThrow('INVALID_REPLAY_CONFIGURATION')
    expect(() => new ReplayGuard(Date.now, 1, 0)).toThrow('INVALID_REPLAY_CONFIGURATION')
  })
})
