import { csrfToken } from '../api'
import copy from '../../src/i18n/assistant.pt-BR.json'
import { ConversationRequestError, type ConversationPort } from './conversationApi'

export const APPROVALS_ENDPOINT = '/studio/approvals'

/** O que o servidor deixa o cliente ver. Não existe impressão digital aqui. */
export interface PendingApproval {
  readonly approval_id: string
  readonly state: 'PENDING' | 'AVAILABLE'
  readonly action: string
  readonly subject_id: string
  readonly tier: 'T2' | 'T3'
  readonly expires_at: string
}

const APPROVAL_ID = /^apv-[a-f0-9]{64}$/u

const defaultPort: ConversationPort = { fetch: (input, init) => fetch(input, init) }

/**
 * Um item da lista só é aceito quando é inteiro e reconhecível. Uma linha
 * malformada é DESCARTADA, nunca desenhada pela metade: um botão "confirmar"
 * sem saber o que confirma é pior do que nenhum botão.
 */
export function isPendingApproval(value: unknown): value is PendingApproval {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row.approval_id === 'string' && APPROVAL_ID.test(row.approval_id)
    && (row.state === 'PENDING' || row.state === 'AVAILABLE')
    && typeof row.action === 'string' && row.action !== ''
    && typeof row.subject_id === 'string' && row.subject_id !== ''
    && (row.tier === 'T2' || row.tier === 'T3')
    && typeof row.expires_at === 'string' && row.expires_at !== ''
}

export async function listPendingApprovals(
  port: ConversationPort = defaultPort,
  signal?: AbortSignal,
): Promise<readonly PendingApproval[]> {
  const response = await port.fetch(APPROVALS_ENDPOINT, {
    method: 'GET',
    credentials: 'same-origin',
    ...(signal === undefined ? {} : { signal }),
  })
  const body = await response.json().catch(() => undefined)
  if (!response.ok) throw failure(response.status, body)
  if (typeof body !== 'object' || body === null || !Array.isArray((body as { approvals?: unknown }).approvals)) {
    throw new ConversationRequestError(response.status, copy.invalidServerResponse, false)
  }
  return (body as { approvals: readonly unknown[] }).approvals.filter(isPendingApproval)
}

export async function decideApproval(
  approvalId: string,
  decision: 'confirm' | 'deny',
  port: ConversationPort = defaultPort,
  getCsrf: () => Promise<string> = csrfToken,
): Promise<void> {
  if (!APPROVAL_ID.test(approvalId)) {
    throw new ConversationRequestError(400, copy.approvalUnknown, false)
  }
  const response = await port.fetch(`${APPROVALS_ENDPOINT}/${approvalId}/${decision}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-dz23-csrf': await getCsrf() },
    body: '{}',
  })
  if (!response.ok) throw failure(response.status, await response.json().catch(() => undefined))
}

/**
 * `403` numa confirmação T3 quase sempre significa "falta a chave de acesso
 * recente", e essa é a única saída que a pessoa tem — por isso vale a pena
 * tentar de novo depois de usá-la.
 */
function failure(status: number, body: unknown): ConversationRequestError {
  const message = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
    && (body as { error: string }).error !== ''
    ? (body as { error: string }).error
    : copy.approvalsError
  return new ConversationRequestError(status, message, status >= 500 || status === 429 || status === 403)
}
