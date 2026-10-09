import { describe, expect, it, vi } from 'vitest'
import {
  answerHarnessApproval,
  questionFingerprint,
  questionSubjectId,
  questionSummary,
  type HarnessApprovalAuthority,
  type HarnessApprovalDeps,
} from '../src/answerer.ts'
import { ActionApprovalError } from '../src/service.ts'
import type { ApprovalRecord } from '../src/model.ts'

const actor = { userId: 'user-1', orgId: 'org-1', tenantId: 'tenant-1', sessionId: 'session-1' }
const question = { toolName: 'bash', callId: 'call-1', reason: 'precisa sair da caixa' }

function record(state: ApprovalRecord['state']): ApprovalRecord {
  const base = {
    org_id: 'org-1', tenant_id: 'tenant-1', user_id: 'user-1', session_id: 'session-1',
    action: 'harness.tool.bash', subject_id: 'call:call-1', fingerprint: 'b'.repeat(64),
    tier: 'T3' as const, request_id: 'harness-1', summary: 'O assistente quer usar a ferramenta bash.', approval_id: `apv-${'a'.repeat(64)}`,
    claim_id: null, created_at: '2026-09-08T00:00:00.000Z', expires_at: '2026-09-08T00:03:00.000Z',
    confirmed_at: null, consumed_at: null, denied_at: null,
  }
  if (state === 'AVAILABLE') return { ...base, state, confirmed_at: '2026-09-08T00:01:00.000Z' }
  if (state === 'DENIED') return { ...base, state, denied_at: '2026-09-08T00:01:00.000Z' }
  if (state === 'CONSUMED') {
    return { ...base, state, confirmed_at: '2026-09-08T00:01:00.000Z', consumed_at: '2026-09-08T00:02:00.000Z', claim_id: 'outro' }
  }
  return { ...base, state }
}

function deps(overrides: {
  readonly authority?: Partial<HarnessApprovalAuthority>
  readonly actor?: HarnessApprovalDeps['actor']
  readonly maxWaitMs?: number
} = {}): HarnessApprovalDeps & { readonly clock: { value: number } } {
  const clock = { value: 0 }
  const authority: HarnessApprovalAuthority = {
    request: vi.fn(() => Promise.resolve(record('PENDING'))),
    get: vi.fn(() => Promise.resolve(record('PENDING'))),
    consume: vi.fn(() => Promise.resolve({ approval_id: record('AVAILABLE').approval_id })),
    ...overrides.authority,
  }
  return {
    clock,
    authority,
    actor: 'actor' in overrides ? overrides.actor : actor,
    tier: 'T3',
    questionId: 'harness-1',
    pollIntervalMs: 10,
    maxWaitMs: overrides.maxWaitMs ?? 100,
    wait: (ms: number) => { clock.value += ms; return Promise.resolve(true) },
    now: () => clock.value,
  }
}

const delegate = () => Promise.resolve('unavailable' as const)

