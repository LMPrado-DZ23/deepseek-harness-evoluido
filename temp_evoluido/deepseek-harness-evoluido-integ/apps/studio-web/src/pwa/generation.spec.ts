import { describe, expect, it } from 'vitest'
import { GENERATION_ACCEPTED_STATUS, postGeneration, startGeneration } from './generation'
import { OFFLINE_ERROR_CODE, SERVICE_UNREACHABLE_ERROR_CODE } from './policy'
import t from '../i18n/pwa.pt-BR.json'

const fallback = 'ATENCAO'

describe('the project only says it is creating after the run was accepted', () => {
  it('moves to GENERATING only on a 202 that carries a run', async () => {
    const accepted = await startGeneration(async () => ({ status: GENERATION_ACCEPTED_STATUS, body: { run_id: 'run-1' } }), () => true, fallback)
    expect(accepted).toEqual({ state: 'GENERATING', runId: 'run-1', message: null })
  })

  it('returns deterministically to PLAN_APPROVED when the run was not accepted', async () => {
    // Offline: the POST never left the machine. Nothing is being created anywhere.
    const offline = await startGeneration(async () => { throw new Error(OFFLINE_ERROR_CODE) }, () => false, fallback)
    expect(offline).toEqual({ state: 'PLAN_APPROVED', runId: null, message: t.offline.blockedAction })
    // The Studio did not answer: whether it arrived is unknown, and the state must not claim it did.
    const unreachable = await startGeneration(async () => ({ status: 503, body: { error: SERVICE_UNREACHABLE_ERROR_CODE } }), () => true, fallback)
    expect(unreachable).toEqual({ state: 'PLAN_APPROVED', runId: null, message: t.offline.serviceUnreachable })
    // A refusal from the server keeps the server's own sentence.
    const refused = await startGeneration(async () => ({ status: 409, body: { error: 'O plano precisa ser aprovado.' } }), () => true, fallback)
    expect(refused).toEqual({ state: 'PLAN_APPROVED', runId: null, message: 'O plano precisa ser aprovado.' })
    // 200 is not 202: only 202 means the run exists.
    const wrongStatus = await startGeneration(async () => ({ status: 200, body: { run_id: 'run-2' } }), () => true, fallback)
    expect(wrongStatus.state).toBe('PLAN_APPROVED')
    expect(wrongStatus.runId).toBeNull()
    // Accepted with nothing to follow is not something to show progress for.
    const noRun = await startGeneration(async () => ({ status: GENERATION_ACCEPTED_STATUS, body: {} }), () => true, fallback)
    expect(noRun).toEqual({ state: 'PLAN_APPROVED', runId: null, message: fallback })
  })

  it('never throws and never leaves the interface without a sentence', async () => {
    for (const outcome of [
      await startGeneration(async () => { throw new TypeError('Failed to fetch') }, () => true, fallback),
      await startGeneration(async () => { throw new TypeError('Failed to fetch') }, () => false, fallback),
      await startGeneration(async () => { throw 'boom' }, () => true, fallback),
      await startGeneration(async () => ({ status: 500, body: null }), () => true, fallback),
    ]) {
      expect(outcome.state).toBe('PLAN_APPROVED')
      expect(outcome.runId).toBeNull()
      expect(outcome.message?.trim()).not.toBe('')
      expect(outcome.message).not.toBeNull()
    }
    expect((await startGeneration(async () => { throw new TypeError('x') }, () => true, fallback)).message).toBe(t.offline.serviceUnreachable)
    expect((await startGeneration(async () => { throw new TypeError('x') }, () => false, fallback)).message).toBe(t.offline.blockedAction)
  })

  it('uses the shared authenticated request and reads the status, which is what 202 means', async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    const result = await postGeneration('p-1', async (path, init) => {
      calls.push([path, init])
      return { status: 202, body: { run_id: 'run-9' } }
    })
    expect(result).toEqual({ status: 202, body: { run_id: 'run-9' } })
    expect(calls[0]?.[0]).toBe('/projects/p-1/generate')
    expect(calls[0]?.[1]?.method).toBe('POST')
    expect(calls[0]?.[1]?.body).toBe('{}')
  })

  it('survives a body that is not JSON, so the status alone decides', async () => {
    const result = await postGeneration('p-1', async () => ({ status: 502, body: null }))
    expect(result).toEqual({ status: 502, body: null })
    const outcome = await startGeneration(async () => result, () => true, fallback)
    expect(outcome.state).toBe('PLAN_APPROVED')
  })
})
