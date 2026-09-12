import { authenticatedMutation } from '@dz23-studio/identity';
import { studioRouteHealthDomainSpec, } from './model.js';
import { StudioRouteHealthService } from './service.js';
import { t } from './i18n.js';
export * from './model.js';
export * from './service.js';
export const name = 'dz23-studio-route-health';
export const inject = ['llm', 'storageDomain', 'studioIdentity', 'webServer'];
class DomainRouteRepository {
    routesTable;
    eventsTable;
    constructor(routesTable, eventsTable) {
        this.routesTable = routesTable;
        this.eventsTable = eventsTable;
    }
    routes() { return [...this.routesTable.entries()].map(([, value]) => value); }
    events() { return [...this.eventsTable.entries()].map(([, value]) => value); }
    putRoute(value) { return this.routesTable.put(value.record_id, value); }
    putEvent(value) { return this.eventsTable.put(value.event_id, value); }
}
function scopeFor(identity, sessionId) {
    const principal = sessionId === undefined ? undefined : identity.principalForHarnessSession(sessionId);
    return principal === undefined
        ? { orgId: 'studio-system', tenantId: 'studio-system' }
        : { orgId: principal.orgId, tenantId: principal.tenantId };
}
export async function apply(ctx) {
    const domain = await ctx.storageDomain.open(studioRouteHealthDomainSpec);
    ctx.effect(() => () => domain.close(), 'studio-route-health.domainClose');
    const repository = new DomainRouteRepository(domain.table('routes'), domain.table('events'));
    const service = new StudioRouteHealthService(repository, {
        routes: ['ollama', 'omniroute', 'deepseek-official'],
        fallbackRoute: 'deepseek-official', fallbackModel: 'deepseek-v4-flash', localRoute: 'ollama',
    });
    const configured = new Set(ctx.llm.listProviders().map(provider => provider.id));
    await service.initialize({ orgId: 'studio-system', tenantId: 'studio-system' }, configured);
    const explicitRequests = new WeakSet();
    const requestScopes = new WeakMap();
    const requestPrivacy = new WeakMap();
    ctx.provide('studioRouteHealth', {
        service,
        markExplicit(options) { explicitRequests.add(options); return options; },
        markScope(options, scope) { requestScopes.set(options, scope); return options; },
        markPrivacy(options, privacy) { requestPrivacy.set(options, privacy); return options; },
    });
    const bypass = new WeakSet();
    ctx.on('llm/stream', (options, next) => {
        if (bypass.delete(options))
            return next();
        const scope = requestScopes.get(options)
            ?? scopeFor(ctx.studioIdentity.service, options.sessionId === undefined ? undefined : String(options.sessionId));
        requestScopes.delete(options);
        const explicit = explicitRequests.delete(options);
        const privacy = requestPrivacy.get(options) ?? 'melhor-qualidade';
        requestPrivacy.delete(options);
        return service.streamWithFallback(scope, options, next, fallbackOptions => {
            bypass.add(fallbackOptions);
            return ctx.llm.stream(fallbackOptions);
        }, explicit, privacy);
    });
    ctx.effect(() => ctx.webServer.register({
        kind: 'exact', path: '/api/studio/routes/health',
        handler: createRouteHealthHandler(service, ctx.studioIdentity.service),
    }), 'studio-route-health.http');
}
export function createRouteHealthHandler(service, identity) {
    return async (request, response) => {
        try {
            if (request.method !== 'GET')
                return send(response, 405, { error: t('errors.methodNotAllowed') });
            const session = await authenticatedMutation(request, identity, response);
            const scope = { orgId: session.org_id, tenantId: session.tenant_id };
            return send(response, 200, { routes: service.list(scope), switches: service.switches(scope) });
        }
        catch (error) {
            return send(response, 401, { error: error instanceof Error ? error.message : t('errors.invalidSession') });
        }
    };
}
function send(response, status, value) {
    if (response.writableEnded)
        return;
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify(value));
}
