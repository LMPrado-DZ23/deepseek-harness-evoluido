import type { AgentRunRecord } from './model.js';
import { type WorktreeDiff, type WorktreePort, type WorktreeSnapshot } from './service.js';
export declare function isolatedGitEnvironment(indexFile?: string): NodeJS.ProcessEnv;
export declare class GitWorktreeManager implements WorktreePort {
    private readonly worktreeRoot;
    constructor(worktreeRoot: string);
    create(repositoryPath: string, runId: string): Promise<WorktreeSnapshot>;
    diff(snapshot: WorktreeSnapshot): Promise<WorktreeDiff>;
    mainFingerprint(repositoryPath: string): Promise<string>;
    applyProposal(record: AgentRunRecord): Promise<void>;
}
//# sourceMappingURL=git.d.ts.map