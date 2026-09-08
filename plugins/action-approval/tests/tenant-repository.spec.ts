import { describe, expect, it, vi } from 'vitest'
import { ApprovalConflictError } from '../src/repository.ts'
import {
  APPROVAL_TENANT_TABLE,
  APPROVAL_TENANT_UNIT,
  TenantRecordActionApprovalRepository,
  type ApprovalTenantRecordStore,
} from '../src/tenant-repository.ts'
import type { ApprovalRecord } from '../src/model.ts'

function record(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    org_id: 'org-1', tenant_id: 'tenant-1', user_id: 'user-1', session_id: 'session-1',
    action: 'studio.deploy', subject_id: 'projeto-1', fingerprint: 'a'.repeat(64),
    tier: 'T2', request_id: 'req-1', summary: 'Publicar o projeto',
    approval_id: `apv-${'b'.repeat(64)}`, state: 'PENDING', claim_id: null,
    created_at: '2026-09-08T00:00:00.000Z', expires_at: '2026-09-08T00:03:00.000Z',
    confirmed_at: null, consumed_at: null, denied_at: null,
    ...overrides,
  }
}

/**
 * O armazenamento por inquilino, do jeito que o banco se comporta: a leitura
 * só enxerga o escopo pedido. É isto que o teste precisa imitar - imitar um
 * mapa global provaria o `if` do repositório e não o contrato.
 */
function store(rows: readonly ApprovalRecord[] = []): ApprovalTenantRecordStore & {
  readonly written: { scope: unknown, key: string, value: unknown }[]
} {
  const data = new Map<string, ApprovalRecord>()
  for (const row of rows) data.set(`${row.org_id}/${row.tenant_id}/${row.approval_id}`, row)
  const written: { scope: unknown, key: string, value: unknown }[] = []
  return {
    written,
    list: async (scope, unit, table) => {
      expect([unit, table]).toEqual([APPROVAL_TENANT_UNIT, APPROVAL_TENANT_TABLE])
      return [...data.entries()]
        .filter(([key]) => key.startsWith(`${scope.orgId}/${scope.tenantId}/`))
        .map(([, value]) => ({ key: value.approval_id, value: value as never }))
    },
    get: async (scope, unit, table, key) => {
      expect([unit, table]).toEqual([APPROVAL_TENANT_UNIT, APPROVAL_TENANT_TABLE])
      return data.get(`${scope.orgId}/${scope.tenantId}/${key}`) as never
    },
    put: async (scope, unit, table, key, value) => {
      expect([unit, table]).toEqual([APPROVAL_TENANT_UNIT, APPROVAL_TENANT_TABLE])
      written.push({ scope, key, value })
      data.set(`${scope.orgId}/${scope.tenantId}/${key}`, value as ApprovalRecord)
    },
  }
}

