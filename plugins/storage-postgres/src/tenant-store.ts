import { Client, Pool } from 'pg'
import type { PoolClient, PoolConfig } from 'pg'
import { UNIT_NAME_RE } from '@deepseek-ai/dsh-storage'
import { withoutTlsParams } from './dsn.js'
import { assertIdentifier, quoteIdentifier, tenantRecordsTable } from './schema.js'

export interface TenantScope {
  readonly orgId: string
  readonly tenantId: string
}

export interface TenantRecord<T = unknown> {
  readonly key: string
  readonly value: T
}

export interface PostgresTenantStoreConfig {
  readonly adminConnectionString: string
  readonly runtimeConnectionString: string
  readonly schema: string
  readonly ssl: false | { rejectUnauthorized: boolean }
  readonly poolMax: number
}

interface RuntimeRole {
  readonly name: string
  readonly superuser: boolean
  readonly bypassRls: boolean
  readonly createRole: boolean
  readonly createDb: boolean
  readonly database: string
}

interface RuntimeProbeRow {
  current_user: string
  rolsuper: boolean
  rolbypassrls: boolean
  rolcreaterole: boolean
  rolcreatedb: boolean
  database_name: string
}

const ORG_SETTING = 'dz23.org_id'
const TENANT_SETTING = 'dz23.tenant_id'
const SCOPE_MAX_LENGTH = 256
const KEY_MAX_BYTES = 4096

/**
 * A tenant-aware repository that never accepts scope from stored JSON. Every
 * operation opens one transaction and installs the server-derived scope with
 * transaction-local PostgreSQL settings before touching the RLS table.
 */
export class PostgresTenantRecordStore {
  private readonly pool: Pool
  private readonly schemaName: string
  private closing: Promise<void> | undefined

  private constructor(config: PostgresTenantStoreConfig) {
    this.schemaName = config.schema
    this.pool = new Pool(connectionConfig(config.runtimeConnectionString, config.ssl, config.poolMax))
  }

  static async create(config: PostgresTenantStoreConfig): Promise<PostgresTenantRecordStore> {
    assertIdentifier(config.schema, 'postgres schema')
    if (configuredTarget(config.adminConnectionString) !== configuredTarget(config.runtimeConnectionString)) {
      throw new Error('tenant admin and runtime credentials must address the same PostgreSQL database')
    }
    const role = await runtimeRole(config)
    if (role.superuser || role.bypassRls || role.createRole || role.createDb) {
      throw new Error('tenant runtime role must be NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE and NOCREATEDB')
    }
    await ensureTenantLayout(config, role)
    const store = new PostgresTenantRecordStore(config)
    try {
      await store.verifyRuntimeBoundary(config.schema, role.name)
      return store
    } catch (error) {
      await store.close()
      throw error
    }
  }

  list<T = unknown>(scope: TenantScope, unit: string, table: string): Promise<readonly TenantRecord<T>[]> {
    assertLogicalName(unit, 'tenant unit')
    assertLogicalName(table, 'tenant table')
    return this.withScope(scope, true, async client => {
      const result = await client.query<{ key: string; value: T }>(`
        SELECT key, value FROM ${tenantRecordsTable(this.schemaName)}
        WHERE unit = $1 AND table_name = $2 ORDER BY key COLLATE "C"
      `, [unit, table])
      return Object.freeze(result.rows.map(row => Object.freeze({ key: row.key, value: row.value })))
    })
  }

  get<T = unknown>(scope: TenantScope, unit: string, table: string, key: string): Promise<T | undefined> {
    assertLogicalName(unit, 'tenant unit')
    assertLogicalName(table, 'tenant table')
    assertKey(key)
    return this.withScope(scope, true, async client => {
      const result = await client.query<{ value: T }>(`
        SELECT value FROM ${tenantRecordsTable(this.schemaName)}
        WHERE unit = $1 AND table_name = $2 AND key = $3
      `, [unit, table, key])
      return result.rows[0]?.value
    })
  }

  put(scope: TenantScope, unit: string, table: string, key: string, value: unknown): Promise<void> {
    assertLogicalName(unit, 'tenant unit')
    assertLogicalName(table, 'tenant table')
    assertKey(key)
    const encoded = encodeJson(value)
    return this.withScope(scope, false, async client => {
      await client.query(`
        INSERT INTO ${tenantRecordsTable(this.schemaName)}
          (org_id, tenant_id, unit, table_name, key, value)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        ON CONFLICT (org_id, tenant_id, unit, table_name, key)
        DO UPDATE SET value = EXCLUDED.value
      `, [scope.orgId, scope.tenantId, unit, table, key, encoded])
    })
  }

