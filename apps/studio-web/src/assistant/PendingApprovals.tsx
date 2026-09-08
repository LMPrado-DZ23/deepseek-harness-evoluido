import { ShieldAlert, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import copy from '../i18n/assistant.pt-BR.json'
import { ConversationRequestError, type ConversationPort } from './conversationApi'
import { ApprovalDecisionError, decideApproval, listPendingApprovals, type PendingApproval } from './approvalsApi'

/** De quanto em quanto tempo reler a lista enquanto a pessoa está na tela. */
export const APPROVALS_POLL_MS = 2_000

/**
 * O que a pessoa vê no lugar do nome interno da ação. Uma ação desconhecida
 * mostra o próprio identificador em vez de sumir: esconder um pedido que
 * existe seria pior do que mostrá-lo com o nome técnico.
 */
export function actionLabel(action: string): string {
  const known = (copy.approvalActions as Readonly<Record<string, string>>)[action]
  if (known !== undefined) return known
  if (action.startsWith('harness.tool.')) {
    return copy.approvalHarnessTool.replace('{tool}', action.slice('harness.tool.'.length))
  }
  return action
}

/** Prazo legível; o texto original quando a data não puder ser lida. */
export function formatDeadline(value: string): string {
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? value : new Date(parsed).toLocaleTimeString('pt-BR')
}

export interface PendingApprovalsProps {
  readonly port?: ConversationPort
  readonly getCsrf?: () => Promise<string>
  readonly pollMs?: number
}

/**
 * A tela por onde uma pessoa autoriza — ou recusa — o que o assistente pediu.
 *
 * Regras que a tela mantém, e que os testes provam: enquanto ninguém decide,
 * nada acontece; uma falha de leitura NUNCA some sozinha em cima de um erro de
 * decisão; e uma decisão em andamento desabilita os dois botões daquele pedido,
 * para que um clique duplo não vire duas decisões.
 */
export function PendingApprovals({ port, getCsrf, pollMs = APPROVALS_POLL_MS }: PendingApprovalsProps) {
  const [approvals, setApprovals] = useState<readonly PendingApproval[]>([])
  const [readError, setReadError] = useState<ConversationRequestError | null>(null)
  const [actionError, setActionError] = useState<ConversationRequestError | null>(null)
  const [deciding, setDeciding] = useState<{ readonly id: string, readonly decision: 'confirm' | 'deny' } | null>(null)
  const [outcome, setOutcome] = useState<string | null>(null)
  // Terceiro estado, antes da primeira resposta. Afirmar "nada esperando por
  // você" sem ter lido nada é mentir sobre segurança justamente na tela que
  // decide uma permissão.
  const [loaded, setLoaded] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    const controller = new AbortController()
    const read = async (): Promise<void> => {
      try {
        const rows = await listPendingApprovals(port, controller.signal)
        if (!live) return
        setApprovals(rows)
        setReadError(null)
        setLoaded(true)
      } catch (error) {
        if (!live || controller.signal.aborted) return
        setReadError(error instanceof ConversationRequestError
          ? error
          : new ConversationRequestError(0, copy.approvalsError, true))
        setLoaded(true)
      }
    }
    void read()
    const timer = setInterval(() => { void read() }, pollMs)
    return () => { live = false; controller.abort(); clearInterval(timer) }
  }, [port, pollMs, attempt])

  const decide = useCallback(async (approvalId: string, decision: 'confirm' | 'deny'): Promise<void> => {
    setDeciding({ id: approvalId, decision })
    setActionError(null)
    setOutcome(null)
    try {
      await decideApproval(approvalId, decision, port, getCsrf)
      // Recusar faz o cartão sumir. Sem esta linha, a pessoa não distingue
      // "eu recusei" de "sumiu sozinho".
      setOutcome(decision === 'deny' ? copy.approvalDeniedDone : null)
      // A lista autoritativa é a do servidor: recarregar, nunca adivinhar.
      setApprovals(await listPendingApprovals(port))
    } catch (error) {
      setActionError(error instanceof ConversationRequestError
        ? error
        : new ConversationRequestError(0, copy.approvalsError, true))
    } finally {
      setDeciding(null)
    }
  }, [port, getCsrf])

  return <PendingApprovalsList
    approvals={approvals}
    loaded={loaded}
    deciding={deciding}
    outcome={outcome}
    readError={readError}
    actionError={actionError}
    onDecide={(approvalId, decision) => { void decide(approvalId, decision) }}
    onRetryRead={() => { setReadError(null); setAttempt(value => value + 1) }}
    onDismissAction={() => { setActionError(null) }}
  />
}