describe('respondedor do Studio para as perguntas do Harness', () => {
  it('só devolve permissão depois que a pessoa confirma e a confirmação é consumida', async () => {
    let reads = 0
    const d = deps({
      authority: {
        get: vi.fn(() => { reads += 1; return Promise.resolve(record(reads >= 3 ? 'AVAILABLE' : 'PENDING')) }),
      },
    })
    await expect(answerHarnessApproval(question, delegate, d)).resolves.toBe('allowed-once')
    expect(d.authority.consume).toHaveBeenCalledWith(expect.objectContaining({
      action: 'harness.tool.bash', subjectId: 'call:call-1', tier: 'T3', claimId: 'harness-1',
    }))
  })

  it('recusa quando a pessoa nega', async () => {
    const d = deps({ authority: { get: vi.fn(() => Promise.resolve(record('DENIED'))) } })
    await expect(answerHarnessApproval(question, delegate, d)).resolves.toBe('rejected')
    expect(d.authority.consume).not.toHaveBeenCalled()
  })

  it('fecha por prazo esgotado sem inventar permissão nem recusa', async () => {
    const d = deps({ maxWaitMs: 25 })
    await expect(answerHarnessApproval(question, delegate, d)).resolves.toBe('unavailable')
    expect(d.authority.consume).not.toHaveBeenCalled()
  })

  it('delega quando o agente não tem identidade do Studio', async () => {
    const d = deps({ actor: undefined })
    const next = vi.fn(() => Promise.resolve('unavailable' as const))
    await expect(answerHarnessApproval(question, next, d)).resolves.toBe('unavailable')
    expect(next).toHaveBeenCalledTimes(1)
    expect(d.authority.request).not.toHaveBeenCalled()
  })

  it('devolve cancelado quando a pergunta foi retirada', async () => {
    const d = deps()
    const cancelled = { ...question, signal: { aborted: true } }
    await expect(answerHarnessApproval(cancelled, delegate, d)).resolves.toBe('cancelled')
    expect(d.authority.request).not.toHaveBeenCalled()
  })

  it('devolve cancelado quando a espera é interrompida no meio', async () => {
    const d = { ...deps(), wait: () => Promise.resolve(false) }
    await expect(answerHarnessApproval(question, delegate, d)).resolves.toBe('cancelled')
  })

  it('não transforma falha de armazenamento em permissão', async () => {
    const failedAsk = deps({ authority: { request: vi.fn(() => Promise.reject(new Error('storage'))) } })
    await expect(answerHarnessApproval(question, delegate, failedAsk)).resolves.toBe('unavailable')

    const failedRead = deps({ authority: { get: vi.fn(() => Promise.reject(new Error('storage'))) } })
    await expect(answerHarnessApproval(question, delegate, failedRead)).resolves.toBe('unavailable')

    const failedConsume = deps({
      authority: {
        request: vi.fn(() => Promise.resolve(record('AVAILABLE'))),
        consume: vi.fn(() => Promise.reject(new Error('storage'))),
      },
    })
    await expect(answerHarnessApproval(question, delegate, failedConsume)).resolves.toBe('unavailable')
  })

  it('mantém a recusa explícita mesmo quando ela chega no consumo', async () => {
    const d = deps({
      authority: {
        request: vi.fn(() => Promise.resolve(record('AVAILABLE'))),
        consume: vi.fn(() => Promise.reject(new ActionApprovalError('DENIED', 'recusado'))),
      },
    })
    await expect(answerHarnessApproval(question, delegate, d)).resolves.toBe('rejected')
  })

  it('fecha diante de uma confirmação já usada por outra reivindicação', async () => {
    const d = deps({ authority: { request: vi.fn(() => Promise.resolve(record('CONSUMED'))) } })
    await expect(answerHarnessApproval(question, delegate, d)).resolves.toBe('unavailable')
    expect(d.authority.consume).not.toHaveBeenCalled()
  })

  it('fecha diante de um pedido vencido', async () => {
    const d = deps({ authority: { request: vi.fn(() => Promise.resolve(record('EXPIRED'))) } })
    await expect(answerHarnessApproval(question, delegate, d)).resolves.toBe('unavailable')
  })

  it('identifica a chamada de forma legível e resume o que não é', () => {
    expect(questionSubjectId({ toolName: 'bash', callId: 'call-1' })).toBe('call:call-1')
    expect(questionSubjectId({ toolName: 'bash', callId: 'chamada com espaço' })).toMatch(/^call:[a-f0-9]{64}$/u)
    expect(questionSubjectId({ toolName: 'bash' })).toMatch(/^call:[a-f0-9]{64}$/u)
  })

  it('diz à pessoa qual ferramenta e por quê, e leva isso ao pedido', async () => {
    expect(questionSummary(question)).toContain('O assistente quer usar a ferramenta bash')
    expect(questionSummary(question)).toContain('precisa sair da caixa')
    // Motivo do modelo, higienizado e cortado NO MOTIVO.
    expect(questionSummary({ toolName: 'bash', reason: 'quebra\nde\tlinha' })).toContain('quebra de linha')
    // Marcas invisíveis e de direção não sobrevivem: com elas, o modelo
    // controlaria a ordem VISUAL da frase enquanto o texto gravado é outro.
    for (const hostile of ['\u202e', '\u200b', '\u2066', '\u0085', '\ufeff', '\u200f']) {
      expect(questionSummary({ toolName: 'bash', reason: `antes${hostile}depois` })).not.toContain(hostile)
    }
    // O código do pedido SOBREVIVE a um motivo gigante: cortar a frase inteira
    // comeria justamente o que distingue dois cartões na tela.
    const long = questionSummary({ toolName: 'bash', reason: 'x'.repeat(5000) })
    expect(long.length).toBeLessThanOrEqual(300)
    expect(long).toMatch(/Código deste pedido: [a-f0-9]{6}\.$/u)
    // Duas perguntas diferentes nunca mostram a mesma frase.
    expect(questionSummary({ toolName: 'bash', reason: `${'y'.repeat(400)}A` }))
      .not.toBe(questionSummary({ toolName: 'bash', reason: `${'y'.repeat(400)}B` }))

    const d = deps({ authority: { request: vi.fn(() => Promise.resolve(record('AVAILABLE'))) } })
    await answerHarnessApproval(question, delegate, d)
    expect(d.authority.request).toHaveBeenCalledWith(expect.objectContaining({
      summary: expect.stringContaining('precisa sair da caixa'),
    }))
  })

  it('muda a impressão digital quando o motivo muda', () => {
    expect(questionFingerprint(question)).not.toBe(questionFingerprint({ ...question, reason: 'outro motivo' }))
    expect(questionFingerprint(question)).toBe(questionFingerprint({ ...question }))
    expect(questionFingerprint({ toolName: 'bash' })).not.toBe(questionFingerprint({ toolName: 'bash', callId: 'x' }))
  })
})

