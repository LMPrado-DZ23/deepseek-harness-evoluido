import type { MissionBudgetPort, MissionBudgetVerdict, MissionScope } from '@dz23-studio/agent-team'
import type { MissionRecord, MissionRunUsage } from './model.js'
import { missionSpend, type MissionRepository } from './service.js'

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
    verdictFor(scope: MissionScope, missionId: string): MissionBudgetVerdict {
      const mission = inScope(repository, scope, missionId)
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
export function inScope(repository: MissionRepository, scope: MissionScope, missionId: string): MissionRecord | undefined {
  return repository.missions().find(record => record.mission_id === missionId
    && record.org_id === scope.orgId && record.tenant_id === scope.tenantId)
}
