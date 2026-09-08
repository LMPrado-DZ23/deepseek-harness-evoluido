import { describe, expect, it, vi } from 'vitest'
import { studioActionApprovalsDomainSpec } from '../src/domain.ts'
import { approvalRecordSchema } from '../src/model.ts'
import { DomainActionApprovalRepository, apply, approvalRepository, inject, name } from '../src/plugin.ts'
import { TenantRecordActionApprovalRepository } from '../src/tenant-repository.ts'
import { ApprovalConflictError, InMemoryActionApprovalRepository } from '../src/repository.ts'
import { StudioActionApprovalService } from '../src/service.ts'
import type { ApprovalRecord } from '../src/model.ts'

function record(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    org_id: 'org-1', tenant_id: 'tenant-1', user_id: 'user-1', session_id: 'session-1',
    action: 'studio.agent.start.secrets', subject_id: 'workspace-1', fingerprint: 'b'.repeat(64),
    tier: 'T3', request_id: 'req-1', summary: 'Usar um segredo guardado.', approval_id: `apv-${'a'.repeat(64)}`, state: 'PENDING',
    claim_id: null, created_at: '2026-09-07T00:00:00.000Z', expires_at: '2026-09-07T00:03:00.000Z',
    confirmed_at: null, consumed_at: null, denied_at: null,
    ...overrides,
  }
}

function table() {
  const rows = new Map<string, ApprovalRecord>()
  return {
    rows,
    entries: () => rows.entries(),
    get: (key: string) => Promise.resolve(rows.get(key)),
    put: (key: string, value: ApprovalRecord) => { rows.set(key, value); return Promise.resolve() },
  }
}

describe('compatibilidade do domínio', () => {
  it('não sobe a versão do domínio, porque não existe passo de migração', () => {
    // Subir a versão faz `open` falhar com `version-mismatch` em qualquer
    // instalação que já rodou. Como a autoridade falha fechada, o portão T3
    // inteiro passaria a recusar para sempre, sem log que apontasse a causa.
    // Um campo novo entra como OPCIONAL no registro; a versão só sobe junto com
    // um caminho de migração que hoje a API de domínio não tem.
    expect(studioActionApprovalsDomainSpec.version).toBe(1)
  })

  it('lê um registro criado antes de o resumo existir', () => {
    const legacy = { ...record() } as Record<string, unknown>
    delete legacy.summary
    expect(approvalRecordSchema.safeParse(legacy).success).toBe(true)
  })
})

/** O escopo do `record()` das provas: leitura fora dele é o mesmo "não existe". */
const SCOPE = { orgId: 'org-1', tenantId: 'tenant-1' }

