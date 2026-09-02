import type { Client } from 'pg';
import type { KvUnit, KvUnitDescriptor } from '@deepseek-ai/dsh-storage';
export interface PostgresKvUnitOptions {
    client: Client;
    descriptor: KvUnitDescriptor;
    schema: string;
    holder: string;
    heartbeatMs: number;
    onClose: () => void;
}
/** One unit and its session-scoped writer lock share the same connection. */
export declare class PostgresKvUnit implements KvUnit {
    private readonly options;
    private readonly tables;
    private readonly heartbeat;
    private closed;
    private leaseLost;
    private closing;
    constructor(options: PostgresKvUnitOptions);
    loadAll(): Promise<{
        tables: Record<string, Record<string, unknown>>;
        global: unknown;
    }>;
    putRecord(table: string, key: string, value: unknown): Promise<void>;
    deleteRecord(table: string, key: string): Promise<void>;
    setGlobal(value: unknown): Promise<void>;
    close(): Promise<void>;
    private touchLease;
    private doClose;
    private ensureOpen;
    private assertTable;
    private markLeaseLost;
    private operationFailure;
    private lockName;
}
//# sourceMappingURL=unit.d.ts.map