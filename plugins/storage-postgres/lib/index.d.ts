/** PostgreSQL backend plugin for durable, single-writer Studio domains. */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export { PostgresStorageBackend } from './backend.js';
export type { PostgresStorageBackendConfig } from './backend.js';
export { StudioStorageError } from './errors.js';
export { POSTGRES_SCHEMA_MAX_LENGTH, STORAGE_POSTGRES_LAYOUT_VERSION } from './schema.js';
export declare const name = "storage-postgres";
export declare const inject: string[];
export interface Config {
    dsnRef: string;
    schema?: string;
    ssl?: 'off' | 'require' | 'verify-full';
    poolMax?: number;
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): Promise<void>;
//# sourceMappingURL=index.d.ts.map