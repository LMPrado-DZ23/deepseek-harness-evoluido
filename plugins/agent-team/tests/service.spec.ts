import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import type { AgentRunRecord, StudioAgentsRuntime } from '@dz23-studio/agents'
import { describe, expect, it, vi } from 'vitest'
import type { AgentTeamRecord, AgentTeamTaskRecord } from '../src/model.ts'
import {
  AgentTeamError,
  StudioAgentTeamService,
  type AgentTeamRepository,
  type AgentTeamStartRequest,
  type AgentTeamTaskInput,
} from '../src/service.ts'

const now = '2026-09-06T12:00:00.000Z'

function parent(id = 'person-session'): Agent {
  return { session: { id, header: { id, version: 1, createdAt: 1, agentPreset: 'dz23-assistant' } } } as unknown as Agent
}

function task(overrides: Partial<AgentTeamTaskInput> = {}): AgentTeamTaskInput {
  return {
    taskId: 'implementation',
    title: 'Implementar núcleo',
    role: 'implementer',
    prompt: 'Implemente o núcleo aprovado.',
    intendedPaths: ['src/core'],
    dependsOn: [],
    ...overrides,
  }
}

function run(id: string, status: AgentRunRecord['status'], diagnostic: string | null = null): AgentRunRecord {
  return {
    run_id: id, org_id: 'org-1', tenant_id: 'tenant-1', workspace_id: 'tenant-1',
    parent_session_id: 'person-session', coordinator_session_id: `coordinator-${id}`, provider: 'spawn-in-process',
    worktree_path: `/copy/${id}`, repository_path: '/repo', base_commit: 'abcdef1', status,
    changed_files: [], diff_bytes: 0, diff_sha256: '0'.repeat(64), main_changed_during_run: false,
    approved_by: 'user-1', approved_at: now, diagnostic, created_at: now, updated_at: now,
  }
}

function harness(options: {
  start?: ReturnType<typeof vi.fn>
  putTask?: (record: AgentTeamTaskRecord) => Promise<void>
} = {}) {
  const teams = new Map<string, AgentTeamRecord>()
  const tasks = new Map<string, AgentTeamTaskRecord>()
  const runs: AgentRunRecord[] = []
  let sequence = 0
  const start = options.start ?? vi.fn(() => {
    sequence += 1
    return { runId: `run-${sequence}`, jobId: `job-${sequence}` as JobId, requiredTier: 'T2' as const }
  })
  const repository: AgentTeamRepository = {
    teams: () => [...teams.values()],
    tasks: () => [...tasks.values()],
    putTeam: record => { teams.set(record.team_id, record); return Promise.resolve() },
    putTask: options.putTask ?? (record => { tasks.set(`${record.team_id}:${record.task_id}`, record); return Promise.resolve() }),
  }
  const killJob = vi.fn((): 'requested' | 'already-finished' => 'requested')
  const agents = {
    service: { start },
    runs: () => runs,
    leases: () => [],
    providerStates: () => ({ codex: 'NOT_PRESENT', 'claude-code': 'NOT_PRESENT' }),
  } as unknown as StudioAgentsRuntime
  const service = new StudioAgentTeamService({ repository, agents, killJob, now: () => new Date(now), createId: () => 'team-1' })
  const request = (overrides: Partial<AgentTeamStartRequest> = {}): AgentTeamStartRequest => ({
    orgId: 'org-1', tenantId: 'tenant-1', workspaceId: 'tenant-1', repositoryPath: '/repo',
    parent: parent(), provider: 'spawn-in-process', name: 'Equipe segura', tasks: [task()],
    approval: { approved: true, tier: 'T2', approvedBy: 'user-1' },
    ...overrides,
  })
  return { service, request, teams, tasks, runs, start, killJob }
}

