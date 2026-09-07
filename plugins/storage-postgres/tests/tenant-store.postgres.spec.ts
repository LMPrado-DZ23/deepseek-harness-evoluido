import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { PostgresTenantRecordStore } from '../src/tenant-store.ts'

const dsn = process.env.DZ23_POSTGRES_TEST_DSN
const describePostgres = dsn === undefined ? describe.skip : describe
const cleanup: Array<() => Promise<void>> = []

describePostgres('tenant record RLS against PostgreSQL 16', () => {
  it('makes PostgreSQL deny reads and writes outside the transaction scope', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const schema = `rls_${suffix}`
    const role = `rls_runtime_${suffix}`
    const password = randomBytes(24).toString('hex')
    const runtimeDsn = runtimeConnectionString(dsn!, role, password)
    const admin = new Client({ connectionString: dsn, ssl: false })
    await admin.connect()
    let store: PostgresTenantRecordStore | undefined
    let attacker: Client | undefined
    cleanup.push(async () => {
      await attacker?.end().catch(() => undefined)
      await store?.close().catch(() => undefined)
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
      await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    })
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`)

    store = await PostgresTenantRecordStore.create({
      adminConnectionString: dsn!, runtimeConnectionString: runtimeDsn,
      schema, ssl: false, poolMax: 2,
    })
    const a = { orgId: 'org-a', tenantId: 'tenant-a' }
    const b = { orgId: 'org-b', tenantId: 'tenant-b' }
    await store.put(a, 'studio_projects', 'projects', 'a', { name: 'A' })
    await store.put(b, 'studio_projects', 'projects', 'b', { name: 'B' })
    await expect(store.list(a, 'studio_projects', 'projects')).resolves.toEqual([{ key: 'a', value: { name: 'A' } }])
    await expect(store.list(b, 'studio_projects', 'projects')).resolves.toEqual([{ key: 'b', value: { name: 'B' } }])

    attacker = new Client({ connectionString: runtimeDsn, ssl: false })
    await attacker.connect()
    const table = `"${schema}"."tenant_records"`
    const withoutScope = await attacker.query<{ count: string }>(`SELECT count(*) FROM ${table}`)
    expect(withoutScope.rows[0]?.count).toBe('0')
    await attacker.query('BEGIN')
    await attacker.query('SELECT set_config($1, $2, true), set_config($3, $4, true)', [
      'dz23.org_id', a.orgId, 'dz23.tenant_id', a.tenantId,
    ])
    const visible = await attacker.query<{ key: string }>(`SELECT key FROM ${table} ORDER BY key`)
    expect(visible.rows).toEqual([{ key: 'a' }])
    await expect(attacker.query(`
      INSERT INTO ${table} (org_id, tenant_id, unit, table_name, key, value)
      VALUES ($1, $2, 'studio_projects', 'projects', 'attack', '{}'::jsonb)
    `, [b.orgId, b.tenantId])).rejects.toMatchObject({ code: '42501' })
    await attacker.query('ROLLBACK')

    const policy = await admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean; roles: string[] }>(`
      -- pg_policies.roles é name[], e o driver não converte name[] em arranjo
      -- JavaScript em toda versão. O cast para text[] fixa o tipo em algo que
      -- ele sempre converte, para este teste falhar por política errada e
      -- nunca por formato de tipo.
      SELECT c.relrowsecurity, c.relforcerowsecurity, p.roles::text[] AS roles
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_policies p ON p.schemaname = n.nspname AND p.tablename = c.relname
      WHERE n.nspname = $1 AND c.relname = 'tenant_records' AND p.policyname = 'tenant_scope'
    `, [schema])
    expect(policy.rows).toEqual([expect.objectContaining({
      relrowsecurity: true, relforcerowsecurity: true, roles: [role],
    })])
  }, 30_000)
})

afterAll(async () => {
  for (const dispose of cleanup.reverse()) await dispose()
})

function runtimeConnectionString(adminDsn: string, role: string, password: string): string {
  const url = new URL(adminDsn)
  url.username = role
  url.password = password
  return url.toString()
}
