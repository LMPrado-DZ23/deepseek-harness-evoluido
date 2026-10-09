export interface ReplayClaimPort {
    claim(requestId: string): Promise<void>;
}
export interface RpcReplayValue {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
}
export interface RpcReplayPort {
    run(requestId: string, fingerprint: string, operation: () => Promise<RpcReplayValue>): Promise<RpcReplayValue>;
}
export declare class RpcReplayGuard implements RpcReplayPort {
    #private;
    private readonly maximum;
    constructor(maximum?: number);
    run(requestId: string, fingerprint: string, operation: () => Promise<RpcReplayValue>): Promise<RpcReplayValue>;
}
export declare class ReplayGuard implements ReplayClaimPort {
    #private;
    private readonly now;
    private readonly ttlMs;
    private readonly maximum;
    constructor(now?: () => number, ttlMs?: number, maximum?: number);
    claim(requestId: string): Promise<void>;
}
//# sourceMappingURL=replay.d.ts.map