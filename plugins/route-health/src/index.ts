import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { authenticatedMutation, type StudioIdentityService } from '@dz23-studio/identity'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  studioRouteHealthDomainSpec,
  type RouteEventKey,
  type RouteHealthKey,
  type RouteHealthRecord,
  type RouteSwitchEvent,
} from './model.js'
import { ROTA_LOCAL, rotasDoServico, StudioRouteHealthService, type RoutePrivacy, type RouteHealthRepository, type RouteScope } from './service.js'
import { t } from './i18n.js'

export * from './model.js'
export * from './service.js'

export const name = 'dz23-studio-route-health'
export const inject = ['llm', 'storageDomain', 'studioIdentity', 'webServer']

export interface StudioRouteHealthRuntime {
  readonly service: StudioRouteHealthService
  markExplicit(options: GenerateOptions): GenerateOptions
  markScope(options: GenerateOptions, scope: RouteScope): GenerateOptions
  /**
   * Diz a esta requisição qual perfil a escolheu.
   *
   * Sem esta marca, a cascata do `streamWithFallback` não teria como saber que
   * a requisição nasceu de um perfil `privado-local` e desceria para a rota
   * externa quando o modelo local falhasse - o C-22 quebrado no meio do fluxo,
   * depois de a escolha já ter sido feita corretamente.
   */
  markPrivacy(options: GenerateOptions, privacy: RoutePrivacy): GenerateOptions
}

declare module '@deepseek-ai/cordis' {
  interface Context { studioRouteHealth: StudioRouteHealthRuntime }
}

class DomainRouteRepository implements RouteHealthRepository {
  constructor(
    private readonly routesTable: KvTable<RouteHealthKey, RouteHealthRecord>,
    private readonly eventsTable: KvTable<RouteEventKey, RouteSwitchEvent>,
  ) {}
  routes() { return [...this.routesTable.entries()].map(([, value]) => value) }
  events() { return [...this.eventsTable.entries()].map(([, value]) => value) }
  putRoute(value: RouteHealthRecord) { return this.routesTable.put(value.record_id as RouteHealthKey, value) }
  putEvent(value: RouteSwitchEvent) { return this.eventsTable.put(value.event_id as RouteEventKey, value) }
}

function scopeFor(identity: StudioIdentityService, sessionId: string | undefined): RouteScope {
  const principal = sessionId === undefined ? undefined : identity.principalForHarnessSession(sessionId)
  return principal === undefined
    ? { orgId: 'studio-system', tenantId: 'studio-system' }
    : { orgId: principal.orgId, tenantId: principal.tenantId }
}

export async function apply(ctx: Context): Promise<void> {
  const domain: Domain<typeof studioRouteHealthDomainSpec> = await ctx.storageDomain.open(studioRouteHealthDomainSpec)
  ctx.effect(() => () => domain.close(), 'studio-route-health.domainClose')
  const repository = new DomainRouteRepository(domain.table('routes'), domain.table('events'))
  const configured = new Set(ctx.llm.listProviders().map(provider => provider.id))
  const service = new StudioRouteHealthService(repository, {
    routes: rotasDoServico(configured),
    fallbackRoute: 'deepseek-official', fallbackModel: 'deepseek-v4-flash', localRoute: ROTA_LOCAL,
  })
  await service.initialize({ orgId: 'studio-system', tenantId: 'studio-system' }, configured)
  const explicitRequests = new WeakSet<GenerateOptions>()
  const requestScopes = new WeakMap<GenerateOptions, RouteScope>()
  const requestPrivacy = new WeakMap<GenerateOptions, RoutePrivacy>()
  ctx.provide('studioRouteHealth', {
    service,
    markExplicit(options) { explicitRequests.add(options); return options },
    markScope(options, scope) { requestScopes.set(options, scope); return options },
    markPrivacy(options, privacy) { requestPrivacy.set(options, privacy); return options },
  })

  const bypass = new WeakSet<GenerateOptions>()
  ctx.on('llm/stream', (options, next): AsyncIterable<StreamChunk> => {
    if (bypass.delete(options)) return next()
    const scope = requestScopes.get(options)
      ?? scopeFor(ctx.studioIdentity.service, options.sessionId === undefined ? undefined : String(options.sessionId))
    requestScopes.delete(options)
    const explicit = explicitRequests.delete(options)
    const privacy = requestPrivacy.get(options) ?? 'melhor-qualidade'
    requestPrivacy.delete(options)
    return service.streamWithFallback(scope, options, next, fallbackOptions => {
      bypass.add(fallbackOptions)
      return ctx.llm.stream(fallbackOptions)
    }, explicit, privacy)
  })

  const nomes = (): Readonly<Record<string, string>> => Object.fromEntries(ctx.llm.listProviders().map(provider => [provider.id, provider.name]))
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/api/studio/routes/health',
    handler: createRouteHealthHandler(service, ctx.studioIdentity.service, nomes),
  }), 'studio-route-health.http')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/api/studio/routes/enabled',
    handler: createRouteSwitchHandler(service, ctx.studioIdentity.service, nomes),
  }), 'studio-route-health.http-enabled')
}

