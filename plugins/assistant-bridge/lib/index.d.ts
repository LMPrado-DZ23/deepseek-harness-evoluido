import type { Context } from '@deepseek-ai/cordis';
import { type ToolDefinition } from '@deepseek-ai/dsh-tools';
import { StudioAssistantBridge, type AssistantRepositoryConfig } from './service.js';
export * from './catalog.js';
export * from './approval.js';
export * from './closed-tool.js';
export * from './service.js';
export declare const name = "dz23-studio-assistant-bridge";
export declare const inject: string[];
export interface Config {
    readonly exposedTools: readonly string[];
    readonly repositories?: readonly AssistantRepositoryConfig[];
}
export interface StudioAssistantRuntime {
    readonly bridge: StudioAssistantBridge;
    readonly tools: readonly string[];
    readonly automaticSessionCreation: 'NOT_PRESENT';
    readonly teamCoordination: 'BETA_MANUAL_DEPENDENCY_CONTINUE';
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        studioAssistant: StudioAssistantRuntime;
    }
}
export declare function createAssistantTools(bridge: StudioAssistantBridge): readonly ToolDefinition[];
export declare function apply(ctx: Context, config: Config): Promise<void>;
//# sourceMappingURL=index.d.ts.map