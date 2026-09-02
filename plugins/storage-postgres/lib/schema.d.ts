import type { Pool } from 'pg';
export declare const STORAGE_POSTGRES_LAYOUT_VERSION = 1;
export declare const POSTGRES_SCHEMA_MAX_LENGTH = 40;
export declare function assertIdentifier(value: string, label: string): void;
export declare function quoteIdentifier(value: string): string;
export declare function recordsTable(schema: string): string;
export declare function globalsTable(schema: string): string;
export declare function unitsTable(schema: string): string;
export declare function leasesTable(schema: string): string;
/** Create and version the physical layout under a database advisory lock. */
export declare function ensureSchema(pool: Pool, schema: string): Promise<void>;
//# sourceMappingURL=schema.d.ts.map