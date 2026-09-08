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

export interface RouteHealthConfig {
  readonly routes: readonly string[]
  readonly fallbackRoute: string
  readonly fallbackModel: string
  readonly localRoute: string
  readonly prices?: Readonly<Record<string, RoutePrice>>
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

export class StudioRouteHealthService {
  readonly #configured = new Set<string>()

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
    if (options.privacy === 'local-only') {
      const localSelected = options.explicitRoute === undefined || options.explicitRoute === this.config.localRoute
      if (localSelected && local?.state === 'OK') {
        return { route: this.config.localRoute, explicit: options.explicitRoute !== undefined, reason: 'Perfil privado restrito à IA local.' }
      }
      const reason = 'IA local indisponível; nenhuma informação foi enviada para uma rota externa.'
      await this.auditSwitch(scope, options.explicitRoute ?? this.config.localRoute, 'blocked', reason, options.explicitRoute !== undefined)
      return { route: undefined, explicit: options.explicitRoute !== undefined, reason }
    }
    if (options.explicitRoute !== undefined) {
      return { route: options.explicitRoute, explicit: true, reason: 'Rota escolhida pela pessoa.' }
    }
    if (purpose === 'T0' && local?.state === 'OK') {
      return { route: this.config.localRoute, explicit: false, reason: 'Modelo local saudável preferido para leitura segura.' }
    }
    const healthy = this.config.routes.map(route => this.get(scope, route))
      .find(record => record?.state === 'OK')
    return healthy === undefined
      ? { route: this.config.fallbackRoute, explicit: false, reason: 'Rota direta usada porque nenhuma rota monitorada está saudável.' }
      : { route: healthy.route, explicit: false, reason: 'Primeira rota saudável do perfil.' }
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
    if (visible || explicitRoute || options.provider !== 'omniroute') {
      if (!visible) for (const pending of buffered) yield pending
      return
    }
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
      last_failure: null, updated_at: (this.config.now?.() ?? new Date()).toISOString(),
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
    await this.repository.putRoute({
      ...previous, state, requests, errors,
      average_latency_ms: ((previous.average_latency_ms * previous.requests) + latencyMs) / requests,
      input_tokens: previous.input_tokens + input,
      output_tokens: previous.output_tokens + output,
      estimated_cost_usd: previous.estimated_cost_usd + cost,
      unpriced_requests: unpriced,
      last_failure: failure ?? previous.last_failure,
      updated_at: (this.config.now?.() ?? new Date()).toISOString(),
    })
  }

  private auditSwitch(scope: RouteScope, from: string, to: string, reason: string, explicit: boolean): Promise<void> {
    const id = this.config.createId?.() ?? randomUUID()
    return this.repository.putEvent({
      event_id: id, org_id: scope.orgId, tenant_id: scope.tenantId,
      from_route: from, to_route: to, reason, explicit_route: explicit,
      created_at: (this.config.now?.() ?? new Date()).toISOString(),
    })
  }
}

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
