import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import type { AgentRunRecord, StudioAgentsRuntime } from '@dz23-studio/agents'
import { describe, expect, it, vi } from 'vitest'
import type { AgentTeamRecord, AgentTeamTaskRecord } from '../src/model.ts'
import {
  AgentTeamError,
  StudioAgentTeamService,
  blockedTasks,
  taskReadiness,
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
  afterPutTeam?: (record: AgentTeamRecord) => Promise<void>
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
    putTeam: async record => {
      teams.set(record.team_id, record)
      await options.afterPutTeam?.(record)
    },
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
  return { service, request, teams, tasks, runs, start, killJob, repository, agents }
}

describe('StudioAgentTeamService', () => {
  it('reconciles team tasks from the authoritative agent runs after restart', async () => {
    const h = harness()
    await h.service.start(h.request())
    const firstTeam = h.teams.get('team-1')!
    const firstTask = h.tasks.get('team-1:implementation')!
    h.teams.set('team-2', { ...firstTeam, team_id: 'team-2' })
    h.tasks.set('team-2:implementation', { ...firstTask, team_id: 'team-2', run_id: 'run-2', job_id: 'job-2' })
    h.teams.set('team-3', {
      ...firstTeam,
      team_id: 'team-3',
      status: 'WAITING_FOR_APPROVAL',
      diagnostic: 'Há propostas para revisar ou tarefas aguardando a aplicação das dependências.',
    })
    h.tasks.set('team-3:implementation', { ...firstTask, team_id: 'team-3', status: 'PROPOSED', run_id: 'run-3', job_id: null })
    h.teams.set('team-4', { ...firstTeam, team_id: 'team-4' })
    h.tasks.set('team-4:implementation', { ...firstTask, team_id: 'team-4', run_id: 'run-4', job_id: 'job-4' })
    h.teams.set('team-5', { ...firstTeam, team_id: 'team-5' })
    h.tasks.set('team-5:implementation', { ...firstTask, team_id: 'team-5', run_id: null, job_id: null })
    h.runs.push(
      run('run-4', 'PROPOSED'),
      run('run-3', 'PROPOSED'),
      run('run-2', 'FAILED', 'segundo reinício'),
      run('run-1', 'FAILED', 'reinício detectado'),
    )
    const restarted = new StudioAgentTeamService({
      repository: h.repository,
      agents: h.agents,
      killJob: h.killJob,
      now: () => new Date(now),
    })
    await expect(restarted.reconcileInterruptedTeams()).resolves.toEqual({
      updatedTasks: 4, updatedTeams: 4, reconciledAt: now,
    })
    expect(h.tasks.get('team-1:implementation')).toMatchObject({ status: 'FAILED', diagnostic: 'reinício detectado' })
    expect(h.teams.get('team-1')).toMatchObject({ status: 'NEEDS_ATTENTION' })
    expect(h.tasks.get('team-2:implementation')).toMatchObject({ status: 'FAILED', diagnostic: 'segundo reinício' })
    expect(h.teams.get('team-2')).toMatchObject({ status: 'NEEDS_ATTENTION' })
    expect(h.teams.get('team-3')).toMatchObject({ status: 'WAITING_FOR_APPROVAL' })
    expect(h.tasks.get('team-4:implementation')).toMatchObject({ status: 'PROPOSED', diagnostic: null })
    expect(h.teams.get('team-4')).toMatchObject({ status: 'WAITING_FOR_APPROVAL' })
    expect(h.tasks.get('team-5:implementation')).toMatchObject({
      status: 'FAILED', diagnostic: expect.stringContaining('interrompida pelo reinício'),
    })
    expect(restarted.activeTaskCount()).toBe(0)
    expect(h.killJob).not.toHaveBeenCalled()
  })

  it('fails closed when agent reconciliation is incomplete and marks a missing run as lost', async () => {
    const live = harness()
    await live.service.start(live.request())
    live.runs.push(run('run-1', 'RUNNING'))
    const blocked = new StudioAgentTeamService({
      repository: live.repository, agents: live.agents, killJob: live.killJob,
      now: () => new Date(now),
    })
    await expect(blocked.reconcileInterruptedTeams()).rejects.toThrow(/trabalho em andamento/)
    expect(live.tasks.get('team-1:implementation')).toMatchObject({ status: 'RUNNING' })

    const missing = harness()
    await missing.service.start(missing.request())
    const restarted = new StudioAgentTeamService({
      repository: missing.repository, agents: missing.agents, killJob: missing.killJob,
      now: () => new Date(now),
    })
    await expect(restarted.reconcileInterruptedTeams()).resolves.toMatchObject({ updatedTasks: 1, updatedTeams: 1 })
    expect(missing.tasks.get('team-1:implementation')).toMatchObject({
      status: 'FAILED', diagnostic: expect.stringContaining('interrompida pelo reinício'),
    })
  })

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
      // A-06: o construtor ESCREVE, então só a rede é recusada — e pelos nomes
      // REAIS. O que havia aqui era `deny: ['network']`, um nome que não existe
      // no Harness: a recusa não recusava nada.
      // A-06: PERMISSÃO por papel, com nomes REAIS. O construtor escreve e,
      // sem aprovação de rede externa, não enxerga as ferramentas de rede.
      inProcess: { toolFilter: { allow: ['edit', 'read', 'read_image', 'write'] }, persona: expect.stringContaining('Implemente somente') },
    }))
    expect(h.service.activeTaskCount()).toBe(2)
    expect(h.service.teams()).toHaveLength(1)
    expect(h.service.tasks()).toHaveLength(2)
    h.service.releaseJob('job-1' as JobId)
    expect(h.service.activeTaskCount()).toBe(1)
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

  it('accepts a transitively ordered DAG and does not mistake its shared path for parallel work', async () => {
    const h = harness()
    const snapshot = await h.service.start(h.request({ tasks: [
      task(),
      task({ taskId: 'review', title: 'Revisar núcleo', role: 'reviewer', prompt: 'Revise o núcleo.', intendedPaths: ['tests/core'], dependsOn: ['implementation'] }),
      task({ taskId: 'synthesis', title: 'Sintetizar núcleo', role: 'synthesizer', prompt: 'Sintetize o núcleo.', intendedPaths: ['src/core'], dependsOn: ['review'] }),
    ] }))
    expect(snapshot.tasks.map(item => [item.task_id, item.status])).toEqual([
      ['implementation', 'RUNNING'], ['review', 'QUEUED'], ['synthesis', 'QUEUED'],
    ])
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
      // Aprovada para rede externa, o construtor passa a enxergar a rede.
      inProcess: expect.objectContaining({
        toolFilter: { allow: ['edit', 'read', 'read_image', 'write'] },
      }),
    }))

    for (const sensitive of ['secrets', 'deploy'] as const) {
      const next = harness()
      await next.service.start(next.request({
        sensitive,
        approval: { approved: true, tier: 'T3', approvedBy: 'user-1' },
        budget: { timeoutMs: 30_000 },
      }))
      expect(next.start).toHaveBeenCalledWith(expect.objectContaining({
        ...(sensitive === 'secrets' ? { touchesSecrets: true } : { touchesDeploy: true }),
        budget: { timeoutMs: 30_000 },
      }))
    }
  })

  it.each([
    [{ name: ' x ' }, /nome/],
    [{ tasks: [] }, /entre 1 e 8/],
    [{ tasks: Array.from({ length: 9 }, (_, index) => task({ taskId: `t${index}`, intendedPaths: [`src/${index}`] })) }, /entre 1 e 8/],
    [{ provider: 'codex' as never }, /agente local/],
    [{ name: 42 as never }, /nome/],
    [{ tasks: [null as never] }, /identificador/],
    [{ tasks: ['task' as never] }, /identificador/],
    [{ tasks: [[] as never] }, /identificador/],
    [{ tasks: [task({ taskId: 42 as never })] }, /identificador/],
    [{ tasks: [task({ taskId: '1bad' })] }, /identificador/],
    [{ tasks: [task(), task()] }, /identificador/],
    [{ tasks: [task({ title: ' x ' })] }, /título/],
    [{ tasks: [task({ title: 42 as never })] }, /título/],
    [{ tasks: [task({ prompt: ' x ' })] }, /instrução/],
    [{ tasks: [task({ prompt: 42 as never })] }, /instrução/],
    [{ tasks: [task({ role: 'owner' as never })] }, /papel/],
    [{ tasks: [task({ intendedPaths: [] })] }, /caminhos/],
    [{ tasks: [task({ intendedPaths: [42 as never] })] }, /caminhos/],
    [{ tasks: [task({ intendedPaths: Array.from({ length: 21 }, (_, index) => `src/${index}`) })] }, /caminhos/],
    [{ tasks: [task({ dependsOn: ['missing'] })] }, /inexistente/],
    [{ tasks: [task({ dependsOn: null as never })] }, /inexistente/],
    [{ tasks: [task({ dependsOn: [42 as never] })] }, /inexistente/],
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

  it('records non-Error provider failures without losing their diagnostic', async () => {
    const h = harness({ start: vi.fn(() => { throw 'provider offline' }) })
    const snapshot = await h.service.start(h.request())
    expect(snapshot.tasks[0]).toMatchObject({ status: 'FAILED', diagnostic: 'provider offline' })
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
    await h.service.start(h.request({ tasks: [
      task(),
      task({ taskId: 'review', title: 'Revisar núcleo', dependsOn: ['implementation'] }),
    ] }))
    await h.service.cancel('team-1', 'user-1')
    expect(h.service.activeTaskCount()).toBe(0)
    expect(h.tasks.get('team-1:review')).toMatchObject({ diagnostic: expect.stringContaining('cancelada') })

    for (const status of ['PENDING_APPROVAL', 'FAILED', 'CANCELLED', 'BUDGET_EXCEEDED', 'REJECTED'] as const) {
      const next = harness()
      await next.service.start(next.request())
      next.runs.push(run('run-1', status, status))
      const snapshot = await next.service.status('team-1')
      expect(snapshot.tasks[0]?.status).toBe(status === 'PENDING_APPROVAL' ? 'QUEUED' : status)
    }

    const running = harness()
    await running.service.start(running.request())
    running.runs.push(run('run-1', 'RUNNING'))
    await expect(running.service.status('team-1')).resolves.toMatchObject({ team: { status: 'RUNNING' } })
  })

  it('serializes concurrent refreshes without releasing a queued team lock', async () => {
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    let blockedOnce = false
    const h = harness({
      afterPutTeam: async record => {
        if (record.status === 'WAITING_FOR_APPROVAL' && !blockedOnce) {
          blockedOnce = true
          await blocked
        }
      },
    })
    await h.service.start(h.request())
    h.runs.push(run('run-1', 'PROPOSED'))
    const first = h.service.status('team-1')
    const second = h.service.status('team-1')
    await Promise.resolve()
    release()
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
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

  it('o RETRATO carrega o bloqueio derivado: a tela nao recalcula a regra', async () => {
    // Falsificacao que expos a lacuna: eu podia trocar `blockedSummary(tasks)`
    // por `[]` no servico e NENHUM teste reprovava. A tela e desacoplada de
    // proposito e le este campo; sem teste aqui, a derivacao podia sumir e a
    // pessoa voltaria a nao ver o plano travado.
    const h = harness()
    const snapshot = await h.service.start(h.request({ tasks: [
      task({ taskId: 'base', title: 'Primeira etapa', intendedPaths: ['src/a.ts'] }),
      task({ taskId: 'depois', title: 'Segunda etapa', intendedPaths: ['src/b.ts'], dependsOn: ['base'] }),
    ] }))
    expect(snapshot.blocked).toEqual([])

    // A primeira etapa morre: a segunda deixa de estar aguardando a vez.
    h.runs.push(run('run-1', 'FAILED', 'quebrou'))
    const depois = await h.service.status('team-1')
    expect(depois.blocked).toEqual([
      { task_id: 'depois', title: 'Segunda etapa', reason: 'DEPENDENCY_FAILED', dependencies: ['base'] },
    ])
  })
})

describe('T-13: uma tarefa que nunca vai rodar nao pode parecer com uma que so aguarda a vez', () => {
  const task = (overrides: Partial<AgentTeamTaskRecord> = {}): AgentTeamTaskRecord => ({
    task_id: 'a', team_id: 't', org_id: 'o', tenant_id: 'n', workspace_id: 'w',
    title: 'Uma tarefa', role: 'implementer', prompt: 'faca algo',
    intended_paths: ['src/a.ts'], depends_on: [], status: 'QUEUED',
    run_id: null, job_id: null, diagnostic: null, created_at: now, updated_at: now,
    ...overrides,
  })
  const index = (...list: readonly AgentTeamTaskRecord[]) => new Map(list.map(item => [item.task_id, item]))

  it('sem dependencia, esta PRONTA', () => {
    const only = task()
    expect(taskReadiness(only, index(only))).toEqual({ kind: 'READY' })
  })

  it('com a dependencia aplicada, esta PRONTA', () => {
    const base = task({ task_id: 'base', status: 'APPLIED' })
    const dependent = task({ task_id: 'dep', depends_on: ['base'] })
    expect(taskReadiness(dependent, index(base, dependent))).toEqual({ kind: 'READY' })
  })

  it('com a dependencia ainda rodando, esta AGUARDANDO — e diz de quem', () => {
    const base = task({ task_id: 'base', status: 'RUNNING' })
    const dependent = task({ task_id: 'dep', depends_on: ['base'] })
    expect(taskReadiness(dependent, index(base, dependent))).toEqual({ kind: 'WAITING', pending: ['base'] })
  })

  it('com dependencia FANTASMA, esta BLOQUEADA — antes ficava esperando para sempre', () => {
    // Este e o defeito: `byId.get(id)?.status === 'APPLIED'` e falso para uma
    // dependencia que nao existe, exatamente como e falso para uma que ainda
    // roda. A tarefa ficava QUEUED sem nunca poder sair.
    const dependent = task({ task_id: 'dep', depends_on: ['nao-existe'] })
    expect(taskReadiness(dependent, index(dependent))).toEqual({
      kind: 'BLOCKED', reason: 'MISSING_DEPENDENCY', dependencies: ['nao-existe'],
    })
  })

  it('com dependencia que FALHOU, esta BLOQUEADA — e nao aguardando', () => {
    for (const status of ['FAILED', 'CANCELLED', 'BUDGET_EXCEEDED', 'REJECTED', 'UNKNOWN'] as const) {
      const base = task({ task_id: 'base', status })
      const dependent = task({ task_id: 'dep', depends_on: ['base'] })
      expect(taskReadiness(dependent, index(base, dependent)), `dependencia ${status} apareceu como espera`).toEqual({
        kind: 'BLOCKED', reason: 'DEPENDENCY_FAILED', dependencies: ['base'],
      })
    }
  })

  it('bloqueio vem ANTES de espera quando ha as duas', () => {
    // Dizer que uma tarefa aguarda, quando uma das dependencias dela morreu,
    // seria a mentira mais cara desta funcao: manda esperar quem precisa agir.
    const morta = task({ task_id: 'morta', status: 'FAILED' })
    const viva = task({ task_id: 'viva', status: 'RUNNING' })
    const dependent = task({ task_id: 'dep', depends_on: ['viva', 'morta'] })
    expect(taskReadiness(dependent, index(morta, viva, dependent)).kind).toBe('BLOCKED')
  })

  it('tarefa que ja saiu da fila nao e prontidao nenhuma', () => {
    for (const status of ['RUNNING', 'APPLIED', 'PROPOSED', 'FAILED'] as const) {
      expect(taskReadiness(task({ status }), index()).kind).toBe('NOT_QUEUED')
    }
  })

  it('blockedTasks lista o que trava o plano, com o motivo', () => {
    const morta = task({ task_id: 'morta', status: 'FAILED' })
    const orfa = task({ task_id: 'orfa', depends_on: ['fantasma'] })
    const parada = task({ task_id: 'parada', depends_on: ['morta'] })
    const boa = task({ task_id: 'boa' })
    const blocked = blockedTasks([morta, orfa, parada, boa])
    expect(blocked.map(item => item.task.task_id).sort()).toEqual(['orfa', 'parada'])
    expect(blocked.find(item => item.task.task_id === 'orfa')?.readiness.reason).toBe('MISSING_DEPENDENCY')
    expect(blocked.find(item => item.task.task_id === 'parada')?.readiness.reason).toBe('DEPENDENCY_FAILED')
  })
})
