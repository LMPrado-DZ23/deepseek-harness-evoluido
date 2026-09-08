import { createHash, randomUUID } from 'node:crypto'
import { t } from './i18n.js'

/**
 * Portao real de confirmacao para operacoes T3 do assistente.
 *
 * O que este modulo existe para impedir: ate aqui o bridge montava
 * `approval: { approved: true, tier: 'T3' }` sozinho, isto e, o modelo pedia
 * uma operacao sensivel e o proprio servidor se autoconcedia a permissao. Com
 * este portao o modelo so consegue obter `APPROVAL_REQUIRED`; quem transforma
 * um pedido em permissao e uma pessoa autenticada confirmando pela rota
 * `/studio/approvals/<id>/confirm`, que em T3 ainda exige identidade forte.
 */

/** Mesmo alfabeto do `identifierSchema` da autoridade de aprovacao. */
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u

/** Quantas confirmacoes sucessivas o mesmo pedido pode gerar antes de recusar. */
export const MAX_APPROVAL_ATTEMPTS = 32

/** Nome estavel da acao sensivel, tal como aparece para a pessoa que confirma. */
export type AssistantApprovalAction =
  | 'studio.agent.start.secrets'
  | 'studio.agent.start.external-network'
  | 'studio.team.start.secrets'
  | 'studio.team.start.external-network'
  | 'studio.team.start.deploy'
  | 'studio.team.continue.sensitive'
  | 'studio.agent.resolve-unknown'

export interface AssistantApprovalPrincipal {
  readonly userId: string
  readonly orgId: string
  readonly tenantId: string
  readonly sessionId: string
}

/**
 * Recorte estrutural da autoridade generica de aprovacao (M90-A). E estrutural
 * de proposito: o bridge nao conhece a implementacao, e a prova pode montar uma
 * autoridade de teste sem simular nada do comportamento de seguranca.
 */
export interface AssistantApprovalPort {
  request(descriptor: {
    readonly org_id: string
    readonly tenant_id: string
    readonly user_id: string
    readonly session_id: string
    readonly action: string
    readonly subject_id: string
    readonly fingerprint: string
    readonly tier: 'T3'
    readonly request_id: string
    readonly summary: string
  }): Promise<{ readonly approval_id: string, readonly state: string }>
  consume(input: {
    readonly actor: AssistantApprovalPrincipal
    readonly approvalId: string
    readonly claimId: string
    readonly action: string
    readonly subjectId: string
    readonly fingerprint: string
    readonly tier: 'T3'
  }): Promise<{ readonly user_id: string }>
}

/**
 * Erro que o modelo recebe no lugar da permissao. Carrega o `approval_id` para
 * que a interface consiga mostrar exatamente qual pedido esta esperando.
 */
export class AssistantApprovalRequiredError extends Error {
  constructor(
    readonly approvalId: string,
    readonly action: AssistantApprovalAction,
    message: string,
  ) {
    super(message)
  }
}

/** A pessoa recusou. Recusa nao roda de novo com outro identificador. */
export class AssistantApprovalDeniedError extends Error {}

/** Limite duro da frase inteira, igual ao da autoridade. */
export const APPROVAL_SUMMARY_LIMIT = 300
/** Quanto de um texto livre (instrucao, motivo) cabe na frase. */
export const APPROVAL_EXCERPT_LIMIT = 140