/** Estado de uma decisão em andamento: qual pedido e qual das duas decisões. */
export interface ApprovalDeciding {
  readonly id: string
  readonly decision: 'confirm' | 'deny'
}

export interface PendingApprovalsListProps {
  readonly approvals: readonly PendingApproval[]
  readonly loaded: boolean
  readonly deciding: ApprovalDeciding | null
  readonly outcome: string | null
  readonly readError: ConversationRequestError | null
  readonly actionError: ConversationRequestError | null
  onDecide(approvalId: string, decision: 'confirm' | 'deny'): void
  onRetryRead(): void
  onDismissAction(): void
}

/**
 * A parte visível, pura. Separada para que o cartão de decisão seja provável
 * sem depender de quando a leitura assíncrona termina - era exatamente o que
 * faltava, e por isso defeitos de rótulo, de botão e de quebra de linha
 * passaram despercebidos.
 */
export function PendingApprovalsList({
  approvals, loaded, deciding, outcome, readError, actionError,
  onDecide, onRetryRead, onDismissAction,
}: PendingApprovalsListProps) {
  return <section className="approvals" aria-labelledby="approvals-title">
    <h2 id="approvals-title"><ShieldAlert aria-hidden="true" />{copy.approvalsTitle}</h2>
    <p className="approvals-intro">{copy.approvalsIntro}</p>

    {approvals.length === 0 && readError === null
      ? <p className="approvals-empty">{loaded ? copy.approvalsEmpty : copy.approvalsLoading}</p>
      : null}

    {outcome === null ? null : <p className="approvals-outcome" role="status">{outcome}</p>}

    <ul className="approvals-list">
      {approvals.map(approval => {
        const busy = deciding?.id === approval.approval_id
        return <li key={approval.approval_id} className="approval-item" aria-busy={busy}>
          {/* A frase vem derivada do servidor e é coberta pela impressão
              digital: o que está escrito aqui é exatamente o que a confirmação
              tranca. Sem ela, duas operações sensíveis diferentes ficariam
              indistinguíveis e confirmar viraria carimbo. */}
          <p className="approval-summary">{approval.summary}</p>
          <p className="approval-action">
            {copy.approvalActionPrefix.replace('{action}', actionLabel(approval.action))}
          </p>
          <p className="approval-subject">
            {copy.approvalSubject.replace('{subject}', approval.subject_id)}
          </p>
          <p className="approval-tier">{approval.tier === 'T3' ? copy.approvalTierT3 : copy.approvalTierT2}</p>
          <p className="approval-deadline">
            {copy.approvalExpiresAt.replace('{time}', formatDeadline(approval.expires_at))}
          </p>
          {approval.state === 'AVAILABLE'
            ? <p className="approval-waiting">{copy.approvalConfirmedWaiting}</p>
            : <>
                <p className="approval-deny-warning">{copy.approvalDenyWarning}</p>
                <div className="approval-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() => { onDecide(approval.approval_id, 'confirm') }}
                  >{busy && deciding.decision === 'confirm' ? copy.approvalDecidingConfirm : copy.approvalConfirm}</button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => { onDecide(approval.approval_id, 'deny') }}
                  >{busy && deciding.decision === 'deny' ? copy.approvalDecidingDeny : copy.approvalDeny}</button>
                </div>
              </>}
        </li>
      })}
    </ul>

    {/* Os dois erros são separados de propósito: uma leitura que voltou a
        funcionar não pode apagar o aviso de que a SUA decisão não foi
        registrada. */}
    {readError === null ? null : <p className="error" role="alert">
      <TriangleAlert aria-hidden="true" />
      {readError.message}
      <button type="button" className="secondary" onClick={onRetryRead}>{copy.approvalsRefresh}</button>
    </p>}

    {actionError === null ? null : <p className="error" role="alert">
      <TriangleAlert aria-hidden="true" />
      {actionError instanceof ApprovalDecisionError && actionError.code === 'STRONG_IDENTITY_REQUIRED'
        ? copy.approvalStrongIdentity
        : actionError.message}
      <button type="button" className="secondary" onClick={onDismissAction}>{copy.dismiss}</button>
    </p>}
  </section>
}
