import type { Context } from '@deepseek-ai/cordis';
import { MemoryEmailSender, type EmailSender } from './email.js';
import { type PasskeyProvider } from './passkey.js';
import { StudioIdentityService, type EnrollmentMode } from './service.js';
export * from './crypto.js';
export * from './email.js';
export * from './http.js';
export * from './model.js';
export * from './mutex.js';
export * from './passkey.js';
export * from './rate-limit.js';
export * from './service.js';
export declare const name = "dz23-studio-identity";
export declare const inject: string[];
export interface IdentityPluginConfig {
    readonly rpName?: string;
    readonly rpId?: string;
    readonly expectedOrigin?: string;
    readonly defaultOrgId?: string;
    readonly defaultTenantId?: string;
    readonly enrollment?: EnrollmentMode;
    readonly allowedHosts?: readonly string[];
    readonly allowedOrigins?: readonly string[];
    readonly edge?: {
        readonly required?: boolean;
        readonly secretRef?: string;
    };
    readonly email?: {
        readonly kind: 'memory';
    } | {
        readonly kind: 'smtp';
        readonly secretRef: string;
    };
    readonly now?: () => Date;
    readonly createId?: () => string;
    readonly createSecret?: () => string;
    readonly createMagicCode?: () => string;
    readonly passkeys?: PasskeyProvider;
    readonly emailSender?: EmailSender;
}
export interface StudioIdentityRuntime {
    readonly service: StudioIdentityService;
    readonly developmentEmailCapture?: MemoryEmailSender;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        studioIdentity: StudioIdentityRuntime;
    }
}
export declare function apply(ctx: Context, config?: IdentityPluginConfig): Promise<void>;
export declare function assertValidRpId(rpId: string): void;
//# sourceMappingURL=index.d.ts.map