import { createHash, randomUUID } from 'node:crypto'
import { t } from './i18n.js'
import type { ApprovalRecord, ApprovalTier } from './model.js'
import { ActionApprovalError, type ApprovalActor } from './service.js'

/**
 * Resposta do Studio às perguntas de permissão do Harness.
 *
 * O que este módulo fecha: o Harness pergunta "posso?" pelo waterfall
 * `approval/request` e resolve a pergunta APENAS com respondedores compostos no
 * mesmo processo. Não existe API externa para responder. Sem um respondedor, a
 * pergunta cai no `'unavailable'` fechado e a pessoa nunca vê nada. Este
 * respondedor liga aquela pergunta à autoridade de confirmação do Studio, por
 * composição - o Harness fica com zero diff.
 */

/** Vocabulário fechado de resultado do seam do Harness. */
export type HarnessApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** Pergunta do Harness, no recorte que este módulo usa. */
export interface HarnessApprovalQuestion {
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly signal?: { readonly aborted: boolean }
}

/** Recorte da autoridade usado pelo respondedor. */
export interface HarnessApprovalAuthority {
  request(descriptor: {
    readonly org_id: string
    readonly tenant_id: string
    readonly user_id: string
    readonly session_id: string
    readonly action: string
    readonly subject_id: string
    readonly fingerprint: string
    readonly tier: ApprovalTier
    readonly request_id: string
    readonly summary: string
  }): Promise<ApprovalRecord>
  get(actor: ApprovalActor, approvalId: string): Promise<ApprovalRecord>
  consume(input: {
    readonly actor: ApprovalActor
    readonly approvalId: string
    readonly claimId: string
    readonly action: string
    readonly subjectId: string
    readonly fingerprint: string
    readonly tier: ApprovalTier
  }): Promise<{ readonly approval_id: string }>
}

