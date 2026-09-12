/**
 * LEARNING ENGINE — com validacao ANTES de virar regra (T-20).
 *
 * Esta e a memoria PROCEDIMENTAL que o mapa de memorias (OS-60) declarou
 * AUSENTE de proposito, e o motivo daquela ausencia e o desenho inteiro deste
 * arquivo: uma memoria que conclui O QUE FUNCIONA e a que mais facilmente vira
 * supersticao. Duas coincidencias viram regra, a regra e escrita num prompt, e
 * um agente passa a segui-la — sem que ninguem nunca tenha perguntado se ela e
 * verdade.
 *
 * O erro que este arquivo existe para impedir tem nome: CONFIRMACAO. Olhar so
 * para os casos em que a regra deu certo e encontrar a regra confirmada sempre.
 * Por isso a validacao aqui NAO e "quantas vezes funcionou": e quantas vezes
 * funcionou CONTRA quantas vezes a mesma condicao esteve presente e NAO
 * funcionou. Sem o segundo numero, o primeiro nao significa nada.
 *
 * QUATRO PORTOES, e nenhum deles e opcional:
 * 1. REPETICAO INDEPENDENTE — ocasioes diferentes, e nao repeticoes dentro da
 *    mesma; tres tentativas do mesmo laco sao UMA observacao.
 * 2. CONTRAPROVA EXAMINADA — tem de existir caso onde a condicao estava la e o
 *    desfecho foi outro, OU a busca por ele tem de ter sido feita e vazia. Uma
 *    regra que nunca foi contestada nao esta validada: esta incontestada.
 * 3. TAXA DE ERRO ABAIXO DO TETO — uma regra que erra um terco das vezes ainda
 *    e uma correlacao, e nao uma regra.
 * 4. VALIDADE — regra validada sobre dado velho volta a ser candidata. O mundo
 *    muda, e uma regra sobre bibliotecas de dois anos atras e arqueologia.
 */

/** Uma observacao: nesta ocasiao, a condicao estava presente e o desfecho foi este. */
export interface Observation {
  /** O que se observou — a condicao mais o desfecho, como identificador. */
  readonly pattern: string
  /** A OCASIAO: execucao, projeto, o que for. Repeticoes dentro dela contam uma vez. */
  readonly occasion: string
  /** A condicao levou ao desfecho esperado nesta ocasiao? */
  readonly held: boolean
  readonly at: Date
}

export type RuleStatus = 'CANDIDATE' | 'VALIDATED' | 'REFUTED' | 'EXPIRED'

export interface Rule {
  readonly pattern: string
  readonly status: RuleStatus
  /** Em quantas OCASIOES distintas a regra valeu. */
  readonly supporting: number
  /** Em quantas OCASIOES distintas a condicao estava la e a regra NAO valeu. */
  readonly contradicting: number
  /** Por que ela ainda nao e regra, quando nao e. */
  readonly reason?: RuleReason
  /** A observacao mais recente que a sustenta. */
  readonly lastSeen: Date
}

export type RuleReason =
  | 'TOO_FEW_OCCASIONS'
  | 'NEVER_CHALLENGED'
  | 'ERROR_RATE'
  | 'STALE'

/**
 * Quantas ocasioes distintas antes de uma observacao poder virar regra.
 *
 * Tres, e nao duas: com duas, a segunda coincidencia JA e a regra, e nao existe
 * nenhuma observacao que possa contradize-la antes de ela nascer. Com tres, a
 * terceira observacao e uma chance real de a regra morrer antes de ser escrita.
 */
export const MIN_OCCASIONS = 3

/**
 * A fracao maxima de ocasioes em que a regra pode ter falhado.
 *
 * Vinte por cento. Acima disso o que existe e uma CORRELACAO, e chamar uma
 * correlacao de regra e exatamente o passo que transforma memoria em
 * supersticao — porque quem le a regra depois nao ve a taxa, ve a regra.
 */
export const MAX_ERROR_RATE = 0.2

/**
 * Por quanto tempo uma validacao continua valendo.
 *
 * Noventa dias porque o objeto destas regras e um mundo que muda: versoes de
 * biblioteca, comportamento de modelo, template do proprio Studio. Uma regra
 * validada sobre o mundo de tres meses atras nao esta errada — ela esta sem
 * evidencia atual, que e coisa diferente, e por isso ela VOLTA A SER CANDIDATA
 * em vez de ser apagada.
 */
export const VALIDATION_WINDOW_DAYS = 90

