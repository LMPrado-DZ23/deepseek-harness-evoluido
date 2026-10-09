import { prompt, t } from './i18n.js'

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
    const warning = prompt('prompts.repeatedFailure', { times: String(times) })
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

/**
 * As falhas que ATRAVESSAM execuções.
 *
 * `FailureMemory` vive em memória e morre com a execução. Ela resolve o defeito
 * para o qual foi escrita — o laço de três tentativas repetindo a mesma
 * correção — e não resolve o de fora: se a tentativa de ontem falhou por um
 * motivo, e a pessoa pede uma mudança hoje, nada lembra.
 *
 * Isto é o de fora. E ele é MAIS perigoso que o de dentro, por dois motivos
 * que o desenho abaixo trata um a um:
 *
 * 1. **O tempo passa.** Uma falha de três semanas atrás pode já ter sido
 *    corrigida por outra coisa, e continuar avisando sobre ela seria mandar o
 *    gerador evitar um caminho que voltou a funcionar. Por isso a leitura é
 *    por JANELA, e a janela é de quem pergunta.
 * 2. **A conclusão é tentadora.** É fácil transformar "isto falhou três vezes"
 *    em "isto não funciona", e a segunda frase é uma REGRA. Esta memória não
 *    conclui: ela conta o que aconteceu e quantas vezes, e quem lê decide.
 */

/** Uma falha já vista neste projeto, antes desta execução. */
export interface PastFailure {
  readonly project_id: string
  readonly run_id: string
  /** O diagnóstico NORMALIZADO, que é como ele é comparado. */
  readonly diagnostic: string
  readonly created_at: string
}

/** O que a memória de falhas responde sobre uma falha. */
export interface FailureHistory {
  readonly times: number
  /** Quando ela foi vista pela última vez antes desta execução. */
  readonly lastSeenAt: string | null
  /** As execuções em que ela apareceu, da mais recente para a mais antiga. */
  readonly runs: readonly string[]
}

/**
 * Quantas vezes esta falha já apareceu ANTES, dentro da janela.
 *
 * A comparação usa a MESMA normalização de `FailureMemory`: espaço e quebra de
 * linha variam entre execuções sem que o problema mude, e nome de arquivo e
 * número NÃO são mexidos, porque dois erros que diferem só no arquivo são
 * erros diferentes.
 *
 * A execução ATUAL é excluída por identificador, e não por data: relógio de
 * máquina anda para trás, e uma falha da própria execução contada como
 * histórico faria a primeira tentativa parecer uma repetição.
 * @param past - as falhas conhecidas do projeto.
 * @param diagnostic - o diagnóstico desta tentativa.
 * @param options - a execução atual e a janela em dias.
 * @returns o histórico.
 */
export function failureHistory(
  past: readonly PastFailure[],
  diagnostic: string,
  options: { readonly currentRunId: string; readonly now: Date; readonly windowDays: number },
): FailureHistory {
  const key = FailureMemory.normalize(diagnostic)
  if (key === '') return { times: 0, lastSeenAt: null, runs: [] }
  const limit = options.now.getTime() - options.windowDays * 24 * 60 * 60 * 1000
  const matching = past
    .filter(row => row.run_id !== options.currentRunId)
    .filter(row => FailureMemory.normalize(row.diagnostic) === key)
    .filter(row => {
      const at = Date.parse(row.created_at)
      // Data ilegível é DESCARTADA e não tratada como recente: uma linha
      // corrompida virando "aconteceu agora" faria o aviso aparecer por causa
      // de um defeito de gravação.
      return Number.isFinite(at) && at >= limit
    })
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
  if (matching.length === 0) return { times: 0, lastSeenAt: null, runs: [] }
  return {
    times: matching.length,
    lastSeenAt: matching[0]!.created_at,
    // Execuções DISTINTAS: a mesma falha três vezes na mesma tentativa é um
    // laço de repetição, não três ocasiões — e contar como três faria a tela
    // dizer que o problema é mais persistente do que é.
    runs: [...new Set(matching.map(row => row.run_id))],
  }
}

/**
 * O aviso a acrescentar ao pedido, quando a falha já é velha conhecida.
 *
 * `undefined` quando ela é nova: um aviso que aparece sempre deixa de ser
 * aviso, e gastaria teto de contexto para não dizer nada.
 *
 * A frase diz QUANTAS execuções e QUANDO foi a última. Nenhuma das duas é
 * enfeite: sem a contagem, "já aconteceu" não distingue uma vez de dez; sem a
 * data, quem lê não consegue julgar se o mundo mudou desde então.
 * @param history - o histórico desta falha.
 * @returns a frase, ou `undefined`.
 */
