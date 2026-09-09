import { csrfToken } from '../api'
import copy from '../../src/i18n/assistant.pt-BR.json'

export const CONVERSATION_ENDPOINT = '/studio/assistant/conversation'

export type ConversationEvent =
  | { readonly type: 'message.user'; readonly seq: number; readonly at: number; readonly id: string; readonly text: string; readonly truncated: boolean; readonly attachments?: readonly MessageAttachment[] }
  | { readonly type: 'message.assistant'; readonly seq: number; readonly at: number; readonly id: string; readonly text: string; readonly interrupted: boolean; readonly truncated: boolean }
  | { readonly type: 'turn.state'; readonly seq: number; readonly at: number; readonly state: 'working' | 'idle' }
  | { readonly type: 'tool.state'; readonly seq: number; readonly at: number; readonly call_id: string; readonly label: string; readonly state: 'running' | 'succeeded' | 'failed' }
  | { readonly type: 'approval.requested'; readonly seq: number; readonly at: number; readonly request_id: string; readonly tool_label: string; readonly explanation: string }
  | { readonly type: 'approval.resolved'; readonly seq: number; readonly at: number; readonly request_id: string; readonly outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' }
  | { readonly type: 'compaction.state'; readonly seq: number; readonly at: number; readonly compaction_id: string; readonly state: CompactionState; readonly items?: number; readonly tokens?: number }
  | { readonly type: 'compaction.checkpoint'; readonly seq: number; readonly at: number; readonly id: string; readonly text: string; readonly truncated: boolean }

/**
 * O anexo de uma mensagem JÁ ENVIADA, do jeito que a conversa o mostra.
 *
 * Nome e tipo, nunca os bytes: devolver a imagem para o navegador
 * transformaria a referência opaca num endereço de arquivo, e a rota de anexo
 * se recusa a ser isso (só POST, sem leitura).
 */
export interface MessageAttachment {
  readonly name: string
  readonly media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
}

/**
 * The four states the server projects from the Harness journal. There is no
 * fifth "percent done": the upstream contract carries no unit of progress.
 */
export type CompactionState = 'summarizing' | 'committing' | 'completed' | 'failed'

export interface ConversationSnapshot {
  readonly conversation_id: string
  readonly cursor: number
  readonly events: readonly ConversationEvent[]
  readonly truncated: boolean
}

/**
 * A referência opaca de um anexo, do jeito que ela chega do servidor.
 *
 * Não há caminho, diretório, extensão original nem nada que descreva onde os
 * bytes estão: `attachment_id` só significa alguma coisa dentro da conversa,
 * do espaço e da pessoa que o criaram.
 */
export interface ConversationAttachment {
  readonly attachment_id: string
  /** Nome já higienizado pelo servidor. Só para ler. */
  readonly name: string
  readonly size: number
  readonly media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'text/plain'
}

/** Teto por arquivo, o mesmo que o servidor aplica. */
export const MAX_ATTACHMENT_BYTES = 512 * 1024
/** Teto por mensagem, o mesmo que o servidor aplica. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 5

export interface ConversationOpened {
  readonly session_id: string
  readonly reused: boolean
  readonly preset: 'dz23-assistant'
}

export interface ConversationPort {
  fetch(input: string, init: RequestInit): Promise<Response>
}

const defaultPort: ConversationPort = { fetch: (input, init) => fetch(input, init) }

/**
 * A conversation failure the person can act on. `retryable` separates "try
 * again" from "this will not work until something changes", so the screen can
 * say the right thing instead of showing the same dead end twice.
 */
export class ConversationRequestError extends Error {
  constructor(readonly status: number, message: string, readonly retryable: boolean) {
    super(message)
  }
}

export async function openConversation(
  port: ConversationPort = defaultPort,
  getCsrf: () => Promise<string> = csrfToken,
): Promise<ConversationOpened> {
  const body = await mutate(port, getCsrf, CONVERSATION_ENDPOINT, undefined)
  if (!isRecord(body) || body.preset !== 'dz23-assistant' || typeof body.session_id !== 'string' || body.session_id === '') {
    throw new ConversationRequestError(200, copy.invalidServerResponse, false)
  }
  return { session_id: body.session_id, reused: body.reused === true, preset: 'dz23-assistant' }
}

export async function readConversation(
  conversationId: string,
  port: ConversationPort = defaultPort,
  signal?: AbortSignal,
): Promise<ConversationSnapshot> {
  const response = await port.fetch(`${CONVERSATION_ENDPOINT}/${encodeURIComponent(conversationId)}/events`, {
    method: 'GET',
    credentials: 'same-origin',
    ...(signal === undefined ? {} : { signal }),
  })
  const body = await readBody(response)
  if (!response.ok) throw failure(response.status, body)
  if (!isRecord(body) || typeof body.conversation_id !== 'string' || typeof body.cursor !== 'number' || !Array.isArray(body.events)) {
    throw new ConversationRequestError(response.status, copy.invalidServerResponse, false)
  }
  return {
    conversation_id: body.conversation_id,
    cursor: body.cursor,
    truncated: body.truncated === true,
    events: body.events.filter(isConversationEvent),
  }
}

/**
 * Manda o arquivo e recebe de volta a referência opaca.
 *
 * O que sobe é o nome dado pela pessoa e os bytes em base64 - e nada mais. Não
 * existe `content_type` neste corpo de propósito: o tipo declarado pelo cliente
 * é um campo que o cliente escreve, e quem decide o tipo é o conteúdo, do lado
 * do servidor. Um `path` também não existe: o navegador nunca soube o caminho e
 * não teria por que informá-lo.
 * @param conversationId - a conversa dona do anexo.
 * @param file - o arquivo escolhido.
 * @returns a referência que a tela mostra e que o envio carrega.
 */
export async function uploadConversationAttachment(
  conversationId: string,
  file: { readonly name: string; arrayBuffer(): Promise<ArrayBuffer> },
  port: ConversationPort = defaultPort,
  getCsrf: () => Promise<string> = csrfToken,
): Promise<ConversationAttachment> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) {
    // Recusado aqui para a pessoa saber AGORA, e recusado de novo no servidor
    // porque este teste roda no navegador e o navegador não decide nada.
    throw new ConversationRequestError(0, copy.attachmentTooLargeLocal, false)
  }
  const body = await mutate(
    port, getCsrf,
    `${CONVERSATION_ENDPOINT}/${encodeURIComponent(conversationId)}/attachments`,
    JSON.stringify({ filename: file.name, content_base64: base64Of(bytes) }),
  )
  if (!isConversationAttachment(body)) {
    throw new ConversationRequestError(201, copy.invalidServerResponse, false)
  }
  return body
}

