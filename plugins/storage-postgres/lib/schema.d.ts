import type { Pool } from 'pg';
export declare const STORAGE_POSTGRES_LAYOUT_VERSION = 1;
export declare const INSTALLATION_ID_KEY = "installation_id";
export declare const POSTGRES_SCHEMA_MAX_LENGTH = 40;
export declare const POSTGRES_IDENTIFIER_MAX_LENGTH = 63;
export declare function assertIdentifier(value: string, label: string): void;
export declare function assertConfiguredSchemaName(value: string): void;
export declare function quoteIdentifier(value: string): string;
export declare function storageUnitLockName(schema: string, unit: string): string;
/**
 * Schema-wide maintenance lock. A running Studio holds it in SHARED mode for
 * as long as it is up; restore and migration take it EXCLUSIVE. That is what
 * makes "the Studio is still running" a refusal even when the incoming bundle
 * mentions none of the units the Studio has open — per-unit locks alone would
 * leave those units unprotected in front of a `DROP SCHEMA`.
 */
export declare function storageMaintenanceLockName(schema: string): string;
export declare function recordsTable(schema: string): string;
export declare function globalsTable(schema: string): string;
export declare function unitsTable(schema: string): string;
export declare function leasesTable(schema: string): string;
export declare function tenantRecordsTable(schema: string): string;
/** Create and version the physical layout under a database advisory lock. */
export declare function ensureSchema(pool: Pool, schema: string): Promise<void>;
//# sourceMappingURL=schema.d.ts.map