/**
 * Deriva as regras das observacoes.
 *
 * `challengedPatterns` e a parte que impede a confirmacao: um padrao so pode
 * ser validado se alguem PROCUROU contraprova para ele. Sem essa lista, um
 * padrao com dez acertos e zero erros e indistinguivel de um padrao com dez
 * acertos onde ninguem olhou para os erros — e os dois casos merecem respostas
 * opostas.
 */
export function deriveRules(
  observations: readonly Observation[],
  options: {
    readonly now: Date
    readonly challengedPatterns: readonly string[]
    readonly minOccasions?: number
    readonly maxErrorRate?: number
    readonly windowDays?: number
  },
): readonly Rule[] {
  const minOccasions = options.minOccasions ?? MIN_OCCASIONS
  const maxErrorRate = options.maxErrorRate ?? MAX_ERROR_RATE
  const windowMs = (options.windowDays ?? VALIDATION_WINDOW_DAYS) * 24 * 60 * 60 * 1000
  const challenged = new Set(options.challengedPatterns)

  // Por PADRAO, e dentro dele por OCASIAO. Tres falhas na mesma execucao sao um
  // laco de repeticao, e conta-las como tres diria que a evidencia e mais forte
  // do que e — o mesmo raciocinio da memoria de falha na OS-60.
  const byPattern = new Map<string, Map<string, { held: boolean; at: Date }>>()
  for (const observation of observations) {
    const occasions = byPattern.get(observation.pattern) ?? new Map()
    const known = occasions.get(observation.occasion)
    // Dentro de uma ocasiao, uma contradicao PESA MAIS que uma confirmacao: se
    // a condicao esteve presente e o desfecho falhou uma vez ali, a regra nao
    // valeu naquela ocasiao. Deixar a confirmacao sobrescrever seria escolher a
    // noticia boa dentro do proprio dado.
    if (known === undefined || (known.held && !observation.held)) {
      occasions.set(observation.occasion, { held: observation.held, at: observation.at })
    } else if (observation.at.getTime() > known.at.getTime()) {
      occasions.set(observation.occasion, { held: known.held, at: observation.at })
    }
    byPattern.set(observation.pattern, occasions)
  }

  const rules: Rule[] = []
  for (const [pattern, occasions] of byPattern) {
    const entries = [...occasions.values()]
    const supporting = entries.filter(entry => entry.held).length
    const contradicting = entries.length - supporting
    const lastSeen = entries.reduce((latest, entry) => (entry.at.getTime() > latest.getTime() ? entry.at : latest), entries[0]!.at)
    const errorRate = entries.length === 0 ? 1 : contradicting / entries.length

    // A REFUTACAO vem antes de tudo, e antes ate da contagem minima: um padrao
    // que ja falhou mais do que acertou nao precisa de mais amostra para nao
    // virar regra, e mante-lo como candidato faria uma lista de candidatos
    // crescer com coisas que ja se sabe que nao valem.
    if (contradicting > supporting) {
      rules.push({ pattern, status: 'REFUTED', supporting, contradicting, reason: 'ERROR_RATE', lastSeen })
      continue
    }
    if (entries.length < minOccasions) {
      rules.push({ pattern, status: 'CANDIDATE', supporting, contradicting, reason: 'TOO_FEW_OCCASIONS', lastSeen })
      continue
    }
    if (!challenged.has(pattern)) {
      // Incontestada NAO e validada. Esta e a linha que separa aprender de
      // confirmar, e ela e a unica do arquivo que nenhuma quantidade de
      // evidencia a favor consegue satisfazer.
      rules.push({ pattern, status: 'CANDIDATE', supporting, contradicting, reason: 'NEVER_CHALLENGED', lastSeen })
      continue
    }
    if (errorRate > maxErrorRate) {
      rules.push({ pattern, status: 'CANDIDATE', supporting, contradicting, reason: 'ERROR_RATE', lastSeen })
      continue
    }
    // Observacao do FUTURO nao sustenta: um relogio adiantado manteria a regra
    // validada para sempre.
    const age = options.now.getTime() - lastSeen.getTime()
    if (age < 0 || age > windowMs) {
      rules.push({ pattern, status: 'EXPIRED', supporting, contradicting, reason: 'STALE', lastSeen })
      continue
    }
    rules.push({ pattern, status: 'VALIDATED', supporting, contradicting, lastSeen })
  }
  return rules
}

/**
 * As regras que podem ser ESCRITAS num prompt.
 *
 * So as validadas. Candidata e refutada nunca saem daqui, e a razao e a unica
 * que importa neste arquivo: o que sai por esta funcao vira instrucao que um
 * agente vai seguir, e uma instrucao nao carrega consigo o aviso de que era so
 * uma hipotese.
 */
