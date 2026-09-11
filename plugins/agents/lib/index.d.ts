import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { PolicyDelegationGrant } from '@dz23-studio/policy';
import { type AgentLeaseRecord, type AgentRunRecord } from './model.js';
import { StudioAgentService, type AgentRestartReconciliation } from './service.js';
import '@deepseek-ai/dsh-token-meter';
export * from './model.js';
export * from './service.js';
export declare const name = "dz23-studio-agents";
export declare const inject: string[];
export interface Config {
    readonly worktreeRoot?: string;
    readonly coordinatorPreset?: string;
    readonly inProcessCoordinatorPreset?: string;
    readonly inProcessProvider?: string;
    readonly inProcessModel?: string;
}
export interface StudioAgentsRuntime {
    readonly service: StudioAgentService;
    readonly restartReconciliation: AgentRestartReconciliation;
    runs(): readonly AgentRunRecord[];
    leases(): readonly AgentLeaseRecord[];
    /** Se este trabalho pode ser retomado (A-03). A tela pergunta antes de oferecer o botão. */
    resumable(run: Pick<AgentRunRecord, 'status' | 'provider' | 'interrupted_by_restart'>): boolean;
    /** O próximo número de cerca deste repositório (A-03), como o serviço o calcularia. */
    nextFence(scope: {
        readonly workspaceId: string;
        readonly repositoryPath: string;
    }): number;
    providerStates(): Readonly<Record<'codex' | 'claude-code', 'OK' | 'NOT_PRESENT' | 'NOT_CONFIGURED'>>;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        studioAgents: StudioAgentsRuntime;
    }
}
/** Mount the Studio-only delegation gate. Generic tool-subagent is deliberately not exposed. */
export declare function apply(ctx: Context, config?: Config): Promise<void>;
export declare function approvedGrantFor(ctx: Pick<Context, 'agents'>, agent: Agent, approved: ReadonlyMap<string, {
    readonly tier: 'T2' | 'T3';
    readonly worktreePath: string;
}>): PolicyDelegationGrant | undefined;
//# sourceMappingURL=index.d.ts.map