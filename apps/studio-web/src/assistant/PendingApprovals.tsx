import { ShieldAlert, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import copy from '../i18n/assistant.pt-BR.json'
import { ConversationRequestError, type ConversationPort } from './conversationApi'
import { decideApproval, listPendingApprovals, type PendingApproval } from './approvalsApi'

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
  const [deciding, setDeciding] = useState<string | null>(null)
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
      } catch (error) {
        if (!live || controller.signal.aborted) return
        setReadError(error instanceof ConversationRequestError
          ? error
          : new ConversationRequestError(0, copy.approvalsError, true))
      }
    }
    void read()
    const timer = setInterval(() => { void read() }, pollMs)
    return () => { live = false; controller.abort(); clearInterval(timer) }
  }, [port, pollMs, attempt])

  const decide = useCallback(async (approvalId: string, decision: 'confirm' | 'deny'): Promise<void> => {
    setDeciding(approvalId)
    setActionError(null)
    try {
      await decideApproval(approvalId, decision, port, getCsrf)
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

  return <section className="approvals" aria-labelledby="approvals-title">
    <h2 id="approvals-title"><ShieldAlert aria-hidden="true" />{copy.approvalsTitle}</h2>
    <p className="approvals-intro">{copy.approvalsIntro}</p>

    {approvals.length === 0 && readError === null
      ? <p className="approvals-empty">{copy.approvalsEmpty}</p>
      : null}

    <ul className="approvals-list">
      {approvals.map(approval => <li key={approval.approval_id} className="approval-item">
        <p className="approval-action">
          {copy.approvalActionPrefix.replace('{action}', actionLabel(approval.action))}
        </p>
        <p className="approval-subject">
          {copy.approvalSubject.replace('{subject}', approval.subject_id)}
        </p>
        <p className="approval-tier">{approval.tier === 'T3' ? copy.approvalTierT3 : copy.approvalTierT2}</p>
        {approval.state === 'AVAILABLE'
          ? <p className="approval-waiting">{copy.approvalConfirmedWaiting}</p>
          : <div className="approval-actions">
              <button
                type="button"
                className="primary"
                disabled={deciding !== null}
                onClick={() => { void decide(approval.approval_id, 'confirm') }}
              >{deciding === approval.approval_id ? copy.approvalDeciding : copy.approvalConfirm}</button>
              <button
                type="button"
                className="secondary"
                disabled={deciding !== null}
                onClick={() => { void decide(approval.approval_id, 'deny') }}
              >{copy.approvalDeny}</button>
            </div>}
      </li>)}
    </ul>

    {/* Os dois erros são separados de propósito: uma leitura que voltou a
        funcionar não pode apagar o aviso de que a SUA decisão não foi
        registrada. */}
    {readError === null ? null : <p className="error" role="alert">
      <TriangleAlert aria-hidden="true" />
      {readError.message}
      <button type="button" className="secondary" onClick={() => {
        setReadError(null); setAttempt(value => value + 1)
      }}>{copy.approvalsRefresh}</button>
    </p>}

    {actionError === null ? null : <p className="error" role="alert">
      <TriangleAlert aria-hidden="true" />
      {actionError.status === 403 ? copy.approvalStrongIdentity : actionError.message}
      <button type="button" className="secondary" onClick={() => { setActionError(null) }}>{copy.dismiss}</button>
    </p>}
  </section>
}
