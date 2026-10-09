import type { MissionBudgetPort, MissionBudgetVerdict } from '@dz23-studio/agent-team'
import type { MissionRecord, MissionRunUsage } from './model.js'
import { missionSpend, type MissionRepository, type MissionScope, type StudioMissionService } from './service.js'

/**
 * O teto da missão, na forma que o serviço de equipes entende.
 *
 * O adaptador existe por causa de um veredito que o motor de missão não tem e o
 * de equipes precisa: `MISSION_MISSING`. Uma missão que sumiu do registro não
 * pode virar "sem teto" — e como `missionSpend` só sabe somar sobre uma missão
 * que existe, é aqui que a ausência vira recusa explícita.
 *
 * A busca leva o ESCOPO DA EQUIPE, e não só o identificador: `mission_id` é
 * escolhido por quem cria a missão, e nada impede duas organizações de
 * escolherem o mesmo. Sem o escopo, a equipe de uma seria medida contra a
 * missão da outra — e, pior, a execução dela entraria na missão alheia.
 * @param repository - de onde as missões são lidas.
 * @param runs - as execuções conhecidas, no recorte que o teto usa.
 * @param noteRun - registra na missão uma execução que acabou de começar.
 * @returns a porta.
 */
export function missionBudgetPort(
  repository: MissionRepository,
  runs: () => readonly MissionRunUsage[],
  noteRun: (scope: MissionScope, missionId: string, runId: string) => Promise<void>,
): MissionBudgetPort {
  return {
    async verdictFor(scope: MissionScope, missionId: string): Promise<MissionBudgetVerdict> {
      const mission = await inScope(repository, scope, missionId)
      if (mission === undefined) return { kind: 'MISSION_MISSING', missionId }
      return missionSpend(mission, runs())
    },
    noteRun,
  }
}

/**
 * A missão daquele identificador DENTRO do escopo, ou nenhuma.
 * @param repository - de onde as missões são lidas.
 * @param scope - a organização e o inquilino.
 * @param missionId - o identificador.
 * @returns a missão, ou `undefined`.
 */
export async function inScope(
  repository: MissionRepository, scope: MissionScope, missionId: string,
): Promise<MissionRecord | undefined> {
  return (await repository.missions(scope)).find(record => record.mission_id === missionId
    && record.org_id === scope.orgId && record.tenant_id === scope.tenantId)
}

/**
 * Registra na missão uma execução que acabou de começar.
 *
 * Se a missão não aceitar, a falha SOBE. Ela chega ao mesmo tratamento que uma
 * gravação de tarefa que falha: o trabalho recém-iniciado é encerrado e a
 * tarefa fica `FAILED` com o motivo. É o lado fail-closed — uma execução que a
 * missão não consegue contabilizar é uma execução fora do teto, e deixá-la
 * correr é como o teto deixa de valer sem ninguém desligá-lo.
 *
 * Está aqui, e não dentro de `apply`, porque uma função dentro da montagem do
 * plugin só é exercida montando o plugin inteiro — e foi assim que a conferência
 * de ausência virou uma comparação de PROMESSA com `undefined`, que nunca
 * recusa nada, sem nenhum teste reclamar.
 * @param repository - de onde as missões são lidas.
 * @param service - o serviço que liga a execução.
 * @param runs - as execuções conhecidas.
 * @returns a função de registro.
 */
export function missionNoteRun(
  repository: MissionRepository,
  service: Pick<StudioMissionService, 'attachRunForApprovedTeam'>,
  runs: () => readonly MissionRunUsage[],
): (scope: MissionScope, missionId: string, runId: string) => Promise<void> {
  return async (scope, missionId, runId) => {
    if (await inScope(repository, scope, missionId) === undefined) {
      throw new Error(`MISSION_MISSING:${missionId}`)
    }
    await service.attachRunForApprovedTeam(scope, missionId, runId, runs())
  }
}
