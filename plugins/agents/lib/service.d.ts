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
        /**
         * A restrição de ferramentas do filho, TIPADA.
         *
         * Era `unknown`, e o `as never` do lado do adaptador completava o cano:
         * qualquer forma atravessava o typecheck, e o único lugar do sistema que
         * conhece a forma certa era o Harness, em tempo de execução. Foi por esse
         * cano que uma permissão nomeando ferramenta inexistente passou até
         * derrubar a delegação de verdade.
         */
        readonly toolFilter?: {
            readonly allow?: readonly string[];
            readonly deny?: readonly string[];
        };
        readonly persona?: string;
    };
    /**
     * O trabalho interrompido cuja CÓPIA ISOLADA será reaproveitada (A-03).
     *
     * Preenchido só por `resume`. Presente, a execução confere e reusa a cópia em
     * vez de criar uma nova — que é a diferença entre retomar e recomeçar.
     */
    readonly resumeFrom?: Pick<AgentRunRecord, 'repository_path' | 'worktree_path' | 'base_commit'>;
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
    /**
     * A cópia isolada que JÁ EXISTE, conferida e devolvida sem ser tocada (A-03).
     *
     * É o que separa retomar de recomeçar: `create` faz `reset --hard`, que
     * apagaria o trabalho parcial que sobreviveu ao reinício — que é exatamente o
     * que a retomada existe para aproveitar. Aqui só se confere que a cópia ainda
     * é do repositório certo, ainda está no lugar certo e ainda parte do mesmo
     * commit, e devolve-se o retrato.
     */
    resume(record: Pick<AgentRunRecord, 'repository_path' | 'worktree_path' | 'base_commit'>): Promise<WorktreeSnapshot>;
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
/**
 * A pergunta que toda delegação nova faz antes de começar.
 *
 * Interface estrutural de propósito: o plugin de agentes continua subindo em
 * perfil sem botão de emergência. A recusa vem como `Error` com
 * `code === 'STOPPED'` e uma frase já escrita para uma pessoa.
 */
