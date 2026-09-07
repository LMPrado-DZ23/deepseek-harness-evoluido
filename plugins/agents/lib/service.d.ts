import type { Agent } from '@deepseek-ai/dsh-agent';
import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { SubagentRun } from '@deepseek-ai/dsh-subagent';
import type { AgentLeaseRecord, AgentRunRecord } from './model.js';
export { GitWorktreeManager } from './git.js';
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
    hasLiveJobs(): boolean;
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
export interface AgentRestartReconciliation {
    readonly interruptedRuns: number;
    readonly releasedLeases: number;
    /**
     * Execucoes cujo trabalhador externo nao pode ser provado morto. Elas NAO
     * viram falha e a reserva de arquivos delas NAO e liberada.
     */
    readonly unresolvedRuns: number;
    readonly keptLeases: number;
    readonly reconciledAt: string;
}
/**
 * Prazo para o encerramento ativo. O que continuar vivo depois disso nao e
 * declarado morto: fica para a reconciliacao do proximo inicio.
 */
export declare const SHUTDOWN_DEADLINE_MS = 15000;
/**
 * `spawn-in-process` morre junto com o Studio, entao um reinicio ja e prova de
 * que terminou. `codex` e `claude-code` sao processos do sistema operacional
 * com vida propria: o pin do Harness nao entrega identidade de processo pelo
 * seam publico, entao o Studio NAO consegue provar que eles morreram - e nao
 * vai fingir que consegue.
 */
export declare function survivesRestart(provider: AgentProvider): boolean;
export declare class DelegationError extends Error {
    readonly code: 'APPROVAL_REQUIRED' | 'WRITE_CONFLICT' | 'INVALID_PATH' | 'INVALID_STATE' | 'PROPOSAL_TAMPERED' | 'WORKTREE_TAMPERED';
    constructor(code: 'APPROVAL_REQUIRED' | 'WRITE_CONFLICT' | 'INVALID_PATH' | 'INVALID_STATE' | 'PROPOSAL_TAMPERED' | 'WORKTREE_TAMPERED', message: string);
}
export declare function normalizeDelegationPath(value: string, allowWildcard?: boolean, invalid?: (path: string) => Error): string;
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
    reconcileInterruptedRuns(): Promise<AgentRestartReconciliation>;
    start(request: DelegationRequest): DelegationAccepted;
    /** Recompute and verify a proposal without applying it or persisting its body. */
    reviewProposal(runId: string): Promise<WorktreeDiff>;
    applyProposal(runId: string, approval: DelegationApproval): Promise<ProposalApplied>;
    /**
     * Uma pessoa confirma que o programa externo terminou. E a unica saida do
     * estado UNKNOWN, e exige motivo: o registro precisa dizer quem decidiu e
     * por que, porque nenhuma prova tecnica sustentou essa conclusao.
     */
    resolveUnknownRun(runId: string, reason: string): Promise<void>;
    /**
     * Encerramento ativo com prazo. Pede cancelamento a tudo que esta em voo e
     * espera ate `SHUTDOWN_DEADLINE_MS`. O que sobreviver ao prazo NAO e
     * declarado morto - fica para a reconciliacao do proximo inicio.
     */
    shutdown(deadlineMs?: number): Promise<{
        readonly stopped: number;
        readonly pending: number;
    }>;
}
//# sourceMappingURL=service.d.ts.map