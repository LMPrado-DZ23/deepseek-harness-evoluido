import { t } from './i18n.js'

/**
 * O que já falhou nesta criação, e quantas vezes.
 *
 * Existe por um defeito concreto do laço de tentativas: ele repete até três
 * vezes passando ao gerador o MESMO diagnóstico da vez anterior. Quando a
 * primeira e a segunda tentativa falham pelo mesmo motivo, a terceira pede
 * exatamente a mesma correção — mesma falha, mesma estratégia — e a única
 * coisa garantida é o gasto.
 *
 * A resposta NÃO é parar. Geração por modelo é não determinística, e uma
 * terceira tentativa pode acertar; interromper por conta própria tiraria da
 * pessoa uma chance que era dela. A resposta é MUDAR O PEDIDO: dizer ao
 * gerador que aquela correção já foi tentada e produziu o mesmo resultado, e
 * que insistir na mesma abordagem é o que não pode acontecer de novo.
 *
 * É memória de FALHA, no sentido estrito: guarda o que aconteceu, não conclui
 * nada sobre o que vai acontecer.
 */
export class FailureMemory {
  readonly #seen = new Map<string, number>()
  /**
   * Os avisos que ESTA memória já emitiu.
   *
   * Existe porque um gerador pode devolver, no erro, parte do que recebeu — o
   * teste do laço de repetição faz exatamente isso, e foi ele que pegou o
   * defeito. Sem remover o próprio aviso antes de registrar, duas coisas
   * quebram: a pessoa lê na mensagem de falha uma INSTRUÇÃO escrita para o
   * modelo, e a contagem de repetição nunca mais casa, porque a falha da
   * terceira tentativa carrega um prefixo que a da segunda não tinha.
   */
  readonly #warnings = new Set<string>()

  /**
   * Normaliza um diagnóstico para comparação.
   *
   * Espaços e quebras de linha variam entre execuções sem que o problema mude;
   * compará-los cru faria duas ocorrências da MESMA falha parecerem
   * diferentes, e a repetição passaria despercebida. O que a normalização NÃO
   * faz é mexer em palavra, número ou caminho de arquivo — dois erros que
   * diferem só no nome do arquivo são erros diferentes, e juntá-los criaria
   * uma falsa repetição que levaria a mudar de estratégia sem motivo.
   * @param diagnostic - o texto do diagnóstico.
   * @returns a forma comparável.
   */
  static normalize(diagnostic: string): string {
    return diagnostic.replace(/\s+/gu, ' ').trim()
  }

  /**
   * O diagnóstico sem os avisos que esta memória colocou nele.
   *
   * Público porque quem guarda a falha para MOSTRAR à pessoa também precisa
   * dele: um gerador que devolva no erro parte do que recebeu faria a pessoa
   * ler, na mensagem de falha, uma instrução escrita para o modelo.
   * @param diagnostic - o texto recebido.
   * @returns só a falha, sem a instrução de estratégia.
   */
  rawOf(diagnostic: string): string {
    return this.#raw(diagnostic)
  }

  #raw(diagnostic: string): string {
    let text = diagnostic
    for (const warning of this.#warnings) {
      if (text.startsWith(`${warning}\n`)) text = text.slice(warning.length + 1)
    }
    return text
  }

  /**
   * Registra uma falha.
   * @param diagnostic - o diagnóstico da tentativa que falhou.
   * @returns quantas vezes esta falha já foi vista, contando esta.
   */
  record(diagnostic: string): number {
    const key = FailureMemory.normalize(this.#raw(diagnostic))
    if (key === '') return 0
    const times = (this.#seen.get(key) ?? 0) + 1
    this.#seen.set(key, times)
    return times
  }

  /**
   * Quantas vezes esta falha já apareceu.
   * @param diagnostic - o diagnóstico.
   * @returns a contagem, zero quando é nova.
   */
  timesSeen(diagnostic: string): number {
    return this.#seen.get(FailureMemory.normalize(this.#raw(diagnostic))) ?? 0
  }

  /**
   * A correção a pedir na próxima tentativa.
   *
   * Igual ao diagnóstico enquanto a falha for nova. Quando ela já se repetiu,
   * o texto ganha na frente o aviso de que aquela mesma correção já foi pedida
   * e deu no mesmo — que é a diferença entre tentar de novo e tentar de outro
   * jeito.
   * @param diagnostic - o diagnóstico da tentativa anterior, ou `undefined` na primeira.
   * @returns o que mandar ao gerador.
   */
  correctionFor(diagnostic: string | undefined): string | undefined {
    if (diagnostic === undefined) return undefined
    const raw = this.#raw(diagnostic)
    const times = this.timesSeen(raw)
    if (times < 2) return raw
    const warning = t('prompts.repeatedFailure', { times: String(times) })
    this.#warnings.add(warning)
    return `${warning}\n${raw}`
  }

  /** As falhas registradas, da mais repetida para a menos, para o relato. */
  entries(): readonly { readonly diagnostic: string; readonly times: number }[] {
    return [...this.#seen.entries()]
      .map(([diagnostic, times]) => ({ diagnostic, times }))
      .sort((left, right) => right.times - left.times || left.diagnostic.localeCompare(right.diagnostic))
  }
}
