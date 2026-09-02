import type { Context } from '@deepseek-ai/cordis';
import { StudioTenancyService } from './service.js';
export * from './http.js';
export * from './model.js';
export * from './service.js';
export declare const name = "dz23-studio-tenancy";
export declare const inject: string[];
export interface TenancyPluginConfig {
    readonly allowedHosts?: readonly string[];
    readonly allowedOrigins?: readonly string[];
    readonly now?: () => Date;
    readonly createId?: () => string;
    readonly createSecret?: () => string;
}
export interface StudioTenancyRuntime {
    readonly service: StudioTenancyService;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        studioTenancy: StudioTenancyRuntime;
    }
}
export declare function apply(ctx: Context, config?: TenancyPluginConfig): Promise<void>;
//# sourceMappingURL=index.d.ts.map