/** Remove o que nao deve chegar a uma frase lida por uma pessoa. */
function sanitize(value: string): string {
  return value
    // Controle, e tambem a categoria de formato: marcas de direcao (bidi),
    // espacos de largura zero e separadores de linha invisiveis. Sem isso, o
    // modelo controla a ORDEM VISUAL da frase que a pessoa le enquanto o texto
    // gravado e outro.
    .replace(/[\u0000-\u001f\u007f\u0085\u00ad\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Trecho de um texto livre, cortado no proprio texto - nunca na frase inteira.
 *
 * Cortar a frase montada comia a ULTIMA parte, que e justamente a lista de
 * arquivos que a acao pode mexer: a informacao mais importante era a primeira
 * a sumir.
 * @param value - texto de origem livre (instrucao do modelo, motivo escrito).
 * @param limit - quantos caracteres do texto cabem.
 * @returns o trecho higienizado, com reticencias quando foi cortado.
 */
export function approvalExcerpt(value: string, limit = APPROVAL_EXCERPT_LIMIT): string {
  const clean = sanitize(value)
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}\u2026`
}

/**
 * A frase que a pessoa le antes de decidir. Cada parte ja chega no tamanho
 * certo; o limite duro aqui e a ultima defesa.
 * @param parts - pedacos ja em portugues, na ordem em que devem ser lidos.
 * @returns a frase pronta para o pedido de confirmacao.
 */
export function approvalSummary(parts: readonly string[]): string {
  const text = parts.map(sanitize).filter(part => part !== '').join(' ')
  if (text === '') return t('summary.missing')
  return text.length <= APPROVAL_SUMMARY_LIMIT ? text : `${text.slice(0, APPROVAL_SUMMARY_LIMIT - 1)}\u2026`
}

/**
 * Codigo curto que a pessoa consegue comparar a olho. Dois pedidos diferentes
 * nunca ficam identicos na tela: mesmo com instrucoes que so divergem depois do
 * corte, o codigo difere - e sem ele o corte devolvia dois cartoes gemeos.
 * @param fingerprint - impressao digital do que esta sendo pedido.
 * @returns seis caracteres estaveis daquele pedido.
 */
export function approvalCode(fingerprint: string): string {
  return fingerprint.slice(0, 6)
}

export function approvalSubjectId(workspaceId: string, repositoryPath: string): string {
  if (SAFE_IDENTIFIER.test(workspaceId)) return workspaceId
  return `repo:${createHash('sha256').update(`${workspaceId} ${repositoryPath}`, 'utf8').digest('hex')}`
}

/**
 * Impressao digital canonica do que esta sendo pedido. Trocar qualquer parte
 * (prompt, caminho, provedor, operacao) muda a impressao, e uma confirmacao
 * antiga deixa de servir - e isso que impede confirmar uma coisa e executar outra.
 */
export function approvalFingerprint(parts: readonly string[]): string {
  const canonical = parts.map(part => `${String(part.length)}:${part}`).join('|')
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/**
 * Exige uma confirmacao humana real para uma operacao T3 e devolve quem
 * confirmou. Falha fechada em toda a saida que nao seja um recibo consumido.
 *
 * O pedido e idempotente enquanto estiver aberto: o modelo repete a mesma
 * chamada e cai no mesmo `approval_id`, que e o que a pessoa confirma. Depois
 * de consumido ou vencido, a proxima chamada abre um pedido NOVO - uma
 * confirmacao vale por uma execucao. Depois de recusado, nada abre.
 */
export async function requireTier3Approval(port: AssistantApprovalPort, input: {
  readonly principal: AssistantApprovalPrincipal
  readonly action: AssistantApprovalAction
  readonly subjectId: string
  readonly fingerprint: string
  /** A frase que a pessoa vai ler antes de decidir. */
  readonly summary: string
}): Promise<{ readonly approvedBy: string }> {
  for (let attempt = 0; attempt < MAX_APPROVAL_ATTEMPTS; attempt += 1) {
    const record = await port.request({
      org_id: input.principal.orgId,
      tenant_id: input.principal.tenantId,
      user_id: input.principal.userId,
      session_id: input.principal.sessionId,
      action: input.action,
      subject_id: input.subjectId,
      fingerprint: input.fingerprint,
      tier: 'T3',
      request_id: `${input.fingerprint}.${String(attempt)}`,
      summary: input.summary,
    })
    if (record.state === 'DENIED') {
      throw new AssistantApprovalDeniedError(t('errors.approvalDenied'))
    }
    // Um pedido ja usado ou vencido nao vira permissao: o laco abre o proximo.
    if (record.state === 'CONSUMED' || record.state === 'EXPIRED') continue
    if (record.state !== 'AVAILABLE') {
      throw new AssistantApprovalRequiredError(record.approval_id, input.action, t('errors.approvalRequired'))
    }
    const receipt = await port.consume({
      actor: input.principal,
      approvalId: record.approval_id,
      // A reivindicacao identifica ESTA execucao, nunca a posicao no laco. Com
      // um valor deterministico, duas chamadas concorrentes apresentariam a
      // MESMA reivindicacao, cairiam no ramo de repeticao idempotente do
      // consumo e as duas receberiam recibo: uma confirmacao humana viraria N
      // execucoes. Aqui a segunda reivindicacao diverge e o consumo recusa.
      claimId: `run-${randomUUID()}`,
      action: input.action,
      subjectId: input.subjectId,
      fingerprint: input.fingerprint,
      tier: 'T3',
    })
    return { approvedBy: receipt.user_id }
  }
  throw new AssistantApprovalRequiredError('', input.action, t('errors.approvalExhausted'))
}
