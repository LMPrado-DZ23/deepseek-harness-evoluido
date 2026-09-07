import { describe, expect, it } from 'vitest'
import {
  ActionApprovalError,
  InMemoryActionApprovalRepository,
  StudioActionApprovalService,
  type ApprovalDescriptor,
} from '@dz23-studio/action-approval'
import { StagingActionApprovalAdapter, sanitizeForStaging } from '../src/approval-adapter.js'
import { stagingApprovalReceiptSchema } from '../src/model.js'
import type { StagingActor } from '../src/service.js'

const FINGERPRINT = 'a'.repeat(64)
const actor: StagingActor = {
  userId: 'user-1', orgId: 'org-1', tenantId: 'tenant-1', sessionId: 'session-1', role: 'owner',
}

function descriptor(): ApprovalDescriptor {
  return {
    org_id: 'org-1', tenant_id: 'tenant-1', user_id: 'user-1', session_id: 'session-1',
    action: 'staging.publish', subject_id: 'project-1', fingerprint: FINGERPRINT,
    tier: 'T2', request_id: 'release-1',
  }
}

async function harness() {
  const repository = new InMemoryActionApprovalRepository()
  const approvals = new StudioActionApprovalService({
    repository, identity: { strongIdentityVerified: () => true },
    now: () => new Date('2026-09-07T12:00:00.000Z'),
  })
  const created = await approvals.request(descriptor())
  return { approvals, repository, adapter: new StagingActionApprovalAdapter(approvals), approvalId: created.approval_id }
}

const input = (approvalId: string, overrides: Record<string, unknown> = {}) => ({
  actor, approvalId, tier: 'T2' as const, action: 'staging.publish' as const,
  subjectId: 'project-1', fingerprint: FINGERPRINT, releaseId: 'stg-release-1', ...overrides,
})

describe('adaptador de confirmação do staging', () => {
  it('mapeia releaseId para claimId, sanitiza o recibo e preserva escopo, ação, sujeito e fingerprint', async () => {
    const h = await harness()
    await h.approvals.confirm(actor, h.approvalId)
    const result = await h.adapter.consume(input(h.approvalId))
    expect(result.kind).toBe('approved')
    if (result.kind !== 'approved') return
    // O recibo estrito do staging não tem `tier` nem `claim_id`: se a projeção
    // deixasse passar, o `parse` reprovaria aqui.
    expect(() => stagingApprovalReceiptSchema.parse(result.receipt)).not.toThrow()
    expect(result.receipt).toEqual({
      approval_id: h.approvalId, action: 'staging.publish', subject_id: 'project-1',
      fingerprint: FINGERPRINT, user_id: 'user-1', session_id: 'session-1',
      org_id: 'org-1', tenant_id: 'tenant-1', approved_at: '2026-09-07T12:00:00.000Z',
    })
    expect(Object.keys(result.receipt)).not.toContain('tier')
    expect(Object.keys(result.receipt)).not.toContain('claim_id')

    // O mesmo release devolve o mesmo recibo; outro release é recusado.
    expect(await h.adapter.consume(input(h.approvalId))).toEqual(result)
    await expect(h.adapter.consume(input(h.approvalId, { releaseId: 'stg-release-2' })))
      .rejects.toMatchObject({ code: 'CONSUMED' })
  })

  it('só a recusa explícita da pessoa é definitiva; todo o resto sobe como erro', async () => {
    const denied = await harness()
    await denied.approvals.deny(actor, denied.approvalId)
    expect(await denied.adapter.consume(input(denied.approvalId))).toEqual({ kind: 'definitive-denied' })

    // Não confirmado ainda: erro, não "negado".
    const pending = await harness()
    await expect(pending.adapter.consume(input(pending.approvalId)))
      .rejects.toBeInstanceOf(ActionApprovalError)

    // Falha de armazenamento: erro, e nada de negação inventada.
    const broken = await harness()
    await broken.approvals.confirm(actor, broken.approvalId)
    const boom = new Error('armazenamento indisponível')
    broken.repository.failNext(boom)
    await expect(broken.adapter.consume(input(broken.approvalId))).rejects.toBe(boom)

    // Confirmação de outra pessoa: erro de não encontrado, nunca "negado".
    const foreign = await harness()
    await foreign.approvals.confirm(actor, foreign.approvalId)
    await expect(foreign.adapter.consume(input(foreign.approvalId, {
      actor: { ...actor, tenantId: 'tenant-2' },
    }))).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('a sanitização é uma projeção explícita: campo novo do recibo genérico não vaza sozinho', () => {
    const receipt = {
      approval_id: `apv-${'0'.repeat(64)}`, action: 'staging.publish', subject_id: 'project-1',
      fingerprint: FINGERPRINT, tier: 'T2' as const, claim_id: 'stg-release-1',
      user_id: 'user-1', session_id: 'session-1', org_id: 'org-1', tenant_id: 'tenant-1',
      approved_at: '2026-09-07T12:00:00.000Z',
    }
    const sanitized = sanitizeForStaging({ ...receipt, segredo: 'não pode vazar' } as typeof receipt)
    expect(Object.keys(sanitized).sort()).toEqual([
      'action', 'approval_id', 'approved_at', 'fingerprint', 'org_id', 'session_id', 'subject_id', 'tenant_id', 'user_id',
    ])
    expect(JSON.stringify(sanitized)).not.toContain('não pode vazar')
  })
})
