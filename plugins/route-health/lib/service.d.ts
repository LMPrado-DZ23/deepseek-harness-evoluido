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
export type RoutePrivacy = 'local-only' | 'any';
export interface RouteHealthRepository {
    routes(): readonly RouteHealthRecord[];
    events(): readonly RouteSwitchEvent[];
    putRoute(record: RouteHealthRecord): Promise<void>;
    putEvent(record: RouteSwitchEvent): Promise<void>;
}
export interface RouteSelection {
    readonly route: string | undefined;
    readonly explicit: boolean;
    readonly reason: string;
}
export interface RouteSelectionOptions {
    readonly privacy: RoutePrivacy;
    readonly explicitRoute?: string;
}
/**
 * Quando uma rota para de ser tentada e por quanto tempo.
 *
 * `failureThreshold` conta falhas SEGUIDAS, não taxa de erro: a taxa já existe
 * em `state` e serve para apresentar saúde; o circuito serve para parar de
 * gastar a espera de quem chega depois.
 */
export interface RouteCircuitConfig {
    readonly failureThreshold: number;
    readonly cooldownMs: number;
}
/**
 * O teto de gasto de um escopo.
 *
 * São DOIS tetos porque só um deles seria mentira. `maxCostUsd` barra pelo
 * custo MEDIDO - requisição em rota com preço configurado. `maxUnpricedRequests`
 * barra pelo NÚMERO de requisições cujo custo ninguém sabe: tratar "não sei o
 * preço" como "gastou zero" é a mesma mentira que `unpriced_requests` acabou de
 * corrigir, e um teto que a repete permite gastar sem limite em qualquer rota
 * sem preço.
 */
export interface RouteBudgetConfig {
    readonly maxCostUsd: number;
    readonly maxUnpricedRequests: number;
}
export interface RouteHealthConfig {
    readonly routes: readonly string[];
    readonly fallbackRoute: string;
    readonly fallbackModel: string;
    readonly localRoute: string;
    readonly prices?: Readonly<Record<string, RoutePrice>>;
    /** Ausente = padrão da casa (`DEFAULT_ROUTE_CIRCUIT`). */
    readonly circuit?: RouteCircuitConfig;
    /**
     * Ausente = SEM teto. Um número inventado aqui seria pior que nenhum: ele
     * barraria trabalho legítimo com uma autoridade que ninguém deu.
     */
    readonly budget?: RouteBudgetConfig;
    readonly now?: () => Date;
    readonly createId?: () => string;
}
/**
 * Estado do circuito de uma rota.
 *
 * `OPEN`: falhou demais e ainda está no tempo de espera - não se tenta.
 * `HALF_OPEN`: a espera passou; UMA chamada decide se fecha ou reabre.
 * `CLOSED`: em uso normal.
 */
export type RouteCircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
/** Três falhas seguidas e trinta segundos de espera: curto o bastante para uma indisponibilidade passageira não virar apagão, longo o bastante para não repetir o erro a cada requisição. */
export declare const DEFAULT_ROUTE_CIRCUIT: RouteCircuitConfig;
/**
 * O estado do circuito de um registro no instante dado.
 *
 * `circuit_opened_at` é a ÚNICA fonte: ele é gravado quando as falhas seguidas
 * atingem o limite e apagado no primeiro sucesso. Registro gravado antes destes
 * campos existirem não tem o campo, e ausência significa circuito fechado.
 * @param record - o registro da rota.
 * @param now - o instante da decisão.
 * @param circuit - limite e tempo de espera.
 * @returns o estado do circuito.
 */
export declare function routeCircuitState(record: Pick<RouteHealthRecord, 'circuit_opened_at'>, now: Date, circuit?: RouteCircuitConfig): RouteCircuitState;
/** O que o teto de gasto respondeu, e por qual dos dois motivos. */
export type RouteBudgetVerdict = 'WITHIN' | 'COST_EXCEEDED' | 'UNPRICED_EXCEEDED';
export interface RouteBudgetUsage {
    readonly measuredCostUsd: number;
    readonly unpricedRequests: number;
    readonly verdict: RouteBudgetVerdict;
}
/**
 * O gasto de um escopo e o veredito do teto.
 *
 * Só entram registros de rota PAGA: a rota local não cobra e barrá-la por
 * dinheiro seria barrar trabalho que não custa nada.
 * @param records - os registros das rotas pagas do escopo.
 * @param budget - o teto configurado, ou `undefined` para nenhum.
 * @returns custo medido, requisições sem preço e o veredito.
 */
export declare function routeBudgetUsage(records: readonly Pick<RouteHealthRecord, 'estimated_cost_usd' | 'unpriced_requests'>[], budget: RouteBudgetConfig | undefined): RouteBudgetUsage;
export declare class StudioRouteHealthService {
    #private;
    private readonly repository;
    private readonly config;
    constructor(repository: RouteHealthRepository, config: RouteHealthConfig);
    initialize(scope: RouteScope, configured: ReadonlySet<string>): Promise<void[]>;
    list(scope: RouteScope): readonly RouteHealthRecord[];
    switches(scope: RouteScope): readonly RouteSwitchEvent[];
    chooseRoute(scope: RouteScope, purpose: string, options?: RouteSelectionOptions): Promise<RouteSelection>;
    /** O estado do circuito de uma rota neste escopo, agora. */
    circuit(scope: RouteScope, route: string): RouteCircuitState;
    /** O gasto do escopo somando apenas as rotas pagas, e o veredito do teto. */
    budget(scope: RouteScope): RouteBudgetUsage;
    /**
     * Marca a chamada de meia-abertura reiniciando a espera.
     *
     * Sem esta marca, todas as requisições que chegassem depois do tempo de
     * espera seriam admitidas juntas: em vez de UMA tentativa decidindo, a rota
     * quebrada levaria a mesma enxurrada que o circuito abriu para evitar.
     */
    private startProbe;
    /** Um único relógio para todo o serviço: registro, auditoria e circuito têm de contar o mesmo tempo. */
    private clock;
    streamWithFallback(scope: RouteScope, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>, fallback: (options: GenerateOptions) => AsyncIterable<StreamChunk>, explicitRoute?: boolean): AsyncIterable<StreamChunk>;
    private get;
    private baseRecord;
    private record;
    private auditSwitch;
}
export declare const ROUTE_FAILURE_MESSAGE = "A conex\u00E3o com a intelig\u00EAncia artificial falhou. Nada foi aplicado; tente novamente ou escolha outra rota.";
/**
 * O que se pode honestamente dizer sobre o custo de uma rota.
 *
 * `UNKNOWN`: nenhuma requisição tinha preço - o número somado é zero porque
 * ninguém sabia, não porque nada foi gasto.
 * `PARTIAL`: parte teve preço; o valor é um piso, não o total.
 * `MEASURED`: toda requisição contada tinha preço configurado.
 */
export type RouteCostState = 'MEASURED' | 'PARTIAL' | 'UNKNOWN';
/**
 * Classifica o custo de uma rota pelo que realmente se sabe.
 * @param record - o registro da rota.
 * @returns o estado do custo, para quem for apresentar o número.
 */
export declare function routeCostState(record: Pick<RouteHealthRecord, 'requests' | 'unpriced_requests'>): RouteCostState;
//# sourceMappingURL=service.d.ts.map