describe('persistência durável da autoridade de confirmação', () => {
  it('a leitura em memória também não atravessa o inquilino', async () => {
    // O repositório em memória é o que as provas do serviço usam. Sem esta
    // afirmação, um vazamento entre inquilinos NELE passaria despercebido e
    // todas as provas do serviço continuariam verdes sobre um repositório que
    // devolve a linha da pessoa errada.
    const repository = new InMemoryActionApprovalRepository()
    await repository.put(record(), 'new')
    await expect(repository.get(SCOPE, record().approval_id)).resolves.toMatchObject({ state: 'PENDING' })
    await expect(repository.get({ orgId: 'org-2', tenantId: 'tenant-1' }, record().approval_id)).resolves.toBeUndefined()
    await expect(repository.get({ orgId: 'org-1', tenantId: 'tenant-2' }, record().approval_id)).resolves.toBeUndefined()
  })

  it('a leitura durável não atravessa o inquilino', async () => {
    const rows = table()
    const repository = new DomainActionApprovalRepository(rows as never)
    await repository.put(record(), 'new')
    // O mesmo id, pedido por outro inquilino, some. Sem isto o serviço seria a
    // ÚNICA coisa entre um pedido e a pessoa errada.
    await expect(repository.get({ orgId: 'org-2', tenantId: 'tenant-1' }, record().approval_id)).resolves.toBeUndefined()
    await expect(repository.get({ orgId: 'org-1', tenantId: 'tenant-2' }, record().approval_id)).resolves.toBeUndefined()
  })

  it('cria apenas o que ainda não existe', async () => {
    const rows = table()
    const repository = new DomainActionApprovalRepository(rows as never)
    await repository.put(record(), 'new')
    await expect(repository.put(record(), 'new')).rejects.toBeInstanceOf(ApprovalConflictError)
    await expect(repository.get(SCOPE, record().approval_id)).resolves.toMatchObject({ state: 'PENDING' })
    await expect(repository.get(SCOPE, 'apv-ausente')).resolves.toBeUndefined()
  })

  it('recusa a escrita quando o estado mudou por baixo dela', async () => {
    const rows = table()
    const repository = new DomainActionApprovalRepository(rows as never)
    await repository.put(record(), 'new')
    const confirmed = record({ state: 'AVAILABLE', confirmed_at: '2026-09-07T00:01:00.000Z' })
    await repository.put(confirmed, 'PENDING')
    // Outra confirmação concorrente encontra o estado já mudado.
    await expect(repository.put(confirmed, 'PENDING')).rejects.toBeInstanceOf(ApprovalConflictError)
    // Uma linha que nem existe também não pode ser sobrescrita por transição.
    rows.rows.clear()
    await expect(repository.put(confirmed, 'PENDING')).rejects.toBeInstanceOf(ApprovalConflictError)
  })

  it('recusa uma linha corrompida na leitura e na escrita', async () => {
    const rows = table()
    const repository = new DomainActionApprovalRepository(rows as never)
    const corrupt = record({ state: 'AVAILABLE', confirmed_at: null })
    await expect(repository.put(corrupt, 'new')).rejects.toThrow()
    rows.rows.set(corrupt.approval_id, corrupt)
    await expect(repository.get(SCOPE, corrupt.approval_id)).rejects.toThrow()
  })

  it('a listagem durável devolve só o escopo exato e recusa uma linha corrompida', async () => {
    const rows = table()
    const repository = new DomainActionApprovalRepository(rows as never)
    const scope = { userId: 'user-1', orgId: 'org-1', tenantId: 'tenant-1', sessionId: 'session-1' }
    await repository.put(record(), 'new')
    for (const [index, other] of [
      { user_id: 'user-2' }, { org_id: 'org-2' }, { tenant_id: 'tenant-2' }, { session_id: 'session-2' },
    ].entries()) {
      await repository.put(record({ ...other, approval_id: `apv-${String(index).repeat(64)}` }), 'new')
    }
    const mine = await repository.listForActor(scope)
    expect(mine.map(row => row.approval_id)).toEqual([record().approval_id])

    // Uma linha corrompida recusa a listagem inteira: melhor um erro do que uma
    // lista que esconde silenciosamente um pedido.
    rows.rows.set('apv-corrompida', record({ state: 'AVAILABLE', confirmed_at: null }))
    await expect(repository.listForActor(scope)).rejects.toThrow()
  })

  it('monta o serviço sobre o domínio e liga a identidade forte real', async () => {
    const rows = table()
    const close = vi.fn(async () => {})
    let provided: { readonly service: StudioActionApprovalService } | undefined
    let disposer: (() => Promise<void>) | undefined
    const strongIdentityForSession = vi.fn((sessionId: string) => sessionId === 'session-1')
    const ctx = {
      storageDomain: { open: vi.fn(async () => ({ table: () => rows, close })) },
      studioIdentity: { service: { strongIdentityForSession } },
      effect: vi.fn((setup: () => () => Promise<void>) => { disposer = setup() }),
      provide: vi.fn((_key: string, value: { readonly service: StudioActionApprovalService }) => { provided = value }),
    }
    await apply(ctx as never, { ttlMs: 60_000 })
    expect(name).toBe('dz23-studio-action-approval')
    expect(inject).toContain('studioIdentity')
    const service = provided!.service
    const actor = { userId: 'user-1', orgId: 'org-1', tenantId: 'tenant-1', sessionId: 'session-1' }
    const created = await service.request({
      org_id: 'org-1', tenant_id: 'tenant-1', user_id: 'user-1', session_id: 'session-1',
      action: 'studio.agent.start.secrets', subject_id: 'workspace-1', fingerprint: 'b'.repeat(64),
      tier: 'T3', request_id: 'req-1', summary: 'Usar um segredo guardado.',
    })
    expect(created.state).toBe('PENDING')
    await expect(service.confirm(actor, created.approval_id)).resolves.toMatchObject({ state: 'AVAILABLE' })
    expect(strongIdentityForSession).toHaveBeenCalledWith('session-1')
    // A confirmação atravessou o domínio: a linha persistida é a confirmada.
    expect(rows.rows.get(created.approval_id)).toMatchObject({ state: 'AVAILABLE' })
    await disposer!()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('responde a pergunta de permissão do Harness com a confirmação real da pessoa', async () => {
    const rows = table()
    let provided: { readonly service: StudioActionApprovalService } | undefined
    let answerer: ((req: unknown, next: () => Promise<string>) => Promise<string>) | undefined
    const sessionRecord = {
      session_id: 'session-1', user_id: 'user-1', org_id: 'org-1', tenant_id: 'tenant-1',
      harness_session_ids: ['agent-1'],
    }
    const ctx = {
      agents: { get: (id: string) => id === 'agent-1' ? { session: { id: 'agent-1' } } : undefined },
      storageDomain: { open: vi.fn(async () => ({ table: () => rows, close: vi.fn(async () => {}) })) },
      studioIdentity: {
        service: {
          strongIdentityForSession: () => true,
          principalForHarnessSession: (id: string) => id === 'agent-1'
            ? { userId: 'user-1', orgId: 'org-1', tenantId: 'tenant-1', sessionId: 'session-1' }
            : undefined,
          sessionRecords: () => [sessionRecord],
        },
      },
      effect: vi.fn((setup: () => unknown) => { setup() }),
      provide: vi.fn((_key: string, value: { readonly service: StudioActionApprovalService }) => { provided = value }),
      on: vi.fn((event: string, handler: typeof answerer) => { if (event === 'approval/request') answerer = handler; return () => {} }),
    }
    await apply(ctx as never, { answerHarnessApprovals: true, harnessPollIntervalMs: 1, harnessMaxWaitMs: 200 })
    expect(answerer).toBeTypeOf('function')
    const service = provided!.service
    const request = { agent: { session: { id: 'agent-1' } }, toolName: 'bash', callId: 'call-1', reason: 'sair da caixa' }
    const pending = answerer!(request, () => Promise.resolve('unavailable'))
    // A pessoa confirma enquanto o Harness espera: nada acontece antes disso.
    const actor = { userId: 'user-1', orgId: 'org-1', tenantId: 'tenant-1', sessionId: 'session-1' }
    for (let attempt = 0; attempt < 50 && rows.rows.size === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 2))
    }
    const [approvalId] = [...rows.rows.keys()]
    expect(approvalId).toMatch(/^apv-[a-f0-9]{64}$/u)
    await service.confirm(actor, approvalId!)
    await expect(pending).resolves.toBe('allowed-once')
    expect(rows.rows.get(approvalId!)).toMatchObject({ state: 'CONSUMED', action: 'harness.tool.bash' })
  })

  it('uma confirmação do Harness autoriza exatamente uma pergunta, mesmo em perguntas idênticas', async () => {
    const rows = table()
    let provided: { readonly service: StudioActionApprovalService } | undefined
    let answerer: ((req: unknown, next: () => Promise<string>) => Promise<string>) | undefined
    const ctx = {
      agents: { get: (id: string) => id === 'agent-1' ? { session: { id: 'agent-1' } } : undefined },
      storageDomain: { open: vi.fn(async () => ({ table: () => rows, close: vi.fn(async () => {}) })) },
      studioIdentity: {
        service: {
          strongIdentityForSession: () => true,
          principalForHarnessSession: () => ({ userId: 'user-1', orgId: 'org-1', tenantId: 'tenant-1', sessionId: 'session-1' }),
        },
      },
      effect: vi.fn((setup: () => unknown) => { setup() }),
      provide: vi.fn((_key: string, value: { readonly service: StudioActionApprovalService }) => { provided = value }),
      on: vi.fn((event: string, handler: typeof answerer) => { if (event === 'approval/request') answerer = handler; return () => {} }),
    }
    await apply(ctx as never, { answerHarnessApprovals: true, harnessPollIntervalMs: 1, harnessMaxWaitMs: 120 })
    const service = provided!.service
    // Duas perguntas RIGOROSAMENTE iguais: mesma ferramenta, mesma chamada, mesmo motivo.
    const request = { agent: { session: { id: 'agent-1' } }, toolName: 'bash', callId: 'call-1', reason: 'sair da caixa' }
    const first = answerer!(request, () => Promise.resolve('unavailable'))
    const second = answerer!(request, () => Promise.resolve('unavailable'))
    for (let attempt = 0; attempt < 100 && rows.rows.size < 2; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 2))
    }
    // Cada pergunta abriu o SEU pedido: uma confirmação não serve para as duas.
    expect(rows.rows.size).toBe(2)
    const actor = { userId: 'user-1', orgId: 'org-1', tenantId: 'tenant-1', sessionId: 'session-1' }
    await service.confirm(actor, [...rows.rows.keys()][0]!)
    const outcomes = await Promise.all([first, second])
    expect(outcomes.filter(outcome => outcome === 'allowed-once')).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome === 'unavailable')).toHaveLength(1)
  })

  it('não responde a pergunta do Harness quando o respondedor não foi ligado', async () => {
    const rows = table()
    const on = vi.fn()
    const ctx = {
      agents: { get: () => undefined },
      storageDomain: { open: vi.fn(async () => ({ table: () => rows, close: vi.fn(async () => {}) })) },
      studioIdentity: { service: { strongIdentityForSession: () => true } },
      effect: vi.fn(),
      provide: vi.fn(),
      on,
    }
    await apply(ctx as never)
    expect(on).not.toHaveBeenCalled()
  })

  it('recusa a confirmação T3 de uma sessão sem chave de acesso', async () => {
    const rows = table()
    const ctx = {
      storageDomain: { open: vi.fn(async () => ({ table: () => rows, close: vi.fn(async () => {}) })) },
      studioIdentity: { service: { strongIdentityForSession: () => false } },
      effect: vi.fn(),
      provide: vi.fn(),
    }
    let provided: { readonly service: StudioActionApprovalService } | undefined
    ctx.provide = vi.fn((_key: string, value: { readonly service: StudioActionApprovalService }) => { provided = value })
    await apply(ctx as never)
    const service = provided!.service
    const created = await service.request({
      org_id: 'org-1', tenant_id: 'tenant-1', user_id: 'user-1', session_id: 'session-1',
      action: 'studio.agent.start.secrets', subject_id: 'workspace-1', fingerprint: 'b'.repeat(64),
      tier: 'T3', request_id: 'req-1', summary: 'Usar um segredo guardado.',
    })
    await expect(service.confirm({ userId: 'user-1', orgId: 'org-1', tenantId: 'tenant-1', sessionId: 'session-1' }, created.approval_id))
      .rejects.toMatchObject({ code: 'STRONG_IDENTITY_REQUIRED' })
    expect(rows.rows.get(created.approval_id)).toMatchObject({ state: 'PENDING' })
  })
})

