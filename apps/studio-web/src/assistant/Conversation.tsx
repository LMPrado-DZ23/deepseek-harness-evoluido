import { Send, Square, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import copy from '../i18n/assistant.pt-BR.json'
import {
  ConversationRequestError,
  cancelConversationTurn,
  readConversation,
  sendConversationMessage,
  type ConversationEvent,
  type ConversationPort,
} from './conversationApi'
import {
  applySnapshot,
  compactionView,
  conversationStatus,
  dropQueuedMessage,
  emptyConversation,
  isCompacting,
  openedConversation,
  queueMessage,
  setDraft,
  type CompactionView,
  type ConversationState,
} from './conversationState'

/** Journal polling. The Studio keeps no second copy of the chat; it re-reads. */
export const CONVERSATION_POLL_MS = 1_500

type Action =
  | { readonly kind: 'opened'; readonly conversationId: string }
  | { readonly kind: 'snapshot'; readonly snapshot: Parameters<typeof applySnapshot>[1] }
  | { readonly kind: 'draft'; readonly draft: string }
  | { readonly kind: 'queued'; readonly requestId: string; readonly text: string }
  | { readonly kind: 'dropped'; readonly requestId: string }

export function conversationReducer(state: ConversationState, action: Action): ConversationState {
  if (action.kind === 'opened') return openedConversation(state, action.conversationId)
  if (action.kind === 'snapshot') return applySnapshot(state, action.snapshot)
  if (action.kind === 'draft') return setDraft(state, action.draft)
  if (action.kind === 'queued') return queueMessage(state, action.requestId, action.text)
  return dropQueuedMessage(state, action.requestId)
}

export interface ConversationProps {
  readonly conversationId: string
  readonly port?: ConversationPort
  readonly getCsrf?: () => Promise<string>
  readonly pollMs?: number
}

export function Conversation({ conversationId, port, getCsrf, pollMs = CONVERSATION_POLL_MS }: ConversationProps) {
  const [state, dispatch] = useReducer(conversationReducer, undefined, emptyConversation)
  /**
   * Dois avisos diferentes. O de LEITURA some sozinho quando a leitura volta a
   * funcionar - ele descreve o agora. O de AÇÃO (enviar, parar, organizar) é
   * sobre algo que a pessoa fez e NÃO some sozinho: um envio recusado que
   * desaparece em um segundo e meio faz a pessoa acreditar que enviou.
   */
  const [readError, setReadError] = useState<{ readonly message: string; readonly retryable: boolean } | null>(null)
  const [actionError, setActionError] = useState<{ readonly message: string; readonly retryable: boolean } | null>(null)
  const error = actionError ?? readError
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const draftRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => { dispatch({ kind: 'opened', conversationId }) }, [conversationId])

  useEffect(() => {
    let live = true
    const controller = new AbortController()
    const read = async () => {
      try {
        const snapshot = await readConversation(conversationId, port, controller.signal)
        if (!live) return
        dispatch({ kind: 'snapshot', snapshot })
        setReadError(null)
      } catch (reason) {
        if (!live || controller.signal.aborted) return
        setReadError(describe(reason))
      }
    }
    void read()
    const timer = setInterval(() => { void read() }, pollMs)
    return () => { live = false; controller.abort(); clearInterval(timer) }
  }, [conversationId, port, pollMs, attempt])

  const status = conversationStatus(state)

  const submit = useCallback(async () => {
    const text = state.draft.trim()
    if (text === '' || busy) return
    setBusy(true)
    let requestId: string | undefined
    try {
      const accepted = await sendConversationMessage(conversationId, text, port, getCsrf)
      requestId = accepted.request_id
      dispatch({ kind: 'queued', requestId: accepted.request_id, text })
      setActionError(null)
    } catch (reason) {
      if (requestId !== undefined) dispatch({ kind: 'dropped', requestId })
      setActionError(describe(reason))
    } finally {
      setBusy(false)
      draftRef.current?.focus()
    }
  }, [busy, conversationId, getCsrf, port, state.draft])

  const stop = useCallback(async () => {
    try {
      await cancelConversationTurn(conversationId, port, getCsrf)
      setActionError(null)
    } catch (reason) {
      setActionError(describe(reason))
    }
  }, [conversationId, getCsrf, port])

  const items = useMemo(() => state.events.filter(isRenderable), [state.events])
  const compaction = useMemo(() => compactionView(state), [state])
  const organizing = isCompacting(compaction)

  const compactNow = useCallback(async () => {
    if (organizing) return
    try {
      const accepted = await sendConversationMessage(conversationId, '/compact', port, getCsrf)
      dispatch({ kind: 'queued', requestId: accepted.request_id, text: '/compact' })
      setActionError(null)
    } catch (reason) {
      setActionError(describe(reason))
    }
  }, [conversationId, getCsrf, organizing, port])

  return <section className="conversation" aria-labelledby="conversation-title">
    <header>
      <h1 id="conversation-title">{copy.conversationTitle}</h1>
      <p className="context-note">{copy.conversationSubtitle}</p>
    </header>

    {state.truncated ? <p className="context-note">{copy.truncated}</p> : null}

    <ol className="conversation-log" role="log" aria-live="polite" aria-relevant="additions">
      {items.length === 0 && state.queued.length === 0
        ? <li className="conversation-empty">
            <strong>{copy.emptyTitle}</strong>
            <span>{copy.emptyBody}</span>
          </li>
        : null}
      {items.map(event => <li key={`${event.type}-${String(event.seq)}`} className={`conversation-item ${event.type.replace('.', '-')}`}>
        <ConversationItem event={event} />
      </li>)}
      {state.queued.map(message => <li key={message.request_id} className="conversation-item message-user queued">
        <span className="who">{copy.you}</span>
        <p>{message.text}</p>
      </li>)}
    </ol>

    {compaction === null ? null : <CompactionBand view={compaction} />}

    <p className="conversation-status" role="status" aria-live="polite">
      {status === 'queued'
        ? state.queued.length > 1 ? copy.queuedMany : copy.queuedOne
        : status === 'working' ? copy.working : ''}
    </p>

    {error === null ? null : <p className="error" role="alert">
      <TriangleAlert aria-hidden="true" />
      {error.message}
      {error.retryable
        ? <button type="button" className="secondary" onClick={() => {
            setReadError(null); setActionError(null); setAttempt(value => value + 1)
          }}>{copy.retry}</button>
        : null}
      {actionError === null
        ? null
        : <button type="button" className="secondary" onClick={() => { setActionError(null) }}>{copy.dismiss}</button>}
    </p>}

    <form
      className="conversation-composer"
      onSubmit={submitEvent => { submitEvent.preventDefault(); void submit() }}
    >
      <label htmlFor="conversation-draft">{copy.composerLabel}</label>
      <textarea
        id="conversation-draft"
        ref={draftRef}
        value={state.draft}
        placeholder={copy.composerPlaceholder}
        onChange={change => { dispatch({ kind: 'draft', draft: change.target.value }) }}
      />
      <div className="conversation-actions">
        <button type="submit" className="primary" disabled={busy || state.draft.trim() === ''}>
          <Send aria-hidden="true" />{busy ? copy.sending : copy.send}
        </button>
        {status === 'working'
          ? <button type="button" className="secondary" onClick={() => { void stop() }}>
              <Square aria-hidden="true" />{copy.stop}
            </button>
          : null}
      </div>
      <details className="conversation-advanced">
        <summary>{copy.advancedOptions}</summary>
        <button type="button" className="secondary" disabled={organizing} onClick={() => { void compactNow() }}>
          {copy.compactNow}
        </button>
      </details>
    </form>
  </section>
}

