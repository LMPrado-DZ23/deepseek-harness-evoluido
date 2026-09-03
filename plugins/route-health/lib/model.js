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
