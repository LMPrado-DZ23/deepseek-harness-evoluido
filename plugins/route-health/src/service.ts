import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { t } from './i18n.js'
import type { RouteHealthRecord, RouteState, RouteSwitchEvent } from './model.js'

export interface RouteScope { readonly orgId: string; readonly tenantId: string }
export interface RoutePrice { readonly inputPerMillion: number; readonly outputPerMillion: number }

/** O que uma rota declara saber fazer (M-03). Campo ausente = DESCONHECIDO, nunca zero nem `false`. */
export interface RouteCapability {
  readonly contextWindowTokens?: number
  readonly supportsTools?: boolean
}
/**
 * Os três perfis de rota, pelo nome que a pessoa lê.
 *
 * `privado-local`: só a IA local. Nunca cai para rota externa - se a local não
 * serve, a criação fica BLOQUEADA e a pessoa é avisada. É o C-22.
 * `equilibrado`: prefere a local; usa a rota externa configurada quando a local
 * não serve, e avisa que vai usar.
 * `melhor-qualidade`: usa a melhor rota disponível.
 */
export type RoutePrivacyProfile = 'privado-local' | 'equilibrado' | 'melhor-qualidade'

/**
 * Os dois valores do binário anterior, que continuam gravados em disco.
 *
 * Eles não são aceitos por gentileza: a versão do domínio NÃO pode subir
 * (`open()` falha com `version-mismatch` em instalação que já rodou e não
 * existe passo de migração), então o registro antigo tem de continuar legível
 * exatamente como está. `local-only` lê como `privado-local` e `any` lê como
 * `melhor-qualidade`.
 */
export type LegacyRoutePrivacy = 'local-only' | 'any'

export type RoutePrivacy = RoutePrivacyProfile | LegacyRoutePrivacy

/** Os três perfis, na ordem em que a tela os oferece. */
export const ROUTE_PRIVACY_PROFILES: readonly RoutePrivacyProfile[] = ['privado-local', 'equilibrado', 'melhor-qualidade']

/**
 * O perfil nomeado de um valor gravado, novo ou antigo.
 *
 * Toda decisão passa por aqui antes de comparar perfil: comparar com o valor
 * cru deixaria `local-only` escapando da regra do C-22 por não ser igual à
 * string nova.
 * @param value - o perfil novo ou o valor binário antigo.
 * @returns o perfil nomeado.
 */
export function routePrivacyProfile(value: RoutePrivacy): RoutePrivacyProfile {
  if (value === 'local-only') return 'privado-local'
  if (value === 'any') return 'melhor-qualidade'
  return value
}

/**
 * O funil por onde TODA escolha de rota sai.
 *
 * `privado-local` promete uma coisa só: nada sai deste computador. Antes, essa
 * promessa era um `if` no começo de `chooseRoute` - convenção, não garantia:
 * qualquer caminho novo aberto depois dele (cascata, rota explícita, circuito
 * meio-aberto, teto de gasto) devolveria uma rota externa em silêncio, e o
 * perfil só descobriria isso pelo dado já enviado. Aqui a promessa é
 * estrutural: quem não é a rota local vira bloqueio, venha de onde vier.
 * @param profile - o perfil pedido.
 * @param localRoute - a rota da IA local.
 * @param selection - a escolha que os caminhos produziram.
 * @param blockedReason - a frase do bloqueio.
 * @returns a escolha, ou o bloqueio.
 */
export function enforceRoutePrivacy(
  profile: RoutePrivacyProfile,
  localRoute: string,
  selection: RouteSelection,
  blockedReason: string,
): RouteSelection {
  if (profile !== 'privado-local') return selection
  if (selection.route === undefined || selection.route === localRoute) return selection
  return { route: undefined, explicit: selection.explicit, reason: blockedReason, reasonCode: 'LOCAL_BLOCKED' }
}
export interface RouteHealthRepository {
  routes(): readonly RouteHealthRecord[]
  events(): readonly RouteSwitchEvent[]
  putRoute(record: RouteHealthRecord): Promise<void>
  putEvent(record: RouteSwitchEvent): Promise<void>
}

/**
 * Por que esta rota foi escolhida — em duas camadas de propósito.
 *
 * `reason` é a frase de quem OPERA o Studio: ela fala de circuito, meia-abertura,
 * teto de escopo e nome de provedor, porque é isso que a tela de rotas precisa
 * dizer. Ela chegava LITERAL à primeira tela do produto, onde quem lê não
 * programa: "Meia-abertura: uma chamada decide se o circuito fecha ou reabre."
 * não diz o que aconteceu nem o que fazer.
 *
 * `reasonCode` é o mesmo fato num código estável, para a tela de quem NÃO opera
 * traduzir em efeito e próximo passo, sem depender de casar texto.
 */
