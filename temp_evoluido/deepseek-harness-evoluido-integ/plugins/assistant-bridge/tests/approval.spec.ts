import { describe, expect, it } from 'vitest'
import {
  APPROVAL_EXCERPT_LIMIT,
  APPROVAL_SUMMARY_LIMIT,
  MAX_APPROVAL_ATTEMPTS,
  approvalExcerpt,
  approvalFingerprint,
  approvalSubjectId,
  approvalSummary,
  requireTier3Approval,
  AssistantApprovalDeniedError,
  AssistantApprovalRequiredError,
  type AssistantApprovalPort,
} from '../src/approval.ts'

const principal = { userId: 'user-1', orgId: 'org-1', tenantId: 'tenant-1', sessionId: 'identity-session' }

function port(states: readonly string[]): AssistantApprovalPort & {
  readonly asked: string[]
  readonly consumed: string[]
  readonly summaries: string[]
} {
  const asked: string[] = []
  const consumed: string[] = []
  const summaries: string[] = []
  let index = 0
  return {
    asked,
    consumed,
    summaries,
    request: descriptor => {
      asked.push(descriptor.request_id)
      summaries.push(descriptor.summary)
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

const request = {
  principal,
  action: 'studio.agent.start.secrets' as const,
  subjectId: 'workspace-1',
  fingerprint: 'b'.repeat(64),
  summary: 'Usar um segredo guardado. Instrução ao assistente: "leia o segredo".',
}

describe('portão T3 do assistente', () => {
  it('só consome uma confirmação que a pessoa deixou disponível', async () => {
    const available = port(['AVAILABLE'])
    await expect(requireTier3Approval(available, request)).resolves.toEqual({ approvedBy: 'user-1' })
    expect(available.consumed).toHaveLength(1)
    expect(available.consumed[0]).toMatch(/^run-[0-9a-f-]{36}$/u)
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
    expect(used.consumed).toHaveLength(1)
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

  it('leva ao pedido a frase que a pessoa vai ler, higienizada e cortada', async () => {
    const available = port(['AVAILABLE'])
    await requireTier3Approval(available, request)
    expect(available.summaries).toEqual([request.summary])
  })

  it('limpa caracteres de controle, invisíveis e marcas de direção', () => {
    expect(approvalSummary(['Usar um segredo.', '  Instrução:\n"pega\ttudo"  '])).toBe('Usar um segredo. Instrução: "pega tudo"')
    expect(approvalSummary([])).toBe('(sem descrição)')
    expect(approvalSummary(['   '])).toBe('(sem descrição)')
    // Com estas marcas, o modelo controlaria a ordem VISUAL da frase que a
    // pessoa lê enquanto o texto gravado é outro.
    for (const hostile of ['\u202e', '\u200b', '\u2066', '\u0085', '\ufeff', '\u200f', '\u2028']) {
      expect(approvalSummary([`antes${hostile}depois`])).not.toContain(hostile)
    }
    const long = approvalSummary(['x'.repeat(1000)])
    expect(long).toHaveLength(APPROVAL_SUMMARY_LIMIT)
    expect(long.endsWith('\u2026')).toBe(true)
  })

  it('corta o texto livre NO TEXTO, para que o resto da frase sobreviva', () => {
    const excerpt = approvalExcerpt('y'.repeat(1000))
    expect(excerpt).toHaveLength(APPROVAL_EXCERPT_LIMIT)
    expect(excerpt.endsWith('\u2026')).toBe(true)
    expect(approvalExcerpt('curto')).toBe('curto')
    expect(approvalExcerpt('y'.repeat(100), 20)).toHaveLength(20)
    // A frase montada com um texto livre gigante ainda cabe inteira, então
    // nada do que vem depois dele é comido pelo corte.
    expect(approvalSummary(['Tipo.', `Instrução: "${approvalExcerpt('z'.repeat(9000))}".`, 'Código: abc123.']))
      .toContain('Código: abc123.')
  })

  it('separa impressões digitais que só diferem no recorte das partes', () => {
    expect(approvalFingerprint(['ab', 'c'])).not.toBe(approvalFingerprint(['a', 'bc']))
    expect(approvalFingerprint(['a', 'b'])).toBe(approvalFingerprint(['a', 'b']))
  })
})