  delete(scope: TenantScope, unit: string, table: string, key: string): Promise<boolean> {
    assertLogicalName(unit, 'tenant unit')
    assertLogicalName(table, 'tenant table')
    assertKey(key)
    return this.withScope(scope, false, async client => {
      const result = await client.query(`
        DELETE FROM ${tenantRecordsTable(this.schemaName)}
        WHERE unit = $1 AND table_name = $2 AND key = $3
      `, [unit, table, key])
      return result.rowCount === 1
    })
  }

  close(): Promise<void> {
    this.closing ??= this.pool.end()
    return this.closing
  }

  private async withScope<T>(scope: TenantScope, readOnly: boolean, action: (client: PoolClient) => Promise<T>): Promise<T> {
    if (this.closing !== undefined) throw new Error('tenant record store is closed')
    assertScope(scope)
    const client = await this.pool.connect()
    try {
      await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN')
      await client.query('SELECT set_config($1, $2, true), set_config($3, $4, true)', [
        ORG_SETTING, scope.orgId, TENANT_SETTING, scope.tenantId,
      ])
      const result = await action(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  private async verifyRuntimeBoundary(schema: string, expectedRole: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      const role = await client.query<RuntimeProbeRow>(`
        SELECT current_user, rol.rolsuper, rol.rolbypassrls, rol.rolcreaterole, rol.rolcreatedb,
          current_database() AS database_name
        FROM pg_catalog.pg_roles rol WHERE rol.rolname = current_user
      `)
      const row = role.rows[0]
      if (row === undefined || row.current_user !== expectedRole || row.rolsuper || row.rolbypassrls || row.rolcreaterole || row.rolcreatedb) {
        throw new Error('tenant runtime connection is not using the expected restricted role')
      }
      const ownership = await client.query<{
        owns_table: boolean
        member_of_owner: boolean
        can_create_in_schema: boolean
        extra_table_privileges: boolean
      }>(`
        SELECT
          c.relowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user) AS owns_table,
          pg_has_role(current_user, c.relowner, 'MEMBER') AS member_of_owner,
          has_schema_privilege(current_user, n.oid, 'CREATE') AS can_create_in_schema,
          EXISTS (
            SELECT 1 FROM pg_catalog.pg_class other
            WHERE other.relnamespace = n.oid
              AND other.relname <> 'tenant_records'
              AND other.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
              AND has_table_privilege(current_user, other.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          ) AS extra_table_privileges
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = 'tenant_records'
      `, [schema])
      if (
        ownership.rows[0]?.owns_table !== false
        || ownership.rows[0]?.member_of_owner !== false
        || ownership.rows[0]?.can_create_in_schema !== false
        || ownership.rows[0]?.extra_table_privileges !== false
      ) {
        throw new Error('tenant runtime role must not own, inherit, create or access other relations in the storage schema')
      }
    } finally {
      client.release()
    }
  }

}

async function runtimeRole(config: PostgresTenantStoreConfig): Promise<RuntimeRole> {
  const client = new Client(connectionConfig(config.runtimeConnectionString, config.ssl))
  try {
    await client.connect()
    const result = await client.query<RuntimeProbeRow>(`
      SELECT current_user, rol.rolsuper, rol.rolbypassrls, rol.rolcreaterole, rol.rolcreatedb,
        current_database() AS database_name
      FROM pg_catalog.pg_roles rol WHERE rol.rolname = current_user
    `)
    const row = result.rows[0]
    if (row === undefined) throw new Error('tenant runtime role was not found')
    assertIdentifier(row.current_user, 'tenant runtime role')
    return {
      name: row.current_user,
      superuser: row.rolsuper,
      bypassRls: row.rolbypassrls,
      createRole: row.rolcreaterole,
      createDb: row.rolcreatedb,
      database: row.database_name,
    }
  } finally {
    await client.end().catch(() => undefined)
  }
}

async function ensureTenantLayout(config: PostgresTenantStoreConfig, runtimeRole: RuntimeRole): Promise<void> {
  const pool = new Pool(connectionConfig(config.adminConnectionString, config.ssl, 1))
  const client = await pool.connect()
  const table = tenantRecordsTable(config.schema)
  const role = quoteIdentifier(runtimeRole.name)
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `dz23-storage-tenant-layout:${config.schema}`,
    ])
    const adminTarget = await client.query<{ database_name: string }>('SELECT current_database() AS database_name')
    const target = adminTarget.rows[0]
    if (
      target === undefined
      || target.database_name !== runtimeRole.database
    ) {
      throw new Error('tenant admin and runtime credentials must address the same PostgreSQL database')
    }
    await client.query(`CREATE TABLE IF NOT EXISTS ${table} (
      org_id TEXT NOT NULL CHECK (char_length(org_id) BETWEEN 1 AND 256 AND org_id = btrim(org_id)),
      tenant_id TEXT NOT NULL CHECK (char_length(tenant_id) BETWEEN 1 AND 256 AND tenant_id = btrim(tenant_id)),
      unit TEXT NOT NULL CHECK (unit ~ '^[a-z][a-z0-9_]*$'),
      table_name TEXT NOT NULL CHECK (table_name ~ '^[a-z][a-z0-9_]*$'),
      key TEXT NOT NULL CHECK (octet_length(key) BETWEEN 1 AND ${String(KEY_MAX_BYTES)}),
      value JSONB NOT NULL,
      PRIMARY KEY (org_id, tenant_id, unit, table_name, key)
    )`)
    await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
    await client.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`)
    await client.query(`DROP POLICY IF EXISTS tenant_scope ON ${table}`)
    await client.query(`CREATE POLICY tenant_scope ON ${table}
      AS PERMISSIVE FOR ALL TO ${role}
      USING (
        org_id = current_setting('${ORG_SETTING}', true)
        AND tenant_id = current_setting('${TENANT_SETTING}', true)
      )
      WITH CHECK (
        org_id = current_setting('${ORG_SETTING}', true)
        AND tenant_id = current_setting('${TENANT_SETTING}', true)
      )`)
    await client.query(`REVOKE ALL ON ${table} FROM PUBLIC`)
    await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${quoteIdentifier(config.schema)} FROM ${role}`)
    await client.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${quoteIdentifier(config.schema)} FROM ${role}`)
    await client.query(`REVOKE CREATE ON SCHEMA ${quoteIdentifier(config.schema)} FROM ${role}`)
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoteIdentifier(config.schema)} REVOKE ALL ON TABLES FROM ${role}`)
    await client.query(`GRANT USAGE ON SCHEMA ${quoteIdentifier(config.schema)} TO ${role}`)
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO ${role}`)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

function connectionConfig(connectionString: string, ssl: PostgresTenantStoreConfig['ssl'], max?: number): PoolConfig {
  return {
    connectionString: withoutTlsParams(connectionString),
    ssl,
    ...(max === undefined ? {} : { max }),
  }
}

function configuredTarget(connectionString: string): string {
  let url: URL
  try {
    url = new URL(connectionString)
  } catch {
    throw new Error('tenant PostgreSQL credentials must use a postgresql:// URL')
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error('tenant PostgreSQL credentials must use a postgresql:// URL')
  }
  const socket = url.searchParams.get('host')
  const host = socket === null ? url.hostname.toLowerCase() : socket
  const port = url.port === '' ? '5432' : url.port
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ''))
  if (host === '' || database === '') throw new Error('tenant PostgreSQL credential has no host or database')
  return JSON.stringify([host, port, database])
}

function assertLogicalName(value: string, label: string): void {
  if (!UNIT_NAME_RE.test(value)) throw new Error(`${label} '${value}' violates ${UNIT_NAME_RE}`)
}

function assertScope(scope: TenantScope): void {
  for (const [label, value] of [['orgId', scope.orgId], ['tenantId', scope.tenantId]] as const) {
    if (value.length === 0 || value.length > SCOPE_MAX_LENGTH || value !== value.trim() || value.includes('\u0000')) {
      throw new Error(`${label} is not a valid tenant scope identifier`)
    }
  }
}

function assertKey(key: string): void {
  const bytes = Buffer.byteLength(key, 'utf8')
  if (bytes === 0 || bytes > KEY_MAX_BYTES || key.includes('\u0000')) throw new Error('tenant record key is invalid')
}

function encodeJson(value: unknown): string {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new TypeError('tenant record values must be JSON-serializable')
  return encoded
}
