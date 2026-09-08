import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
export const routeStateSchema = z.enum(['OK', 'DEGRADED', 'DOWN', 'NOT_CONFIGURED']);
export const routeHealthRecordSchema = z.object({
    record_id: z.string().min(1),
    org_id: z.string().min(1),
    tenant_id: z.string().min(1),
    route: z.string().min(1),
    state: routeStateSchema,
    requests: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    average_latency_ms: z.number().nonnegative(),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    estimated_cost_usd: z.number().nonnegative(),
    /**
     * Quantas requisições entraram na conta SEM preço configurado.
     *
     * Sem este campo, `estimated_cost_usd` somava 0 para elas e o resultado era
     * apresentado como custo medido: "não sei o preço" virava "custou zero".
     *
     * É opcional de propósito. Torná-lo obrigatório exigiria subir a versão do
     * domínio, e `open()` falha com `version-mismatch` em qualquer instalação que
     * já rodou - não existe passo de migração. Registro antigo, sem o campo,
     * significa zero não precificadas.
     */
    unpriced_requests: z.number().int().nonnegative().optional(),
    last_failure: z.string().nullable(),
    updated_at: z.iso.datetime(),
}).strict();
export const routeSwitchEventSchema = z.object({
    event_id: z.string().min(1),
    org_id: z.string().min(1),
    tenant_id: z.string().min(1),
    from_route: z.string().min(1),
    to_route: z.string().min(1),
    reason: z.string().min(1),
    explicit_route: z.boolean(),
    created_at: z.iso.datetime(),
}).strict();
export const STUDIO_ROUTE_HEALTH_PHYSICAL_DOMAIN = 'studio_route_health';
export const STUDIO_ROUTE_HEALTH_LOGICAL_DOMAIN = 'studio.route.health';
export const studioRouteHealthDomainSpec = defineDomain({
    name: STUDIO_ROUTE_HEALTH_PHYSICAL_DOMAIN,
    version: 1,
    tables: {
        routes: domainTable(routeHealthRecordSchema),
        events: domainTable(routeSwitchEventSchema),
    },
});