/**
 * The band. It is deliberately indeterminate: the upstream events carry no
 * completed/total pair, so there is nothing honest to turn into a percentage.
 * `aria-valuenow` is absent for the same reason - an indeterminate bar must not
 * claim a value. Counts appear only once the summary really reported them.
 */
export function CompactionBand({ view }: { readonly view: CompactionView }) {
  if (view.phase === 'completed') {
    return <p className="compaction-marker" role="status">
      <strong>{copy.compactionDone}</strong>
      {view.items === undefined && view.tokens === undefined ? null : <span className="context-note">
        {copy.compactionMarker}
        {view.items === undefined ? '' : ` — ${String(view.items)} ${copy.compactionMarkerItems}`}
        {view.tokens === undefined ? '' : ` — ${String(view.tokens)} ${copy.compactionMarkerTokens}`}
      </span>}
    </p>
  }
  if (view.phase === 'failed') {
    return <p className="compaction-band failed" role="status">{copy.compactionFailed}</p>
  }
  const step = view.phase === 'summarizing' ? copy.compactionStepSummarizing
    : view.phase === 'committing' ? copy.compactionStepCommitting
      : copy.compactionStepReconciling
  return <section className="compaction-band" role="status" aria-live="polite">
    <strong>{copy.compactionTitle}</strong>
    <span className="context-note">{step}</span>
    <span className="compaction-bar" role="progressbar" aria-label={copy.compactionTitle} />
  </section>
}

function ConversationItem({ event }: { readonly event: ConversationEvent }) {
  if (event.type === 'message.user') {
    return <><span className="who">{copy.you}</span><p>{event.text}</p></>
  }
  if (event.type === 'message.assistant') {
    return <>
      <span className="who">{copy.assistant}</span>
      <p>{event.text}</p>
      {event.interrupted ? <span className="context-note">{copy.interrupted}</span> : null}
    </>
  }
  if (event.type === 'tool.state') {
    const label = event.state === 'running' ? copy.toolRunning : event.state === 'succeeded' ? copy.toolSucceeded : copy.toolFailed
    return <span className="context-note">{event.label} — {label}</span>
  }
  if (event.type === 'approval.requested') {
    return <><strong>{copy.approvalPending}</strong><p>{event.tool_label}: {event.explanation}</p></>
  }
  /* c8 ignore next -- turn.state never reaches here: isRenderable filters it. */
  if (event.type !== 'approval.resolved') return null
  const outcome = event.outcome === 'allowed-once' ? copy.approvalAllowed
    : event.outcome === 'rejected' ? copy.approvalRejected
      : event.outcome === 'cancelled' ? copy.approvalCancelled : copy.approvalUnavailable
  return <span className="context-note">{outcome}</span>
}

/** `turn.state` drives the status line, not the transcript. */
function isRenderable(event: ConversationEvent): boolean {
  return event.type !== 'turn.state' && event.type !== 'compaction.state'
}

function describe(reason: unknown): { readonly message: string; readonly retryable: boolean } {
  if (reason instanceof ConversationRequestError) return { message: reason.message, retryable: reason.retryable }
  return { message: copy.loadError, retryable: true }
}
