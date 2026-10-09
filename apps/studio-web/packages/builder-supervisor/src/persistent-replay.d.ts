import type { BuilderErrorCode, BuildState, ExportedArtifact, FinishResult } from './model.js';
import type { ReplayClaimPort, RpcReplayPort, RpcReplayValue } from './replay.js';
export interface PersistentReplayRuntime {
    readonly platform: NodeJS.Platform;
    readonly getuid: (() => number) | undefined;
    readonly randomHex: (bytes: number) => string;
    readonly inspectDirectory?: (path: string) => Promise<{
        readonly resolved: string;
        readonly directory: boolean;
        readonly symbolicLink: boolean;
        readonly mode: number;
        readonly uid: number;
    }>;
}
export declare class FileRpcReplayGuard implements RpcReplayPort {
    #private;
    private readonly maximum;
    private readonly retentionMs;
    private readonly now;
    private readonly runtime;
    constructor(directory: string, maximum?: number, retentionMs?: number, now?: () => number, runtime?: PersistentReplayRuntime);
    initialize(): Promise<void>;
    run(requestId: string, fingerprint: string, operation: () => Promise<RpcReplayValue>): Promise<RpcReplayValue>;
}
export declare class FileReplayGuard implements ReplayClaimPort {
    #private;
    private readonly maximum;
    private readonly retentionMs;
    private readonly now;
    private readonly runtime;
    constructor(directory: string, maximum?: number, retentionMs?: number, now?: () => number, runtime?: PersistentReplayRuntime);
    claim(requestId: string): Promise<void>;
}
export interface BuildJournalRecord {
    readonly build_id: string;
    readonly build_ref: string;
    readonly build_state: BuildState;
    readonly exported: ExportedArtifact | null;
    readonly cleanup_pending: boolean;
    readonly finish_result: FinishResult | null;
    readonly finish_error: BuilderErrorCode | null;
}
export interface BuildIdClaimPort {
    claim(buildId: string, buildRef: string): Promise<void>;
    update(record: BuildJournalRecord): Promise<void>;
    release(buildId: string): Promise<void>;
    complete(record: BuildJournalRecord): Promise<void>;
    list(): Promise<readonly BuildJournalRecord[]>;
}
export declare class FileBuildIdGuard implements BuildIdClaimPort {
    #private;
    private readonly directory;
    private readonly maximum;
    private readonly retentionMs;
    private readonly now;
    private readonly runtime;
    constructor(directory: string, maximum?: number, retentionMs?: number, now?: () => number, runtime?: PersistentReplayRuntime);
    claim(buildId: string, buildRef?: string): Promise<void>;
    update(record: BuildJournalRecord): Promise<void>;
    release(buildId: string): Promise<void>;
    complete(value: BuildJournalRecord | string): Promise<void>;
    list(): Promise<readonly BuildJournalRecord[]>;
}
//# sourceMappingURL=persistent-replay.d.ts.map