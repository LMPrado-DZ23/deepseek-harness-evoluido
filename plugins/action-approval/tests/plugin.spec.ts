import { describe, expect, it, vi } from 'vitest'
import { DomainActionApprovalRepository, apply, inject, name } from '../src/plugin.ts'
import { ApprovalConflictError } from '../src/repository.ts'
import { StudioActionApprovalService } from '../src/service.ts'
import type { ApprovalRecord } from '../src/model.ts'

function record(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    org_id: 'org-1', tenant_id: 'tenant-1', user_id: 'user-1', session_id: 'session-1',
    action: 'studio.agent.start.secrets', subject_id: 'workspace-1', fingerprint: 'b'.repeat(64),
    tier: 'T3', request_id: 'req-1', approval_id: `apv-${'a'.repeat(64)}`, state: 'PENDING',
    claim_id: null, created_at: '2026-09-07T00:00:00.000Z', expires_at: '2026-09-07T00:03:00.000Z',
    confirmed_at: null, consumed_at: null, denied_at: null,
    ...overrides,
  }
}

function table() {
  const rows = new Map<string, ApprovalRecord>()
  return {
    rows,
    get: (key: string) => Promise.resolve(rows.get(key)),
    put: (key: string, value: ApprovalRecord) => { rows.set(key, value); return Promise.resolve() },
  }
}

describe('persistência durável da autoridade de confirmação', () => {
  it('cria apenas o que ainda não existe', async () => {
    const rows = table()
    const repository = new DomainActionApprovalRepository(rows as never)
    await repository.put(record(), 'new')
    await expect(repository.put(record(), 'new')).rejects.toBeInstanceOf(ApprovalConflictError)
    await expect(repository.get(record().approval_id)).resolves.toMatchObject({ state: 'PENDING' })
    await expect(repository.get('apv-ausente')).resolves.toBeUndefined()
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
    await expect(repository.get(corrupt.approval_id)).rejects.toThrow()
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
      tier: 'T3', request_id: 'req-1',
    })
    expect(created.state).toBe('PENDING')
    await expect(service.confirm(actor, created.approval_id)).resolves.toMatchObject({ state: 'AVAILABLE' })
    expect(strongIdentityForSession).toHaveBeenCalledWith('session-1')
    // A confirmação atravessou o domínio: a linha persistida é a confirmada.
    expect(rows.rows.get(created.approval_id)).toMatchObject({ state: 'AVAILABLE' })
    await disposer!()
    expect(close).toHaveBeenCalledTimes(1)
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
      tier: 'T3', request_id: 'req-1',
    })
    await expect(service.confirm({ userId: 'user-1', orgId: 'org-1', tenantId: 'tenant-1', sessionId: 'session-1' }, created.approval_id))
      .rejects.toMatchObject({ code: 'STRONG_IDENTITY_REQUIRED' })
    expect(rows.rows.get(created.approval_id)).toMatchObject({ state: 'PENDING' })
  })
})
