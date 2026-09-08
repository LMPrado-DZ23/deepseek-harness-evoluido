import { describe, expect, it } from 'vitest'
import {
  MAX_APPROVAL_ATTEMPTS,
  approvalFingerprint,
  approvalSubjectId,
  requireTier3Approval,
  AssistantApprovalDeniedError,
  AssistantApprovalRequiredError,
  type AssistantApprovalPort,
} from '../src/approval.ts'

const principal = { userId: 'user-1', orgId: 'org-1', tenantId: 'tenant-1', sessionId: 'identity-session' }

function port(states: readonly string[]): AssistantApprovalPort & { readonly asked: string[], readonly consumed: string[] } {
  const asked: string[] = []
  const consumed: string[] = []
  let index = 0
  return {
    asked,
    consumed,
    request: descriptor => {
      asked.push(descriptor.request_id)
      const state = states[Math.min(index, states.length - 1)] ?? 'PENDING'
      index += 1
      return Promise.resolve({ approval_id: `apv-${'a'.repeat(64)}`, state })
    },
    consume: input => {
      consumed.push(input.claimId)
      return Promise.resolve({ user_id: principal.userId })
    },
  }
}

const request = { principal, action: 'studio.agent.start.secrets' as const, subjectId: 'workspace-1', fingerprint: 'b'.repeat(64) }

describe('portão T3 do assistente', () => {
  it('só consome uma confirmação que a pessoa deixou disponível', async () => {
    const available = port(['AVAILABLE'])
    await expect(requireTier3Approval(available, request)).resolves.toEqual({ approvedBy: 'user-1' })
    expect(available.consumed).toEqual(['studio.agent.start.secrets:0'])
  })

  it('recusa enquanto o pedido está pendente e nunca consome nada', async () => {
    const pending = port(['PENDING'])
    await expect(requireTier3Approval(pending, request)).rejects.toBeInstanceOf(AssistantApprovalRequiredError)
    expect(pending.consumed).toEqual([])
  })

  it('recusa para sempre depois de uma negativa', async () => {
    const denied = port(['DENIED'])
    await expect(requireTier3Approval(denied, request)).rejects.toBeInstanceOf(AssistantApprovalDeniedError)
    expect(denied.asked).toHaveLength(1)
    expect(denied.consumed).toEqual([])
  })

  it('abre o próximo pedido quando o anterior foi usado ou venceu', async () => {
    const used = port(['CONSUMED', 'EXPIRED', 'AVAILABLE'])
    await expect(requireTier3Approval(used, request)).resolves.toEqual({ approvedBy: 'user-1' })
    expect(used.asked).toEqual([`${request.fingerprint}.0`, `${request.fingerprint}.1`, `${request.fingerprint}.2`])
    expect(used.consumed).toEqual(['studio.agent.start.secrets:2'])
  })

  it('para de abrir pedidos em vez de girar sem fim', async () => {
    const exhausted = port(['CONSUMED'])
    await expect(requireTier3Approval(exhausted, request)).rejects.toBeInstanceOf(AssistantApprovalRequiredError)
    expect(exhausted.asked).toHaveLength(MAX_APPROVAL_ATTEMPTS)
    expect(exhausted.consumed).toEqual([])
  })

  it('normaliza um estado desconhecido como recusa, nunca como permissão', async () => {
    const rogue = port(['SOMETHING_ELSE'])
    await expect(requireTier3Approval(rogue, request)).rejects.toBeInstanceOf(AssistantApprovalRequiredError)
    expect(rogue.consumed).toEqual([])
  })

  it('mantém o identificador do repositório legível e recorre ao resumo quando não é', () => {
    expect(approvalSubjectId('workspace-1', '/repo')).toBe('workspace-1')
    expect(approvalSubjectId('espaço com acento', '/repo')).toMatch(/^repo:[a-f0-9]{64}$/u)
    expect(approvalSubjectId('espaço com acento', '/repo')).not.toBe(approvalSubjectId('espaço com acento', '/outro'))
  })

  it('separa impressões digitais que só diferem no recorte das partes', () => {
    expect(approvalFingerprint(['ab', 'c'])).not.toBe(approvalFingerprint(['a', 'bc']))
    expect(approvalFingerprint(['a', 'b'])).toBe(approvalFingerprint(['a', 'b']))
  })
})