export async function sendConversationMessage(
  conversationId: string,
  text: string,
  port: ConversationPort = defaultPort,
  getCsrf: () => Promise<string> = csrfToken,
  attachmentIds: readonly string[] = [],
): Promise<{ readonly request_id: string }> {
  const body = await mutate(
    port, getCsrf,
    `${CONVERSATION_ENDPOINT}/${encodeURIComponent(conversationId)}/messages`,
    // O corpo tem a forma exata que o servidor aceita: `{text}` quando não há
    // anexo, e `{text, attachments}` quando há. Mandar `attachments: []` seria
    // uma terceira forma, e o servidor a recusaria - com razão.
    JSON.stringify(attachmentIds.length === 0 ? { text } : { text, attachments: attachmentIds }),
  )
  if (!isRecord(body) || typeof body.request_id !== 'string' || body.request_id === '') {
    throw new ConversationRequestError(202, copy.invalidServerResponse, false)
  }
  return { request_id: body.request_id }
}

/**
 * Pede a compactação real ao servidor.
 *
 * Rota própria de propósito: mandar a string `/compact` por `/messages` era
 * escrever um texto estranho na conversa da pessoa e não organizar nada.
 * @returns se algo foi organizado, e quanto.
 */
export async function organizeConversation(
  conversationId: string,
  port: ConversationPort = defaultPort,
  getCsrf: () => Promise<string> = csrfToken,
): Promise<{ readonly organized: boolean }> {
  const body = await mutate(
    port, getCsrf,
    `${CONVERSATION_ENDPOINT}/${encodeURIComponent(conversationId)}/compact`,
    undefined,
  )
  if (!isRecord(body) || typeof body.organized !== 'boolean') {
    throw new ConversationRequestError(202, copy.invalidServerResponse, false)
  }
  return { organized: body.organized }
}

export async function cancelConversationTurn(
  conversationId: string,
  port: ConversationPort = defaultPort,
  getCsrf: () => Promise<string> = csrfToken,
): Promise<void> {
  await mutate(port, getCsrf, `${CONVERSATION_ENDPOINT}/${encodeURIComponent(conversationId)}/cancel`, undefined)
}

