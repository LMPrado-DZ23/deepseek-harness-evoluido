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
    context_window_tokens: z.ZodOptional<z.ZodNumber>;
    supports_tools: z.ZodOptional<z.ZodBoolean>;
    privacy: z.ZodOptional<z.ZodEnum<{
        local: "local";
        externa: "externa";
    }>>;
    unpriced_requests: z.ZodOptional<z.ZodNumber>;
    consecutive_failures: z.ZodOptional<z.ZodNumber>;
    circuit_opened_at: z.ZodOptional<z.ZodNullable<z.ZodISODateTime>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    last_failure: z.ZodNullable<z.ZodString>;
    updated_at: z.ZodISODateTime;
}, z.core.$strict>;
/**
 * O perfil de rota como ele é ACEITO em disco e na borda HTTP.
 *
 * Os três nomes novos e os dois valores do binário anterior convivem na mesma
 * enumeração de propósito: a versão do domínio não pode subir, então o registro
 * gravado com `local-only` ou `any` precisa continuar validando. Quem decide
 * comportamento usa `routePrivacyProfile`, que traduz os antigos; ninguém
 * compara com o valor cru.
 */
export declare const routePrivacySchema: z.ZodEnum<{
    "privado-local": "privado-local";
    equilibrado: "equilibrado";
    "melhor-qualidade": "melhor-qualidade";
    "local-only": "local-only";
    any: "any";
}>;
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
            context_window_tokens?: number | undefined;
            supports_tools?: boolean | undefined;
            privacy?: "local" | "externa" | undefined;
            unpriced_requests?: number | undefined;
            consecutive_failures?: number | undefined;
            circuit_opened_at?: string | null | undefined;
            enabled?: boolean | undefined;
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