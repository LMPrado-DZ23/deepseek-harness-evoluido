import type { Pool, PoolClient } from 'pg'
import type { CapacityLimits } from '@dz23-studio/runtime-governor'
import { assertConfiguredSchemaName, quoteIdentifier } from './schema.js'

export const CAPACITY_POSTGRES_LAYOUT_VERSION = 1

export function capacityMetaTable(schema: string): string {
  return `${quoteIdentifier(schema)}."capacity_meta"`
}

export function capacityLeasesTable(schema: string): string {
  return `${quoteIdentifier(schema)}."capacity_leases"`
}

export function capacitySchemaLockName(schema: string): string {
  assertConfiguredSchemaName(schema)
  return `dz23-capacity-schema:${schema}`
}

export function storageMaintenanceLockName(schema: string): string {
  assertConfiguredSchemaName(schema)
  return `dz23-storage-maintenance:${schema}`
}

export function canonicalCapacityLimits(limits: CapacityLimits): CapacityLimits {
  return {
    'prompt-job': { ...limits['prompt-job'] },
    build: { ...limits.build },
    preview: { ...limits.preview },
  }
}

export async function ensureCapacitySchema(pool: Pool, schema: string, limits: CapacityLimits): Promise<void> {
  assertConfiguredSchemaName(schema)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await assertSchemaProtected(client, schema)
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [capacitySchemaLockName(schema)])
    const quoted = quoteIdentifier(schema)
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoted}`)
    await client.query(`CREATE TABLE IF NOT EXISTS ${capacityMetaTable(schema)} (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      layout_version INTEGER NOT NULL CHECK (layout_version > 0),
      limits JSONB NOT NULL,
      next_fencing_token BIGINT NOT NULL CHECK (next_fencing_token >= 0 AND next_fencing_token <= 9007199254740991)
    )`)
    await client.query(`CREATE TABLE IF NOT EXISTS ${capacityLeasesTable(schema)} (
      lease_id TEXT PRIMARY KEY CHECK (char_length(lease_id) BETWEEN 1 AND 256 AND lease_id = btrim(lease_id)),
      fencing_token BIGINT UNIQUE NOT NULL CHECK (fencing_token > 0 AND fencing_token <= 9007199254740991),
      holder_id TEXT NOT NULL CHECK (char_length(holder_id) BETWEEN 1 AND 256 AND holder_id = btrim(holder_id)),
      owner_id TEXT UNIQUE NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 256 AND owner_id = btrim(owner_id)),
      org_id TEXT NOT NULL CHECK (char_length(org_id) BETWEEN 1 AND 256 AND org_id = btrim(org_id)),
      tenant_id TEXT NOT NULL CHECK (char_length(tenant_id) BETWEEN 1 AND 256 AND tenant_id = btrim(tenant_id)),
      project_id TEXT NOT NULL CHECK (char_length(project_id) BETWEEN 1 AND 256 AND project_id = btrim(project_id)),
      prompt_job_units INTEGER NOT NULL CHECK (prompt_job_units >= 0),
      build_units INTEGER NOT NULL CHECK (build_units >= 0),
      preview_units INTEGER NOT NULL CHECK (preview_units >= 0),
      acquired_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      CHECK (prompt_job_units + build_units + preview_units > 0),
      CHECK (expires_at > acquired_at)
    )`)
    await client.query(`CREATE INDEX IF NOT EXISTS capacity_leases_expires_idx ON ${capacityLeasesTable(schema)} (expires_at)`)
    await client.query(`CREATE INDEX IF NOT EXISTS capacity_leases_tenant_idx ON ${capacityLeasesTable(schema)} (org_id, tenant_id, expires_at)`)
    await client.query(`CREATE INDEX IF NOT EXISTS capacity_leases_project_idx ON ${capacityLeasesTable(schema)} (org_id, tenant_id, project_id, expires_at)`)

    const expectedLimits = canonicalCapacityLimits(limits)
    await client.query(
      `INSERT INTO ${capacityMetaTable(schema)} (singleton, layout_version, limits, next_fencing_token)
       VALUES (TRUE, $1, $2::jsonb, 0)
       ON CONFLICT (singleton) DO NOTHING`,
      [CAPACITY_POSTGRES_LAYOUT_VERSION, JSON.stringify(expectedLimits)],
    )
    const result = await client.query<{ layout_version: number; limits: CapacityLimits }>(
      `SELECT layout_version, limits FROM ${capacityMetaTable(schema)} WHERE singleton = TRUE FOR UPDATE`,
    )
    const row = result.rows[0]
    if (row === undefined || row.layout_version !== CAPACITY_POSTGRES_LAYOUT_VERSION) {
      throw new Error(`capacity postgres layout is incompatible with version ${CAPACITY_POSTGRES_LAYOUT_VERSION}`)
    }
    if (JSON.stringify(canonicalCapacityLimits(row.limits)) !== JSON.stringify(expectedLimits)) {
      throw new Error('capacity postgres limits differ from the limits already active in this schema')
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export async function assertSchemaProtected(client: PoolClient, schema: string): Promise<void> {
  const result = await client.query<{ acquired: boolean }>(
    'SELECT pg_try_advisory_xact_lock_shared(hashtext($1)) AS acquired',
    [storageMaintenanceLockName(schema)],
  )
  if (result.rows[0]?.acquired !== true) {
    throw new Error(`postgres storage schema '${schema}' is under exclusive maintenance`)
  }
}