export interface HarnessApprovalDeps {
  readonly authority: HarnessApprovalAuthority
  /** Identidade do Studio para o agente que está perguntando, ou nada. */
  readonly actor: ApprovalActor | undefined
  /** Nível exigido. Um pedido do Harness é sempre escalada de permissão. */
  readonly tier: ApprovalTier
  /** Identificador único desta pergunta; o Harness não fornece um. */
  readonly questionId: string
  readonly pollIntervalMs: number
  readonly maxWaitMs: number
  /** Espera cancelável. Devolve `false` quando a espera foi interrompida. */
  wait(ms: number): Promise<boolean>
  now(): number
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$/u

/**
 * Um identificador proprio para a pergunta que chegou SEM `callId`.
 *
 * Sem isto, duas perguntas distintas da MESMA ferramenta com o MESMO motivo
 * produziam a mesma impressao digital, o mesmo `subject_id` e o mesmo codigo de
 * seis caracteres — que e justamente o que distingue dois cartoes na tela. A
 * pessoa via duas confirmacoes visualmente IDENTICAS e nao tinha como saber
 * qual das duas estava aprovando.
 *
 * Chaveado pelo OBJETO da pergunta, e nao pelo conteudo: a mesma pergunta
 * perguntada de novo (o mesmo objeto, reapresentado) mantem a identidade, e
 * duas perguntas diferentes recebem identidades diferentes mesmo escrevendo a
 * mesma coisa. E `WeakMap` para a identidade morrer junto com a pergunta.
 */
const SYNTHETIC_CALL_IDS = new WeakMap<object, string>()

function callIdentity(question: HarnessApprovalQuestion): string {
  const declared = question.callId
  if (declared !== undefined && declared !== '') return declared
  const existing = SYNTHETIC_CALL_IDS.get(question)
  if (existing !== undefined) return existing
  const minted = `anon:${randomUUID()}`
  SYNTHETIC_CALL_IDS.set(question, minted)
  return minted
}

/** Identidade da chamada dentro do pedido, legível quando já é legível. */
export function questionSubjectId(question: HarnessApprovalQuestion): string {
  const callId = question.callId
  if (callId !== undefined && SAFE_SEGMENT.test(callId)) return `call:${callId}`
  // `callIdentity` e nao `question.toolName`: cair no nome da ferramenta fazia
  // toda pergunta anonima da mesma ferramenta virar o MESMO sujeito.
  return `call:${createHash('sha256').update(callIdentity(question), 'utf8').digest('hex')}`
}

/** Limite da frase mostrada, igual ao da autoridade. */
export const QUESTION_SUMMARY_LIMIT = 300
/** Quanto do motivo dado pelo modelo cabe na frase. */
export const QUESTION_REASON_LIMIT = 160

/**
 * A frase que a pessoa le sobre a pergunta do Harness: qual ferramenta e por
 * que. Higienizada porque o motivo tem origem no modelo, e coberta pela
 * impressao digital - o texto exibido e o texto que a confirmacao tranca.
 * @param question - a pergunta emprestada pelo Harness.
 * @returns a frase pronta, cortada no limite.
 */
export function questionSummary(question: HarnessApprovalQuestion): string {
  // Controle E categoria de formato: marcas de direcao (bidi), espacos de
  // largura zero e separadores invisiveis. Sem isso, o modelo controla a ordem
  // VISUAL da frase que a pessoa le enquanto o texto gravado e outro.
  const clean = (value: string): string => value
    .replace(/[\u0000-\u001f\u007f\u0085\u00ad\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/gu, ' ')
    .replace(/\s+/gu, ' ').trim()
  const reason = clean(question.reason ?? '')
  const tool = clean(question.toolName)
  // O motivo e cortado NO MOTIVO, nunca na frase: cortar a frase comeria o
  // codigo do pedido, que e o que distingue dois cartoes na tela.
  const excerpt = reason.length <= QUESTION_REASON_LIMIT ? reason : `${reason.slice(0, QUESTION_REASON_LIMIT - 1)}\u2026`
  const code = questionFingerprint(question).slice(0, 6)
  const text = excerpt === ''
    ? t('summary.harnessTool', { tool, code })
    : t('summary.harnessToolWithReason', { tool, reason: excerpt, code })
  if (text.length <= QUESTION_SUMMARY_LIMIT) return text
  return `${text.slice(0, QUESTION_SUMMARY_LIMIT - 1)}\u2026`
}

/** Impressão digital do que está sendo perguntado, incluindo o motivo dado. */
export function questionFingerprint(question: HarnessApprovalQuestion): string {
  const parts = [question.toolName, callIdentity(question), question.reason ?? '']
  return createHash('sha256')
    .update(parts.map(part => `${String(part.length)}:${part}`).join('|'), 'utf8')
    .digest('hex')
}

/**
 * Responde uma pergunta do Harness esperando a decisão de uma pessoa real.
 *
 * Falha fechada em tudo que não seja uma confirmação consumida: sem identidade
 * do Studio a pergunta é DELEGADA (o seam decide o fecho), e prazo esgotado,
 * erro de armazenamento ou estado inesperado viram `'unavailable'`. Só um
 * `AVAILABLE` consumido vira `'allowed-once'`, e só uma recusa explícita da
 * pessoa vira `'rejected'`.
 * @param question - a pergunta emprestada pelo Harness.
 * @param next - delega para o próximo respondedor composto.
 * @param deps - autoridade, identidade e relógio desta resposta.
 * @returns o resultado fechado que o Harness vai registrar no log da sessão.
 */
export async function answerHarnessApproval(
  question: HarnessApprovalQuestion,
  next: () => Promise<HarnessApprovalOutcome>,
  deps: HarnessApprovalDeps,
): Promise<HarnessApprovalOutcome> {
  const actor = deps.actor
  // Sem identidade do Studio esta pergunta não é nossa: delegar preserva a
  // composição, e o seam já fecha sozinho quando ninguém responde.
  if (actor === undefined) return next()
  const aborted = (): boolean => question.signal?.aborted ?? false
  if (aborted()) return 'cancelled'

  const action = `harness.tool.${question.toolName}`
  const subjectId = questionSubjectId(question)
  const fingerprint = questionFingerprint(question)
  let record: ApprovalRecord
  try {
    record = await deps.authority.request({
      org_id: actor.orgId,
      tenant_id: actor.tenantId,
      user_id: actor.userId,
      session_id: actor.sessionId,
      action,
      subject_id: subjectId,
      fingerprint,
      tier: deps.tier,
      request_id: deps.questionId,
      // A pessoa precisa ler o que o assistente pediu, e o motivo que ele deu.
      // Sem isso, autorizar "usar a ferramenta bash" e um botao de "sim para
      // tudo".
      summary: questionSummary(question),
    })
  } catch {
    // Não deu para nem PERGUNTAR. Isso não é "a pessoa recusou".
    return 'unavailable'
  }

  const deadline = deps.now() + deps.maxWaitMs
  for (;;) {
    if (aborted()) return 'cancelled'
    switch (record.state) {
      case 'AVAILABLE':
        try {
          await deps.authority.consume({
            actor,
            approvalId: record.approval_id,
            claimId: deps.questionId,
            action,
            subjectId,
            fingerprint,
            tier: deps.tier,
          })
          return 'allowed-once'
        } catch (error) {
          // Recusa explícita continua sendo recusa; qualquer outra coisa é
          // "não deu para saber", e não vira permissão.
          if (error instanceof ActionApprovalError && error.code === 'DENIED') return 'rejected'
          return 'unavailable'
        }
      case 'DENIED':
        return 'rejected'
      case 'PENDING':
        break
      default:
        // CONSUMED por outra reivindicação, ou EXPIRED: fecha.
        return 'unavailable'
    }
    if (deps.now() >= deadline) return 'unavailable'
    if (!await deps.wait(deps.pollIntervalMs)) return 'cancelled'
    try {
      record = await deps.authority.get(actor, record.approval_id)
    } catch {
      return 'unavailable'
    }
  }
}
