import { assertValidApproval, type ApprovalRecord } from './model.js'

/**
 * Persistência das aprovações. Erros de armazenamento sobem como erros: nunca
 * são convertidos em "aprovado" nem em "negado" - quem chama precisa distinguir
 * "a pessoa recusou" de "não deu para saber".
 */
/**
 * A organização e o inquilino de quem está lendo.
 *
 * A leitura carrega o escopo em vez de o serviço filtrar depois. Sob o
 * armazenamento por chave-valor as duas formas dão o mesmo resultado; sob uma
 * tabela com RLS elas são diferentes de verdade: com o escopo na leitura o
 * BANCO recusa a linha do outro inquilino, e um descuido futuro no serviço
 * deixa de ser a única coisa entre um pedido e a pessoa errada.
 */
export interface ApprovalTenantScope {
  readonly orgId: string
  readonly tenantId: string
}

export interface ActionApprovalRepository {
  get(scope: ApprovalTenantScope, approvalId: string): Promise<ApprovalRecord | undefined>
  /**
   * Todos os pedidos de um escopo exato. Filtrar é obrigação de quem
   * implementa: uma listagem que devolvesse a linha de outra pessoa seria um
   * vazamento entre inquilinos, não um detalhe de desempenho.
   */
  listForActor(scope: {
    readonly userId: string
    readonly orgId: string
    readonly tenantId: string
    readonly sessionId: string
  }): Promise<readonly ApprovalRecord[]>
  /** Escrita condicionada ao estado lido, para que duas confirmações concorrentes não gerem dois recibos. */
  put(record: ApprovalRecord, expectedState: ApprovalRecord['state'] | 'new'): Promise<void>
}

export class ApprovalConflictError extends Error {}

/**
 * Implementação em memória usada pelas provas. A validação é a mesma da
 * durável: um registro que não passa no modelo não entra e não sai.
 */
export class InMemoryActionApprovalRepository implements ActionApprovalRepository {
  /**
   * Espelha o seam REAL de domínio quando `false`: `put(chave, valor)`, sem
   * "grave só se o estado ainda for X". É assim que as provas verificam que a
   * correção não depende de escrita condicional.
   */
  constructor(private readonly enforceExpectedState = true) {}

  readonly #rows = new Map<string, ApprovalRecord>()
  #failure: Error | undefined
  #beforePut: ((record: ApprovalRecord) => void) | undefined

  /** Faz a próxima operação falhar, para provar que erro de storage continua erro. */
  failNext(error: Error): void { this.#failure = error }

  /**
   * Executa algo imediatamente antes da próxima escrita. É como as provas
   * encenam uma escrita concorrente: outro processo grava primeiro e a nossa
   * escrita encontra o estado já mudado.
   */
  interceptNextPut(hook: (record: ApprovalRecord) => void): void { this.#beforePut = hook }

  /** Remoção direta usada apenas para encenar a linha que sumiu sob a corrida. */
  forget(approvalId: string): void { this.#rows.delete(approvalId) }

  /** Escrita direta usada apenas para encenar o vencedor de uma corrida. */
  seed(record: ApprovalRecord): void {
    assertValidApproval(record)
    this.#rows.set(record.approval_id, record)
  }

  size(): number { return this.#rows.size }

  get(scope: ApprovalTenantScope, approvalId: string): Promise<ApprovalRecord | undefined> {
    this.#throwIfArmed()
    const row = this.#rows.get(approvalId)
    if (row === undefined) return Promise.resolve(undefined)
    // Fora do escopo é o MESMO "não existe" de um id inventado.
    if (row.org_id !== scope.orgId || row.tenant_id !== scope.tenantId) return Promise.resolve(undefined)
    assertValidApproval(row)
    return Promise.resolve(row)
  }

  put(record: ApprovalRecord, expectedState: ApprovalRecord['state'] | 'new'): Promise<void> {
    this.#throwIfArmed()
    const hook = this.#beforePut
    if (hook !== undefined) { this.#beforePut = undefined; hook(record) }
    assertValidApproval(record)
    const current = this.#rows.get(record.approval_id)
    const observed = current === undefined ? 'new' : current.state
    if (this.enforceExpectedState && observed !== expectedState) {
      throw new ApprovalConflictError('approval changed under this write')
    }
    this.#rows.set(record.approval_id, record)
    return Promise.resolve()
  }

  listForActor(scope: {
    readonly userId: string
    readonly orgId: string
    readonly tenantId: string
    readonly sessionId: string
  }): Promise<readonly ApprovalRecord[]> {
    this.#throwIfArmed()
    const rows: ApprovalRecord[] = []
    for (const row of this.#rows.values()) {
      if (!inScope(row, scope)) continue
      assertValidApproval(row)
      rows.push(row)
    }
    return Promise.resolve(rows)
  }

  #throwIfArmed(): void {
    const failure = this.#failure
    if (failure === undefined) return
    this.#failure = undefined
    throw failure
  }
}

/** Um pedido pertence ao escopo exato: pessoa, sessão, organização e inquilino. */
export function inScope(record: ApprovalRecord, scope: {
  readonly userId: string
  readonly orgId: string
  readonly tenantId: string
  readonly sessionId: string
}): boolean {
  return record.user_id === scope.userId
    && record.session_id === scope.sessionId
    && record.org_id === scope.orgId
    && record.tenant_id === scope.tenantId
}