export interface EmergencyStopGuard {
    assertRunning(scope: {
        readonly orgId: string;
        readonly tenantId: string;
    }): void;
}
/** Uma execução que recebeu o pedido de parada e cujo fim o Studio NÃO consegue provar. */
export interface UnprovenAgentStop {
    readonly runId: string;
    readonly provider: AgentProvider;
}
/** O que a parada de emergência alcançou nos assistentes de um escopo. */
export interface AgentScopeCancellation {
    readonly cancelled: number;
    readonly unproven: readonly UnprovenAgentStop[];
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
/** A cerca que uma reserva carrega. Reserva antiga, sem o campo, vale como 0 — a mais fraca. */
export declare function leaseFence(lease: Pick<AgentLeaseRecord, 'fence'>): number;
/**
 * O próximo número de cerca para um repositório dentro de um espaço de trabalho.
 *
 * Derivado do MAIOR já visto ali, e não de um contador em memória: um contador
 * em memória voltaria a zero no reinício, e a primeira reserva depois de um
 * reinício receberia um número menor do que o da reserva que ela precisa
 * superar — exatamente o zumbi que a cerca existe para barrar, com os papéis
 * trocados. Reservas liberadas continuam contando: elas são liberadas, nunca
 * apagadas.
 * @param leases - todas as reservas conhecidas.
 * @param scope - o espaço de trabalho e o repositório.
 * @returns o número a gravar na reserva nova.
 */
export declare function nextFence(leases: readonly AgentLeaseRecord[], scope: {
    readonly workspaceId: string;
    readonly repositoryPath: string;
}): number;
/**
 * A cerca que TORNOU VELHA a desta execução, quando existe.
 *
 * Só conta reserva de OUTRA execução, no mesmo repositório do mesmo espaço de
 * trabalho, que toque algum dos mesmos caminhos e que tenha número MAIOR.
 * Empate não supera: duas reservas com o mesmo número seriam um defeito de
 * `nextFence`, e tratar empate como superação faria uma execução barrar a si
 * mesma numa releitura.
 * @param leases - todas as reservas conhecidas.
 * @param runId - a execução que quer escrever.
 * @returns o número que a superou, ou `undefined` quando ela ainda é a mais nova.
 */
export declare function supersedingFence(leases: readonly AgentLeaseRecord[], runId: string): number | undefined;
export declare class StudioAgentService {
    #private;
    private readonly dependencies;
    constructor(dependencies: {
        readonly repository: AgentRepository;
        readonly worktrees: WorktreePort;
        readonly coordinators: CoordinatorPort;
        readonly subagents: SubagentPort;
        readonly identity: StrongIdentityPort;
        /** Ausente = nenhum botão de emergência montado neste perfil, e nada a perguntar. */
        readonly emergencyStop?: EmergencyStopGuard;
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
     * Se este trabalho pode ser RETOMADO (A-03).
     *
     * Duas condições, e as duas são recusas de segurança, não de conveniência:
     *
     * - o Studio tem que ter PROVADO que ele parou. `UNKNOWN` significa
     *   "pode estar rodando por fora agora"; retomar ali seria colocar dois
     *   trabalhadores escrevendo na mesma cópia, e o segundo nem saberia do
     *   primeiro. `survivesRestart` é a mesma regra que a reconciliação usa;
     * - ele tem que ter sido interrompido por um reinício, e não ter falhado
     *   sozinho, estourado o orçamento ou sido cancelado por alguém. Retomar um
     *   trabalho que a pessoa CANCELOU seria desfazer o cancelamento dela.
     * @param run - o registro.
     * @returns se `resumeRun` aceitaria este trabalho.
     */
    static resumable(run: Pick<AgentRunRecord, 'status' | 'provider' | 'interrupted_by_restart'>): boolean;
    /**
     * Retoma um trabalho interrompido por um reinício, NA CÓPIA QUE SOBROU.
     *
     * O que é retomado é o trabalho, não o processo: o processo antigo morreu com
     * o Studio (é a condição para chegar aqui). O que sobrevive e é aproveitado é
     * a cópia isolada com o que já tinha sido escrito — e é por isso que a
     * retomada usa `worktrees.resume`, que confere e devolve, em vez de `create`,
     * que faria `reset --hard` e apagaria justamente aquilo.
     *
     * A retomada é um ato da PESSOA e pede a mesma confirmação da delegação
     * original: ela vai fazer um assistente escrever de novo nos arquivos dela.
     *
     * A reserva nova recebe uma CERCA nova, maior. Se enquanto isso outro
     * trabalho pegou os mesmos arquivos, quem perde é o mais velho — inclusive
     * este, se ele for o mais velho na hora de aplicar.
     * @param runId - o trabalho interrompido.
     * @param request - o pedido, com a confirmação da pessoa.
     * @returns o identificador do trabalho novo e o do trabalho retomado.
     */
    resume(runId: string, request: DelegationRequest): DelegationAccepted & {
        readonly resumedFrom: string;
    };
    /**
     * Uma pessoa confirma que o programa externo terminou. E a unica saida do
     * estado UNKNOWN, e exige motivo: o registro precisa dizer quem decidiu e
     * por que, porque nenhuma prova tecnica sustentou essa conclusao.
     */
    resolveUnknownRun(runId: string, reason: string): Promise<void>;
    /**
     * Cancela toda delegação em voo de UM escopo, para uma parada de emergência.
     *
     * O que o Studio consegue provar morto entra em `cancelled`; o que ele não
     * consegue entra em `unproven` com o provedor pelo nome. A regra é a mesma de
     * `survivesRestart`: `spawn-in-process` morre junto com o processo do Studio,
     * enquanto `codex` e `claude-code` são processos do sistema operacional com
     * vida própria - o pedido de parada sai, e o Studio NÃO tem como provar que
     * eles pararam. Contá-los como cancelados seria a mentira que a tela de
     * emergência não pode contar.
     * @param scope - a organização e o inquilino parados.
     * @returns o que parou e o que não pôde ser provado morto.
     */
    cancelScope(scope: {
        readonly orgId: string;
        readonly tenantId: string;
    }): AgentScopeCancellation;
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