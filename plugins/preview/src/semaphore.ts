/** Não há vaga agora, e a fila de espera já está cheia. */
export class SemaphoreFullError extends Error {
  readonly code = 'SEMAPHORE_FULL'
  constructor(readonly limit: number, readonly queueLimit: number) {
    super('SEMAPHORE_FULL')
  }
}

/**
 * Um teto de quantas operações caras correm ao mesmo tempo, com fila limitada.
 *
 * Existe por um caminho concreto: a verificação do artefato lê e resume a
 * árvore inteira — até 160 MiB — e acontece ANTES de qualquer reserva de
 * capacidade. O mutex que protege o início de um preview é por projeto, então
 * N projetos em paralelo produzem N leituras simultâneas de disco e N resumos
 * de hash sem que nada tenha dito que há espaço para eles. Uma conta com muitos
 * projetos derruba a máquina sem estourar nenhuma cota.
 *
 * A fila também tem teto, e isso é deliberado: uma fila infinita apenas troca
 * a saturação de CPU pela de memória, e ainda faz a pessoa esperar por um
 * trabalho que já não vai acontecer a tempo. Recusar rápido é mais honesto do
 * que enfileirar para sempre.
 */
export class Semaphore {
  #active = 0
  readonly #waiting: (() => void)[] = []

  constructor(readonly limit: number, readonly queueLimit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('INVALID_SEMAPHORE_LIMIT')
    if (!Number.isSafeInteger(queueLimit) || queueLimit < 0) throw new Error('INVALID_SEMAPHORE_QUEUE_LIMIT')
  }

  /** Quantas operações estão correndo agora. */
  get active(): number {
    return this.#active
  }

  /** Quantas estão esperando vaga. */
  get waiting(): number {
    return this.#waiting.length
  }

  /**
   * Corre a operação quando houver vaga.
   * @param operation - o trabalho caro.
   * @returns o resultado da operação.
   * @throws SemaphoreFullError quando não há vaga nem lugar na fila.
   */
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#active >= this.limit) {
      if (this.#waiting.length >= this.queueLimit) throw new SemaphoreFullError(this.limit, this.queueLimit)
      // A vaga é TRANSFERIDA para quem acorda, e por isso quem acorda não
      // incrementa: se o contador caísse a zero entre o fim de uma operação e
      // o início da próxima, uma chamada nova entraria por essa fresta e o
      // teto seria ultrapassado em um — o defeito clássico de semáforo.
      await new Promise<void>(resolve => this.#waiting.push(resolve))
    } else {
      this.#active += 1
    }
    try {
      return await operation()
    } finally {
      const next = this.#waiting.shift()
      if (next === undefined) this.#active -= 1
      else next()
    }
  }
}
