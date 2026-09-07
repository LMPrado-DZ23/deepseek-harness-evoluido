import type { IncomingMessage, ServerResponse } from 'node:http'
import { t } from './i18n.js'
import { ActionApprovalError, type ApprovalActor, type StudioActionApprovalService } from './service.js'

export const APPROVAL_PREFIX = '/studio/approvals'

/** Corpo minúsculo de propósito: o cliente só diz QUAL confirmação, nunca o quê. */
const MAX_BODY_BYTES = 4 * 1024
const APPROVAL_ID = /^apv-[a-f0-9]{64}$/u

export type ApprovalRoute =
  | { readonly kind: 'confirm'; readonly approvalId: string }
  | { readonly kind: 'deny'; readonly approvalId: string }
  | { readonly kind: 'read'; readonly approvalId: string }
  | { readonly kind: 'method-not-allowed' }
  | { readonly kind: 'not-found' }

/**
 * Roteamento puro. Note o que NÃO existe: nenhuma forma de criar uma
 * confirmação. Criar é privilégio de serviço interno; a rota pública só
 * confirma, nega ou lê uma confirmação que o servidor já emitiu.
 */
export function routeApproval(method: string | undefined, pathname: string): ApprovalRoute | undefined {
  if (pathname !== APPROVAL_PREFIX && !pathname.startsWith(`${APPROVAL_PREFIX}/`)) return undefined
  if (pathname === APPROVAL_PREFIX) return { kind: 'not-found' }
  const segments = pathname.slice(`${APPROVAL_PREFIX}/`.length).split('/')
  let approvalId: string
  try {
    approvalId = decodeURIComponent(segments[0]!)
  } catch {
    return { kind: 'not-found' }
  }
  if (!APPROVAL_ID.test(approvalId)) return { kind: 'not-found' }
  if (segments.length === 1) return method === 'GET' ? { kind: 'read', approvalId } : { kind: 'method-not-allowed' }
  if (segments.length !== 2) return { kind: 'not-found' }
  const action = segments[1]
  if (action === 'confirm') return method === 'POST' ? { kind: 'confirm', approvalId } : { kind: 'method-not-allowed' }
  if (action === 'deny') return method === 'POST' ? { kind: 'deny', approvalId } : { kind: 'method-not-allowed' }
  return { kind: 'not-found' }
}

export interface ApprovalHttpConfig {
  readonly service: StudioActionApprovalService
  /**
   * Usuário, sessão, organização e inquilino saem de Identity + Tenancy. O
   * cliente não contribui com nenhum deles.
   */
  authenticate(request: IncomingMessage): Promise<ApprovalActor>
  /** CSRF obrigatório em POST. Lançar aqui é o comportamento correto. */
  assertCsrf(request: IncomingMessage, actor: ApprovalActor): void
}

export interface ApprovalOutcome {
  readonly status: number
  readonly body: unknown
}

export async function handleApproval(
  request: IncomingMessage,
  route: ApprovalRoute,
  config: ApprovalHttpConfig,
): Promise<ApprovalOutcome> {
  if (route.kind === 'method-not-allowed') return { status: 405, body: { error: t('errors.methodNotAllowed') } }
  if (route.kind === 'not-found') return { status: 404, body: { error: t('errors.routeNotFound') } }
  const actor = await config.authenticate(request)
  if (route.kind !== 'read') {
    config.assertCsrf(request, actor)
    await drainBody(request)
  }
  if (route.kind === 'read') {
    return { status: 200, body: publicView(await config.service.get(actor, route.approvalId)) }
  }
  const resolved = route.kind === 'confirm'
    ? await config.service.confirm(actor, route.approvalId)
    : await config.service.deny(actor, route.approvalId)
  return { status: 200, body: publicView(resolved) }
}

export function approvalStatus(error: unknown): number | undefined {
  if (!(error instanceof ActionApprovalError)) return undefined
  return ({
    INVALID_REQUEST: 400, NOT_FOUND: 404, FORBIDDEN: 403, CONFLICT: 409,
    EXPIRED: 410, DENIED: 409, CONSUMED: 409, STRONG_IDENTITY_REQUIRED: 403,
  } as const)[error.code]
}

/**
 * O que a tela pode ver. O fingerprint NÃO sai: ele é o vínculo entre a
 * confirmação e a carga exata da ação, e não tem utilidade nenhuma no cliente.
 */
function publicView(record: { readonly approval_id: string; readonly state: string; readonly action: string; readonly subject_id: string; readonly tier: string; readonly expires_at: string }): unknown {
  return {
    approval_id: record.approval_id,
    state: record.state,
    action: record.action,
    subject_id: record.subject_id,
    tier: record.tier,
    expires_at: record.expires_at,
  }
}

/** O corpo é lido e descartado com teto: o cliente não decide nada por ele. */
async function drainBody(request: IncomingMessage): Promise<void> {
  let size = 0
  for await (const chunk of request) {
    /* v8 ignore next -- node:http entrega Buffer para corpos de requisição. */
    size += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk))
    if (size > MAX_BODY_BYTES) throw new ActionApprovalError('INVALID_REQUEST', t('errors.invalidRequest'))
  }
}
