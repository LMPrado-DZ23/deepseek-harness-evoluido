import { t } from './i18n.js'

/**
 * FEATURE CAPABILITY REGISTRY (T-22).
 *
 * A pergunta que ninguem conseguia responder sem abrir o codigo: o que este
 * Studio, NESTA instalacao, consegue de fato fazer agora?
 *
 * O jeito obvio de responder e uma lista escrita a mao dizendo o que existe. E
 * o jeito obvio esta errado, e erra sempre do mesmo lado: uma lista escrita a
 * mao envelhece em silencio, e envelhece dizendo que SIM. Ninguem volta para
 * rebaixar uma linha quando a dependencia dela cai — entao a lista passa a ser
 * a ultima coisa a saber que algo quebrou, que e exatamente o oposto do que ela
 * existe para ser.
 *
 * Por isso NADA AQUI E DECLARADO PRONTO. O estado e DERIVADO de tres coisas que
 * ja existem em outro lugar do sistema: o codigo estar presente, as
 * dependencias estarem configuradas, e uma SONDAGEM REAL ter dado certo
 * RECENTEMENTE.
 *
 * CINCO ESTADOS, e o primeiro e o que impede a lista de mentir:
 * - `UNKNOWN`    — ninguem sondou. NAO e "provavelmente funciona".
 * - `ABSENT`     — o codigo desta capacidade nao esta nesta instalacao.
 * - `PRESENT`    — o codigo esta, e nada mais se sabe.
 * - `CONFIGURED` — as dependencias estao configuradas; ninguem exercitou.
 * - `OPERATIONAL`— uma sondagem real deu certo dentro da janela.
 */

export type CapabilityState = 'UNKNOWN' | 'ABSENT' | 'PRESENT' | 'CONFIGURED' | 'OPERATIONAL'

/**
 * Quanto tempo uma sondagem sustenta a palavra `OPERATIONAL`.
 *
 * Uma hora nao e sobre desempenho: e sobre o que uma sondagem consegue afirmar.
 * Ela prova que a capacidade funcionou NAQUELE instante, e a distancia entre
 * aquele instante e agora e a margem de erro da afirmacao. Longa demais, e
 * `OPERATIONAL` vira memoria; curta demais, a tela pisca entre dois estados a
 * cada leitura sem que nada tenha mudado.
 */
export const PROBE_FRESHNESS_MS = 60 * 60 * 1000

export interface CapabilityDeclaration {
  readonly id: string
  /** O codigo desta capacidade existe nesta instalacao? */
  readonly present: boolean
  /** As capacidades sem as quais esta nao consegue funcionar. */
  readonly requires?: readonly string[]
  /**
   * Esta capacidade TEM sondagem?
   *
   * `false` e uma afirmacao honesta e permanente: existem capacidades que
   * ninguem sabe exercitar sozinho — e elas nunca chegam a `OPERATIONAL`, em
   * vez de chegarem por nao terem sido contestadas.
   */
  readonly probed: boolean
  /** As dependencias de configuracao desta capacidade estao resolvidas? */
  readonly configured?: boolean
}

export interface ProbeResult {
  readonly capability: string
  readonly ok: boolean
  /** Quando a sondagem rodou. */
  readonly at: Date
  /** O que ela viu, para quem for conferir depois. */
  readonly detail?: string
}

export interface CapabilityStatus {
  readonly id: string
  readonly state: CapabilityState
  /** Por que ela nao esta `OPERATIONAL`, quando nao esta. */
  readonly reason?: CapabilityReason
  /** Qual dependencia a segura, quando e uma dependencia. */
  readonly blockedBy?: string
  readonly probedAt?: Date
}

export type CapabilityReason =
  | 'CODE_ABSENT'
  | 'NOT_CONFIGURED'
  | 'NO_PROBE'
  | 'NEVER_PROBED'
  | 'PROBE_FAILED'
  | 'PROBE_STALE'
  | 'DEPENDENCY'
  | 'DEPENDENCY_UNDECLARED'

const RANK: Readonly<Record<CapabilityState, number>> = {
  ABSENT: 0, UNKNOWN: 1, PRESENT: 2, CONFIGURED: 3, OPERATIONAL: 4,
}

/**
 * O estado de cada capacidade, derivado.
 *
 * A ordem das declaracoes NAO importa: uma capacidade que depende de outra
 * declarada depois dela e resolvida do mesmo jeito. Depender da ordem faria a
 * resposta mudar por causa de como alguem escreveu a lista.
 *
 * CICLO entre dependencias nao trava nem lanca: as capacidades do ciclo ficam
 * `UNKNOWN` com motivo de dependencia. Lancar derrubaria o relatorio INTEIRO
 * por causa de duas linhas mal declaradas, e o relatorio e justamente o que
 * alguem esta lendo para descobrir que algo esta errado.
 */
