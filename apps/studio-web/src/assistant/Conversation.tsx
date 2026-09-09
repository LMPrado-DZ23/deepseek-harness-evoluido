import { Paperclip, Send, Square, TriangleAlert, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import copy from '../i18n/assistant.pt-BR.json'
import { Markdown } from './Markdown'
import { openConversationStream, streamingAvailable, type ConversationStreamOptions } from './conversationStream'
import {
  ConversationRequestError,
  cancelConversationTurn,
  readConversation,
  sendConversationMessage,
  organizeConversation,
  uploadConversationAttachment,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type ConversationAttachment,
  type ConversationEvent,
  type ConversationPort,
} from './conversationApi'
import { PendingApprovals } from './PendingApprovals'
import { StuckRuns } from './StuckRuns'
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
  /** Injetável para o teste do fluxo não precisar de navegador nem de rede. */
  readonly createStream?: ConversationStreamOptions['create']
}

export function Conversation({ conversationId, port, getCsrf, pollMs = CONVERSATION_POLL_MS, createStream }: ConversationProps) {
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
  const [nothingToOrganize, setNothingToOrganize] = useState(false)
  /**
   * Os anexos desta mensagem, do jeito que o SERVIDOR os confirmou. A tela
   * nunca guarda os bytes nem o arquivo escolhido: guardar o `File` faria a
   * lista mostrar um anexo que o servidor talvez tenha recusado.
   */
  const [attachments, setAttachments] = useState<readonly ConversationAttachment[]>([])
  const [attaching, setAttaching] = useState(false)
  const draftRef = useRef<HTMLTextAreaElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => { dispatch({ kind: 'opened', conversationId }) }, [conversationId])

  /**
   * Como a conversa chega: por FLUXO, com leitura periódica de queda.
   *
   * O fluxo entrega assim que o servidor vê a mudança, em vez de a resposta
   * pronta esperar até 1,5 s por alguém perguntar. E uma conversa em silêncio
   * deixa de custar uma requisição a cada 1,5 s por aba aberta.
   *
   * A leitura periódica NÃO foi apagada. Navegador sem `EventSource`, rede que
   * corta fluxo, intermediário que segura buffer — em qualquer um deles a
   * conversa continua funcionando, mais devagar, em vez de parar de atualizar
   * sem dizer nada. A primeira leitura acontece SEMPRE, dos dois jeitos: quem
   * abriu a tela precisa ver o que já existe antes da próxima mudança.
   */
  const [streaming, setStreaming] = useState(() => streamingAvailable(createStream))
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
    if (!streaming) {
      const timer = setInterval(() => { void read() }, pollMs)
      return () => { live = false; controller.abort(); clearInterval(timer) }
    }
    const close = openConversationStream(conversationId, {
      onSnapshot: snapshot => { if (live) { dispatch({ kind: 'snapshot', snapshot }); setReadError(null) } },
      // Cair NÃO é um erro para a pessoa: a conversa continua, mais devagar.
      // Mostrar um aviso vermelho aqui assustaria por causa de um detalhe de
      // transporte que ela não escolheu e não pode consertar.
      onFallback: () => { if (live) setStreaming(false) },
      ...(createStream === undefined ? {} : { create: createStream }),
    })
    return () => { live = false; controller.abort(); close() }
  }, [conversationId, port, pollMs, attempt, streaming, createStream])

  const status = conversationStatus(state)

  const submit = useCallback(async () => {
    const text = state.draft.trim()
    if (text === '' || busy) return
    setBusy(true)
    let requestId: string | undefined
    try {
      const accepted = await sendConversationMessage(
        conversationId, text, port, getCsrf, attachments.map(item => item.attachment_id),
      )
      requestId = accepted.request_id
      dispatch({ kind: 'queued', requestId: accepted.request_id, text })
      // Só depois do aceite: limpar antes faria a pessoa perder os anexos numa
      // falha que não foi dela, e ter de escolher os arquivos de novo.
      setAttachments([])
      setActionError(null)
    } catch (reason) {
      if (requestId !== undefined) dispatch({ kind: 'dropped', requestId })
      setActionError(describe(reason))
    } finally {
      setBusy(false)
      draftRef.current?.focus()
    }
  }, [attachments, busy, conversationId, getCsrf, port, state.draft])

  const attach = useCallback(async (file: File) => {
    if (attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      setActionError({ message: copy.attachmentTooManyLocal, retryable: false })
      return
    }
    setAttaching(true)
    try {
      const reference = await uploadConversationAttachment(conversationId, file, port, getCsrf)
      setAttachments(current => [...current, reference])
      setActionError(null)
    } catch (reason) {
      setActionError(describe(reason))
    } finally {
      setAttaching(false)
      // Sem isto, escolher o MESMO arquivo de novo depois de uma recusa não
      // dispara `change` e o botão parece morto.
      if (fileRef.current !== null) fileRef.current.value = ''
    }
  }, [attachments.length, conversationId, getCsrf, port])

  const removeAttachment = useCallback((attachmentId: string) => {
    setAttachments(current => current.filter(item => item.attachment_id !== attachmentId))
  }, [])

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
      // A compactação de verdade, e não a string "/compact" enfiada na conversa
      // como se a pessoa a tivesse escrito.
      const outcome = await organizeConversation(conversationId, port, getCsrf)
      setNothingToOrganize(!outcome.organized)
      setActionError(null)
      setAttempt(value => value + 1)
    } catch (reason) {
      setNothingToOrganize(false)
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

    {/* Fica ACIMA do estado e do compositor: uma permissão esperando é a única
        coisa na tela que bloqueia o trabalho, então é a primeira que a pessoa vê. */}
    <PendingApprovals {...(port === undefined ? {} : { port })} {...(getCsrf === undefined ? {} : { getCsrf })} />

    {/* Depois das confirmações: uma permissão esperando bloqueia o assistente
        agora; trabalho parado bloqueia arquivos, o que é sério mas não urgente. */}
    <StuckRuns {...(port === undefined ? {} : { port })} />

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
      <div className="conversation-attach">
        <label htmlFor="conversation-attachment">
          <Paperclip aria-hidden="true" />{attaching ? copy.attaching : copy.attachLabel}
        </label>
        <input
          id="conversation-attachment"
          ref={fileRef}
          type="file"
          disabled={attaching || attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE}
          aria-describedby="conversation-attachment-hint"
          onChange={change => {
            const file = change.target.files?.[0]
            if (file !== undefined) void attach(file)
          }}
        />
        <p id="conversation-attachment-hint" className="context-note">{copy.attachHint}</p>
      </div>

      <AttachmentList items={attachments} onRemove={removeAttachment} />

      <div className="conversation-actions">
        <button type="submit" className="primary" disabled={busy || attaching || state.draft.trim() === ''}>
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
        {nothingToOrganize
          ? <p className="context-note" role="status">{copy.compactionNothingToOrganize}</p>
          : null}
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

/**
 * Os anexos já confirmados, com o que a pessoa precisa para reconhecê-los:
 * nome exibível, tipo e tamanho. Cada um sai daqui antes do envio, sozinho -
 * um botão "limpar tudo" obrigaria a refazer a escolha inteira por causa de um
 * arquivo errado.
 */
export function AttachmentList({ items, onRemove }: {
  readonly items: readonly ConversationAttachment[]
  readonly onRemove: (attachmentId: string) => void
}) {
  if (items.length === 0) return null
  return <section className="conversation-attachments" aria-labelledby="conversation-attachments-title">
    <h2 id="conversation-attachments-title">{copy.attachmentsTitle}</h2>
    <ul>
      {items.map(item => <li key={item.attachment_id}>
        <span className="attachment-name">{item.name}</span>
        <span className="context-note">
          {attachmentKind(item)} — {formatAttachmentSize(item.size)}
        </span>
        <button
          type="button"
          className="secondary"
          aria-label={copy.attachmentRemoveLabel.replace('{name}', item.name)}
          onClick={() => { onRemove(item.attachment_id) }}
        >
          <X aria-hidden="true" />{copy.attachmentRemove}
        </button>
      </li>)}
    </ul>
  </section>
}

/** Imagem ou texto, em palavra, porque `image/webp` não diz nada a ninguém. */
export function attachmentKind(attachment: ConversationAttachment): string {
  return attachment.media_type === 'text/plain' ? copy.attachmentKindText : copy.attachmentKindImage
}

/**
 * O tamanho em KB, arredondado para cima.
 *
 * Para cima porque arredondar 512 bytes para "0 KB" mostraria um anexo que
 * parece vazio; e a unidade é uma só para não haver duas contas na mesma tela.
 */
export function formatAttachmentSize(bytes: number): string {
  return `${String(Math.max(1, Math.ceil(bytes / 1024)))} ${copy.attachmentSizeUnit}`
}

export function ConversationItem({ event }: { readonly event: ConversationEvent }) {
  if (event.type === 'message.user') {
    const attachments = event.attachments ?? []
    return <>
      <span className="who">{copy.you}</span>
      {/* Mensagem SÓ com anexo não tem parágrafo vazio: um `<p>` em branco é
          um buraco na conversa, e antes desta correção ela nem aparecia. */}
      {event.text === '' ? null : <p>{event.text}</p>}
      {/* Os anexos que foram JUNTO. Eles chegavam ao modelo e sumiam da tela:
          quem mandava uma foto via o assistente responder sobre uma coisa que
          a conversa não mostrava. Nome e tipo, nunca a imagem — devolver os
          bytes transformaria a referência opaca num endereço de arquivo. */}
      {attachments.length === 0 ? null : <ul className="message-attachments">
        <li className="context-note">{copy.messageAttachments}</li>
        {attachments.map(item => <li key={`${item.name}-${item.media_type}`}>
          <Paperclip aria-hidden="true" /> {item.name} <span className="context-note">({copy.messageAttachmentImage})</span>
        </li>)}
      </ul>}
    </>
  }
  if (event.type === 'message.assistant') {
    return <>
      <span className="who">{copy.assistant}</span>
      {/* A resposta do assistente é lida como Markdown; a da PESSOA continua
          texto puro, porque ela escreveu texto e não marcação — interpretar o
          que ela digitou faria um asterisco sumir da própria frase dela. */}
      <Markdown text={event.text} />
      {event.interrupted ? <span className="context-note">{copy.interrupted}</span> : null}
    </>
  }
  if (event.type === 'compaction.checkpoint') {
    // Fechado por padrão: ele substitui muitas mensagens e roubaria a leitura
    // da conversa. Aberto por escolha, porque auditar precisa ser possível.
    return <details className="compaction-checkpoint">
      <summary>{copy.compactionCheckpointTitle} — {copy.compactionCheckpointShow}</summary>
      <p className="context-note">{copy.compactionCheckpointHelp}</p>
      <p dir="auto">{event.text}</p>
    </details>
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
