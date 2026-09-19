import type { Context } from '@deepseek-ai/cordis';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import { type StudioIdentityService } from '@dz23-studio/identity';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StudioRouteHealthService, type RoutePrivacy, type RouteScope } from './service.js';
export * from './model.js';
export * from './service.js';
export declare const name = "dz23-studio-route-health";
export declare const inject: string[];
export interface StudioRouteHealthRuntime {
    readonly service: StudioRouteHealthService;
    markExplicit(options: GenerateOptions): GenerateOptions;
    markScope(options: GenerateOptions, scope: RouteScope): GenerateOptions;
    /**
     * Diz a esta requisição qual perfil a escolheu.
     *
     * Sem esta marca, a cascata do `streamWithFallback` não teria como saber que
     * a requisição nasceu de um perfil `privado-local` e desceria para a rota
     * externa quando o modelo local falhasse - o C-22 quebrado no meio do fluxo,
     * depois de a escolha já ter sido feita corretamente.
     */
    markPrivacy(options: GenerateOptions, privacy: RoutePrivacy): GenerateOptions;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        studioRouteHealth: StudioRouteHealthRuntime;
    }
}
export declare function apply(ctx: Context): Promise<void>;
export declare function createRouteHealthHandler(service: StudioRouteHealthService, identity: StudioIdentityService, nomes?: () => Readonly<Record<string, string>>): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
/** O teto do corpo de um pedido de ligar/desligar: ele carrega um nome e um sim ou não. */
export declare const LIMITE_DO_PEDIDO_DE_ROTA: number;
/**
 * Lê `{ route, enabled }` de um corpo JSON, ou `undefined` quando não é isso.
 * @param texto - o corpo.
 * @returns o pedido.
 */
export declare function pedidoDeRota(texto: string): {
    readonly route: string;
    readonly enabled: boolean;
} | undefined;
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
export declare function createRouteSwitchHandler(service: StudioRouteHealthService, identity: StudioIdentityService, nomes?: () => Readonly<Record<string, string>>): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
//# sourceMappingURL=index.d.ts.map