export function crossRunWarning(history: FailureHistory): string | undefined {
  if (history.runs.length === 0 || history.lastSeenAt === null) return undefined
  return prompt('prompts.failureAcrossRuns', {
    runs: String(history.runs.length),
    when: history.lastSeenAt,
  })
}

/**
 * Quantos dias para trás a memória entre execuções olha.
 *
 * Trinta é uma escolha, e ela é sobre o MUNDO e não sobre armazenamento: uma
 * dependência que quebrou há um mês provavelmente já foi corrigida por uma
 * atualização, e avisar sobre ela mandaria o gerador evitar um caminho que
 * voltou a funcionar. Curto demais perderia a repetição que importa; longo
 * demais transforma história em superstição.
 */
export const CROSS_RUN_FAILURE_WINDOW_DAYS = 30

/**
 * A falha de uma execução anterior, como ela chega do registro.
 *
 * `failure_code` carrega ou um CÓDIGO (`STUDIO_RESTARTED_DURING_RUN`) ou o
 * DIAGNÓSTICO inteiro, dependendo de quem gravou — o nome do campo promete só
 * o primeiro. Esta memória compara o que estiver lá, e isso funciona nos dois
 * casos: dois reinícios são a mesma coisa, e dois diagnósticos iguais também.
 * O que ela não faz é fingir que o campo tem um significado só.
 */
export interface FailedRunRecord {
  readonly run_id: string
  readonly project_id: string
  readonly plan_id: string
  readonly state: string
  readonly failure_code: string | null
  readonly started_at: string
}

/**
 * As falhas passadas, tiradas das execuções do projeto.
 * @param runs - as execuções conhecidas.
 * @returns as falhas comparáveis.
 */
export function pastFailuresFrom(runs: readonly FailedRunRecord[]): readonly PastFailure[] {
  const found: PastFailure[] = []
  for (const run of runs) {
    if (run.state !== 'FAILED') continue
    if (run.failure_code === null || run.failure_code.trim() === '') continue
    found.push({
      project_id: run.project_id, run_id: run.run_id,
      diagnostic: run.failure_code, created_at: run.started_at,
    })
  }
  return found
}

/**
 * O que dizer ao gerador na PRIMEIRA tentativa, quando a última já falhou.
 *
 * A memória por criação só compara tentativas de uma mesma criação entre si —
 * é o que ela foi escrita para fazer. Esta é a outra metade: a criação de
 * ontem falhou, e a de hoje começa sem saber disso.
 *
 * A regra que decide quando avisar é o MESMO PLANO. Plano diferente significa
 * que a pessoa mudou o que pediu, e a falha antiga pode não ter mais nada a
 * ver — avisar ali seria mandar o gerador evitar um caminho que ninguém está
 * mais percorrendo. Mesmo plano e mesma falha é repetição de verdade.
 *
 * NÃO avisa sobre falha de outro projeto: um projeto não aprende com a falha
 * do vizinho, e tratar assim vazaria o diagnóstico de um inquilino para o
 * pedido de outro.
 * @param runs - as execuções do PROJETO atual.
 * @param options - o plano de agora, a execução de agora, o relógio e a janela.
 * @returns o aviso a prefixar, ou `undefined`.
 */
export function seedCorrection(
  runs: readonly FailedRunRecord[],
  options: {
    readonly projectId: string
    readonly planId: string
    readonly currentRunId: string
    readonly now: Date
    readonly windowDays: number
  },
): string | undefined {
  const mesmas = runs.filter(run => run.project_id === options.projectId && run.plan_id === options.planId)
  const past = pastFailuresFrom(mesmas)
  // A falha MAIS RECENTE é a que interessa: é ela que descreve o estado em que
  // as coisas pararam. Avisar sobre a mais antiga contaria uma história que
  // tentativas posteriores já podem ter superado.
  const latest = [...past].sort((left, right) => right.created_at.localeCompare(left.created_at))[0]
  if (latest === undefined) return undefined
  const history = failureHistory(past, latest.diagnostic, {
    currentRunId: options.currentRunId, now: options.now, windowDays: options.windowDays,
  })
  const warning = crossRunWarning(history)
  if (warning === undefined) return undefined
  return `${warning}\n${latest.diagnostic}`
}