export function applicableRules(rules: readonly Rule[]): readonly Rule[] {
  return rules.filter(rule => rule.status === 'VALIDATED')
}

/**
 * O que a regra diz, com a evidencia GRUDADA nela.
 *
 * Os dois numeros vao junto de proposito. Uma regra sem eles pede obediencia;
 * uma regra com eles pede julgamento — e quem le pode discordar dela, que e
 * exatamente o que se quer de uma coisa aprendida por contagem.
 */
export function ruleEvidence(rule: Rule): string {
  return `${rule.pattern} (${rule.supporting}/${rule.supporting + rule.contradicting})`
}

/**
 * Uma execucao terminada, como o registro a guarda.
 *
 * So o que o aprendizado precisa: quando, de que projeto, em que tentativa, se
 * passou, e o que falhou quando nao passou.
 */
export interface ObservedRun {
  readonly project_id: string
  readonly run_id: string
  readonly operation_id: string
  readonly attempt: number
  readonly state: string
  readonly failure_code: string | null
  readonly finished_at: string | null
  readonly started_at: string
}

/**
 * O que o pipeline consegue observar sem inventar nada.
 *
 * O padrao e `recuperou:<falha>`: a condicao e uma tentativa ter falhado com
 * aquela assinatura, e o desfecho e a criacao ter CHEGADO a passar depois. E a
 * unica coisa util que o registro sabe responder sozinho — e ela e util de
 * verdade, porque a pergunta "vale a pena tentar de novo depois desta falha?"
 * e a que decide gastar ou nao a proxima tentativa.
 *
 * A OCASIAO e a operacao inteira, e nao a tentativa: tres tentativas da mesma
 * criacao sao um laco de repeticao, e conta-las como tres diria que a evidencia
 * e mais forte do que e — a mesma regra da memoria de falha na OS-60.
 *
 * O DESFECHO e por operacao: se ALGUMA tentativa daquela operacao passou depois
 * da falha, a recuperacao valeu ali. Marcar cada tentativa separadamente faria
 * a tentativa 2 que falhou contar contra uma criacao que a 3 salvou.
 */
export function observationsFrom(
  runs: readonly ObservedRun[],
  options: { readonly now: Date; readonly windowDays?: number },
): { readonly observations: readonly Observation[]; readonly challenged: readonly string[] } {
  const windowMs = (options.windowDays ?? VALIDATION_WINDOW_DAYS) * 24 * 60 * 60 * 1000
  // Por OPERACAO: qual falha apareceu nela, e se ela chegou a passar.
  const byOperation = new Map<string, { failures: Set<string>; passed: boolean; at: Date; project: string }>()
  for (const run of runs) {
    if (run.state !== 'PASSED' && run.state !== 'FAILED') continue
    const at = new Date(run.finished_at ?? run.started_at)
    if (Number.isNaN(at.getTime())) continue
    const age = options.now.getTime() - at.getTime()
    // Fora da janela, ou do FUTURO: um relogio adiantado sustentaria uma regra
    // para sempre, e uma falha de meses atras ja pode ter sido corrigida.
    if (age < 0 || age > windowMs) continue
    const known = byOperation.get(run.operation_id)
      ?? { failures: new Set<string>(), passed: false, at, project: run.project_id }
    if (run.state === 'PASSED') known.passed = true
    else if (run.failure_code !== null && run.failure_code.length > 0) known.failures.add(run.failure_code)
    if (at.getTime() > known.at.getTime()) known.at = at
    byOperation.set(run.operation_id, known)
  }

  const observations: Observation[] = []
  const patterns = new Set<string>()
  for (const [operation, info] of byOperation) {
    for (const failure of info.failures) {
      const pattern = `recuperou:${failure}`
      patterns.add(pattern)
      // A ocasiao carrega o PROJETO: um projeto nao aprende com a operacao do
      // vizinho, e o identificador da operacao ja e unico — o projeto entra
      // para que quem ler a ocasiao saiba de onde ela veio.
      observations.push({ pattern, occasion: `${info.project}/${operation}`, held: info.passed, at: info.at })
    }
  }
  // A CONTRAPROVA foi PROCURADA porque esta leitura percorreu a janela INTEIRA,
  // sem filtrar por desfecho: toda ocasiao em que a condicao apareceu entrou,
  // tenha ela dado certo ou errado. E isso, e so isso, que `challengedPatterns`
  // quer dizer — e um leitor futuro que consultasse so os sucessos
  // simplesmente nao poderia declarar nada aqui.
  return { observations, challenged: [...patterns] }
}
