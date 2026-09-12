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

  it('a escrita condicional acontece no BANCO: duas confirmacoes concorrentes, uma so passa', async () => {
    // O buraco que isto fecha: a autoridade de confirmacao marcava o consumo
    // lendo e escrevendo em duas idas, serializadas por um mutex EM MEMORIA.
    // Com duas replicas, as duas leem `AVAILABLE`, as duas escrevem `CONSUMED`
    // com reivindicacoes DIFERENTES, e a segunda passa por cima da primeira:
    // uma confirmacao humana autorizando duas execucoes distintas.
    //
    // O teste usa DOIS armazenamentos separados — conexoes diferentes, sem
    // mutex compartilhado — porque e exatamente isso que duas replicas sao. Com
    // um so, o defeito nao aparece.
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const schema = `cas_${suffix}`
    const role = `cas_runtime_${suffix}`
    const password = randomBytes(24).toString('hex')
    const runtimeDsn = runtimeConnectionString(dsn!, role, password)
    const admin = new Client({ connectionString: dsn, ssl: false })
    await admin.connect()
    let um: PostgresTenantRecordStore | undefined
    let dois: PostgresTenantRecordStore | undefined
    cleanup.push(async () => {
      await um?.close().catch(() => undefined)
      await dois?.close().catch(() => undefined)
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
      await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    })
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`)
    const config = { adminConnectionString: dsn!, runtimeConnectionString: runtimeDsn, schema, ssl: false as const, poolMax: 2 }
    um = await PostgresTenantRecordStore.create(config)
    dois = await PostgresTenantRecordStore.create(config)

    const scope = { orgId: 'org-a', tenantId: 'tenant-a' }
    const unit = 'studio_action_approvals'
    const table = 'approvals'
    // Nasce disponivel, e so UMA criacao passa: `absent` tambem e condicao.
    const criacoes = await Promise.all([
      um.putIf(scope, unit, table, 'ap-1', { state: 'AVAILABLE', claim_id: null }, 'absent'),
      dois.putIf(scope, unit, table, 'ap-1', { state: 'AVAILABLE', claim_id: null }, 'absent'),
    ])
    expect(criacoes.filter(Boolean)).toHaveLength(1)

    // Duas reivindicacoes DIFERENTES, ao mesmo tempo, sobre a mesma confirmacao.
    const consumos = await Promise.all([
      um.putIf(scope, unit, table, 'ap-1', { state: 'CONSUMED', claim_id: 'run-a' }, { field: 'state', value: 'AVAILABLE' }),
      dois.putIf(scope, unit, table, 'ap-1', { state: 'CONSUMED', claim_id: 'run-b' }, { field: 'state', value: 'AVAILABLE' }),
    ])
    expect(consumos.filter(Boolean)).toHaveLength(1)

    // E o registro final tem UMA reivindicacao — a de quem ganhou —, e nao a
    // ultima que escreveu.
    const final = await um.get<{ state: string; claim_id: string }>(scope, unit, table, 'ap-1')
    expect(final?.state).toBe('CONSUMED')
    expect(['run-a', 'run-b']).toContain(final?.claim_id)

    // Depois de consumida, a condicao `AVAILABLE` nao vale mais para ninguem.
    await expect(um.putIf(scope, unit, table, 'ap-1', { state: 'CONSUMED', claim_id: 'run-c' }, { field: 'state', value: 'AVAILABLE' }))
      .resolves.toBe(false)

    // Linha que NAO existe nao e criada por uma condicao de estado anterior:
    // exigir um estado anterior so faz sentido sobre uma linha que existe, e
    // criar aqui aceitaria a escrita justamente quando o registro sumiu.
    await expect(um.putIf(scope, unit, table, 'sumiu', { state: 'CONSUMED' }, { field: 'state', value: 'AVAILABLE' }))
      .resolves.toBe(false)
    await expect(um.get(scope, unit, table, 'sumiu')).resolves.toBeUndefined()

    // E o escopo continua valendo: a condicao nao atravessa inquilino.
    await expect(dois.putIf({ orgId: 'org-b', tenantId: 'tenant-b' }, unit, table, 'ap-1', { state: 'CONSUMED' }, { field: 'state', value: 'CONSUMED' }))
      .resolves.toBe(false)
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