export type RouteReasonCode =
  | 'PRIVATE_LOCAL' | 'LOCAL_BLOCKED' | 'EXPLICIT' | 'SAFE_READ_LOCAL' | 'FIRST_HEALTHY'
  | 'DIRECT_FALLBACK' | 'BUDGET_LOCAL' | 'BUDGET_BLOCKED' | 'HALF_OPEN' | 'ALL_OPEN'
  | 'DISABLED' | 'BALANCED_LOCAL' | 'BALANCED_EXTERNAL'

export interface RouteSelection {
  readonly route: string | undefined
  readonly explicit: boolean
  readonly reason: string
  readonly reasonCode: RouteReasonCode
}

export interface RouteSelectionOptions {
  readonly privacy: RoutePrivacy
  readonly explicitRoute?: string
}

/**
 * Quando uma rota para de ser tentada e por quanto tempo.
 *
 * `failureThreshold` conta falhas SEGUIDAS, não taxa de erro: a taxa já existe
 * em `state` e serve para apresentar saúde; o circuito serve para parar de
 * gastar a espera de quem chega depois.
 */
export interface RouteCircuitConfig {
  readonly failureThreshold: number
  readonly cooldownMs: number
}

/**
 * O teto de gasto de um escopo.
 *
 * São DOIS tetos porque só um deles seria mentira. `maxCostUsd` barra pelo
 * custo MEDIDO - requisição em rota com preço configurado. `maxUnpricedRequests`
 * barra pelo NÚMERO de requisições cujo custo ninguém sabe: tratar "não sei o
 * preço" como "gastou zero" é a mesma mentira que `unpriced_requests` acabou de
 * corrigir, e um teto que a repete permite gastar sem limite em qualquer rota
 * sem preço.
 */
export interface RouteBudgetConfig {
  readonly maxCostUsd: number
  readonly maxUnpricedRequests: number
}

/**
 * A ROTA DA IA LOCAL, num lugar só.
 *
 * Ela era escrita à mão em cada consumidor. Quem precisa dela não precisa de
 * uma cópia do nome: precisa DESTE nome — e um nome copiado é a segunda verdade
 * que diverge no primeiro conserto de uma das cópias.
 */
export const ROTA_LOCAL = 'ollama'

/** O prefixo das rotas da conexão pela linha de comando (`@dz23-studio/llm-cli`). */
export const PREFIXO_DE_LINHA = 'cli-'

/**
 * As rotas que o serviço considera, na ordem em que a primeira saudável ganha.
 *
 * A IA local vem primeiro (não cobra e não manda dado para fora). As
 * ferramentas de linha de comando vêm em seguida, antes das rotas por chave:
 * quem instalou uma delas já paga a assinatura, e a chave é o gasto novo. Só
 * entram as que o adaptador REGISTROU — uma ferramenta que não está instalada
 * não é rota que caiu.
 * @param registradas - as rotas que o runtime de modelos conhece.
 * @returns a lista ordenada.
 */
export function rotasDoServico(registradas: ReadonlySet<string>): readonly string[] {
  const deLinha = [...registradas].filter(rota => rota.startsWith(PREFIXO_DE_LINHA)).sort()
  return [ROTA_LOCAL, ...deLinha, 'omniroute', 'deepseek-official']
}

export interface RouteHealthConfig {
  readonly routes: readonly string[]
  readonly fallbackRoute: string
  readonly fallbackModel: string
  readonly localRoute: string
  readonly prices?: Readonly<Record<string, RoutePrice>>
  /**
   * O que cada rota DECLARA saber fazer (M-03): janela de contexto e suporte a
   * ferramentas.
   *
   * Declaração, e não medida, porque não há como medir a janela de um provedor
   * de fora. Rota ausente daqui fica com os dois campos ausentes no registro —
   * DESCONHECIDO — e nunca com um número inventado.
   */
  readonly capabilities?: Readonly<Record<string, RouteCapability>>
  /** Ausente = padrão da casa (`DEFAULT_ROUTE_CIRCUIT`). */
  readonly circuit?: RouteCircuitConfig
  /**
   * Ausente = SEM teto. Um número inventado aqui seria pior que nenhum: ele
   * barraria trabalho legítimo com uma autoridade que ninguém deu.
   */
  readonly budget?: RouteBudgetConfig
  readonly now?: () => Date
  readonly createId?: () => string
}

function recordId(scope: RouteScope, route: string): string {
  return `${scope.orgId}:${scope.tenantId}:${route}`
}

function isVisible(chunk: StreamChunk): boolean {
  return chunk.type === 'text-delta' || chunk.type === 'reasoning-delta'
    || chunk.type === 'tool-call-delta' || chunk.type === 'block-end'
}

function failedFinish(chunk: StreamChunk): string | undefined {
  if (chunk.type !== 'finish') return undefined
  if (chunk.reason.kind === 'error') return chunk.reason.failure.message
  if (chunk.reason.kind === 'aborted') return chunk.reason.failure.message
  return undefined
}

