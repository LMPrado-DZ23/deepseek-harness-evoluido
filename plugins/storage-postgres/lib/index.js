import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { storageBackendServiceKey } from '@deepseek-ai/dsh-storage';
import z from '@deepseek-ai/schemastery';
import { PostgresStorageBackend } from './backend.js';
import { assertConfiguredSchemaName } from './schema.js';
export { PostgresStorageBackend } from './backend.js';
export { StudioStorageError } from './errors.js';
export { POSTGRES_IDENTIFIER_MAX_LENGTH, POSTGRES_SCHEMA_MAX_LENGTH, STORAGE_POSTGRES_LAYOUT_VERSION, assertConfiguredSchemaName, storageUnitLockName, } from './schema.js';
export const name = 'storage-postgres';
export const inject = ['storage', 'credentials'];
export const Config = z.object({
    dsnRef: z.string().role('credential-ref').required(),
    schema: z.string().default('dz23_storage'),
    ssl: z.union(['off', 'require', 'verify-full']).default('verify-full'),
    poolMax: z.number().step(1).min(1).max(32).default(4),
});
export async function apply(ctx, config) {
    const schema = config.schema ?? 'dz23_storage';
    assertConfiguredSchemaName(schema);
    const resolved = await ctx.credentials.resolve(credentialRef(config.dsnRef));
    if (resolved === undefined) {
        throw new Error(`storage-postgres: credential reference '${config.dsnRef}' is not configured`);
    }
    const sslMode = config.ssl ?? 'verify-full';
    const ssl = sslMode === 'off'
        ? false
        : { rejectUnauthorized: sslMode === 'verify-full' };
    const backend = new PostgresStorageBackend({
        connectionString: resolved.value,
        schema,
        ssl,
        poolMax: config.poolMax ?? 4,
    });
    try {
        await backend.waitUntilReady();
    }
    catch (error) {
        await backend.close();
        throw new Error('storage-postgres: PostgreSQL is unavailable or incompatible', { cause: error });
    }
    ctx.effect(() => {
        const dispose = ctx.storage.backend.register('postgres', backend);
        return async () => {
            dispose();
            await backend.close();
        };
    }, 'storage-postgres.registerBackend');
    ctx.provide(storageBackendServiceKey('postgres'), backend);
}
