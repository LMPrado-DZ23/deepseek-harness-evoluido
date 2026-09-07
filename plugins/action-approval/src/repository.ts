import { assertValidApproval, type ApprovalRecord } from './model.js'

/**
 * Persistência das aprovações. Erros de armazenamento sobem como erros: nunca
 * são convertidos em "aprovado" nem em "negado" - quem chama precisa distinguir
 * "a pessoa recusou" de "não deu para saber".
 */
export interface ActionApprovalRepository {
  get(approvalId: string): Promise<ApprovalRecord | undefined>
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

  get(approvalId: string): Promise<ApprovalRecord | undefined> {
    this.#throwIfArmed()
    const row = this.#rows.get(approvalId)
    if (row === undefined) return Promise.resolve(undefined)
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

  #throwIfArmed(): void {
    const failure = this.#failure
    if (failure === undefined) return
    this.#failure = undefined
    throw failure
  }
}
