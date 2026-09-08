import type { AgentRunRecord } from './model.js';
import { type WorktreeDiff, type WorktreePort, type WorktreeSnapshot } from './service.js';
export declare function isolatedGitEnvironment(indexFile?: string): NodeJS.ProcessEnv;
export declare class GitWorktreeManager implements WorktreePort {
    private readonly worktreeRoot;
    constructor(worktreeRoot: string);
    create(repositoryPath: string, runId: string): Promise<WorktreeSnapshot>;
    /**
     * A cópia isolada que sobreviveu ao reinício, CONFERIDA e devolvida intacta.
     *
     * A diferença para `create` é o que NÃO se faz aqui: não há `worktree add` e
     * não há `reset --hard`. O `reset` é justamente o que apagaria o trabalho
     * parcial que a retomada existe para aproveitar.
     *
     * O que se faz é a mesma conferência de sempre — a cópia tem que estar dentro
     * da raiz de worktrees do Studio, tem que estar registrada como worktree
     * DESTE repositório, e tem que partir do mesmo commit base. Uma cópia que
     * alguém trocou por outra coisa reprova em `verifiedWorktreeBinding` antes de
     * qualquer assistente escrever nela.
     * @param record - o registro do trabalho interrompido.
     * @returns o retrato da cópia, com a impressão atual do repositório principal.
     */
    resume(record: Pick<AgentRunRecord, 'repository_path' | 'worktree_path' | 'base_commit'>): Promise<WorktreeSnapshot>;
    diff(snapshot: WorktreeSnapshot): Promise<WorktreeDiff>;
    mainFingerprint(repositoryPath: string): Promise<string>;
    applyProposal(record: AgentRunRecord): Promise<void>;
}
//# sourceMappingURL=git.d.ts.map