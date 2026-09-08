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
 * O que isto NÃO conserta, e está dito porque a diferença é fácil de confundir
 * com segurança que não existe: a escrita condicional continua sendo lida e
 * escrita em duas idas ao banco, sob o mutex do serviço, exatamente como na
 * chave-valor. RLS separa inquilinos; ela não cria transação. Duas confirmações
 * concorrentes DO MESMO pedido continuam serializadas pelo processo, e não pelo
 * banco — e por isso o Studio continua sendo escritor único.
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
    const current = await this.get(scope, record.approval_id)
    if (expectedState === 'new') {
      if (current !== undefined) throw new ApprovalConflictError('approval already exists')
    } else if (current === undefined || current.state !== expectedState) {
      throw new ApprovalConflictError('approval state moved under the write')
    }
    await this.store.put(scope, APPROVAL_TENANT_UNIT, APPROVAL_TENANT_TABLE, record.approval_id, record)
  }
}
