import type { AgentRunRecord } from './model.js';
import { type WorktreeDiff, type WorktreePort, type WorktreeSnapshot } from './service.js';
export declare class GitWorktreeManager implements WorktreePort {
    private readonly worktreeRoot;
    constructor(worktreeRoot: string);
    create(repositoryPath: string, runId: string): Promise<WorktreeSnapshot>;
    diff(snapshot: WorktreeSnapshot): Promise<WorktreeDiff>;
    mainFingerprint(repositoryPath: string): Promise<string>;
    applyProposal(record: AgentRunRecord): Promise<void>;
}
export declare function assertInsideWorktree(worktreePath: string, candidate: string): string;
//# sourceMappingURL=git.d.ts.map