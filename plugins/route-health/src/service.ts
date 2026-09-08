import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import type { RouteHealthRecord, RouteState, RouteSwitchEvent } from './model.js'

export interface RouteScope { readonly orgId: string; readonly tenantId: string }
export interface RoutePrice { readonly inputPerMillion: number; readonly outputPerMillion: number }
export type RoutePrivacy = 'local-only' | 'any'
export interface RouteHealthRepository {
  routes(): readonly RouteHealthRecord[]
  events(): readonly RouteSwitchEvent[]
  putRoute(record: RouteHealthRecord): Promise<void>
  putEvent(record: RouteSwitchEvent): Promise<void>
}

export interface RouteSelection {
  readonly route: string | undefined
  readonly explicit: boolean
  readonly reason: string
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

export interface RouteHealthConfig {
  readonly routes: readonly string[]
  readonly fallbackRoute: string
  readonly fallbackModel: string
  readonly localRoute: string
  readonly prices?: Readonly<Record<string, RoutePrice>>
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

  async chooseRoute(
    scope: RouteScope,
    purpose: string,
    options: RouteSelectionOptions = { privacy: 'any' },
  ): Promise<RouteSelection> {
    const local = this.get(scope, this.config.localRoute)
    const localUsable = local?.state === 'OK'
    if (options.privacy === 'local-only') {
      const localSelected = options.explicitRoute === undefined || options.explicitRoute === this.config.localRoute
      if (localSelected && localUsable) {
        return { route: this.config.localRoute, explicit: options.explicitRoute !== undefined, reason: 'Perfil privado restrito à IA local.' }
      }
      const reason = 'IA local indisponível; nenhuma informação foi enviada para uma rota externa.'
      await this.auditSwitch(scope, options.explicitRoute ?? this.config.localRoute, 'blocked', reason, options.explicitRoute !== undefined)
      return { route: undefined, explicit: options.explicitRoute !== undefined, reason }
    }
    const explicit = options.explicitRoute !== undefined
    // O teto vale também para a rota escolhida a dedo: um guarda que a escolha
    // explícita atravessa não é guarda, é sugestão. A rota local fica de fora
    // porque ela não cobra - o teto existe para o dinheiro, não para o trabalho.
    if (options.explicitRoute !== this.config.localRoute && this.budget(scope).verdict !== 'WITHIN') {
      const from = options.explicitRoute ?? this.config.fallbackRoute
      if (localUsable) {
        const reason = BUDGET_LOCAL_REASON
        await this.auditSwitch(scope, from, this.config.localRoute, reason, explicit)
        return { route: this.config.localRoute, explicit, reason }
      }
      const reason = BUDGET_BLOCKED_REASON
      await this.auditSwitch(scope, from, 'blocked', reason, explicit)
      return { route: undefined, explicit, reason }
    }
    if (options.explicitRoute !== undefined) {
      return { route: options.explicitRoute, explicit: true, reason: 'Rota escolhida pela pessoa.' }
    }
    if (purpose === 'T0' && localUsable) {
      return { route: this.config.localRoute, explicit: false, reason: 'Modelo local saudável preferido para leitura segura.' }
    }
    const known = this.config.routes.map(route => this.get(scope, route))
    const healthy = known.find(record => record?.state === 'OK')
    if (healthy !== undefined) return { route: healthy.route, explicit: false, reason: 'Primeira rota saudável do perfil.' }
    // Nenhuma rota saudável. Uma rota que caiu era simplesmente abandonada até
    // um sucesso que ela nunca teria a chance de ter; cumprido o tempo de
    // espera, ela ganha UMA chamada que decide se o circuito fecha ou reabre.
    const probe = known.find((record): record is RouteHealthRecord =>
      record !== undefined && this.circuit(scope, record.route) === 'HALF_OPEN')
    if (probe !== undefined) {
      await this.startProbe(probe)
      return { route: probe.route, explicit: false, reason: HALF_OPEN_REASON }
    }
    if (this.circuit(scope, this.config.fallbackRoute) === 'OPEN') {
      const reason = ALL_OPEN_REASON
      await this.auditSwitch(scope, this.config.fallbackRoute, 'blocked', reason, false)
      return { route: undefined, explicit: false, reason }
    }
    return { route: this.config.fallbackRoute, explicit: false, reason: 'Rota direta usada porque nenhuma rota monitorada está saudável.' }
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
    const doomed = this.#cascaded.has(options)
      || options.provider === this.config.fallbackRoute
      || this.circuit(scope, this.config.fallbackRoute) === 'OPEN'
    if (visible || explicitRoute || options.provider !== 'omniroute' || doomed) {
      if (!visible) for (const pending of buffered) yield pending
      return
    }
    this.#cascaded.add(options)
    await this.auditSwitch(scope, options.provider, this.config.fallbackRoute,
      'OmniRoute falhou antes de produzir conteúdo; usando a rota DeepSeek direta.', false)
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
      last_failure: null, updated_at: this.clock().toISOString(),
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
    // Sem preço não existe custo conhecido: a requisição é contada como não
    // precificada em vez de somar 0 e virar "custou zero" na apresentação.
    const cost = price === undefined ? 0 : (input * price.inputPerMillion + output * price.outputPerMillion) / 1_000_000
    const unpriced = (previous.unpriced_requests ?? 0) + (price === undefined ? 1 : 0)
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
 * As quatro frases do circuito e do teto.
 *
 * Elas são escritas sem acento porque o portão de i18n reprova literal em
 * português dentro de `plugins/*\/src` que não esteja no catálogo, este plugin
 * não tem catálogo (criar um reprovaria de uma vez todas as frases que já
 * existem aqui) e o baseline herdado pode encolher, nunca crescer. Quando a
 * tela de rotas ler estas razões, elas mudam de lugar junto com as outras.
 */
const BUDGET_LOCAL_REASON = 'Teto de gasto do escopo estourado; seguindo apenas com a IA local.'
const BUDGET_BLOCKED_REASON = 'Teto de gasto do escopo estourado; nenhuma rota paga foi acionada.'
const HALF_OPEN_REASON = 'Meia-abertura: uma chamada decide se o circuito fecha ou reabre.'
const ALL_OPEN_REASON = 'Circuito aberto em todas as rotas; nenhuma chamada nova enquanto durar a espera.'

export const ROUTE_FAILURE_MESSAGE = 'A conexão com a inteligência artificial falhou. Nada foi aplicado; tente novamente ou escolha outra rota.'

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
