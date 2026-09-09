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
/** O que uma rota declara saber fazer (M-03). Campo ausente = DESCONHECIDO, nunca zero nem `false`. */
export interface RouteCapability {
    readonly contextWindowTokens?: number;
    readonly supportsTools?: boolean;
}
/**
 * Os três perfis de rota, pelo nome que a pessoa lê.
 *
 * `privado-local`: só a IA local. Nunca cai para rota externa - se a local não
 * serve, a criação fica BLOQUEADA e a pessoa é avisada. É o C-22.
 * `equilibrado`: prefere a local; usa a rota externa configurada quando a local
 * não serve, e avisa que vai usar.
 * `melhor-qualidade`: usa a melhor rota disponível.
 */
export type RoutePrivacyProfile = 'privado-local' | 'equilibrado' | 'melhor-qualidade';
/**
 * Os dois valores do binário anterior, que continuam gravados em disco.
 *
 * Eles não são aceitos por gentileza: a versão do domínio NÃO pode subir
 * (`open()` falha com `version-mismatch` em instalação que já rodou e não
 * existe passo de migração), então o registro antigo tem de continuar legível
 * exatamente como está. `local-only` lê como `privado-local` e `any` lê como
 * `melhor-qualidade`.
 */
export type LegacyRoutePrivacy = 'local-only' | 'any';
export type RoutePrivacy = RoutePrivacyProfile | LegacyRoutePrivacy;
/** Os três perfis, na ordem em que a tela os oferece. */
export declare const ROUTE_PRIVACY_PROFILES: readonly RoutePrivacyProfile[];
/**
 * O perfil nomeado de um valor gravado, novo ou antigo.
 *
 * Toda decisão passa por aqui antes de comparar perfil: comparar com o valor
 * cru deixaria `local-only` escapando da regra do C-22 por não ser igual à
 * string nova.
 * @param value - o perfil novo ou o valor binário antigo.
 * @returns o perfil nomeado.
 */
export declare function routePrivacyProfile(value: RoutePrivacy): RoutePrivacyProfile;
/**
 * O funil por onde TODA escolha de rota sai.
 *
 * `privado-local` promete uma coisa só: nada sai deste computador. Antes, essa
 * promessa era um `if` no começo de `chooseRoute` - convenção, não garantia:
 * qualquer caminho novo aberto depois dele (cascata, rota explícita, circuito
 * meio-aberto, teto de gasto) devolveria uma rota externa em silêncio, e o
 * perfil só descobriria isso pelo dado já enviado. Aqui a promessa é
 * estrutural: quem não é a rota local vira bloqueio, venha de onde vier.
 * @param profile - o perfil pedido.
 * @param localRoute - a rota da IA local.
 * @param selection - a escolha que os caminhos produziram.
 * @param blockedReason - a frase do bloqueio.
 * @returns a escolha, ou o bloqueio.
 */
export declare function enforceRoutePrivacy(profile: RoutePrivacyProfile, localRoute: string, selection: RouteSelection, blockedReason: string): RouteSelection;
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
    /**
     * O que cada rota DECLARA saber fazer (M-03): janela de contexto e suporte a
     * ferramentas.
     *
     * Declaração, e não medida, porque não há como medir a janela de um provedor
     * de fora. Rota ausente daqui fica com os dois campos ausentes no registro —
     * DESCONHECIDO — e nunca com um número inventado.
     */
    readonly capabilities?: Readonly<Record<string, RouteCapability>>;
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
    /**
     * A rota escolhida para um propósito, já respeitando o perfil do escopo.
     *
     * A escolha inteira sai por `enforceRoutePrivacy`: o caminho que a produziu
     * pode mudar amanhã, a promessa do `privado-local` não.
     */
    chooseRoute(scope: RouteScope, purpose: string, options?: RouteSelectionOptions): Promise<RouteSelection>;
    private select;
    /**
     * Se esta rota está ligada neste escopo, agora.
     *
     * Ausência do campo significa LIGADA: registro gravado antes de o
     * desligamento existir descreve um mundo em que toda rota era usada, e lê-lo
     * como desligada apagaria rotas que ninguém mandou apagar.
     */
    enabled(scope: RouteScope, route: string): boolean;
    /**
     * Liga ou desliga uma rota para um escopo.
     *
     * O desligamento é por escopo - `org_id`/`tenant_id`/rota - e nunca global:
     * desligar a rota de um locatário por decisão de outro seria o mesmo erro que
     * o circuito por escopo já evita.
     * @param scope - a organização e o locatário.
     * @param route - a rota.
     * @param enabled - `true` liga, `false` desliga.
     * @returns quando a decisão estiver gravada.
     */
    setRouteEnabled(scope: RouteScope, route: string, enabled: boolean): Promise<void>;
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
    streamWithFallback(scope: RouteScope, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>, fallback: (options: GenerateOptions) => AsyncIterable<StreamChunk>, explicitRoute?: boolean, privacy?: RoutePrivacy): AsyncIterable<StreamChunk>;
    private get;
    private baseRecord;
    /**
     * Os fatos declarados e derivados desta rota (M-03).
     *
     * Campo AUSENTE quando não há o que dizer: um `0` de janela seria lido como
     * "não cabe nada" e um `false` de ferramentas seria lido como "não aceita",
     * e as duas leituras são afirmações que ninguém fez.
     * @param route - o nome da rota.
     * @returns só os campos que têm resposta.
     */
    private capabilitiesOf;
    private record;
    private auditSwitch;
}
export declare const ROUTE_FAILURE_MESSAGE: string;
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