describe('confirmações na tabela por inquilino', () => {
  it('a leitura carrega o escopo, e não filtra depois', async () => {
    const rows = store([record()])
    const spy = vi.spyOn(rows, 'get')
    const repository = new TenantRecordActionApprovalRepository(rows)
    await expect(repository.get({ orgId: 'org-1', tenantId: 'tenant-1' }, record().approval_id))
      .resolves.toMatchObject({ state: 'PENDING' })
    // O escopo vai NA CONSULTA. Sem isto o banco devolveria a linha do outro
    // inquilino e a separação voltaria a depender só do processo.
    expect(spy.mock.calls[0]![0]).toEqual({ orgId: 'org-1', tenantId: 'tenant-1' })
  })

  it('o pedido de outro inquilino recebe o mesmo "não existe" de um id inventado', async () => {
    const repository = new TenantRecordActionApprovalRepository(store([record()]))
    await expect(repository.get({ orgId: 'org-2', tenantId: 'tenant-1' }, record().approval_id)).resolves.toBeUndefined()
    await expect(repository.get({ orgId: 'org-1', tenantId: 'tenant-2' }, record().approval_id)).resolves.toBeUndefined()
    await expect(repository.get({ orgId: 'org-1', tenantId: 'tenant-1' }, 'apv-ausente')).resolves.toBeUndefined()
  })

  it('uma linha gravada com o escopo errado no corpo some da leitura', async () => {
    // Segunda tranca: o banco impõe o escopo pela coluna, e o corpo guarda a
    // organização e o inquilino de novo. Se um dia os dois divergirem, a linha
    // NÃO aparece como se fosse de quem perguntou.
    const rows = store()
    await rows.put({ orgId: 'org-1', tenantId: 'tenant-1' }, APPROVAL_TENANT_UNIT, APPROVAL_TENANT_TABLE,
      record().approval_id, record({ org_id: 'org-9' }))
    const repository = new TenantRecordActionApprovalRepository(rows)
    await expect(repository.get({ orgId: 'org-1', tenantId: 'tenant-1' }, record().approval_id)).resolves.toBeUndefined()
  })

  it('uma linha corrompida recusa a leitura, e não vira aprovação silenciosa', async () => {
    const rows = store([record({ state: 'AVAILABLE', confirmed_at: null })])
    const repository = new TenantRecordActionApprovalRepository(rows)
    await expect(repository.get({ orgId: 'org-1', tenantId: 'tenant-1' }, record().approval_id)).rejects.toThrow()
  })

  it('a listagem devolve o escopo exato: pessoa, sessão, organização e inquilino', async () => {
    const repository = new TenantRecordActionApprovalRepository(store([
      record(),
      record({ approval_id: `apv-${'c'.repeat(64)}`, user_id: 'user-2' }),
      record({ approval_id: `apv-${'d'.repeat(64)}`, session_id: 'session-2' }),
      record({ approval_id: `apv-${'e'.repeat(64)}`, tenant_id: 'tenant-2' }),
    ]))
    const rows = await repository.listForActor({
      userId: 'user-1', orgId: 'org-1', tenantId: 'tenant-1', sessionId: 'session-1',
    })
    expect(rows.map(row => row.approval_id)).toEqual([record().approval_id])
  })

  it('uma linha corrompida recusa a listagem INTEIRA', async () => {
    // Melhor a pessoa ver um erro do que uma lista que esconde um pedido.
    const repository = new TenantRecordActionApprovalRepository(store([
      record(), record({ approval_id: `apv-${'c'.repeat(64)}`, state: 'CONSUMED', consumed_at: null }),
    ]))
    await expect(repository.listForActor({
      userId: 'user-1', orgId: 'org-1', tenantId: 'tenant-1', sessionId: 'session-1',
    })).rejects.toThrow()
  })

  it('a escrita condicional continua valendo depois da migração', async () => {
    const rows = store()
    const repository = new TenantRecordActionApprovalRepository(rows)
    await repository.put(record(), 'new')
    await expect(repository.put(record(), 'new')).rejects.toBeInstanceOf(ApprovalConflictError)
    const confirmed = record({ state: 'AVAILABLE', confirmed_at: '2026-09-08T00:01:00.000Z' })
    await repository.put(confirmed, 'PENDING')
    // Duas confirmações concorrentes do MESMO pedido não geram dois recibos.
    await expect(repository.put(confirmed, 'PENDING')).rejects.toBeInstanceOf(ApprovalConflictError)
  })

  it('a transição de um pedido que nem existe é recusada', async () => {
    const repository = new TenantRecordActionApprovalRepository(store())
    await expect(repository.put(record({ state: 'AVAILABLE', confirmed_at: '2026-09-08T00:01:00.000Z' }), 'PENDING'))
      .rejects.toBeInstanceOf(ApprovalConflictError)
  })

  it('a escrita usa o escopo do PRÓPRIO registro, e não um escopo de fora', async () => {
    const rows = store()
    const repository = new TenantRecordActionApprovalRepository(rows)
    await repository.put(record({ org_id: 'org-7', tenant_id: 'tenant-7' }), 'new')
    expect(rows.written[0]!.scope).toEqual({ orgId: 'org-7', tenantId: 'tenant-7' })
  })

  it('um registro inválido não entra', async () => {
    const repository = new TenantRecordActionApprovalRepository(store())
    await expect(repository.put(record({ state: 'DENIED', denied_at: null }), 'new')).rejects.toThrow()
  })
})
