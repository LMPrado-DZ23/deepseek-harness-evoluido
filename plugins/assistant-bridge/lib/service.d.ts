import { type AgentRunRecord, type DelegationAccepted, type DelegationBudget, type DelegationRequest, type StudioAgentsRuntime } from '@dz23-studio/agents';
import type { AgentTeamRecord, AgentTeamRole, AgentTeamTaskRecord, StudioAgentTeamRuntime } from '@dz23-studio/agent-team';
import { type StudioRole } from '@dz23-studio/policy';
import { type AssistantProvider } from './catalog.js';
import { type AssistantApprovalPort } from './approval.js';
export type AssistantSensitiveOperation = 'secrets' | 'external-network';
export interface AssistantRepositoryConfig {
    readonly orgId: string;
    readonly tenantId: string;
    readonly workspaceId: string;
    readonly repositoryPath: string;
    readonly allowedPaths: readonly string[];
    readonly providers: readonly AssistantProvider[];
    readonly budget?: DelegationBudget;
    readonly maxPaths?: number;
}
export interface ValidatedRepositoryConfig extends Omit<AssistantRepositoryConfig, 'repositoryPath' | 'allowedPaths' | 'providers' | 'maxPaths'> {
    readonly repositoryPath: string;
    readonly allowedPaths: readonly string[];
    readonly providers: ReadonlySet<AssistantProvider>;
    readonly maxPaths: number;
}
type AssistantAgent = DelegationRequest['parent'];
type AssistantJobId = DelegationAccepted['jobId'];
interface AssistantPrincipal {
    readonly userId: string;
    readonly orgId: string;
    readonly tenantId: string;
    readonly sessionId: string;
    readonly role: StudioRole;
}
export interface AssistantRunSummary {
    readonly run_id: string;
    readonly status: AgentRunRecord['status'];
    readonly provider: AssistantProvider;
    readonly changed_files: readonly string[];
    readonly diagnostic: string | null;
    readonly created_at: string;
    readonly updated_at: string;
}
export interface AssistantRunReview extends AssistantRunSummary {
    readonly diff_text: string;
    readonly main_changed_during_run: boolean;
}
export interface AssistantTeamTaskInput {
    readonly taskId: string;
    readonly title: string;
    readonly role: AgentTeamRole;
    readonly prompt: string;
    readonly intendedPaths: readonly string[];
    readonly dependsOn: readonly string[];
}
export interface AssistantTeamSummary {
    readonly team_id: string;
    readonly name: string;
    readonly status: AgentTeamRecord['status'];
    readonly required_tier: AgentTeamRecord['required_tier'];
    readonly diagnostic: string | null;
    readonly tasks: readonly Pick<AgentTeamTaskRecord, 'task_id' | 'title' | 'role' | 'status' | 'run_id' | 'depends_on' | 'diagnostic'>[];
    readonly created_at: string;
    readonly updated_at: string;
}
export declare class AssistantBridgeError extends Error {
    readonly code: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_CONFIGURED' | 'INVALID_REQUEST' | 'NOT_FOUND' | 'CANCEL_UNAVAILABLE';
    constructor(code: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_CONFIGURED' | 'INVALID_REQUEST' | 'NOT_FOUND' | 'CANCEL_UNAVAILABLE', message: string);
}
export interface AssistantBridgeDependencies {
    resolvePrincipal(agent: AssistantAgent): Omit<AssistantPrincipal, 'role'> | undefined;
    authorizationFor(userId: string, orgId: string, tenantId: string): {
        readonly role: StudioRole;
    } | undefined;
    readonly studioAgents: StudioAgentsRuntime;
    readonly studioAgentTeams?: StudioAgentTeamRuntime;
    /**
     * Autoridade de confirmação (M90-A). Ausente, toda operação T3 falha fechada:
     * o bridge nunca se autoconcede o nível sensível.
     */
    readonly approvalAuthority?: AssistantApprovalPort;
    killJob(jobId: AssistantJobId, owner: AssistantAgent, reason: string): 'requested' | 'already-finished';
}
export declare class StudioAssistantBridge {
    #private;
    private readonly dependencies;
    private constructor();
    static create(dependencies: AssistantBridgeDependencies, repositories: readonly AssistantRepositoryConfig[]): Promise<StudioAssistantBridge>;
    start(agent: AssistantAgent | undefined, input: {
        readonly provider: AssistantProvider;
        readonly prompt: string;
        readonly intendedPaths: readonly string[];
    }, sensitive?: AssistantSensitiveOperation): Promise<{
        run_id: string;
        job_id: string;
        status: "RUNNING";
        required_tier: import("@dz23-studio/agents").ApprovalTier;
    }>;
    startTeam(agent: AssistantAgent | undefined, input: {
        readonly provider: AssistantProvider;
        readonly name: string;
        readonly tasks: readonly AssistantTeamTaskInput[];
    }, sensitive?: AssistantSensitiveOperation | 'deploy'): Promise<AssistantTeamSummary>;
    listTeams(agent: AssistantAgent | undefined): readonly AssistantTeamSummary[];
    teamStatus(agent: AssistantAgent | undefined, teamId: string): Promise<AssistantTeamSummary>;
    continueTeam(agent: AssistantAgent | undefined, teamId: string, sensitive: boolean): Promise<AssistantTeamSummary>;
    cancelTeam(agent: AssistantAgent | undefined, teamId: string, reason?: string): Promise<AssistantTeamSummary>;
    list(agent: AssistantAgent | undefined): readonly AssistantRunSummary[];
    review(agent: AssistantAgent | undefined, runId: string): Promise<AssistantRunReview>;
    /**
     * A pessoa confirma que o programa externo realmente terminou - a única
     * saída do estado UNKNOWN. Nenhuma prova técnica sustentou essa conclusão,
     * então ela exige confirmação reforçada e um motivo escrito, e os dois ficam
     * gravados no registro da execução.
     * @param agent - a sessão do assistente que está pedindo.
     * @param runId - a execução parada em UNKNOWN.
     * @param reason - o que a pessoa verificou antes de decidir.
     * @returns a execução já encerrada, como ela ficou gravada.
     */
    resolveUnknownRun(agent: AssistantAgent | undefined, runId: string, reason: string): Promise<AssistantRunSummary>;
    cancel(agent: AssistantAgent | undefined, runId: string, reason?: string): {
        run_id: string;
        outcome: "requested" | "already-finished";
        limitation: string;
    };
    /** Called by the authoritative Harness job lifecycle; it never changes a persisted run. */
    releaseJob(jobId: AssistantJobId): void;
    /** Bounded diagnostic used by the runtime proof to detect stale cancel handles. */
    activeJobCount(): number;
    apply(agent: AssistantAgent | undefined, runId: string): Promise<import("@dz23-studio/agents").ProposalApplied>;
}
export declare function validateAssistantRepository(input: AssistantRepositoryConfig): Promise<ValidatedRepositoryConfig>;
export declare function normalizeRelativePath(value: string): string;
export {};
//# sourceMappingURL=service.d.ts.map