import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import { describe, expect, it, vi } from 'vitest'
import type { AgentLeaseRecord, AgentRunRecord } from '../src/model.ts'
import {
  DelegationError,
  StudioAgentService,
  normalizeDelegationPath,
  type AgentRepository,
  type DelegationRequest,
  type JobPort,
  type WorktreeDiff,
  type WorktreeSnapshot,
} from '../src/service.ts'

class MemoryRepository implements AgentRepository {
  constructor(private readonly hideLeases = false, private readonly hideRuns = false) {}
  readonly runMap = new Map<string, AgentRunRecord>()
  readonly leaseMap = new Map<string, AgentLeaseRecord>()
  runs() { return this.hideRuns ? [] : [...this.runMap.values()] }
  leases() { return this.hideLeases ? [] : [...this.leaseMap.values()] }
  putRun(record: AgentRunRecord) { this.runMap.set(record.run_id, record); return Promise.resolve() }
  putLease(record: AgentLeaseRecord) { this.leaseMap.set(record.lease_id, record); return Promise.resolve() }
}

class MemoryJobs implements JobPort {
  readonly entries: Array<{
    id: JobId
    cancel(reason?: string): void
    done: Promise<JobOutcome>
  }> = []
  fail = false
  start(spec: Parameters<JobPort['start']>[0]): JobId {
    if (this.fail) throw new Error('jobs unavailable')
    const hooks = spec.run()
    const id = `studio-agent-${this.entries.length + 1}` as JobId
    this.entries.push({ id, ...hooks })
    return id
  }
}

const parent = { session: { id: SessionId('person-session') } } as Agent
const coordinatorAgent = { session: { id: SessionId('coordinator'), header: { cwd: '/copies/run' } } } as Agent

function completed(output = 'feito'): SubagentResult {
  return { stopReason: 'completed', output: [{ type: 'text', text: output }] }
}

function runWith(result: Promise<SubagentResult>, signal?: AbortSignal): SubagentRun {
  if (signal !== undefined) {
    signal.addEventListener('abort', () => undefined, { once: true })
  }
  return {
    id: SessionId('child'), localAgent: undefined, result,
    dispose: vi.fn(() => Promise.resolve()),
  }
}

function request(overrides: Partial<DelegationRequest> = {}): DelegationRequest {
  return {
    orgId: 'org-1', tenantId: 'tenant-1', workspaceId: 'workspace-1',
    repositoryPath: '/repo', parent, provider: 'spawn-in-process', prompt: 'Ajuste o arquivo.',
    intendedPaths: ['src'], approval: { approved: true, tier: 'T2', approvedBy: 'user-1' },
    ...overrides,
  }
}

function harness(options: {
  result?: SubagentResult
  resultFactory?: (signal: AbortSignal) => Promise<SubagentResult>
  diff?: WorktreeDiff
  mainAfter?: string
  usage?: number
  applyProposal?: (record: AgentRunRecord) => Promise<void>
  createError?: Error
  coordinatorError?: Error
  subagentStartError?: Error
  childDisposeError?: Error
  coordinatorDisposeError?: Error
  hideLeases?: boolean
  hideRuns?: boolean
  createId?: () => string
  omitId?: boolean
  omitClock?: boolean
  strongIdentity?: boolean
} = {}) {
  const repository = new MemoryRepository(options.hideLeases, options.hideRuns)
  const jobs = new MemoryJobs()
  const snapshot: WorktreeSnapshot = {
    repositoryPath: '/repo', worktreePath: '/copies/run', baseCommit: 'abcdef1234567', mainFingerprint: 'main-before',
  }
  const diff = options.diff ?? { text: 'diff --git a/src/a.ts b/src/a.ts', bytes: 35, files: ['src/a.ts'] }
  const coordinatorDispose = vi.fn(() => options.coordinatorDisposeError === undefined
    ? Promise.resolve()
    : Promise.reject(options.coordinatorDisposeError))
  const childDispose = vi.fn(() => options.childDisposeError === undefined
    ? Promise.resolve()
    : Promise.reject(options.childDisposeError))
  const starts: unknown[] = []
  const service = new StudioAgentService({
    repository,
    jobs,
    worktrees: {
      create: vi.fn(() => options.createError === undefined ? Promise.resolve(snapshot) : Promise.reject(options.createError)),
      diff: vi.fn(() => Promise.resolve(diff)),
      mainFingerprint: vi.fn(() => Promise.resolve(options.mainAfter ?? 'main-before')),
      applyProposal: vi.fn(record => options.applyProposal?.(record) ?? Promise.resolve()),
    },
    coordinators: {
      create: vi.fn((cwd, parentSessionId, provider) => {
        starts.push({ cwd, parentSessionId, provider })
        return options.coordinatorError === undefined
          ? Promise.resolve({ sessionId: SessionId('coordinator'), agent: coordinatorAgent, dispose: coordinatorDispose })
          : Promise.reject(options.coordinatorError)
      }),
    },
    subagents: {
      start: vi.fn((_provider, input) => {
        starts.push(input)
        if (options.subagentStartError !== undefined) return Promise.reject(options.subagentStartError)
        const promise = options.resultFactory?.(input.signal) ?? Promise.resolve(options.result ?? completed())
        return Promise.resolve({ ...runWith(promise), dispose: childDispose })
      }),
    },
    identity: { strongIdentityVerified: vi.fn(() => options.strongIdentity ?? true) },
    ...(options.usage === undefined ? {} : { usage: { tokensFor: () => options.usage } }),
    ...(options.omitClock ? {} : { now: () => new Date('2026-09-03T00:00:00.000Z') }),
    ...(options.omitId ? {} : { createId: options.createId ?? (() => 'run-1') }),
  })
  return { service, repository, jobs, starts, coordinatorDispose, childDispose }
}