function safeFailureChunk(chunk: StreamChunk): StreamChunk {
  /* v8 ignore next -- internal invariant: called only after failedFinish returned a message */
  if (chunk.type !== 'finish' || (chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted')) return chunk
  return {
    ...chunk,
    reason: { ...chunk.reason, failure: { ...chunk.reason.failure, message: ROUTE_FAILURE_MESSAGE } },
  }
}

/**
 * Estado do circuito de uma rota.
 *
 * `OPEN`: falhou demais e ainda está no tempo de espera - não se tenta.
 * `HALF_OPEN`: a espera passou; UMA chamada decide se fecha ou reabre.
 * `CLOSED`: em uso normal.
 */
export type RouteCircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

/** Três falhas seguidas e trinta segundos de espera: curto o bastante para uma indisponibilidade passageira não virar apagão, longo o bastante para não repetir o erro a cada requisição. */
export const DEFAULT_ROUTE_CIRCUIT: RouteCircuitConfig = { failureThreshold: 3, cooldownMs: 30_000 }

/**
 * O estado do circuito de um registro no instante dado.
 *
 * `circuit_opened_at` é a ÚNICA fonte: ele é gravado quando as falhas seguidas
 * atingem o limite e apagado no primeiro sucesso. Registro gravado antes destes
 * campos existirem não tem o campo, e ausência significa circuito fechado.
 * @param record - o registro da rota.
 * @param now - o instante da decisão.
 * @param circuit - limite e tempo de espera.
 * @returns o estado do circuito.
 */
export function routeCircuitState(
  record: Pick<RouteHealthRecord, 'circuit_opened_at'>,
  now: Date,
  circuit: RouteCircuitConfig = DEFAULT_ROUTE_CIRCUIT,
): RouteCircuitState {
  const openedAt = record.circuit_opened_at
  if (openedAt === undefined || openedAt === null) return 'CLOSED'
  return now.getTime() - Date.parse(openedAt) < circuit.cooldownMs ? 'OPEN' : 'HALF_OPEN'
}

/** O que o teto de gasto respondeu, e por qual dos dois motivos. */
export type RouteBudgetVerdict = 'WITHIN' | 'COST_EXCEEDED' | 'UNPRICED_EXCEEDED'

export interface RouteBudgetUsage {
  readonly measuredCostUsd: number
  readonly unpricedRequests: number
  readonly verdict: RouteBudgetVerdict
}

/**
 * O gasto de um escopo e o veredito do teto.
 *
 * Só entram registros de rota PAGA: a rota local não cobra e barrá-la por
 * dinheiro seria barrar trabalho que não custa nada.
 * @param records - os registros das rotas pagas do escopo.
 * @param budget - o teto configurado, ou `undefined` para nenhum.
 * @returns custo medido, requisições sem preço e o veredito.
 */
export function routeBudgetUsage(
  records: readonly Pick<RouteHealthRecord, 'estimated_cost_usd' | 'unpriced_requests'>[],
  budget: RouteBudgetConfig | undefined,
): RouteBudgetUsage {
  let measuredCostUsd = 0
  let unpricedRequests = 0
  for (const record of records) {
    measuredCostUsd += record.estimated_cost_usd
    unpricedRequests += record.unpriced_requests ?? 0
  }
  if (budget === undefined) return { measuredCostUsd, unpricedRequests, verdict: 'WITHIN' }
  if (measuredCostUsd >= budget.maxCostUsd) return { measuredCostUsd, unpricedRequests, verdict: 'COST_EXCEEDED' }
  return unpricedRequests >= budget.maxUnpricedRequests
    ? { measuredCostUsd, unpricedRequests, verdict: 'UNPRICED_EXCEEDED' }
    : { measuredCostUsd, unpricedRequests, verdict: 'WITHIN' }
}

export class StudioRouteHealthService {
  readonly #configured = new Set<string>()
  /**
   * Requisições que já desceram a cascata uma vez.
   *
   * A chave é o próprio objeto da requisição: duas cascatas para a MESMA
   * requisição cobram duas vezes e dobram a espera de quem já estava esperando.
   */
  readonly #cascaded = new WeakSet<GenerateOptions>()

  constructor(
    private readonly repository: RouteHealthRepository,
    private readonly config: RouteHealthConfig,
  ) {}

  initialize(scope: RouteScope, configured: ReadonlySet<string>): Promise<void[]> {
    this.#configured.clear()
    for (const route of configured) this.#configured.add(route)
    return Promise.all(this.config.routes.map(route => this.repository.putRoute(this.baseRecord(
      scope, route, configured.has(route) ? 'OK' : 'NOT_CONFIGURED',
    ))))
  }

  list(scope: RouteScope): readonly RouteHealthRecord[] {
    const stored = this.repository.routes().filter(record => record.org_id === scope.orgId && record.tenant_id === scope.tenantId)
    const known = new Set(stored.map(record => record.route))
    return [
      ...stored,
      ...this.config.routes.filter(route => !known.has(route)).map(route => this.baseRecord(
        scope, route, this.#configured.has(route) ? 'OK' : 'NOT_CONFIGURED',
      )),
    ]
  }

  switches(scope: RouteScope): readonly RouteSwitchEvent[] {
    return this.repository.events().filter(event => event.org_id === scope.orgId && event.tenant_id === scope.tenantId)
  }

  /**
   * A rota escolhida para um propósito, já respeitando o perfil do escopo.
   *
   * A escolha inteira sai por `enforceRoutePrivacy`: o caminho que a produziu
   * pode mudar amanhã, a promessa do `privado-local` não.
   */
  async chooseRoute(
    scope: RouteScope,
    purpose: string,
    options: RouteSelectionOptions = { privacy: 'melhor-qualidade' },
  ): Promise<RouteSelection> {
    const profile = routePrivacyProfile(options.privacy)
    const selection = await this.select(scope, purpose, profile, options)
    return enforceRoutePrivacy(profile, this.config.localRoute, selection, LOCAL_BLOCKED_REASON)
  }

  private async select(
    scope: RouteScope,
    purpose: string,
    profile: RoutePrivacyProfile,
    options: RouteSelectionOptions,
  ): Promise<RouteSelection> {
    const local = this.get(scope, this.config.localRoute)
    // Uma rota desligada não está saudável para efeito de escolha: o desligamento
    // é uma decisão de quem opera, e ignorá-la para a rota local seria justamente
    // mandar trabalho para onde alguém pediu que não fosse.
    const localUsable = local?.state === 'OK' && this.enabled(scope, this.config.localRoute)
    /*
      A ROTA LOCAL SEM ALTERNATIVA MERECE UMA CHAMADA, e isto conserta um beco.

      `state` é taxa de erro, e serve para APRESENTAR saúde; quem manda parar de
      chamar é o CIRCUITO — está escrito em `RouteCircuitConfig`, logo acima.
      No perfil `privado-local` não existe para onde desviar, então recusar por
      `state` abandonava a rota até um sucesso que ela nunca teria chance de
      ter: uma única falha (por exemplo, a credencial que ainda não tinha sido
      guardada) deixava a instalação local sem IA PARA SEMPRE, e nenhum gesto da
      pessoa a trazia de volta. Medido em 18/09/2026, no produto montado: uma
      falha em uma requisição, `state: DOWN`, circuito FECHADO, e toda tentativa
      seguinte recusada antes de sair.

      Os outros perfis já tinham essa saída — a meia-abertura, algumas linhas
      abaixo, com o comentário que diz exatamente isto. O que faltava era ela
      aqui, onde não há segunda rota.

      O desligamento continua valendo: ele é decisão de quem opera, e não
      sintoma. O circuito ABERTO também: ali a espera existe para não gastar o
      tempo de quem chega depois. E rota NÃO CONFIGURADA não é rota que caiu:
      não há o que tentar, e tentar produziria um erro pior que a recusa.
    */
    const localTentavel = local !== undefined && local.state !== 'NOT_CONFIGURED'
      && this.enabled(scope, this.config.localRoute)
      && this.circuit(scope, this.config.localRoute) !== 'OPEN'
    if (profile === 'privado-local') {
      const localSelected = options.explicitRoute === undefined || options.explicitRoute === this.config.localRoute
      if (localSelected && localUsable) {
        return { route: this.config.localRoute, explicit: options.explicitRoute !== undefined, reason: t('reasons.privateLocalOnly'), reasonCode: 'PRIVATE_LOCAL' }
      }
      if (localSelected && localTentavel) {
        return { route: this.config.localRoute, explicit: options.explicitRoute !== undefined, reason: HALF_OPEN_REASON, reasonCode: 'HALF_OPEN' }
      }
      const reason = LOCAL_BLOCKED_REASON
      await this.auditSwitch(scope, options.explicitRoute ?? this.config.localRoute, 'blocked', reason, options.explicitRoute !== undefined)
      return { route: undefined, explicit: options.explicitRoute !== undefined, reason, reasonCode: 'LOCAL_BLOCKED' }
    }
    const explicit = options.explicitRoute !== undefined
    // O desligamento vem ANTES do teto e antes da rota escolhida a dedo: ele é a
    // decisão mais explícita que existe sobre esta rota, e uma rota desligada que
    // ainda pudesse ser pedida pelo nome não estaria desligada.
    if (options.explicitRoute !== undefined && !this.enabled(scope, options.explicitRoute)) {
      const reason = DISABLED_REASON
      await this.auditSwitch(scope, options.explicitRoute, 'blocked', reason, true)
      return { route: undefined, explicit: true, reason, reasonCode: 'DISABLED' }
    }
    // O teto vale também para a rota escolhida a dedo: um guarda que a escolha
    // explícita atravessa não é guarda, é sugestão. A rota local fica de fora
    // porque ela não cobra - o teto existe para o dinheiro, não para o trabalho.
    if (options.explicitRoute !== this.config.localRoute && this.budget(scope).verdict !== 'WITHIN') {
      const from = options.explicitRoute ?? this.config.fallbackRoute
      if (localUsable) {
        const reason = BUDGET_LOCAL_REASON
        await this.auditSwitch(scope, from, this.config.localRoute, reason, explicit)
        return { route: this.config.localRoute, explicit, reason, reasonCode: 'BUDGET_LOCAL' }
      }
      const reason = BUDGET_BLOCKED_REASON
      await this.auditSwitch(scope, from, 'blocked', reason, explicit)
      return { route: undefined, explicit, reason, reasonCode: 'BUDGET_BLOCKED' }
    }
    if (options.explicitRoute !== undefined) {
      return { route: options.explicitRoute, explicit: true, reason: t('reasons.explicitRoute'), reasonCode: 'EXPLICIT' }
    }
    // `equilibrado` prefere a local em TODO propósito, não só na leitura segura:
    // é isso que separa "prefere a local" de "usa a melhor que houver".
    if (localUsable && (profile === 'equilibrado' || purpose === 'T0')) {
      return {
        route: this.config.localRoute, explicit: false,
        reason: profile === 'equilibrado' ? BALANCED_LOCAL_REASON : t('reasons.safeReadLocal'),
        reasonCode: profile === 'equilibrado' ? 'BALANCED_LOCAL' : 'SAFE_READ_LOCAL',
      }
    }
    const known = this.config.routes.map(route => this.get(scope, route))
      .filter((record): record is RouteHealthRecord => record !== undefined && this.enabled(scope, record.route))
    const healthy = known.find(record => record.state === 'OK')
    if (healthy !== undefined) {
      // No `equilibrado` a ida para fora não é silenciosa: a pessoa pediu a
      // local e está recebendo outra coisa, e a frase diz isso.
      if (profile === 'equilibrado') {
        await this.auditSwitch(scope, this.config.localRoute, healthy.route, BALANCED_EXTERNAL_REASON, false)
        return { route: healthy.route, explicit: false, reason: BALANCED_EXTERNAL_REASON, reasonCode: 'BALANCED_EXTERNAL' }
      }
      return { route: healthy.route, explicit: false, reason: t('reasons.firstHealthy'), reasonCode: 'FIRST_HEALTHY' }
    }
    // Nenhuma rota saudável. Uma rota que caiu era simplesmente abandonada até
    // um sucesso que ela nunca teria a chance de ter; cumprido o tempo de
    // espera, ela ganha UMA chamada que decide se o circuito fecha ou reabre.
    const probe = known.find(record => this.circuit(scope, record.route) === 'HALF_OPEN')
    if (probe !== undefined) {
      await this.startProbe(probe)
      return { route: probe.route, explicit: false, reason: HALF_OPEN_REASON, reasonCode: 'HALF_OPEN' }
    }
    if (!this.enabled(scope, this.config.fallbackRoute)) {
      const reason = DISABLED_REASON
      await this.auditSwitch(scope, this.config.fallbackRoute, 'blocked', reason, false)
      return { route: undefined, explicit: false, reason, reasonCode: 'DISABLED' }
    }
    if (this.circuit(scope, this.config.fallbackRoute) === 'OPEN') {
      const reason = ALL_OPEN_REASON
      await this.auditSwitch(scope, this.config.fallbackRoute, 'blocked', reason, false)
      return { route: undefined, explicit: false, reason, reasonCode: 'ALL_OPEN' }
    }
    if (profile === 'equilibrado') {
      await this.auditSwitch(scope, this.config.localRoute, this.config.fallbackRoute, BALANCED_EXTERNAL_REASON, false)
      return { route: this.config.fallbackRoute, explicit: false, reason: BALANCED_EXTERNAL_REASON, reasonCode: 'BALANCED_EXTERNAL' }
    }
    return { route: this.config.fallbackRoute, explicit: false, reason: t('reasons.directFallback'), reasonCode: 'DIRECT_FALLBACK' }
  }

  /**
   * Se esta rota está ligada neste escopo, agora.
   *
   * Ausência do campo significa LIGADA: registro gravado antes de o
   * desligamento existir descreve um mundo em que toda rota era usada, e lê-lo
   * como desligada apagaria rotas que ninguém mandou apagar.
   */
  enabled(scope: RouteScope, route: string): boolean {
    return this.get(scope, route)?.enabled ?? true
  }

  /**
   * Liga ou desliga uma rota para um escopo.
   *
   * O desligamento é por escopo - `org_id`/`tenant_id`/rota - e nunca global:
   * desligar a rota de um locatário por decisão de outro seria o mesmo erro que
   * o circuito por escopo já evita.
   * @param scope - a organização e o locatário.
   * @param route - a rota.
   * @param enabled - `true` liga, `false` desliga.
   * @returns quando a decisão estiver gravada.
   */
  async setRouteEnabled(scope: RouteScope, route: string, enabled: boolean): Promise<void> {
    const previous = this.get(scope, route) ?? this.baseRecord(scope, route, this.#configured.has(route) ? 'OK' : 'NOT_CONFIGURED')
    await this.repository.putRoute({ ...previous, enabled, updated_at: this.clock().toISOString() })
    // A decisão fica no registro de trocas: quem lê a história das rotas vê
    // quando a pessoa ligou ou desligou, e não só o estado de agora.
    await this.auditSwitch(scope, route, enabled ? route : 'blocked', t(enabled ? 'reasons.ligadaPelaPessoa' : 'reasons.desligadaPelaPessoa'), true)
  }

  /** O estado do circuito de uma rota neste escopo, agora. */
  circuit(scope: RouteScope, route: string): RouteCircuitState {
    const record = this.get(scope, route)
    if (record === undefined) return 'CLOSED'
    return routeCircuitState(record, this.clock(), this.config.circuit ?? DEFAULT_ROUTE_CIRCUIT)
  }

  /** O gasto do escopo somando apenas as rotas pagas, e o veredito do teto. */
  budget(scope: RouteScope): RouteBudgetUsage {
    return routeBudgetUsage(
      this.list(scope).filter(record => record.route !== this.config.localRoute),
      this.config.budget,
    )
  }

  /**
   * Marca a chamada de meia-abertura reiniciando a espera.
   *
   * Sem esta marca, todas as requisições que chegassem depois do tempo de
   * espera seriam admitidas juntas: em vez de UMA tentativa decidindo, a rota
   * quebrada levaria a mesma enxurrada que o circuito abriu para evitar.
   */
  private startProbe(record: RouteHealthRecord): Promise<void> {
    return this.repository.putRoute({ ...record, circuit_opened_at: this.clock().toISOString() })
  }

  /** Um único relógio para todo o serviço: registro, auditoria e circuito têm de contar o mesmo tempo. */
  private clock(): Date {
    return this.config.now?.() ?? new Date()
  }

  async * streamWithFallback(
    scope: RouteScope,
    options: GenerateOptions,
    next: () => AsyncIterable<StreamChunk>,
    fallback: (options: GenerateOptions) => AsyncIterable<StreamChunk>,
    explicitRoute = false,
    privacy: RoutePrivacy = 'melhor-qualidade',
  ): AsyncIterable<StreamChunk> {
    const started = performance.now()
    const buffered: StreamChunk[] = []
    let visible = false
    let usage: TokenUsage | undefined
    let failure: string | undefined
    for await (const chunk of next()) {
      if (chunk.type === 'usage') usage = chunk.usage
      failure = failedFinish(chunk)
      if (!visible && isVisible(chunk)) {
        visible = true
        for (const pending of buffered) yield pending
        buffered.length = 0
      }
      const publicChunk = failure === undefined ? chunk : safeFailureChunk(chunk)
      if (visible) yield publicChunk
      else buffered.push(publicChunk)
    }
    const latency = Math.max(0, performance.now() - started)
    if (failure === undefined) {
      await this.record(scope, options.provider, true, latency, usage)
      for (const pending of buffered) yield pending
      return
    }
    await this.record(scope, options.provider, false, latency, usage, failure)
    // Uma cascata só desce quando ainda pode ajudar: nunca duas vezes para a
    // mesma requisição, nunca para uma rota que JÁ falhou nesta requisição, e
    // nunca para uma rota com o circuito aberto - as três repetiriam uma espera
    // que já se sabe perdida.
    // E nunca sob o perfil `privado-local`: a cascata leva para a rota EXTERNA
    // de propósito, e uma escolha que o C-22 barrou na entrada não pode voltar
    // pela porta dos fundos quando o modelo local falha no meio do fluxo.
    const doomed = routePrivacyProfile(privacy) === 'privado-local'
      || this.#cascaded.has(options)
      || options.provider === this.config.fallbackRoute
      || this.circuit(scope, this.config.fallbackRoute) === 'OPEN'
      || !this.enabled(scope, this.config.fallbackRoute)
    if (visible || explicitRoute || options.provider !== 'omniroute' || doomed) {
      if (!visible) for (const pending of buffered) yield pending
      return
    }
    this.#cascaded.add(options)
    await this.auditSwitch(scope, options.provider, this.config.fallbackRoute,
      t('reasons.omniRouteCascade'), false)
    const fallbackOptions: GenerateOptions = {
      ...options, provider: this.config.fallbackRoute, model: this.config.fallbackModel,
    }
    const fallbackStarted = performance.now()
    let fallbackUsage: TokenUsage | undefined
    let fallbackFailure: string | undefined
    for await (const chunk of fallback(fallbackOptions)) {
      if (chunk.type === 'usage') fallbackUsage = chunk.usage
      fallbackFailure = failedFinish(chunk)
      yield chunk
    }
    await this.record(scope, this.config.fallbackRoute, fallbackFailure === undefined,
      Math.max(0, performance.now() - fallbackStarted), fallbackUsage, fallbackFailure)
  }

  private get(scope: RouteScope, route: string): RouteHealthRecord | undefined {
    return this.repository.routes().find(record => record.record_id === recordId(scope, route))
      ?? (this.config.routes.includes(route)
        ? this.baseRecord(scope, route, this.#configured.has(route) ? 'OK' : 'NOT_CONFIGURED')
        : undefined)
  }

  private baseRecord(scope: RouteScope, route: string, state: RouteState): RouteHealthRecord {
    return {
      record_id: recordId(scope, route), org_id: scope.orgId, tenant_id: scope.tenantId,
      route, state, requests: 0, errors: 0, average_latency_ms: 0,
      input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0,
      ...this.capabilitiesOf(route),
      last_failure: null, updated_at: this.clock().toISOString(),
    }
  }

  /**
   * Os fatos declarados e derivados desta rota (M-03).
   *
   * Campo AUSENTE quando não há o que dizer: um `0` de janela seria lido como
   * "não cabe nada" e um `false` de ferramentas seria lido como "não aceita",
   * e as duas leituras são afirmações que ninguém fez.
   * @param route - o nome da rota.
   * @returns só os campos que têm resposta.
   */
  private capabilitiesOf(route: string): Partial<Pick<RouteHealthRecord, 'context_window_tokens' | 'supports_tools' | 'privacy'>> {
    const declared = this.config.capabilities !== undefined && Object.hasOwn(this.config.capabilities, route)
      ? this.config.capabilities[route]
      : undefined
    // As chaves saem SEMPRE, com `undefined` quando não há declaração. Só
    // omiti-las faria a reaplicação nunca LIMPAR: espalhadas sobre a linha
    // anterior, as chaves ausentes deixam o valor velho de pé, e uma janela de
    // contexto declarada por engano e depois removida continuaria sendo
    // afirmada para sempre. "Desconhecido" é justamente o estado que este
    // requisito insiste em preservar.
    return {
      context_window_tokens: declared?.contextWindowTokens,
      supports_tools: declared?.supportsTools,
      // Derivado do MESMO fato que bloqueia em `enforceRoutePrivacy`: ser, ou
      // não ser, a rota local. Se isto virasse configuração, alguém poderia
      // marcar uma rota externa como local e a tela mentiria sobre para onde o
      // texto da pessoa vai.
      privacy: route === this.config.localRoute ? 'local' : 'externa',
    }
  }

  private async record(
    scope: RouteScope,
    route: string,
    success: boolean,
    latencyMs: number,
    usage?: TokenUsage,
    failure?: string,
  ): Promise<void> {
    const previous = this.get(scope, route) ?? this.baseRecord(scope, route, 'OK')
    const now = this.clock().toISOString()
    const requests = previous.requests + 1
    const errors = previous.errors + (success ? 0 : 1)
    const errorRate = errors / requests
    const state: RouteState = success ? (errorRate >= 0.25 ? 'DEGRADED' : 'OK') : (errorRate >= 0.5 ? 'DOWN' : 'DEGRADED')
    const input = usage?.inputTokens ?? 0
    const output = usage?.outputTokens ?? 0
    const price = this.config.prices?.[route]
    /*
      DUAS ausências diferentes tornam o custo desconhecido, e a segunda estava
      faltando — MEDIDA em `alcance-do-adendo.spec.ts`:

      1. não há PREÇO para a rota. Já era contada.
      2. o provedor não DECLAROU uso nenhum. Não era — e este é o furo, porque
         é o mais comum: a chamada acontecia, `usage` chegava `undefined`, os
         tokens somavam 0, o custo somava 0, e o registro ficava dizendo
         "medido, custou zero" sobre uma chamada de custo inteiramente
         desconhecido. Um provedor que nunca declara uso parecia de graça, e o
         teto de dinheiro nunca disparava por ele.

      A regra do adendo é uma frase só — ausência de prova não vira prova — e
      ela vale para as duas ausências.
    */
    const semUsoDeclarado = usage === undefined
    /*
      O CUSTO não repete a condição de propósito: sem uso declarado os tokens
      já são zero, e zero vezes preço é zero. A primeira versão repetia, a
      sabotagem que a removia SOBREVIVEU — porque era código morto —, e ela
      saiu em vez de ganhar um teste que fingisse cobri-la.

      Quem carrega a ausência é `unpriced`, logo abaixo: é ELE que faz o
      registro dizer "não sei", em vez de o custo zero dizer "foi de graça".
    */
    const cost = price === undefined ? 0 : (input * price.inputPerMillion + output * price.outputPerMillion) / 1_000_000
    const unpriced = (previous.unpriced_requests ?? 0) + (price === undefined || semUsoDeclarado ? 1 : 0)
    // O circuito conta falha SEGUIDA e zera no primeiro sucesso: uma rota que
    // volta a responder volta a ser escolhida sem esperar nada. Falhar de novo
    // no limite - inclusive na chamada de meia-abertura - reabre a espera do
    // zero, em vez de deixar a rota quebrada passar por fechada.
    const consecutive = success ? 0 : (previous.consecutive_failures ?? 0) + 1
    const threshold = (this.config.circuit ?? DEFAULT_ROUTE_CIRCUIT).failureThreshold
    const openedAt = success
      ? null
      : (consecutive >= threshold ? now : previous.circuit_opened_at ?? null)
    await this.repository.putRoute({
      ...previous, state, requests, errors,
      // Os fatos declarados são reaplicados a cada gravação: uma linha gravada
      // antes de a rota declarar a janela passa a carregá-la na próxima
      // requisição, sem ninguém ter de migrar nada. E a privacidade é
      // recalculada, para uma troca da rota local não deixar uma linha antiga
      // dizendo `local` sobre uma rota que agora é externa.
      ...this.capabilitiesOf(route),
      average_latency_ms: ((previous.average_latency_ms * previous.requests) + latencyMs) / requests,
      input_tokens: previous.input_tokens + input,
      output_tokens: previous.output_tokens + output,
      estimated_cost_usd: previous.estimated_cost_usd + cost,
      unpriced_requests: unpriced,
      consecutive_failures: consecutive,
      circuit_opened_at: openedAt,
      last_failure: failure ?? previous.last_failure,
      updated_at: now,
    })
  }

  private auditSwitch(scope: RouteScope, from: string, to: string, reason: string, explicit: boolean): Promise<void> {
    const id = this.config.createId?.() ?? randomUUID()
    return this.repository.putEvent({
      event_id: id, org_id: scope.orgId, tenant_id: scope.tenantId,
      from_route: from, to_route: to, reason, explicit_route: explicit,
      created_at: this.clock().toISOString(),
    })
  }
}

/**
 * As frases do circuito, do teto, do desligamento e do perfil equilibrado.
 *
 * Elas vivem no catálogo `i18n/pt-BR.json` deste plugin, como todo texto que a
 * pessoa lê. Antes ficavam aqui, escritas SEM ACENTO para escapar do portão de
 * i18n — o que deixava o portão verde sem que uma única frase estivesse
 * traduzível. Com o catálogo, o plugin passou a ser `strict` no portão: nenhum
 * literal em português volta a este diretório sem reprovar.
 */
const BUDGET_LOCAL_REASON = t('reasons.budgetLocal')
const BUDGET_BLOCKED_REASON = t('reasons.budgetBlocked')
const HALF_OPEN_REASON = t('reasons.halfOpen')
const ALL_OPEN_REASON = t('reasons.allOpen')
const DISABLED_REASON = t('reasons.disabled')
const BALANCED_LOCAL_REASON = t('reasons.balancedLocal')
const BALANCED_EXTERNAL_REASON = t('reasons.balancedExternal')

/**
 * A frase do bloqueio do `privado-local`.
 *
 * Ela é a MESMA em toda saída barrada - local fora do ar, local desligada, rota
 * externa pedida pelo nome, rota que algum caminho novo tentou devolver - porque
 * para quem lê o fato é um só: nada foi enviado para fora.
 */
const LOCAL_BLOCKED_REASON = t('reasons.localBlocked')

export const ROUTE_FAILURE_MESSAGE = t('errors.routeFailure')

/**
 * O que se pode honestamente dizer sobre o custo de uma rota.
 *
 * `UNKNOWN`: nenhuma requisição tinha preço - o número somado é zero porque
 * ninguém sabia, não porque nada foi gasto.
 * `PARTIAL`: parte teve preço; o valor é um piso, não o total.
 * `MEASURED`: toda requisição contada tinha preço configurado.
 */
export type RouteCostState = 'MEASURED' | 'PARTIAL' | 'UNKNOWN'

/**
 * Classifica o custo de uma rota pelo que realmente se sabe.
 * @param record - o registro da rota.
 * @returns o estado do custo, para quem for apresentar o número.
 */
export function routeCostState(record: Pick<RouteHealthRecord, 'requests' | 'unpriced_requests'>): RouteCostState {
  const unpriced = record.unpriced_requests ?? 0
  if (record.requests === 0 || unpriced === 0) return 'MEASURED'
  return unpriced >= record.requests ? 'UNKNOWN' : 'PARTIAL'
}
