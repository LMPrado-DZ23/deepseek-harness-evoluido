import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { PolicyDelegationGrant } from '@dz23-studio/policy';
import { type AgentLeaseRecord, type AgentRunRecord } from './model.js';
import { StudioAgentService, type AgentRestartReconciliation, type DelegationRequest } from './service.js';
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
    providerStates(): Readonly<Record<'codex' | 'claude-code', 'OK' | 'NOT_PRESENT' | 'NOT_CONFIGURED'>>;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        studioAgents: StudioAgentsRuntime;
    }
}
/** Mount the Studio-only delegation gate. Generic tool-subagent is deliberately not exposed. */
export declare function apply(ctx: Context, config?: Config): Promise<void>;
export declare function hasApprovedAncestor(ctx: Pick<Context, 'agents'>, agent: Agent, approved: ReadonlySet<string>): boolean;
export declare function approvedGrantFor(ctx: Pick<Context, 'agents'>, agent: Agent, approved: ReadonlyMap<string, {
    readonly tier: 'T2' | 'T3';
    readonly worktreePath: string;
}>): PolicyDelegationGrant | undefined;
export declare function startDelegation(ctx: Context, request: DelegationRequest): import("./service.js").DelegationAccepted;
//# sourceMappingURL=index.d.ts.map