/**
 * S-09: o PRIMEIRO domínio do Studio saindo da chave-valor opaca para uma
 * tabela com isolamento por linha, contra PostgreSQL 16 de verdade.
 *
 * Esta prova existe porque as três afirmações do requisito - backfill,
 * verificação e rollback - são exatamente as que passam despercebidas quando
 * alguém confere só a contagem de linhas. Aqui a verificação é adversarial: uma
 * linha é ADULTERADA no destino e a migração tem de reprovar mesmo com os dois
 * lados tendo o mesmo número de registros.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { PostgresTenantRecordStore } from '../src/tenant-store.ts'
import {
  APPROVAL_TENANT_TABLE,
  APPROVAL_TENANT_UNIT,
  TenantRecordActionApprovalRepository,
} from '@dz23-studio/action-approval'
import {
  migrationPlan,
  scopeCounts,
  verifyMigration,
  type DomainRow,
} from '../../../scripts/domain-rls-migration.ts'

const dsn = process.env.DZ23_POSTGRES_TEST_DSN
const describePostgres = dsn === undefined ? describe.skip : describe
const cleanup: Array<() => Promise<void>> = []

function approval(id: string, overrides: Record<string, unknown> = {}) {
  return {
    org_id: 'org-a', tenant_id: 'tenant-a', user_id: 'user-1', session_id: 'session-1',
    action: 'studio.deploy', subject_id: 'projeto-1', fingerprint: 'a'.repeat(64),
    tier: 'T2' as const, request_id: 'req-1', summary: 'Publicar o projeto',
    approval_id: `apv-${id.repeat(64).slice(0, 64)}`,
    state: 'PENDING' as const, claim_id: null,
    created_at: '2026-09-08T00:00:00.000Z', expires_at: '2026-09-08T00:03:00.000Z',
    confirmed_at: null, consumed_at: null, denied_at: null,
    ...overrides,
  }
}

describePostgres('S-09 — confirmações na tabela por inquilino, contra PostgreSQL 16', () => {
  it('faz backfill verificável, recusa adulteração e volta atrás', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const schema = `s09_${suffix}`
    const role = `s09_runtime_${suffix}`
    const password = randomBytes(24).toString('hex')
    const runtimeDsn = runtimeConnectionString(dsn!, role, password)
    const admin = new Client({ connectionString: dsn, ssl: false })
    await admin.connect()
    let store: PostgresTenantRecordStore | undefined
    cleanup.push(async () => {
      await store?.close().catch(() => undefined)
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
      await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    })
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`)
    store = await PostgresTenantRecordStore.create({
      adminConnectionString: dsn!, runtimeConnectionString: runtimeDsn, schema, ssl: false, poolMax: 4,
    })

    // ── o lado de origem: a chave-valor opaca, com dois inquilinos ───────────
    const kv = new Map<string, unknown>()
    for (const record of [
      approval('1'),
      approval('2', { state: 'AVAILABLE', confirmed_at: '2026-09-08T00:01:00.000Z' }),
      approval('3', { org_id: 'org-b', tenant_id: 'tenant-b' }),
    ]) kv.set(record.approval_id, record)
    const source: DomainRow[] = [...kv.entries()].map(([key, value]) => ({ key, value }))

    // ── backfill ────────────────────────────────────────────────────────────
    const plan = migrationPlan(source)
    expect(scopeCounts(plan)).toEqual([
      { scope: 'org-a/tenant-a', rows: 2 },
      { scope: 'org-b/tenant-b', rows: 1 },
    ])
    for (const step of plan) {
      await store.put(step.scope, APPROVAL_TENANT_UNIT, APPROVAL_TENANT_TABLE, step.key, step.value)
    }

    // ── verificação: os dois lados, registro a registro ──────────────────────
    const readTarget = async (): Promise<DomainRow[]> => {
      const rows: DomainRow[] = []
      for (const scope of [{ orgId: 'org-a', tenantId: 'tenant-a' }, { orgId: 'org-b', tenantId: 'tenant-b' }]) {
        for (const row of await store!.list(scope, APPROVAL_TENANT_UNIT, APPROVAL_TENANT_TABLE)) {
          rows.push({ key: row.key, value: row.value })
        }
      }
      return rows
    }
    const verified = verifyMigration(source, await readTarget())
    expect(verified.findings).toEqual([])
    expect(verified.verified).toBe(true)
    expect(verified.sourceDigest).toBe(verified.targetDigest)

    // ── a autoridade de confirmação lendo da TABELA ──────────────────────────
    const repository = new TenantRecordActionApprovalRepository(store)
    const a = { orgId: 'org-a', tenantId: 'tenant-a' }
    const b = { orgId: 'org-b', tenantId: 'tenant-b' }
    await expect(repository.get(a, approval('1').approval_id)).resolves.toMatchObject({ state: 'PENDING' })
    // O pedido do outro inquilino recebe o MESMO "não existe" de um id
    // inventado - e quem recusa aqui é o banco, não um `if` deste repositório.
    await expect(repository.get(a, approval('3').approval_id)).resolves.toBeUndefined()
    await expect(repository.get(b, approval('3').approval_id)).resolves.toMatchObject({ state: 'PENDING' })
    await expect(repository.listForActor({ ...a, userId: 'user-1', sessionId: 'session-1' }))
      .resolves.toHaveLength(2)

    // A escrita condicional continua valendo depois da migração.
    const confirmed = approval('1', { state: 'AVAILABLE', confirmed_at: '2026-09-08T00:02:00.000Z' })
    await repository.put(confirmed, 'PENDING')
    await expect(repository.put(confirmed, 'PENDING')).rejects.toThrow()
    await expect(repository.put(approval('1'), 'new')).rejects.toThrow()

    // ── verificação adversarial: mesma contagem, conteúdo adulterado ─────────
    const tampered = await readTarget()
    const afterWrite = verifyMigration(source, tampered)
    expect(afterWrite.source).toBe(afterWrite.target)
    // Contar linhas dos dois lados NÃO pega isto: a confirmação mudou de
    // estado no destino, e uma migração que só contasse diria "confere".
    expect(afterWrite.verified).toBe(false)
    expect(afterWrite.findings).toEqual([{ kind: 'different', key: approval('1').approval_id }])

    // ── rollback: a tabela volta para a chave-valor, e ela nunca foi apagada ─
    const restored = new Map(kv)
    for (const row of tampered) restored.set(row.key, row.value)
    const back: DomainRow[] = [...restored.entries()].map(([key, value]) => ({ key, value }))
    const rollback = verifyMigration(back, tampered)
    expect(rollback.verified).toBe(true)
    // A origem continua intacta: o rollback é voltar a LER dela, e não
    // reconstruí-la a partir do destino.
    expect(kv.size).toBe(3)

    // E a volta é executável, não só conferível: as linhas saem da tabela e a
    // chave-valor - que nunca foi apagada - volta a ser a autoridade com o
    // conteúdo mais recente já reconciliado.
    for (const row of tampered) {
      const scope = row.key === approval('3').approval_id ? b : a
      await expect(store.delete(scope, APPROVAL_TENANT_UNIT, APPROVAL_TENANT_TABLE, row.key)).resolves.toBe(true)
    }
    expect(await readTarget()).toEqual([])
    expect(restored.size).toBe(3)
    expect((restored.get(approval('1').approval_id) as { state: string }).state).toBe('AVAILABLE')
  }, 60_000)
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