export function capabilityStatuses(
  declarations: readonly CapabilityDeclaration[],
  probes: readonly ProbeResult[],
  options: { readonly now: Date; readonly freshnessMs?: number },
): readonly CapabilityStatus[] {
  const freshness = options.freshnessMs ?? PROBE_FRESHNESS_MS
  const byId = new Map(declarations.map(declaration => [declaration.id, declaration] as const))
  // A sondagem MAIS RECENTE de cada capacidade. Uma antiga que deu certo nao
  // pode apagar uma nova que falhou — seria escolher a noticia boa.
  const latest = new Map<string, ProbeResult>()
  for (const probe of probes) {
    const known = latest.get(probe.capability)
    if (known === undefined || probe.at.getTime() > known.at.getTime()) latest.set(probe.capability, probe)
  }

  const resolved = new Map<string, CapabilityStatus>()
  const visiting = new Set<string>()

  function resolve(id: string): CapabilityStatus {
    const done = resolved.get(id)
    if (done !== undefined) return done
    const declaration = byId.get(id)
    if (declaration === undefined) {
      const status: CapabilityStatus = { id, state: 'UNKNOWN', reason: 'DEPENDENCY_UNDECLARED' }
      resolved.set(id, status)
      return status
    }
    if (visiting.has(id)) return { id, state: 'UNKNOWN', reason: 'DEPENDENCY', blockedBy: id }
    visiting.add(id)
    const status = derive(declaration)
    visiting.delete(id)
    resolved.set(id, status)
    return status
  }

  function derive(declaration: CapabilityDeclaration): CapabilityStatus {
    if (!declaration.present) return { id: declaration.id, state: 'ABSENT', reason: 'CODE_ABSENT' }

    // A DEPENDENCIA vem antes de tudo: uma capacidade nunca esta melhor do que
    // aquilo de que ela precisa. Sondar a camada de cima com a de baixo caida
    // produziria um `OPERATIONAL` que a proxima chamada de verdade desmente.
    for (const required of declaration.requires ?? []) {
      const dependency = resolve(required)
      if (RANK[dependency.state] < RANK.OPERATIONAL) {
        return {
          id: declaration.id,
          // A capacidade herda o estado da dependencia, e nunca um estado
          // melhor: dizer `PRESENT` quando a base esta `ABSENT` seria descrever
          // o codigo em vez de descrever o que a pessoa consegue fazer.
          state: dependency.state === 'ABSENT' ? 'PRESENT' : dependency.state === 'UNKNOWN' ? 'UNKNOWN' : dependency.state,
          reason: 'DEPENDENCY',
          blockedBy: required,
        }
      }
    }

    if (declaration.configured === false) return { id: declaration.id, state: 'PRESENT', reason: 'NOT_CONFIGURED' }
    if (!declaration.probed) return { id: declaration.id, state: 'CONFIGURED', reason: 'NO_PROBE' }

    const probe = latest.get(declaration.id)
    if (probe === undefined) return { id: declaration.id, state: 'CONFIGURED', reason: 'NEVER_PROBED' }
    if (!probe.ok) return { id: declaration.id, state: 'CONFIGURED', reason: 'PROBE_FAILED', probedAt: probe.at }
    // Sondagem do FUTURO conta como vencida, e nao como recente: um relogio
    // adiantado num computador sustentaria `OPERATIONAL` para sempre.
    const age = options.now.getTime() - probe.at.getTime()
    if (age < 0 || age > freshness) return { id: declaration.id, state: 'CONFIGURED', reason: 'PROBE_STALE', probedAt: probe.at }
    return { id: declaration.id, state: 'OPERATIONAL', probedAt: probe.at }
  }

  return declarations.map(declaration => resolve(declaration.id))
}

/**
 * Todos os motivos, para que nenhum fique sem frase por esquecimento.
 *
 * A chave e montada a partir do motivo, e uma chave que falta LANCA em tempo de
 * execucao — o portao de i18n nao ve nomes montados. Esta lista existe para o
 * teste percorre-la: e ela que transforma um esquecimento em reprovacao aqui,
 * em vez de numa excecao na tela de alguem.
 */
export const CAPABILITY_REASONS = [
  'CODE_ABSENT', 'NOT_CONFIGURED', 'NO_PROBE', 'NEVER_PROBED',
  'PROBE_FAILED', 'PROBE_STALE', 'DEPENDENCY', 'DEPENDENCY_UNDECLARED',
] as const satisfies readonly CapabilityReason[]

/** A frase que a pessoa le sobre uma capacidade que nao esta operacional. */
export function capabilityMessage(status: CapabilityStatus): string | undefined {
  if (status.state === 'OPERATIONAL') return undefined
  if (status.reason === 'DEPENDENCY' && status.blockedBy !== undefined) {
    return t('capability.DEPENDENCY', { id: status.id, blockedBy: status.blockedBy })
  }
  if (status.reason === undefined) return undefined
  return t(`capability.${status.reason}`, { id: status.id })
}

/**
 * O resumo, para quem pergunta "isto aqui funciona?".
 *
 * `unknown` sai SEPARADO de `notOperational`, e nao somado: "nao funciona" e
 * "ninguem sabe" sao respostas diferentes, e junta-las apagaria exatamente a
 * ignorancia que este registro existe para tornar visivel.
 */
