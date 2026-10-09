import { CONVERSATION_ENDPOINT, isConversationEvent, type ConversationSnapshot } from './conversationApi'

/**
 * A conexão que a tela mantém aberta enquanto a conversa acontece.
 *
 * A tela relia a conversa inteira a cada 1,5 segundo. Uma resposta pronta podia
 * ficar um segundo e meio parada esperando alguém perguntar por ela — e uma
 * conversa em SILÊNCIO custava uma requisição a cada 1,5 s, por aba aberta,
 * para sempre. O preço de não estar acontecendo nada era o mesmo de estar
 * acontecendo tudo.
 *
 * Aqui o servidor manda assim que vê a mudança. Ele vê RELENDO — a costura do
 * Harness não oferece assinatura —, mas relendo do lado de lá, onde é uma
 * leitura local e não uma requisição autenticada atravessando a borda.
 *
 * A pesquisa periódica NÃO foi apagada: ela é a queda. Navegador sem
 * `EventSource`, rede que corta fluxo, intermediário que segura buffer — em
 * qualquer um desses a conversa precisa continuar funcionando, mais devagar,
 * em vez de parar de atualizar sem dizer nada.
 */

/** O mínimo de `EventSource` que este módulo usa. */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: { readonly data?: string }) => void): void
  close(): void
}

export interface ConversationStreamHandlers {
  /** Um pedaço novo da conversa. Pode conter só os eventos inéditos. */
  readonly onSnapshot: (snapshot: ConversationSnapshot) => void
  /** O fluxo desistiu: quem chamou volta para a leitura periódica. */
  readonly onFallback: () => void
}

export interface ConversationStreamOptions extends ConversationStreamHandlers {
  /** Injetável para o teste não precisar de rede nem de navegador. */
  readonly create?: (url: string) => EventSourceLike
}

/** O endereço do fluxo de uma conversa. */
export function conversationStreamUrl(conversationId: string): string {
  return `${CONVERSATION_ENDPOINT}/${encodeURIComponent(conversationId)}/events/stream`
}

/** Se este ambiente tem `EventSource`. Sem ele, a queda vale desde o início. */
export function streamingAvailable(create?: ConversationStreamOptions['create']): boolean {
  return create !== undefined || typeof EventSource !== 'undefined'
}

/**
 * Abre o fluxo e devolve como fechá-lo.
 *
 * Um corpo que não é um retrato de conversa é DESCARTADO em silêncio em vez de
 * derrubar a conexão: um evento estranho no meio de mil bons não pode apagar a
 * conversa de quem está lendo. Já um erro de conexão chama a queda — e a queda
 * é a leitura periódica de sempre, e não uma tela que para de atualizar.
 *
 * @param conversationId - a conversa.
 * @param options - o que fazer com o que chega, e como criar a conexão.
 * @returns a função que fecha a conexão.
 */
export function openConversationStream(conversationId: string, options: ConversationStreamOptions): () => void {
  const create = options.create ?? ((url: string) => new EventSource(url, { withCredentials: true }) as unknown as EventSourceLike)
  let source: EventSourceLike
  try { source = create(conversationStreamUrl(conversationId)) }
  catch { options.onFallback(); return () => undefined }

  let closed = false
  const close = () => { if (!closed) { closed = true; source.close() } }

  source.addEventListener('snapshot', event => {
    const snapshot = parseStreamSnapshot(event.data)
    if (snapshot !== null) options.onSnapshot(snapshot)
  })
  // O servidor avisa quando desistiu de ler. Sem este aviso a tela ficaria com
  // uma conexão viva que não entrega nada — que é pior que uma fechada.
  source.addEventListener('unavailable', () => { close(); options.onFallback() })
  source.addEventListener('error', () => { close(); options.onFallback() })
  return close
}

/** Interpreta um corpo de evento. `null` para tudo que não é um retrato. */
export function parseStreamSnapshot(data: string | undefined): ConversationSnapshot | null {
  if (data === undefined) return null
  let body: unknown
  try { body = JSON.parse(data) }
  catch { return null }
  if (typeof body !== 'object' || body === null) return null
  const record = body as Record<string, unknown>
  if (typeof record.conversation_id !== 'string' || typeof record.cursor !== 'number' || !Array.isArray(record.events)) return null
  return {
    conversation_id: record.conversation_id,
    cursor: record.cursor,
    truncated: record.truncated === true,
    events: record.events.filter(isConversationEvent),
  }
}
