import { assertValidApproval, type ApprovalRecord } from './model.js'
import {
  ApprovalConflictError,
  inScope,
  type ActionApprovalRepository,
  type ApprovalTenantScope,
} from './repository.js'

/**
 * O primeiro domínio do Studio a sair do armazenamento por chave-valor opaco e
 * ir para uma TABELA com isolamento por linha (RLS) — o requisito S-09.
 *
 * A diferença que importa não é o banco: é QUEM separa os inquilinos. Sob a
 * chave-valor, o Studio abre a unidade inteira e a separação é uma comparação
 * de campos dentro do processo; se um dia essa comparação sair de um caminho,
 * a linha do outro inquilino chega a quem pediu. Aqui a organização e o
 * inquilino viajam na própria consulta, e o banco recusa o que não é do escopo
 * — sem depender de nenhum `if` deste repositório estar correto.
 *
 * A ESCRITA CONDICIONAL DEIXOU DE SER LIDA E ESCRITA EM DUAS IDAS quando o
 * armazenamento oferece `putIf`. Antes, o mutex do serviço serializava dentro
 * do processo e mais nada: com duas réplicas — ou um segundo processo
 * qualquer — as duas liam `AVAILABLE`, as duas escreviam `CONSUMED` com
 * reivindicações DIFERENTES, e a segunda passava por cima da primeira. Uma
 * confirmação humana autorizava duas execuções distintas, que é o oposto exato
 * do que uso único significa.
 *
 * Agora a condição viaja DENTRO da instrução e quem perde a corrida escreve
 * zero linhas. Onde o armazenamento não oferecer `putIf`, o caminho antigo
 * continua — seguro em instância única, insuficiente com réplicas — e essa
 * diferença está declarada no tipo em vez de escondida.
 */

/** A unidade e a tabela onde os pedidos moram na tabela por inquilino. */
export const APPROVAL_TENANT_UNIT = 'studio_action_approvals'
export const APPROVAL_TENANT_TABLE = 'approvals'

/**
 * O recorte do armazenamento por inquilino que este repositório usa.
 *
 * É uma interface estrutural de propósito: `@dz23-studio/action-approval` não
 * depende de `@dz23-studio/storage-postgres`. A autoridade das confirmações não
 * pode passar a exigir um banco específico para compilar.
 */
export interface ApprovalTenantRecordStore {
  list<T>(scope: ApprovalTenantScope, unit: string, table: string): Promise<readonly { readonly key: string, readonly value: T }[]>
  get<T>(scope: ApprovalTenantScope, unit: string, table: string, key: string): Promise<T | undefined>
  put(scope: ApprovalTenantScope, unit: string, table: string, key: string, value: unknown): Promise<void>
  /**
   * Grava SE a linha ainda estiver como quem escreve viu, numa instrução só.
   *
   * OPCIONAL porque nem todo armazenamento oferece isso, e a ausência tem de
   * ser VISÍVEL em vez de silenciosa: sem ele o repositório volta a ler e
   * escrever em duas idas, que é seguro em instância única e insuficiente com
   * réplicas. Ver `put`.
   */
  putIf?(
    scope: ApprovalTenantScope, unit: string, table: string, key: string, value: unknown,
    expected: 'absent' | { readonly field: string; readonly value: string },
  ): Promise<boolean>
}

export class TenantRecordActionApprovalRepository implements ActionApprovalRepository {
  constructor(private readonly store: ApprovalTenantRecordStore) {}

  async get(scope: ApprovalTenantScope, approvalId: string): Promise<ApprovalRecord | undefined> {
    const row = await this.store.get<ApprovalRecord>(scope, APPROVAL_TENANT_UNIT, APPROVAL_TENANT_TABLE, approvalId)
    if (row === undefined) return undefined
    // Uma linha corrompida é recusada na leitura: corrupção não pode virar uma
    // aprovação silenciosa.
    assertValidApproval(row)
    // O escopo já foi imposto pelo banco. Esta conferência é a segunda tranca,
    // e existe porque a linha guarda a organização e o inquilino DENTRO do
    // valor: se algum dia uma linha for gravada com o escopo errado no corpo,
    // ela some da leitura em vez de aparecer como se fosse de quem perguntou.
    if (row.org_id !== scope.orgId || row.tenant_id !== scope.tenantId) return undefined
    return row
  }

  async listForActor(scope: {
    readonly userId: string
    readonly orgId: string
    readonly tenantId: string
    readonly sessionId: string
  }): Promise<readonly ApprovalRecord[]> {
    const rows = await this.store.list<ApprovalRecord>(scope, APPROVAL_TENANT_UNIT, APPROVAL_TENANT_TABLE)
    const result: ApprovalRecord[] = []
    for (const { value } of rows) {
      if (!inScope(value, scope)) continue
      // Uma linha corrompida recusa a listagem inteira: melhor a pessoa ver um
      // erro do que uma lista que silenciosamente esconde um pedido.
      assertValidApproval(value)
      result.push(value)
    }
    return result
  }

  async put(record: ApprovalRecord, expectedState: ApprovalRecord['state'] | 'new'): Promise<void> {
    assertValidApproval(record)
    const scope: ApprovalTenantScope = { orgId: record.org_id, tenantId: record.tenant_id }
    const conditional = this.store.putIf?.bind(this.store)
    if (conditional !== undefined) {
      // UMA instrução: a condição é avaliada contra a linha travada, e não
      // contra o que foi lido antes. Quem perde a corrida grava zero linhas.
      const written = await conditional(
        scope, APPROVAL_TENANT_UNIT, APPROVAL_TENANT_TABLE, record.approval_id, record,
        expectedState === 'new' ? 'absent' : { field: 'state', value: expectedState },
      )
      if (!written) {
        throw new ApprovalConflictError(expectedState === 'new'
          ? 'approval already exists'
          : 'approval state moved under the write')
      }
      return
    }
    // Caminho sem escrita condicional durável: ler, conferir, escrever. Vale em
    // instância única, sob o mutex do serviço; com réplicas, duas leituras
    // concorrentes veem o mesmo estado e as duas escrevem.
    const current = await this.get(scope, record.approval_id)
    if (expectedState === 'new') {
      if (current !== undefined) throw new ApprovalConflictError('approval already exists')
    } else if (current === undefined || current.state !== expectedState) {
      throw new ApprovalConflictError('approval state moved under the write')
    }
    await this.store.put(scope, APPROVAL_TENANT_UNIT, APPROVAL_TENANT_TABLE, record.approval_id, record)
  }
}
