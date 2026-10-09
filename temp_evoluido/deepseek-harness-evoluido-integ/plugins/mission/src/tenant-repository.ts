import { missionRecordSchema, type MissionRecord } from './model.js'
import type { MissionRepository, MissionScope } from './service.js'

/** A unidade e a tabela onde as missões moram na tabela por inquilino. */
export const MISSION_TENANT_UNIT = 'studio_missions'
export const MISSION_TENANT_TABLE = 'missions'

/**
 * O recorte do armazenamento por inquilino que este repositório usa.
 *
 * Interface estrutural de propósito: `@dz23-studio/mission` não depende de
 * `@dz23-studio/storage-postgres`. O motor de missão não pode passar a exigir
 * um banco específico para compilar.
 *
 * `putIf` é OPCIONAL e a ausência dele é VISÍVEL no tipo. Sem ele o repositório
 * volta a ler e escrever em duas idas — suficiente em instância única, sob a
 * fila do serviço, e insuficiente com réplicas. Esconder essa diferença seria
 * pior do que não ter a escrita condicional.
 */
export interface MissionTenantRecordStore {
  list<T>(scope: MissionScope, unit: string, table: string): Promise<readonly { readonly key: string, readonly value: T }[]>
  get<T>(scope: MissionScope, unit: string, table: string, key: string): Promise<T | undefined>
  put(scope: MissionScope, unit: string, table: string, key: string, value: unknown): Promise<void>
  putIf?(
    scope: MissionScope, unit: string, table: string, key: string, value: unknown,
    expected: 'absent' | { readonly field: string; readonly value: string },
  ): Promise<boolean>
}

/**
 * As missões numa TABELA com isolamento por linha, e não na chave-valor opaca.
 *
 * `studio_missions` era o único domínio classificado `ready` para RLS na
 * auditoria do `S-08`: toda leitura é por (organização, inquilino,
 * identificador), não há varredura de início, guarda síncrona nem invariante
 * entre inquilinos. Esta é a migração que a classificação prometia.
 *
 * A diferença que importa não é o banco: é QUEM separa os inquilinos. Sob a
 * chave-valor, o Studio abre a unidade inteira e a separação é uma comparação
 * de campos dentro do processo; se um dia essa comparação sair de um caminho, a
 * linha do outro inquilino chega a quem pediu. Aqui a organização e o inquilino
 * viajam na própria consulta.
 *
 * E a gravação condicional deixa de depender de trava em memória: a revisão vai
 * DENTRO da instrução, e duas réplicas alterando a mesma missão não se apagam.
 */
export class TenantRecordMissionRepository implements MissionRepository {
  constructor(private readonly store: MissionTenantRecordStore) {}

  async missions(scope: MissionScope): Promise<readonly MissionRecord[]> {
    const rows = await this.store.list<MissionRecord>(scope, MISSION_TENANT_UNIT, MISSION_TENANT_TABLE)
    const result: MissionRecord[] = []
    for (const { value } of rows) {
      // Uma linha corrompida é recusada na LEITURA. Deixá-la passar faria um
      // registro sem critérios — ou com um critério comprovado sem prova —
      // chegar à tela como se fosse uma missão legítima.
      const parsed = missionRecordSchema.safeParse(value)
      if (!parsed.success) continue
      // Segunda tranca, depois da do banco: a linha guarda o escopo DENTRO do
      // valor, e se alguma vez for gravada com o escopo errado no corpo, ela
      // some da leitura em vez de aparecer como se fosse de quem perguntou.
      if (parsed.data.org_id !== scope.orgId || parsed.data.tenant_id !== scope.tenantId) continue
      result.push(parsed.data)
    }
    return result
  }

  async putMission(record: MissionRecord, expected: 'new' | number): Promise<boolean> {
    const scope: MissionScope = { orgId: record.org_id, tenantId: record.tenant_id }
    const conditional = this.store.putIf?.bind(this.store)
    if (conditional !== undefined) {
      return conditional(
        scope, MISSION_TENANT_UNIT, MISSION_TENANT_TABLE, record.mission_id, record,
        expected === 'new' ? 'absent' : { field: 'revision', value: String(expected) },
      )
    }
    // Sem escrita condicional durável: ler, conferir, escrever. Vale em
    // instância única, sob a fila do serviço.
    const current = await this.store.get<MissionRecord>(scope, MISSION_TENANT_UNIT, MISSION_TENANT_TABLE, record.mission_id)
    if (expected === 'new') {
      if (current !== undefined) return false
    } else if (current === undefined || current.revision !== expected) {
      return false
    }
    await this.store.put(scope, MISSION_TENANT_UNIT, MISSION_TENANT_TABLE, record.mission_id, record)
    return true
  }
}
