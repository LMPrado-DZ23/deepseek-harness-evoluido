import { authenticatedMutation } from '@dz23-studio/identity';
import { studioRouteHealthDomainSpec, } from './model.js';
import { ROTA_LOCAL, rotasDoServico, StudioRouteHealthService } from './service.js';
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
    const configured = new Set(ctx.llm.listProviders().map(provider => provider.id));
    const service = new StudioRouteHealthService(repository, {
        routes: rotasDoServico(configured),
        fallbackRoute: 'deepseek-official', fallbackModel: 'deepseek-v4-flash', localRoute: ROTA_LOCAL,
    });
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
    const nomes = () => Object.fromEntries(ctx.llm.listProviders().map(provider => [provider.id, provider.name]));
    ctx.effect(() => ctx.webServer.register({
        kind: 'exact', path: '/api/studio/routes/health',
        handler: createRouteHealthHandler(service, ctx.studioIdentity.service, nomes),
    }), 'studio-route-health.http');
    ctx.effect(() => ctx.webServer.register({
        kind: 'exact', path: '/api/studio/routes/enabled',
        handler: createRouteSwitchHandler(service, ctx.studioIdentity.service, nomes),
    }), 'studio-route-health.http-enabled');
}
export function createRouteHealthHandler(service, identity, nomes = () => ({})) {
    return async (request, response) => {
        try {
            if (request.method !== 'GET')
                return send(response, 405, { error: t('errors.methodNotAllowed') });
            const session = await authenticatedMutation(request, identity, response);
            const scope = { orgId: session.org_id, tenantId: session.tenant_id };
            return send(response, 200, { routes: service.list(scope), switches: service.switches(scope), names: nomes() });
        }
        catch (error) {
            return send(response, 401, { error: error instanceof Error ? error.message : t('errors.invalidSession') });
        }
    };
}
/** O teto do corpo de um pedido de ligar/desligar: ele carrega um nome e um sim ou não. */
export const LIMITE_DO_PEDIDO_DE_ROTA = 4 * 1024;
/**
 * Lê `{ route, enabled }` de um corpo JSON, ou `undefined` quando não é isso.
 * @param texto - o corpo.
 * @returns o pedido.
 */
export function pedidoDeRota(texto) {
    let valor;
    try {
        valor = JSON.parse(texto);
    }
    catch {
        // Corpo que não é JSON: quem responde é o chamador, com 400.
        return undefined;
    }
    if (typeof valor !== 'object' || valor === null)
        return undefined;
    const { route, enabled } = valor;
    return typeof route === 'string' && route !== '' && typeof enabled === 'boolean' ? { route, enabled } : undefined;
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
export function createRouteSwitchHandler(service, identity, nomes = () => ({})) {
    return async (request, response) => {
        let session;
        try {
            if (request.method !== 'POST')
                return send(response, 405, { error: t('errors.methodNotAllowed') });
            session = await authenticatedMutation(request, identity, response);
        }
        catch (error) {
            return send(response, 401, { error: error instanceof Error ? error.message : t('errors.invalidSession') });
        }
        const texto = await lerCorpo(request, LIMITE_DO_PEDIDO_DE_ROTA);
        const pedido = texto === undefined ? undefined : pedidoDeRota(texto);
        if (pedido === undefined)
            return send(response, 400, { error: t('errors.pedidoInvalido') });
        const scope = { orgId: session.org_id, tenantId: session.tenant_id };
        if (!service.list(scope).some(record => record.route === pedido.route))
            return send(response, 404, { error: t('errors.rotaDesconhecida') });
        await service.setRouteEnabled(scope, pedido.route, pedido.enabled);
        return send(response, 200, { routes: service.list(scope), switches: service.switches(scope), names: nomes() });
    };
}
async function lerCorpo(request, limite) {
    const partes = [];
    let total = 0;
    for await (const parte of request) {
        const pedaco = typeof parte === 'string' ? Buffer.from(parte) : parte;
        total += pedaco.length;
        if (total > limite)
            return undefined;
        partes.push(pedaco);
    }
    return Buffer.concat(partes).toString('utf8');
}
function send(response, status, value) {
    if (response.writableEnded)
        return;
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify(value));
}