describe('onde a autoridade guarda os pedidos', () => {
  const domain = { table: () => table() as never } as never

  it('o padrão continua sendo a chave-valor', () => {
    // Trocar isto sozinho migraria dados de gente sem ninguém pedir.
    expect(approvalRepository({ get: () => undefined }, {}, domain)).toBeInstanceOf(DomainActionApprovalRepository)
    expect(approvalRepository({ get: () => undefined }, { storageAuthority: 'kv' }, domain))
      .toBeInstanceOf(DomainActionApprovalRepository)
  })

  it('pedir RLS sem o armazenamento por inquilino FALHA ALTO', () => {
    // Cair de volta para a chave-valor em silêncio seria o pior desfecho: quem
    // pediu RLS acharia que tem isolamento no banco, e os dois lados
    // divergiriam desde o primeiro pedido.
    expect(() => approvalRepository({ get: () => undefined }, { storageAuthority: 'rls' }, domain))
      .toThrow('APPROVAL_TENANT_STORAGE_UNAVAILABLE')
  })

  it('com o armazenamento montado, RLS é usado', () => {
    const records = { list: async () => [], get: async () => undefined, put: async () => undefined }
    const repository = approvalRepository({ get: (key: string) => (key === 'studioTenantStorage' ? { records } : undefined) } as never, { storageAuthority: 'rls' }, domain)
    expect(repository).toBeInstanceOf(TenantRecordActionApprovalRepository)
  })
})
