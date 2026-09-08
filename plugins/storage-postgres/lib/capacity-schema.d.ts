import type { Pool, PoolClient } from 'pg';
import type { CapacityLimits } from '@dz23-studio/runtime-governor';
export declare const CAPACITY_POSTGRES_LAYOUT_VERSION = 1;
export declare function capacityMetaTable(schema: string): string;
export declare function capacityLeasesTable(schema: string): string;
export declare function capacitySchemaLockName(schema: string): string;
export declare function storageMaintenanceLockName(schema: string): string;
export declare function canonicalCapacityLimits(limits: CapacityLimits): CapacityLimits;
export declare function ensureCapacitySchema(pool: Pool, schema: string, limits: CapacityLimits): Promise<void>;
export declare function assertSchemaProtected(client: PoolClient, schema: string): Promise<void>;
//# sourceMappingURL=capacity-schema.d.ts.map