describe('StudioAgentTeamService', () => {
  it('starts independent tasks in parallel and derives waiting and completed states from authoritative runs', async () => {
    const h = harness()
    const started = await h.service.start(h.request({ tasks: [
      task(),
      task({ taskId: 'tests', title: 'Testar núcleo', role: 'tester', prompt: 'Teste o núcleo.', intendedPaths: ['tests/core'] }),
    ] }))
    expect(started.team).toMatchObject({ team_id: 'team-1', status: 'RUNNING', required_tier: 'T2', sensitive_operation: null })
    expect(started.tasks.map(item => item.status)).toEqual(['RUNNING', 'RUNNING'])
    expect(h.start).toHaveBeenCalledTimes(2)
    expect(h.start).toHaveBeenNthCalledWith(1, expect.objectContaining({
      prompt: expect.stringContaining('Implemente somente'), intendedPaths: ['src/core'],
      inProcess: { toolFilter: { deny: ['network'] }, persona: expect.stringContaining('Implemente somente') },
    }))
    expect(h.service.activeTaskCount()).toBe(2)
    h.runs.push(run('run-1', 'PROPOSED', 'proposta 1'), run('run-2', 'PROPOSED', 'proposta 2'))
    const waiting = await h.service.status('team-1')
    expect(waiting.team.status).toBe('WAITING_FOR_APPROVAL')
    expect(waiting.tasks.map(item => item.status)).toEqual(['PROPOSED', 'PROPOSED'])
    expect(h.service.activeTaskCount()).toBe(0)
    h.runs.splice(0, 2, run('run-1', 'APPLIED'), run('run-2', 'APPLIED'))
    await expect(h.service.status('team-1')).resolves.toMatchObject({ team: { status: 'COMPLETED' } })
    h.service.releaseJob('missing' as JobId)
  })

  it('starts dependent work only after the person applies every dependency', async () => {
    const h = harness()
    const plan = [
      task(),
      task({ taskId: 'review', title: 'Revisar núcleo', role: 'reviewer', prompt: 'Revise o núcleo.', dependsOn: ['implementation'] }),
    ]
    const started = await h.service.start(h.request({ tasks: plan }))
    expect(started.tasks.map(item => [item.task_id, item.status])).toEqual([
      ['implementation', 'RUNNING'], ['review', 'QUEUED'],
    ])
    h.runs.push(run('run-1', 'PROPOSED'))
    await h.service.status('team-1')
    await expect(h.service.continue('team-1', parent(), { approved: true, tier: 'T2', approvedBy: 'user-1' }))
      .rejects.toMatchObject({ code: 'INVALID_STATE' })
    h.runs[0] = run('run-1', 'APPLIED')
    const continued = await h.service.continue('team-1', parent('new-session'), { approved: true, tier: 'T2', approvedBy: 'user-1' })
    expect(continued.tasks.find(item => item.task_id === 'review')).toMatchObject({ status: 'RUNNING', run_id: 'run-2' })
    expect(h.start).toHaveBeenLastCalledWith(expect.objectContaining({ parent: expect.objectContaining({ session: expect.objectContaining({ id: 'new-session' }) }) }))
  })

  it('preserves the declared T3 operation and requires the exact approval tier', async () => {
    const h = harness()
    await expect(h.service.start(h.request({ sensitive: 'external-network' }))).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
    const started = await h.service.start(h.request({
      sensitive: 'external-network',
      approval: { approved: true, tier: 'T3', approvedBy: 'user-1' },
    }))
    expect(started.team).toMatchObject({ required_tier: 'T3', sensitive_operation: 'external-network' })
    expect(h.start).toHaveBeenCalledWith(expect.objectContaining({
      usesExternalNetwork: true,
      approval: { approved: true, tier: 'T3', approvedBy: 'user-1' },
      inProcess: expect.objectContaining({ toolFilter: undefined }),
    }))
  })

  it.each([
    [{ name: ' x ' }, /nome/],
    [{ tasks: [] }, /entre 1 e 8/],
    [{ tasks: Array.from({ length: 9 }, (_, index) => task({ taskId: `t${index}`, intendedPaths: [`src/${index}`] })) }, /entre 1 e 8/],
    [{ provider: 'codex' as never }, /agente local/],
    [{ tasks: [task({ taskId: '1bad' })] }, /identificador/],
    [{ tasks: [task(), task()] }, /identificador/],
    [{ tasks: [task({ title: ' x ' })] }, /título/],
    [{ tasks: [task({ prompt: ' x ' })] }, /instrução/],
    [{ tasks: [task({ role: 'owner' as never })] }, /papel/],
    [{ tasks: [task({ intendedPaths: [] })] }, /caminhos/],
    [{ tasks: [task({ intendedPaths: Array.from({ length: 21 }, (_, index) => `src/${index}`) })] }, /caminhos/],
    [{ tasks: [task({ dependsOn: ['missing'] })] }, /inexistente/],
    [{ tasks: [task({ dependsOn: ['implementation'] })] }, /inexistente/],
    [{ tasks: [task(), task({ taskId: 'other', dependsOn: [], intendedPaths: ['src/core/file.ts'] })] }, /disputam/],
    [{ tasks: [task({ dependsOn: ['other'] }), task({ taskId: 'other', dependsOn: ['implementation'] })] }, /ciclo/],
  ])('rejects an invalid or unsafe plan: %j', async (override, error) => {
    const h = harness()
    await expect(h.service.start(h.request(override as never))).rejects.toThrow(error)
    expect(h.start).not.toHaveBeenCalled()
  })

  it.each([
    [{ approved: false, tier: 'T2', approvedBy: 'user-1' }, /Confirme/],
    [{ approved: true, tier: 'T3', approvedBy: 'user-1' }, /nível/],
    [{ approved: true, tier: 'T2', approvedBy: ' ' }, /Confirme/],
  ] as const)('rejects invalid approval %j', async (approval, error) => {
    const h = harness()
    await expect(h.service.start(h.request({ approval }))).rejects.toThrow(error)
  })

  it('records a failed task when delegation cannot start', async () => {
    const h = harness({ start: vi.fn(() => { throw new Error('provider unavailable') }) })
    const snapshot = await h.service.start(h.request())
    expect(snapshot.team.status).toBe('NEEDS_ATTENTION')
    expect(snapshot.tasks[0]).toMatchObject({ status: 'FAILED', diagnostic: 'provider unavailable' })
  })

  it('kills an accepted job when the running link cannot be persisted', async () => {
    let puts = 0
    const h = harness({ putTask: async record => {
      puts += 1
      if (puts === 2) throw new Error('disk failure')
      h.tasks.set(`${record.team_id}:${record.task_id}`, record)
    } })
    const snapshot = await h.service.start(h.request())
    expect(h.killJob).toHaveBeenCalledWith('job-1', expect.anything(), expect.stringContaining('registrar'))
    expect(snapshot.tasks[0]).toMatchObject({ status: 'FAILED', diagnostic: 'disk failure' })
  })

  it('cancels active and queued work without applying proposals', async () => {
    const h = harness()
    await h.service.start(h.request({ tasks: [
      task(),
      task({ taskId: 'review', title: 'Revisar núcleo', dependsOn: ['implementation'] }),
    ] }))
    await expect(h.service.cancel('team-1', 'another-user')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const cancelled = await h.service.cancel('team-1', 'user-1', 'pare agora')
    expect(cancelled.team.status).toBe('CANCELLED')
    expect(cancelled.tasks.find(item => item.task_id === 'review')).toMatchObject({ status: 'CANCELLED', diagnostic: 'pare agora' })
    expect(h.killJob).toHaveBeenCalledWith('job-1', expect.anything(), 'pare agora')
    h.runs.push(run('run-1', 'PROPOSED'))
    await expect(h.service.status('team-1')).resolves.toMatchObject({ team: { status: 'CANCELLED' } })
    await expect(h.service.continue('team-1', parent(), { approved: true, tier: 'T2', approvedBy: 'user-1' }))
      .rejects.toMatchObject({ code: 'INVALID_STATE' })
  })

  it('covers already-finished cancellation and all terminal run mappings', async () => {
    const h = harness()
    h.killJob.mockReturnValue('already-finished')
    await h.service.start(h.request())
    await h.service.cancel('team-1', 'user-1')
    expect(h.service.activeTaskCount()).toBe(0)

    for (const status of ['PENDING_APPROVAL', 'FAILED', 'CANCELLED', 'BUDGET_EXCEEDED', 'REJECTED'] as const) {
      const next = harness()
      await next.service.start(next.request())
      next.runs.push(run('run-1', status, status))
      const snapshot = await next.service.status('team-1')
      expect(snapshot.tasks[0]?.status).toBe(status === 'PENDING_APPROVAL' ? 'QUEUED' : status)
    }
  })

  it('rejects missing, completed, wrong-owner and wrong-tier continuation', async () => {
    const h = harness()
    await expect(h.service.status('missing')).rejects.toBeInstanceOf(AgentTeamError)
    await h.service.start(h.request())
    await expect(h.service.continue('team-1', parent(), { approved: true, tier: 'T2', approvedBy: 'other' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(h.service.continue('team-1', parent(), { approved: true, tier: 'T3', approvedBy: 'user-1' }))
      .rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
    h.runs.push(run('run-1', 'APPLIED'))
    await h.service.status('team-1')
    await expect(h.service.continue('team-1', parent(), { approved: true, tier: 'T2', approvedBy: 'user-1' }))
      .rejects.toMatchObject({ code: 'INVALID_STATE' })
  })
})
