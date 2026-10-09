export declare class Semaphore {
    #private;
    private readonly maximum;
    constructor(maximum: number);
    acquire(signal: AbortSignal): Promise<() => void>;
    get active(): number;
    get queued(): number;
}
//# sourceMappingURL=semaphore.d.ts.map