describe('ACHADO: duas perguntas anônimas não viram o mesmo cartão', () => {
  it('perguntas DIFERENTES sem `callId` recebem identidades diferentes', () => {
    // Sem `callId`, a impressão digital era `[toolName, '', reason]`. Duas
    // perguntas distintas da MESMA ferramenta com o MESMO motivo produziam a
    // mesma impressão digital, o mesmo `subject_id` e o mesmo código de seis
    // caracteres — que é exatamente o que distingue dois cartões na tela.
    //
    // A pessoa via duas confirmações visualmente IDÊNTICAS e não tinha como
    // saber qual das duas estava aprovando. Numa tela de autorização T2/T3,
    // isso é a diferença entre confirmar o que se leu e confirmar outra coisa.
    const primeira = { toolName: 'bash', reason: 'listar os arquivos do projeto' }
    const segunda = { toolName: 'bash', reason: 'listar os arquivos do projeto' }
    expect(questionFingerprint(primeira)).not.toBe(questionFingerprint(segunda))
    expect(questionSubjectId(primeira)).not.toBe(questionSubjectId(segunda))
  })

  it('a MESMA pergunta mantém a identidade quando perguntada de novo', () => {
    // A impressão digital é comparada no momento de consumir a confirmação:
    // uma identidade que mudasse a cada leitura recusaria a própria aprovação
    // da pessoa.
    const pergunta = { toolName: 'bash', reason: 'listar os arquivos do projeto' }
    expect(questionFingerprint(pergunta)).toBe(questionFingerprint(pergunta))
    expect(questionSubjectId(pergunta)).toBe(questionSubjectId(pergunta))
  })

  it('com `callId`, quem manda continua sendo ele', () => {
    // A identidade sintética é só para a ausência: onde o Harness dá um
    // `callId`, ele é a verdade, e duas leituras da mesma chamada precisam
    // continuar casando.
    expect(questionFingerprint({ toolName: 'bash', callId: 'call-1', reason: 'x' }))
      .toBe(questionFingerprint({ toolName: 'bash', callId: 'call-1', reason: 'x' }))
    expect(questionSubjectId({ toolName: 'bash', callId: 'call-1' })).toBe('call:call-1')
  })
})
