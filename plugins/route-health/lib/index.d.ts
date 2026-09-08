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
export declare function createRouteHealthHandler(service: StudioRouteHealthService, identity: StudioIdentityService): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
//# sourceMappingURL=index.d.ts.map