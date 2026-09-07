/**
 * Serialização por chave dentro do processo.
 *
 * Por que ela existe aqui: a correção do consumo NÃO pode depender de escrita
 * condicional no armazenamento. O seam de domínio deste projeto expõe
 * `put(chave, valor)` — sem "grave só se o estado ainda for X". A condição que
 * o repositório recebe continua valendo como defesa em profundidade (e a
 * implementação em memória a honra), mas quem garante que duas confirmações ou
 * dois consumos da MESMA aprovação não se atropelam é este mutex.
 *
 * O que ele não faz: não protege contra dois PROCESSOS. Multi-instância exige
 * um lock durável — está registrado como limitação, não como resolvido.
 */
export class KeyedMutex {
  readonly #tails = new Map<string, Promise<void>>()

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => current)
    this.#tails.set(key, tail)
    await previous
    try {
      return await work()
    } finally {
      release()
      if (this.#tails.get(key) === tail) this.#tails.delete(key)
    }
  }
}
