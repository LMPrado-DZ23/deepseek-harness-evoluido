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
import { ROTA_LOCAL, StudioRouteHealthService, type RoutePrivacy, type RouteHealthRepository, type RouteScope } from './service.js'
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
  const service = new StudioRouteHealthService(repository, {
    routes: [ROTA_LOCAL, 'omniroute', 'deepseek-official'],
    fallbackRoute: 'deepseek-official', fallbackModel: 'deepseek-v4-flash', localRoute: ROTA_LOCAL,
  })
  const configured = new Set(ctx.llm.listProviders().map(provider => provider.id))
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

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/api/studio/routes/health',
    handler: createRouteHealthHandler(service, ctx.studioIdentity.service),
  }), 'studio-route-health.http')
}

export function createRouteHealthHandler(service: StudioRouteHealthService, identity: StudioIdentityService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      if (request.method !== 'GET') return send(response, 405, { error: t('errors.methodNotAllowed') })
      const session = await authenticatedMutation(request, identity, response)
      const scope = { orgId: session.org_id, tenantId: session.tenant_id }
      return send(response, 200, { routes: service.list(scope), switches: service.switches(scope) })
    } catch (error) {
      return send(response, 401, { error: error instanceof Error ? error.message : t('errors.invalidSession') })
    }
  }
}

function send(response: ServerResponse, status: number, value: unknown): void {
  if (response.writableEnded) return
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}
