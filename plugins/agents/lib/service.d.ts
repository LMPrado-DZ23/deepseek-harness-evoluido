import type { Agent } from '@deepseek-ai/dsh-agent';
import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { SubagentRun } from '@deepseek-ai/dsh-subagent';
import type { AgentLeaseRecord, AgentRunRecord } from './model.js';
export { GitWorktreeManager, assertInsideWorktree } from './git.js';
export type AgentProvider = 'spawn-in-process' | 'codex' | 'claude-code';
export type ApprovalTier = 'T2' | 'T3';
export interface DelegationApproval {
    readonly approved: boolean;
    readonly tier: ApprovalTier;
    readonly approvedBy: string;
}
export interface DelegationBudget {
    readonly timeoutMs?: number;
    readonly maxFiles?: number;
    readonly maxDiffBytes?: number;
    readonly maxTokens?: number;
}
export interface DelegationRequest {
    readonly orgId: string;
    readonly tenantId: string;
    readonly workspaceId: string;
    readonly repositoryPath: string;
    readonly parent: Agent;
    readonly provider: AgentProvider;
    readonly prompt: string;
    readonly intendedPaths: readonly string[];
    readonly approval: DelegationApproval;
    readonly touchesDeploy?: boolean;
    readonly touchesSecrets?: boolean;
    readonly usesExternalNetwork?: boolean;
    readonly budget?: DelegationBudget;
    readonly inProcess?: {
        readonly toolFilter?: unknown;
        readonly persona?: string;
    };
}
export interface WorktreeSnapshot {
    readonly repositoryPath: string;
    readonly worktreePath: string;
    readonly baseCommit: string;
    readonly mainFingerprint: string;
}
export interface WorktreeDiff {
    readonly text: string;
    readonly bytes: number;
    readonly files: readonly string[];
}
export interface WorktreePort {
    create(repositoryPath: string, runId: string): Promise<WorktreeSnapshot>;
    diff(snapshot: WorktreeSnapshot): Promise<WorktreeDiff>;
    mainFingerprint(repositoryPath: string): Promise<string>;
    applyProposal(record: AgentRunRecord): Promise<void>;
}
export interface CoordinatorHandle {
    readonly sessionId: SessionId;
    readonly agent: Agent;
    dispose(): Promise<void>;
}
export interface CoordinatorPort {
    create(cwd: string, parentSessionId: SessionId, provider: AgentProvider, approvedTier: ApprovalTier): Promise<CoordinatorHandle>;
}
export interface SubagentPort {
    start(provider: AgentProvider, request: {
        readonly parent: Agent;
        readonly prompt: ContentBlock[];
        readonly signal: AbortSignal;
        readonly inProcess?: DelegationRequest['inProcess'];
    }): Promise<SubagentRun>;
}
export interface UsagePort {
    tokensFor(run: SubagentRun): number | undefined;
}
export interface StrongIdentityPort {
    strongIdentityVerified(parentSessionId: SessionId): boolean;
}
export interface AgentRepository {
    runs(): readonly AgentRunRecord[];
    leases(): readonly AgentLeaseRecord[];
    putRun(record: AgentRunRecord): Promise<void>;
    putLease(record: AgentLeaseRecord): Promise<void>;
}
export interface JobPort {
    start(spec: {
        readonly kind: 'studio-agent';
        readonly label: string;
        readonly owner: Agent;
        run(): {
            cancel(reason?: string): void;
            done: Promise<JobOutcome>;
        };
    }): JobId;
}
export interface DelegationAccepted {
    readonly runId: string;
    readonly jobId: JobId;
    readonly requiredTier: ApprovalTier;
}
export interface ProposalApplied {
    readonly runId: string;
    readonly status: 'APPLIED';
    readonly changedFiles: readonly string[];
}
export declare class DelegationError extends Error {
    readonly code: 'APPROVAL_REQUIRED' | 'WRITE_CONFLICT' | 'INVALID_PATH' | 'INVALID_STATE' | 'PROPOSAL_TAMPERED';
    constructor(code: 'APPROVAL_REQUIRED' | 'WRITE_CONFLICT' | 'INVALID_PATH' | 'INVALID_STATE' | 'PROPOSAL_TAMPERED', message: string);
}
export declare class StudioAgentService {
    #private;
    private readonly dependencies;
    constructor(dependencies: {
        readonly repository: AgentRepository;
        readonly worktrees: WorktreePort;
        readonly coordinators: CoordinatorPort;
        readonly subagents: SubagentPort;
        readonly identity: StrongIdentityPort;
        readonly usage?: UsagePort;
        readonly jobs: JobPort;
        readonly now?: () => Date;
        readonly createId?: () => string;
    });
    start(request: DelegationRequest): DelegationAccepted;
    applyProposal(runId: string, approval: DelegationApproval): Promise<ProposalApplied>;
}
//# sourceMappingURL=service.d.ts.map