export function createRouteHealthHandler(service: StudioRouteHealthService, identity: StudioIdentityService, nomes: () => Readonly<Record<string, string>> = () => ({})) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      if (request.method !== 'GET') return send(response, 405, { error: t('errors.methodNotAllowed') })
      const session = await authenticatedMutation(request, identity, response)
      const scope = { orgId: session.org_id, tenantId: session.tenant_id }
      return send(response, 200, { routes: service.list(scope), switches: service.switches(scope), names: nomes() })
    } catch (error) {
      return send(response, 401, { error: error instanceof Error ? error.message : t('errors.invalidSession') })
    }
  }
}

/** O teto do corpo de um pedido de ligar/desligar: ele carrega um nome e um sim ou não. */
export const LIMITE_DO_PEDIDO_DE_ROTA = 4 * 1024

/**
 * Lê `{ route, enabled }` de um corpo JSON, ou `undefined` quando não é isso.
 * @param texto - o corpo.
 * @returns o pedido.
 */
export function pedidoDeRota(texto: string): { readonly route: string; readonly enabled: boolean } | undefined {
  let valor: unknown
  try {
    valor = JSON.parse(texto)
  } catch {
    // Corpo que não é JSON: quem responde é o chamador, com 400.
    return undefined
  }
  if (typeof valor !== 'object' || valor === null) return undefined
  const { route, enabled } = valor as { route?: unknown; enabled?: unknown }
  return typeof route === 'string' && route !== '' && typeof enabled === 'boolean' ? { route, enabled } : undefined
}

/**
 * LIGA ou DESLIGA uma conexão de IA para este espaço de trabalho.
 *
 * É o controle que faltava para a pessoa escolher, pela tela, qual IA as
 * criações usam: a escolha é a primeira conexão LIGADA e saudável da lista, e
 * desligar a IA local faz a próxima — por exemplo, o Claude Code pela linha de
 * comando — assumir. Só uma conexão que o serviço conhece pode ser mexida, e a
 * decisão vale para o escopo da sessão, nunca para outro locatário.
 * @param service - o serviço de rotas.
 * @param identity - a identidade, para a sessão.
 * @param nomes - os nomes legíveis das rotas.
 * @returns o manipulador HTTP.
 */
export function createRouteSwitchHandler(service: StudioRouteHealthService, identity: StudioIdentityService, nomes: () => Readonly<Record<string, string>> = () => ({})) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let session
    try {
      if (request.method !== 'POST') return send(response, 405, { error: t('errors.methodNotAllowed') })
      session = await authenticatedMutation(request, identity, response)
    } catch (error) {
      return send(response, 401, { error: error instanceof Error ? error.message : t('errors.invalidSession') })
    }
    const texto = await lerCorpo(request, LIMITE_DO_PEDIDO_DE_ROTA)
    const pedido = texto === undefined ? undefined : pedidoDeRota(texto)
    if (pedido === undefined) return send(response, 400, { error: t('errors.pedidoInvalido') })
    const scope = { orgId: session.org_id, tenantId: session.tenant_id }
    if (!service.list(scope).some(record => record.route === pedido.route)) return send(response, 404, { error: t('errors.rotaDesconhecida') })
    await service.setRouteEnabled(scope, pedido.route, pedido.enabled)
    return send(response, 200, { routes: service.list(scope), switches: service.switches(scope), names: nomes() })
  }
}

async function lerCorpo(request: IncomingMessage, limite: number): Promise<string | undefined> {
  const partes: Buffer[] = []
  let total = 0
  for await (const parte of request as AsyncIterable<Buffer | string>) {
    const pedaco = typeof parte === 'string' ? Buffer.from(parte) : parte
    total += pedaco.length
    if (total > limite) return undefined
    partes.push(pedaco)
  }
  return Buffer.concat(partes).toString('utf8')
}

function send(response: ServerResponse, status: number, value: unknown): void {
  if (response.writableEnded) return
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}
