/** PostgreSQL backend plugin for durable, single-writer Studio domains. */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import z from '@deepseek-ai/schemastery'
import type { DistributedCapacityGovernor } from '@dz23-studio/runtime-governor'
import { PostgresStorageBackend } from './backend.js'
import { PostgresCapacityGovernor } from './capacity.js'
import { assertConfiguredSchemaName } from './schema.js'

export { PostgresStorageBackend } from './backend.js'
export type { PostgresStorageBackendConfig } from './backend.js'
export { StudioStorageError } from './errors.js'
export { PostgresCapacityGovernor } from './capacity.js'
export type { PostgresCapacityGovernorOptions } from './capacity.js'
export type { CapacityTakeoverRequest } from '@dz23-studio/runtime-governor'
export { CAPACITY_POSTGRES_LAYOUT_VERSION } from './capacity-schema.js'
export {
  POSTGRES_IDENTIFIER_MAX_LENGTH,
  POSTGRES_SCHEMA_MAX_LENGTH,
  STORAGE_POSTGRES_LAYOUT_VERSION,
  assertConfiguredSchemaName,
  storageUnitLockName,
} from './schema.js'

export const name = 'storage-postgres'
export const inject = ['storage', 'credentials']

declare module '@deepseek-ai/cordis' {
  interface Context { studioCapacity: DistributedCapacityGovernor }
}

export interface Config {
  dsnRef: string
  schema?: string
  ssl?: 'off' | 'require' | 'verify-full'
  poolMax?: number
}

export const Config: z<Config> = z.object({
  dsnRef: z.string().role('credential-ref').required(),
  schema: z.string().default('dz23_storage'),
  ssl: z.union(['off', 'require', 'verify-full'] as const).default('verify-full'),
  poolMax: z.number().step(1).min(1).max(32).default(4),
})

export async function apply(ctx: Context, config: Config): Promise<void> {
  const schema = config.schema ?? 'dz23_storage'
  assertConfiguredSchemaName(schema)
  const resolved = await ctx.credentials.resolve(credentialRef(config.dsnRef))
  if (resolved === undefined) {
    throw new Error(`storage-postgres: credential reference '${config.dsnRef}' is not configured`)
  }
  const sslMode = config.ssl ?? 'verify-full'
  const ssl = sslMode === 'off'
    ? false
    : { rejectUnauthorized: sslMode === 'verify-full' }
  const backend = new PostgresStorageBackend({
    connectionString: resolved.value,
    schema,
    ssl,
    poolMax: config.poolMax ?? 4,
  })
  const capacity = new PostgresCapacityGovernor({
    connectionString: resolved.value,
    schema,
    ssl,
    poolMax: Math.min(4, config.poolMax ?? 4),
  })
  try {
    await Promise.all([backend.waitUntilReady(), capacity.waitUntilReady()])
  } catch (error) {
    await Promise.allSettled([backend.close(), capacity.close()])
    throw new Error('storage-postgres: PostgreSQL is unavailable or incompatible', { cause: error })
  }
  ctx.effect(() => {
    const dispose = ctx.storage.backend.register('postgres', backend)
    return async () => {
      dispose()
      await Promise.all([backend.close(), capacity.close()])
    }
  }, 'storage-postgres.registerBackend')
  ctx.provide(storageBackendServiceKey('postgres'), backend)
  ctx.provide('studioCapacity', capacity)
}
