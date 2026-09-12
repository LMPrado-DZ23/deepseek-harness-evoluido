import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@dz23-studio/identity'
import type {} from '@dz23-studio/tenancy'
import { inScope, missionBudgetPort } from './budget-port.js'
import { createMissionHttpHandler } from './http.js'
import { studioMissionsDomainSpec, type MissionKey, type MissionRecord } from './model.js'
import { StudioMissionService, type MissionRepository } from './service.js'

export * from './budget-port.js'
export * from './http.js'
export * from './model.js'
export * from './service.js'

export const name = 'dz23-studio-mission'
/**
 * `studioAgentTeams` é injetado porque a DEPENDÊNCIA É INVERTIDA: quem sabe o
 * que é uma missão é este plugin, e é ele que se apresenta ao serviço de
 * equipes. O caminho oposto — `agent-team` injetar `studioMission` — exigiria
 * injeção opcional, que esta versão do cordis não tem; torná-la obrigatória
 * faria toda instalação sem motor de missão deixar de carregar equipes, que é
 * o oposto do que se quer.
 */
export const inject = ['storageDomain', 'studioAgentTeams', 'studioAgents', 'studioIdentity', 'studioTenancy', 'webServer']

export interface StudioMissionRuntime {
  readonly service: StudioMissionService
  missions(): readonly MissionRecord[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    studioMission: StudioMissionRuntime
  }
}

class DomainMissionRepository implements MissionRepository {
  constructor(private readonly table: KvTable<MissionKey, MissionRecord>) {}
  missions() { return [...this.table.entries()].map(([, value]) => value) }
  putMission(record: MissionRecord) { return this.table.put(record.mission_id as MissionKey, record) }
}

export async function apply(ctx: Context): Promise<void> {
  const domain: Domain<typeof studioMissionsDomainSpec> = await ctx.storageDomain.open(studioMissionsDomainSpec)
  ctx.effect(() => async () => { await domain.close() }, 'studio-mission.domainClose')
  const repository = new DomainMissionRepository(domain.table('missions'))
  const service = new StudioMissionService({ repository })

  ctx.studioAgentTeams.service.setMissionBudget(missionBudgetPort(
    repository,
    () => ctx.studioAgents.runs(),
    // Se a missão não aceitar a execução, a falha SOBE. Ela chega ao mesmo
    // tratamento que uma gravação de tarefa que falha: o trabalho recém-iniciado
    // é encerrado e a tarefa fica `FAILED` com o motivo. É o lado fail-closed —
    // uma execução que a missão não consegue contabilizar é uma execução fora
    // do teto, e deixá-la correr é como o teto deixa de valer sem ninguém
    // desligá-lo. O custo é baixo de propósito: o trabalho acabou de começar.
    async (scope, missionId, runId) => {
      if (inScope(repository, scope, missionId) === undefined) throw new Error(`MISSION_MISSING:${missionId}`)
      await service.attachRunForApprovedTeam(scope, missionId, runId, ctx.studioAgents.runs())
    },
  ))

  ctx.provide('studioMission', { service, missions: () => repository.missions() })

  const port = ctx.webServer.port
  const defaultHost = `127.0.0.1:${String(port)}`
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/studio/missions',
    handler: createMissionHttpHandler({
      service,
      identity: ctx.studioIdentity.service,
      tenancy: ctx.studioTenancy.service,
      allowedHosts: [defaultHost, `localhost:${String(port)}`],
      allowedOrigins: [`http://localhost:${String(port)}`, `http://${defaultHost}`],
      runs: () => ctx.studioAgents.runs(),
    }),
  }), 'dz23-studio-mission.http')
}