describe('StudioAgentService PoC 3A', () => {
  it('uses one canonical lease-path grammar and rejects ambiguous platform paths', () => {
    expect(normalizeDelegationPath('src/safe')).toBe('src/safe')
    expect(normalizeDelegationPath('src\\safe')).toBe('src/safe')
    expect(normalizeDelegationPath('*')).toBe('*')
    for (const value of [
      '', '.', './src', 'src/.', 'src/..', 'src//safe', '/src', '\\server\\share',
      'C:/src', 'C:\\src', ' src', 'src ', 'src\0safe', 'src\nsafe',
    ]) {
      expect(() => normalizeDelegationPath(value)).toThrowError(expect.objectContaining({ code: 'INVALID_PATH' }))
    }
    expect(() => normalizeDelegationPath('*', false)).toThrowError(expect.objectContaining({ code: 'INVALID_PATH' }))
  })

  it('requires the exact T2 or T3 approval before creating any work', () => {
    const h = harness()
    expect(() => h.service.start(request({ approval: { approved: false, tier: 'T2', approvedBy: 'u' } })))
      .toThrowError(new DelegationError('APPROVAL_REQUIRED', 'Confirme antes de o assistente trabalhar numa cópia do projeto.'))
    expect(() => h.service.start(request({
      touchesSecrets: true, approval: { approved: true, tier: 'T2', approvedBy: 'u' },
    }))).toThrow(/confirmação reforçada/)
    expect(h.repository.runs()).toHaveLength(0)
  })

  it('uses the isolated worktree as coordinator cwd and returns only a proposed diff', async () => {
    const h = harness()
    const accepted = h.service.start(request({
      inProcess: { toolFilter: { deny: ['network'] }, persona: 'Trabalhe somente na cópia.' },
    }))
    expect(accepted).toEqual({ runId: 'run-1', jobId: 'studio-agent-1', requiredTier: 'T2' })
    await expect(h.jobs.entries[0]!.done).resolves.toEqual({
      status: 'completed', output: 'diff --git a/src/a.ts b/src/a.ts',
    })
    expect(h.starts[0]).toEqual({ cwd: '/copies/run', parentSessionId: SessionId('person-session'), provider: 'spawn-in-process' })
    expect(h.starts[1]).toMatchObject({ parent: coordinatorAgent, inProcess: { persona: 'Trabalhe somente na cópia.' } })
    expect(h.repository.runs()[0]).toMatchObject({
      parent_session_id: 'person-session', coordinator_session_id: 'coordinator',
      worktree_path: '/copies/run', status: 'PROPOSED', changed_files: ['src/a.ts'], diff_bytes: 35,
      main_changed_during_run: false, approved_by: 'user-1', approved_at: '2026-09-03T00:00:00.000Z',
    })
    expect(h.repository.leases()[0]).toMatchObject({ active: false, paths: ['src'], released_at: expect.any(String) })
    expect(h.childDispose).toHaveBeenCalledOnce()
    expect(h.coordinatorDispose).toHaveBeenCalledOnce()
  })

  it('recomputes a proposal for review and rejects a changed worktree without persisting the diff body', async () => {
    const diff = { text: 'diff --git a/src/a.ts b/src/a.ts', bytes: 35, files: ['src/a.ts'] }
    const h = harness({ diff })
    const accepted = h.service.start(request())
    await h.jobs.entries[0]!.done
    await expect(h.service.reviewProposal(accepted.runId)).resolves.toEqual(diff)
    expect(JSON.stringify(h.repository.runs()[0])).not.toContain('diff_text')
    diff.text = 'tampered'
    await expect(h.service.reviewProposal(accepted.runId)).rejects.toMatchObject({ code: 'PROPOSAL_TAMPERED' })
    await expect(h.service.reviewProposal('missing')).rejects.toMatchObject({ code: 'INVALID_STATE' })
  })

  it('requires a second T2 approval to apply a reviewed proposal and records the result', async () => {
    const applied: AgentRunRecord[] = []
    const h = harness({ applyProposal: record => { applied.push(record); return Promise.resolve() } })
    const accepted = h.service.start(request())
    await h.jobs.entries[0]!.done
    await expect(h.service.applyProposal(accepted.runId, { approved: false, tier: 'T2', approvedBy: 'user-1' }))
      .rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
    await expect(h.service.applyProposal(accepted.runId, { approved: true, tier: 'T2', approvedBy: 'user-1' }))
      .resolves.toEqual({ runId: 'run-1', status: 'APPLIED', changedFiles: ['src/a.ts'] })
    expect(applied).toHaveLength(1)
    expect(h.repository.runs()[0]).toMatchObject({ status: 'APPLIED' })
    await expect(h.service.applyProposal(accepted.runId, { approved: true, tier: 'T2', approvedBy: 'user-1' }))
      .rejects.toMatchObject({ code: 'INVALID_STATE' })
  })

  it('refuses overlapping live leases without silently queueing', async () => {
    let release!: (result: SubagentResult) => void
    const h = harness({ resultFactory: () => new Promise(resolve => { release = resolve }) })
    h.service.start(request())
    expect(() => h.service.start(request({ intendedPaths: ['src/a.ts'] }))).toThrowError(expect.objectContaining({ code: 'WRITE_CONFLICT' }))
    await vi.waitFor(() => { expect(h.starts).toHaveLength(2) })
    release(completed())
    await h.jobs.entries[0]!.done
  })

  it.each([
    [{ text: 'x', bytes: 1, files: ['other/a.ts'] }, 'arquivo fora dos caminhos aprovados'],
    [{ text: 'x', bytes: 3_000_000, files: ['src/a.ts'] }, 'limite de bytes do diff excedido'],
    [{ text: 'x', bytes: 1, files: Array.from({ length: 51 }, (_, i) => `src/${i}.ts`) }, 'limite de arquivos excedido'],
  ] as const)('preserves the worktree when a diff budget fails', async (diff, reason) => {
    const h = harness({ diff })
    h.service.start(request())
    await expect(h.jobs.entries[0]!.done).resolves.toMatchObject({ status: 'failed', detail: reason })
    expect(h.repository.runs()[0]).toMatchObject({ status: 'BUDGET_EXCEEDED', diagnostic: reason })
  })

  it('reports a person workspace mutation without discarding the proposal and detects a token overrun', async () => {
    const outside = harness({ mainAfter: 'changed' })
    outside.service.start(request())
    await expect(outside.jobs.entries[0]!.done).resolves.toMatchObject({ status: 'completed' })
    expect(outside.repository.runs()[0]).toMatchObject({
      status: 'PROPOSED',
      main_changed_during_run: true,
      diagnostic: 'Seu projeto mudou enquanto o assistente trabalhava; confira antes de aplicar.',
    })

    const tokens = harness({ usage: 101 })
    tokens.service.start(request({ budget: { maxTokens: 100 } }))
    await tokens.jobs.entries[0]!.done
    expect(tokens.repository.runs()[0]?.diagnostic).toBe('limite de tokens excedido')
  })

  it('records child failure, process loss, user cancellation and timeout honestly', async () => {
    const failed = harness({ result: { stopReason: 'error', diagnostic: 'SIGKILL', output: [] } })
    failed.service.start(request())
    await expect(failed.jobs.entries[0]!.done).resolves.toEqual({ status: 'failed', detail: 'SIGKILL' })
    expect(failed.repository.runs()[0]?.status).toBe('FAILED')

    const cancelled = harness({ resultFactory: signal => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve(completed()), { once: true })
    }) })
    cancelled.service.start(request())
    await vi.waitFor(() => { expect(cancelled.starts).toHaveLength(2) })
    cancelled.jobs.entries[0]!.cancel('cancelled-by-user')
    await expect(cancelled.jobs.entries[0]!.done).resolves.toEqual({ status: 'killed', detail: 'cancelled-by-user' })
    expect(cancelled.repository.runs()[0]?.status).toBe('CANCELLED')

    const timed = harness({ resultFactory: signal => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve(completed()), { once: true })
    }) })
    timed.service.start(request({ budget: { timeoutMs: 5 } }))
    await expect(timed.jobs.entries[0]!.done).resolves.toEqual({ status: 'failed', detail: 'timeout' })
    expect(timed.repository.runs()[0]?.status).toBe('BUDGET_EXCEEDED')
  })

  it('rejects unsafe declarations', () => {
    const h = harness()
    expect(() => h.service.start(request({ intendedPaths: [] }))).toThrowError(expect.objectContaining({ code: 'INVALID_PATH' }))
    expect(() => h.service.start(request({ intendedPaths: ['../outside'] }))).toThrow(/inválido/)
  })

  it('releases admission when job registration fails', () => {
    const h = harness()
    h.jobs.fail = true
    expect(() => h.service.start(request())).toThrow('jobs unavailable')
    h.jobs.fail = false
    expect(() => h.service.start(request())).not.toThrow()
  })

  it.each([
    { touchesDeploy: true },
    { usesExternalNetwork: true },
  ])('accepts every sensitive declaration only with T3 approval', async flags => {
    const h = harness()
    h.service.start(request({ ...flags, approval: { approved: true, tier: 'T3', approvedBy: 'u' } }))
    await expect(h.jobs.entries[0]!.done).resolves.toMatchObject({ status: 'completed' })
  })

  it('requires recent strong identity for T3 even when the approval object says approved', () => {
    const h = harness({ strongIdentity: false })
    expect(() => h.service.start(request({
      touchesDeploy: true,
      approval: { approved: true, tier: 'T3', approvedBy: 'user-1' },
    }))).toThrowError(new DelegationError(
      'APPROVAL_REQUIRED',
      'Confirme com sua passkey antes de iniciar esta tarefa sensível.',
    ))
    expect(h.repository.runs()).toHaveLength(0)
  })

  it('normalizes wildcard paths and permits simultaneous non-overlapping leases', async () => {
    let release!: (result: SubagentResult) => void
    let id = 0
    const h = harness({
      createId: () => `run-${++id}`,
      resultFactory: () => id === 1 ? new Promise(resolve => { release = resolve }) : Promise.resolve(completed('')),
    })
    h.service.start(request({ intendedPaths: ['*'] }))
    await vi.waitFor(() => expect(h.repository.leases()[0]?.paths).toEqual(['*']))
    release(completed())
    await h.jobs.entries[0]!.done

    h.service.start(request({ intendedPaths: ['src'] }))
    h.service.start(request({ intendedPaths: ['docs'] }))
    await Promise.all(h.jobs.entries.slice(1).map(entry => entry.done))
    expect(h.repository.leases().map(lease => lease.paths)).toEqual([['*'], ['src'], ['docs']])
  })

  it('uses default budgets, clock and random id and supports cancellation without a reason', async () => {
    const h = harness({ omitClock: true, omitId: true, resultFactory: signal => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve(completed()), { once: true })
    }) })
    const accepted = h.service.start(request())
    expect(accepted.runId).toMatch(/^[0-9a-f-]{36}$/)
    await vi.waitFor(() => expect(h.starts).toHaveLength(2))
    h.jobs.entries[0]!.cancel()
    await expect(h.jobs.entries[0]!.done).resolves.toEqual({ status: 'killed', detail: 'cancelled-by-user' })
  })

  it('applies with the real clock and ignores non-text terminal blocks', async () => {
    const h = harness({ omitClock: true, result: { stopReason: 'completed', output: [{ type: 'image', data: 'x', mimeType: 'image/png' } as never] } })
    const accepted = h.service.start(request())
    await expect(h.jobs.entries[0]!.done).resolves.toMatchObject({ status: 'completed' })
    await expect(h.service.applyProposal(accepted.runId, { approved: true, tier: 'T2', approvedBy: 'u' }))
      .resolves.toMatchObject({ status: 'APPLIED' })
  })

  it('fails closed at every setup boundary and tolerates cleanup failures', async () => {
    for (const [options, message] of [
      [{ createError: new Error('create failed') }, 'create failed'],
      [{ coordinatorError: new Error('coordinator failed') }, 'coordinator failed'],
      [{ subagentStartError: new Error('child start failed'), hideLeases: true }, 'child start failed'],
      [{ subagentStartError: new Error('child start failed') }, 'child start failed'],
    ] as const) {
      const h = harness(options)
      h.service.start(request())
      await expect(h.jobs.entries[0]!.done).resolves.toMatchObject({ status: 'failed', detail: expect.stringContaining(message) })
    }

    const cleanup = harness({
      result: { stopReason: 'error', output: [] },
      childDisposeError: new Error('dispose child'), coordinatorDisposeError: new Error('dispose coordinator'),
    })
    cleanup.service.start(request())
    await expect(cleanup.jobs.entries[0]!.done).resolves.toEqual({ status: 'failed', detail: 'error' })
  })

  it('classifies thrown setup failures after timeout or cancellation and keeps a timestamp without a visible RUNNING row', async () => {
    const timed = harness({ resultFactory: signal => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('lost after timeout')), { once: true })
    }) })
    timed.service.start(request({ budget: { timeoutMs: 5 } }))
    await expect(timed.jobs.entries[0]!.done).resolves.toEqual({ status: 'failed', detail: 'Error: lost after timeout' })
    expect(timed.repository.runs()[0]?.status).toBe('BUDGET_EXCEEDED')

    const cancelled = harness({ resultFactory: signal => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('lost after cancel')), { once: true })
    }) })
    cancelled.service.start(request())
    await vi.waitFor(() => expect(cancelled.starts).toHaveLength(2))
    cancelled.jobs.entries[0]!.cancel('stop-now')
    await expect(cancelled.jobs.entries[0]!.done).resolves.toEqual({ status: 'killed', detail: 'Error: lost after cancel' })

    const hidden = harness({ hideRuns: true })
    hidden.service.start(request())
    await expect(hidden.jobs.entries[0]!.done).resolves.toMatchObject({ status: 'completed' })
  })

  it('returns killed when cancellation races with worktree setup failure', async () => {
    const h = harness({ createError: new Error('create failed') })
    h.service.start(request())
    h.jobs.entries[0]!.cancel('cancel-before-create')
    await expect(h.jobs.entries[0]!.done).resolves.toEqual({ status: 'killed', detail: 'Error: create failed' })
  })

  it('serializes proposal application per workspace and releases the lock after failure', async () => {
    let release!: () => void
    const applying = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    const h = harness({ applyProposal: () => ++calls === 1 ? applying : Promise.resolve() })
    const accepted = h.service.start(request())
    await h.jobs.entries[0]!.done
    const first = h.service.applyProposal(accepted.runId, { approved: true, tier: 'T2', approvedBy: 'u' })
    await expect(h.service.applyProposal(accepted.runId, { approved: true, tier: 'T2', approvedBy: 'u' }))
      .rejects.toMatchObject({ code: 'WRITE_CONFLICT' })
    release()
    await expect(first).resolves.toMatchObject({ status: 'APPLIED' })

    const failed = harness({ applyProposal: () => Promise.reject(new Error('git apply failed')) })
    const proposal = failed.service.start(request())
    await failed.jobs.entries[0]!.done
    await expect(failed.service.applyProposal(proposal.runId, { approved: true, tier: 'T2', approvedBy: 'u' }))
      .rejects.toThrow('git apply failed')
    expect(failed.repository.runs()[0]?.status).toBe('PROPOSED')
  })
})
