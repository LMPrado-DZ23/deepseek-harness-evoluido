import { z } from 'zod';
export declare const routeStateSchema: z.ZodEnum<{
    OK: "OK";
    DEGRADED: "DEGRADED";
    DOWN: "DOWN";
    NOT_CONFIGURED: "NOT_CONFIGURED";
}>;
export type RouteState = z.infer<typeof routeStateSchema>;
export declare const routeHealthRecordSchema: z.ZodObject<{
    record_id: z.ZodString;
    org_id: z.ZodString;
    tenant_id: z.ZodString;
    route: z.ZodString;
    state: z.ZodEnum<{
        OK: "OK";
        DEGRADED: "DEGRADED";
        DOWN: "DOWN";
        NOT_CONFIGURED: "NOT_CONFIGURED";
    }>;
    requests: z.ZodNumber;
    errors: z.ZodNumber;
    average_latency_ms: z.ZodNumber;
    input_tokens: z.ZodNumber;
    output_tokens: z.ZodNumber;
    estimated_cost_usd: z.ZodNumber;
    unpriced_requests: z.ZodOptional<z.ZodNumber>;
    last_failure: z.ZodNullable<z.ZodString>;
    updated_at: z.ZodISODateTime;
}, z.core.$strict>;
export declare const routeSwitchEventSchema: z.ZodObject<{
    event_id: z.ZodString;
    org_id: z.ZodString;
    tenant_id: z.ZodString;
    from_route: z.ZodString;
    to_route: z.ZodString;
    reason: z.ZodString;
    explicit_route: z.ZodBoolean;
    created_at: z.ZodISODateTime;
}, z.core.$strict>;
export type RouteHealthRecord = z.infer<typeof routeHealthRecordSchema>;
export type RouteSwitchEvent = z.infer<typeof routeSwitchEventSchema>;
declare const routeHealthKeyBrand: unique symbol;
declare const routeEventKeyBrand: unique symbol;
export type RouteHealthKey = string & {
    readonly [routeHealthKeyBrand]: true;
};
export type RouteEventKey = string & {
    readonly [routeEventKeyBrand]: true;
};
export declare const STUDIO_ROUTE_HEALTH_PHYSICAL_DOMAIN = "studio_route_health";
export declare const STUDIO_ROUTE_HEALTH_LOGICAL_DOMAIN = "studio.route.health";
export declare const studioRouteHealthDomainSpec: {
    name: string;
    version: number;
    tables: {
        routes: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<RouteHealthKey, {
            record_id: string;
            org_id: string;
            tenant_id: string;
            route: string;
            state: "OK" | "DEGRADED" | "DOWN" | "NOT_CONFIGURED";
            requests: number;
            errors: number;
            average_latency_ms: number;
            input_tokens: number;
            output_tokens: number;
            estimated_cost_usd: number;
            last_failure: string | null;
            updated_at: string;
            unpriced_requests?: number | undefined;
        }>;
        events: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<RouteEventKey, {
            event_id: string;
            org_id: string;
            tenant_id: string;
            from_route: string;
            to_route: string;
            reason: string;
            explicit_route: boolean;
            created_at: string;
        }>;
    };
};
export {};
//# sourceMappingURL=model.d.ts.map