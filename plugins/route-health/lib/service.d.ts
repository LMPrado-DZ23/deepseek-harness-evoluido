import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { RouteHealthRecord, RouteSwitchEvent } from './model.js';
export interface RouteScope {
    readonly orgId: string;
    readonly tenantId: string;
}
export interface RoutePrice {
    readonly inputPerMillion: number;
    readonly outputPerMillion: number;
}
export interface RouteHealthRepository {
    routes(): readonly RouteHealthRecord[];
    events(): readonly RouteSwitchEvent[];
    putRoute(record: RouteHealthRecord): Promise<void>;
    putEvent(record: RouteSwitchEvent): Promise<void>;
}
export interface RouteSelection {
    readonly route: string;
    readonly explicit: boolean;
    readonly reason: string;
}
export interface RouteHealthConfig {
    readonly routes: readonly string[];
    readonly fallbackRoute: string;
    readonly fallbackModel: string;
    readonly localRoute: string;
    readonly prices?: Readonly<Record<string, RoutePrice>>;
    readonly now?: () => Date;
    readonly createId?: () => string;
}
export declare class StudioRouteHealthService {
    #private;
    private readonly repository;
    private readonly config;
    constructor(repository: RouteHealthRepository, config: RouteHealthConfig);
    initialize(scope: RouteScope, configured: ReadonlySet<string>): Promise<void[]>;
    list(scope: RouteScope): readonly RouteHealthRecord[];
    switches(scope: RouteScope): readonly RouteSwitchEvent[];
    chooseRoute(scope: RouteScope, purpose: string, explicitRoute?: string): RouteSelection;
    streamWithFallback(scope: RouteScope, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>, fallback: (options: GenerateOptions) => AsyncIterable<StreamChunk>, explicitRoute?: boolean): AsyncIterable<StreamChunk>;
    private get;
    private baseRecord;
    private record;
    private auditSwitch;
}
export declare const ROUTE_FAILURE_MESSAGE = "A conex\u00E3o com a intelig\u00EAncia artificial falhou. Nada foi aplicado; tente novamente ou escolha outra rota.";
//# sourceMappingURL=service.d.ts.map