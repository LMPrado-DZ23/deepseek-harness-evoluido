import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { PolicyIdentityState } from '@dz23-studio/policy';
import { MemoryEmailSender, type EmailSender } from './email.js';
import { type PasskeyProvider } from './passkey.js';
import { StudioIdentityService, type EnrollmentMode, type IdentityPrincipal } from './service.js';
export * from './crypto.js';
export * from './email.js';
export * from './http.js';
export * from './model.js';
export * from './mutex.js';
export * from './passkey.js';
export * from './rate-limit.js';
export * from './service.js';
export declare const name = "dz23-studio-identity";
export interface AgentLookup {
    get(id: SessionId): Agent | undefined;
}
/** Resolve identity through an explicitly recorded agent lineage, never through ambient process state. */
export declare function identityStateForAgent(service: StudioIdentityService, agents: AgentLookup, agent: Agent | undefined, bindHost: '127.0.0.1' | '0.0.0.0'): PolicyIdentityState;
/** Resolve the tenant principal through the same durable parentSession lineage. */
export declare function principalForAgent(service: StudioIdentityService, agents: AgentLookup, agent: Agent | undefined): IdentityPrincipal | undefined;
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