async function mutate(
  port: ConversationPort,
  getCsrf: () => Promise<string>,
  path: string,
  body: string | undefined,
): Promise<unknown> {
  const response = await port.fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-dz23-csrf': await getCsrf() },
    body: body ?? '{}',
  })
  const parsed = await readBody(response)
  if (!response.ok) throw failure(response.status, parsed)
  return parsed
}

async function readBody(response: Response): Promise<unknown> {
  return response.json().catch(() => undefined)
}

/**
 * 401 and 403 mean the person's access changed, 404 that the conversation is
 * not theirs any more: retrying those only repeats the same refusal. A 5xx or a
 * timeout is worth trying again.
 */
function failure(status: number, body: unknown): ConversationRequestError {
  const message = isRecord(body) && typeof body.error === 'string' && body.error !== '' ? body.error : copy.openError
  return new ConversationRequestError(status, message, status >= 500 || status === 429)
}

function isOptionalCount(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A resposta do anexo, conferida campo a campo.
 *
 * Meia referência renderizada seria um anexo na tela que o servidor nunca
 * confirmou, e a pessoa mandaria a mensagem acreditando que o arquivo foi
 * junto.
 */
export function isConversationAttachment(value: unknown): value is ConversationAttachment {
  return isRecord(value)
    && typeof value.attachment_id === 'string' && value.attachment_id !== ''
    && typeof value.name === 'string' && value.name !== ''
    && typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size > 0
    && ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'text/plain'].includes(value.media_type as string)
}

/** Base64 sem depender do que `btoa` faz sozinho: ele só fala latin1. */
function base64Of(bytes: Uint8Array): string {
  let binary = ''
  // Em blocos porque `String.fromCharCode(...bytes)` com meio milhão de
  // argumentos estoura a pilha do navegador.
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  }
  return btoa(binary)
}

/**
 * Forward compatible on purpose: an event type this build does not know is
 * ignored instead of breaking the screen. A KNOWN type with a broken shape is
 * also dropped - rendering half an event would show the person something the
 * server never said.
 */
const MESSAGE_ATTACHMENT_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Se o valor é um anexo de mensagem que dá para mostrar. */
export function isMessageAttachment(value: unknown): value is MessageAttachment {
  return isRecord(value) && typeof value.name === 'string' && value.name !== ''
    && typeof value.media_type === 'string' && MESSAGE_ATTACHMENT_TYPES.includes(value.media_type)
}

export function isConversationEvent(value: unknown): value is ConversationEvent {
  if (!isRecord(value) || typeof value.seq !== 'number' || typeof value.at !== 'number') return false
  if (value.type === 'message.user') {
    // `attachments` é OPCIONAL e, quando vem, precisa ser uma lista de anexos
    // de verdade. Um campo malformado derruba o evento inteiro em vez de
    // aparecer meio desenhado na conversa de quem não programa.
    return typeof value.id === 'string' && typeof value.text === 'string'
      && (value.attachments === undefined || (Array.isArray(value.attachments) && value.attachments.every(isMessageAttachment)))
  }
  if (value.type === 'message.assistant') return typeof value.id === 'string' && typeof value.text === 'string'
  if (value.type === 'compaction.checkpoint') return typeof value.id === 'string' && typeof value.text === 'string'
  if (value.type === 'turn.state') return value.state === 'working' || value.state === 'idle'
  if (value.type === 'tool.state') {
    return typeof value.call_id === 'string' && typeof value.label === 'string'
      && (value.state === 'running' || value.state === 'succeeded' || value.state === 'failed')
  }
  if (value.type === 'approval.requested') {
    return typeof value.request_id === 'string' && typeof value.tool_label === 'string' && typeof value.explanation === 'string'
  }
  if (value.type === 'approval.resolved') {
    return typeof value.request_id === 'string'
      && ['allowed-once', 'rejected', 'cancelled', 'unavailable'].includes(value.outcome as string)
  }
  if (value.type === 'compaction.state') {
    return typeof value.compaction_id === 'string' && value.compaction_id !== ''
      && ['summarizing', 'committing', 'completed', 'failed'].includes(value.state as string)
      && isOptionalCount(value.items) && isOptionalCount(value.tokens)
  }
  return false
}
