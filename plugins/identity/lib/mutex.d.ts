export declare class KeyedMutex {
    #private;
    run<T>(key: string, work: () => Promise<T>): Promise<T>;
}
//# sourceMappingURL=mutex.d.ts.map