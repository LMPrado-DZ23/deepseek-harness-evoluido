/**
 * S-08 — o que a credencial de tempo de execução alcança, contra PostgreSQL 16
 * de verdade.
 *
 * O requisito pede `org_id` e `tenant_id` em TODA tabela. As tabelas do motor
 * de chave-valor (`records`, `units`, `unit_globals`, `unit_leases`,
 * `storage_meta`) não têm essas colunas, e este arquivo existe para responder o
 * que isso significa NA PRÁTICA — com o banco respondendo, não com leitura de
 * código.
 *
 * A resposta é: a credencial de tempo de execução, que é a única que atende
 * pedido de gente, NÃO ALCANÇA essas tabelas. Nem para ler. Isso é uma garantia
 * mais forte do que ter as colunas lá, porque uma coluna com política errada
 * ainda deixa ler; nenhum privilégio não deixa.
 *
 * O que este arquivo NÃO prova, e está escrito no livro-razão: os domínios que
 * ainda vivem na chave-valor são servidos pela credencial de ADMINISTRAÇÃO, e o
 * isolamento entre inquilinos deles é feito por código do produto, não pelo
 * banco. Quem está fechando isso, domínio a domínio, é o S-09.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { Client, Pool } from 'pg'
import { PostgresTenantRecordStore } from '../src/tenant-store.ts'
import { ensureSchema } from '../src/schema.ts'

const dsn = process.env.DZ23_POSTGRES_TEST_DSN
const describePostgres = dsn === undefined ? describe.skip : describe
const cleanup: Array<() => Promise<void>> = []

/** As tabelas do motor de chave-valor. Nomes literais: é sobre elas que o requisito fala. */
const KV_TABLES = ['records', 'units', 'unit_globals', 'unit_leases', 'storage_meta'] as const

/** O código do PostgreSQL para "privilégio insuficiente". */
const INSUFFICIENT_PRIVILEGE = '42501'

function runtimeConnectionString(base: string, role: string, password: string): string {
  const url = new URL(base)
  url.username = role
  url.password = password
  return url.toString()
}

describePostgres('S-08 — o alcance real da credencial de tempo de execução', () => {
  it('a credencial de execução NÃO lê nem escreve nenhuma tabela do motor de chave-valor', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const schema = `s08_${suffix}`
    const role = `s08_runtime_${suffix}`
    const password = randomBytes(24).toString('hex')
    const admin = new Client({ connectionString: dsn, ssl: false })
    await admin.connect()
    let store: PostgresTenantRecordStore | undefined
    let runtime: Client | undefined
    cleanup.push(async () => {
      await runtime?.end().catch(() => undefined)
      await store?.close().catch(() => undefined)
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
      await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    })
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`)

    // As duas metades convivem no MESMO esquema: as tabelas do motor de
    // chave-valor e a tabela por inquilino. É essa convivência que o requisito
    // pergunta sobre, e é por isso que as duas são criadas aqui.
    const adminPool = new Pool({ connectionString: dsn, ssl: false, max: 2 })
    cleanup.push(async () => { await adminPool.end().catch(() => undefined) })
    await ensureSchema(adminPool, schema)
    store = await PostgresTenantRecordStore.create({
      adminConnectionString: dsn!, runtimeConnectionString: runtimeConnectionString(dsn!, role, password),
      schema, ssl: false, poolMax: 2,
    })

    // A credencial de ADMINISTRAÇÃO enxerga tudo — é ela que cria o esquema.
    for (const table of KV_TABLES) {
      await expect(admin.query(`SELECT 1 FROM "${schema}"."${table}" LIMIT 1`)).resolves.toBeDefined()
    }

    runtime = new Client({ connectionString: runtimeConnectionString(dsn!, role, password), ssl: false })
    await runtime.connect()
    // E a de EXECUÇÃO não enxerga nenhuma delas, em nenhuma operação.
    for (const table of KV_TABLES) {
      for (const statement of [
        `SELECT 1 FROM "${schema}"."${table}" LIMIT 1`,
        `INSERT INTO "${schema}"."${table}" VALUES (DEFAULT)`,
        `UPDATE "${schema}"."${table}" SET key = key`,
        `DELETE FROM "${schema}"."${table}"`,
      ]) {
        const failure = await runtime.query(statement).then(() => undefined, (error: unknown) => error)
        expect(failure, `${statement} não foi recusada`).toBeDefined()
        // `42501` é privilégio insuficiente. Aceitamos também o erro de sintaxe
        // ou de coluna quando o PostgreSQL reclama da forma ANTES do
        // privilégio: o que não pode acontecer é a instrução PASSAR.
        expect((failure as { code?: string }).code).toBeDefined()
        await runtime.query('ROLLBACK').catch(() => undefined)
      }
    }
    // E pelo menos a LEITURA — a operação mais simples, onde o PostgreSQL
    // reclama de privilégio e não de forma — tem de ser exatamente 42501 em
    // todas elas. Sem esta asserção, um erro de digitação no nome da tabela
    // faria o laço acima "passar" reclamando de tabela inexistente.
    for (const table of KV_TABLES) {
      const failure = await runtime.query(`SELECT 1 FROM "${schema}"."${table}" LIMIT 1`)
        .then(() => undefined, (error: unknown) => error)
      expect((failure as { code?: string }).code, `${table}`).toBe(INSUFFICIENT_PRIVILEGE)
    }

    // E a tabela por inquilino, essa sim, ela alcança — senão o produto não
    // funcionaria e este teste estaria provando um banco vazio.
    await store.put({ orgId: 'org-a', tenantId: 'tenant-a' }, 'probe_unit', 'probe_table', 'k', { ok: true })
    await expect(store.list({ orgId: 'org-a', tenantId: 'tenant-a' }, 'probe_unit', 'probe_table')).resolves.toHaveLength(1)
    // E o escopo do outro inquilino não devolve a linha — quem recusa é o banco.
    await expect(store.list({ orgId: 'org-b', tenantId: 'tenant-b' }, 'probe_unit', 'probe_table')).resolves.toHaveLength(0)
  }, 60_000)
})

afterAll(async () => {
  for (const task of cleanup.splice(0)) await task()
})
