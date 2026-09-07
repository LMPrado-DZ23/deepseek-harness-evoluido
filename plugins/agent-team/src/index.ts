import type { Context } from '@deepseek-ai/cordis'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@dz23-studio/agents'
import {
  studioAgentTeamsDomainSpec,
  type AgentTeamKey,
  type AgentTeamRecord,
  type AgentTeamTaskKey,
  type AgentTeamTaskRecord,
} from './model.js'
import {
  StudioAgentTeamService,
  type AgentTeamRepository,
  type AgentTeamRestartReconciliation,
} from './service.js'

export * from './model.js'
export * from './service.js'

export const name = 'dz23-studio-agent-team'
export const inject = ['jobs', 'storageDomain', 'studioAgents']

export interface StudioAgentTeamRuntime {
  readonly service: StudioAgentTeamService
  readonly restartReconciliation: AgentTeamRestartReconciliation
  teams(): readonly AgentTeamRecord[]
  tasks(): readonly AgentTeamTaskRecord[]
  readonly automaticDependentStart: 'NOT_PRESENT'
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    studioAgentTeams: StudioAgentTeamRuntime
  }
}

class DomainAgentTeamRepository implements AgentTeamRepository {
  constructor(
    private readonly teamTable: KvTable<AgentTeamKey, AgentTeamRecord>,
    private readonly taskTable: KvTable<AgentTeamTaskKey, AgentTeamTaskRecord>,
  ) {}

  teams() { return [...this.teamTable.entries()].map(([, value]) => value) }
  tasks() { return [...this.taskTable.entries()].map(([, value]) => value) }
  putTeam(record: AgentTeamRecord) { return this.teamTable.put(record.team_id as AgentTeamKey, record) }
  putTask(record: AgentTeamTaskRecord) {
    return this.taskTable.put(`${record.team_id}:${record.task_id}` as AgentTeamTaskKey, record)
  }
}

export async function apply(ctx: Context): Promise<void> {
  const domain: Domain<typeof studioAgentTeamsDomainSpec> = await ctx.storageDomain.open(studioAgentTeamsDomainSpec)
  ctx.effect(() => async () => { await domain.close() }, 'studio-agent-team.domainClose')
  const repository = new DomainAgentTeamRepository(domain.table('teams'), domain.table('tasks'))
  const service = new StudioAgentTeamService({
    repository,
    agents: ctx.studioAgents,
    killJob: (jobId, owner, reason) => ctx.jobs.kill(jobId as JobId, owner, reason),
  })
  const restartReconciliation = await service.reconcileInterruptedTeams()
  const detachJobDone = ctx.jobs.onJobDone(snapshot => service.releaseJob(snapshot.id as JobId))
  ctx.effect(() => detachJobDone, 'studio-agent-team.jobDone')
  ctx.provide('studioAgentTeams', {
    service,
    restartReconciliation,
    teams: () => repository.teams(),
    tasks: () => repository.tasks(),
    automaticDependentStart: 'NOT_PRESENT',
  })
}