export function capabilitySummary(statuses: readonly CapabilityStatus[]): {
  readonly operational: number
  readonly notOperational: number
  readonly unknown: number
} {
  return {
    operational: statuses.filter(status => status.state === 'OPERATIONAL').length,
    unknown: statuses.filter(status => status.state === 'UNKNOWN').length,
    notOperational: statuses.filter(status => status.state !== 'OPERATIONAL' && status.state !== 'UNKNOWN').length,
  }
}

/**
 * Os sinais REAIS de que o Studio dispoe, sem sondar nada de proposito.
 *
 * Tudo aqui ja e medido por outra parte do sistema — a saude das rotas, a
 * disponibilidade do construtor, os dominios abertos, a ultima criacao que
 * terminou. Medir de novo criaria uma SEGUNDA VERDADE sobre o mesmo fato, e
 * duas medidas do mesmo fato divergem no primeiro conserto de uma delas.
 */
export interface StudioSignals {
  /** A saude das rotas de modelo, como o `route-health` a registrou. */
  readonly routes: readonly { readonly route: string; readonly state: 'OK' | 'DEGRADED' | 'DOWN' | 'NOT_CONFIGURED'; readonly at?: Date }[]
  /** O ambiente isolado de construcao respondeu? `undefined` = ninguem perguntou. */
  readonly builder?: { readonly available: boolean; readonly at: Date }
  /** As criacoes que terminaram, para provar a cadeia inteira de ponta a ponta. */
  readonly lastRun?: { readonly passed: boolean; readonly at: Date }
  /** Os dominios de armazenamento que abriram nesta instalacao. */
  readonly openDomains: readonly string[]
  /** As categorias de aplicativo que esta instalacao sabe gerar. */
  readonly categories: readonly string[]
  /**
   * O instante em que estes sinais foram colhidos.
   *
   * Ele e a data da sondagem do ARMAZENAMENTO, e isso nao e um atalho: para
   * saber quais dominios abriram foi preciso perguntar ao armazenamento, agora.
   * A leitura E o exercicio. Inventar uma sondagem separada para ele faria duas
   * perguntas ao mesmo componente para responder a mesma coisa.
   */
  readonly observedAt: Date
}

/** As capacidades do Studio e de que cada uma depende. */
export const STUDIO_CAPABILITY_IDS = ['modelo', 'armazenamento', 'construtor', 'criar-aplicativo'] as const

/**
 * Traduz os sinais em declaracoes e sondagens.
 *
 * O ponto desta funcao e que ela NAO decide nada sobre estado: ela so diz o que
 * existe e o que foi observado, e quem decide continua sendo
 * `capabilityStatuses`. Misturar as duas coisas faria a regra de "sondagem
 * velha nao sustenta operacional" ter de ser repetida aqui — e uma regra
 * repetida em dois lugares e uma regra que vai divergir.
 *
 * Uma rota `NOT_CONFIGURED` NAO vira sondagem nenhuma: ela nao foi exercitada e
 * falhou, ela nunca existiu. Registra-la como falha diria que algo quebrou onde
 * o que houve foi ninguem ter configurado.
 */
export function studioCapabilities(signals: StudioSignals): {
  readonly declarations: readonly CapabilityDeclaration[]
  readonly probes: readonly ProbeResult[]
} {
  const probes: ProbeResult[] = [
    // Ter conseguido listar os dominios E a sondagem do armazenamento. Lista
    // vazia nao e falha de sondagem: e falta de configuracao, e quem diz isso e
    // o `configured` da declaracao, com a frase certa para a pessoa.
    { capability: 'armazenamento', ok: true, at: signals.observedAt, detail: signals.openDomains.join(',') },
  ]

  const usable = signals.routes.filter(route => route.state !== 'NOT_CONFIGURED')
  for (const route of usable) {
    // Sem data a observacao existe e nao tem quando: ela nao entra como
    // sondagem, porque uma sondagem sem instante nao sustenta nem vence.
    if (route.at === undefined) continue
    probes.push({ capability: 'modelo', ok: route.state === 'OK', at: route.at, detail: route.route })
  }
  if (signals.builder !== undefined) {
    probes.push({ capability: 'construtor', ok: signals.builder.available, at: signals.builder.at })
  }
  if (signals.lastRun !== undefined) {
    probes.push({ capability: 'criar-aplicativo', ok: signals.lastRun.passed, at: signals.lastRun.at })
  }

  const declarations: CapabilityDeclaration[] = [
    { id: 'armazenamento', present: true, probed: true, configured: signals.openDomains.length > 0 },
    { id: 'modelo', present: true, probed: true, configured: usable.length > 0 },
    { id: 'construtor', present: true, probed: true, configured: true },
    {
      id: 'criar-aplicativo',
      present: signals.categories.length > 0,
      probed: true,
      configured: true,
      requires: ['armazenamento', 'modelo', 'construtor'],
    },
  ]
  return { declarations, probes }
}
