import type { IncomingMessage, ServerResponse } from 'node:http'
import { authenticatedMutation, singleHeader, type StudioIdentityService } from '@dz23-studio/identity'
import { MAX_ATTACHMENTS_PER_MESSAGE } from './assistant-attachments.js'
import {
  AssistantConversationError,
  type AssistantConversationService,
} from './assistant-conversation.js'
import { t } from './i18n.js'
import { ASSISTANT_STREAM_HEADERS, streamAssistantConversation, type AssistantStreamOptions } from './assistant-stream.js'

export const ASSISTANT_CONVERSATION_PREFIX = '/studio/assistant/conversation'

/** Bounded so an authenticated caller cannot stream an unbounded prompt body. */
const MAX_BODY_BYTES = 64 * 1024
/**
 * O corpo do anexo tem teto PRÓPRIO, e maior.
 *
 * Um arquivo de 512 KiB vira ~683 KiB de base64 mais o resto do JSON: medir o
 * anexo com o teto da mensagem recusaria todo arquivo acima de ~48 KiB, e a
 * pessoa leria "grande demais" num arquivo que a tela dizia caber. O teto de
 * verdade - o dos BYTES - é verificado depois, no guarda-anexos; este aqui só
 * impede que alguém autenticado transmita um corpo sem fim.
 */
const MAX_ATTACHMENT_BODY_BYTES = 1024 * 1024
/** Uma referência opaca. Nunca vira caminho, mas morre na borda se for hostil. */
const ATTACHMENT_ID = /^[A-Za-z0-9_-]{1,128}$/u
/** A stuck upstream must free the socket instead of holding the person's turn open. */
const REQUEST_TIMEOUT_MS = 30_000
/**
 * The conversation id is a Harness Session id echoed back by the client. It is
 * never used to build a path or a query, but it is still validated here so a
 * hostile value dies at the edge rather than deeper in the stack.
 */
const CONVERSATION_ID = /^[A-Za-z0-9_.:-]{1,128}$/u

export type AssistantConversationRoute =
  | { readonly kind: 'open' }
  | { readonly kind: 'snapshot'; readonly conversationId: string }
  | { readonly kind: 'send'; readonly conversationId: string }
  | { readonly kind: 'attach'; readonly conversationId: string }
  | { readonly kind: 'stream'; readonly conversationId: string }
  | { readonly kind: 'cancel'; readonly conversationId: string }
  | { readonly kind: 'compact'; readonly conversationId: string }
  | { readonly kind: 'method-not-allowed' }
  | { readonly kind: 'not-found' }

/**
 * Pure routing for the conversation surface. Kept separate from the handler so
 * every shape - including the ones that must NOT exist - is provable by test.
 */
export function routeAssistantConversation(
  method: string | undefined,
  pathname: string,
): AssistantConversationRoute | undefined {
  if (pathname !== ASSISTANT_CONVERSATION_PREFIX && !pathname.startsWith(`${ASSISTANT_CONVERSATION_PREFIX}/`)) {
    return undefined
  }
  if (pathname === ASSISTANT_CONVERSATION_PREFIX) {
    return method === 'POST' ? { kind: 'open' } : { kind: 'method-not-allowed' }
  }
  const rest = pathname.slice(`${ASSISTANT_CONVERSATION_PREFIX}/`.length)
  const segments = rest.split('/')
  const rawId = segments[0]!
  let conversationId: string
  try {
    conversationId = decodeURIComponent(rawId)
  } catch {
    return { kind: 'not-found' }
  }
  if (!CONVERSATION_ID.test(conversationId)) return { kind: 'not-found' }
  if (conversationId.replaceAll('.', '') === '') return { kind: 'not-found' }
  // `events/stream` é o único caminho de TRÊS segmentos. Ele fica aqui, e não
  // como uma rota solta, para continuar valendo a mesma conferência de
  // identidade do conversationId que todas as outras passam.
  if (segments.length === 3 && segments[1] === 'events' && segments[2] === 'stream') {
    return method === 'GET' ? { kind: 'stream', conversationId } : { kind: 'method-not-allowed' }
  }
  if (segments.length !== 2) return { kind: 'not-found' }
  const action = segments[1]
  if (action === 'events') return method === 'GET' ? { kind: 'snapshot', conversationId } : { kind: 'method-not-allowed' }
  if (action === 'messages') return method === 'POST' ? { kind: 'send', conversationId } : { kind: 'method-not-allowed' }
  // Só POST: não existe listar nem baixar anexo. Uma rota de leitura devolveria
  // o conteúdo de volta ao navegador e transformaria a referência opaca num
  // endereço de arquivo - exatamente o que ela existe para não ser.
  if (action === 'attachments') return method === 'POST' ? { kind: 'attach', conversationId } : { kind: 'method-not-allowed' }
  if (action === 'cancel') return method === 'POST' ? { kind: 'cancel', conversationId } : { kind: 'method-not-allowed' }
  if (action === 'compact') return method === 'POST' ? { kind: 'compact', conversationId } : { kind: 'method-not-allowed' }
  return { kind: 'not-found' }
}

export interface AssistantConversationHttpConfig {
  readonly identity: StudioIdentityService
  readonly conversations?: Pick<AssistantConversationService, 'open' | 'snapshot' | 'send' | 'cancel' | 'compact'>
    & Partial<Pick<AssistantConversationService, 'attach'>>
  /** Deadline per request. Injectable so the abort itself is provable by test. */
  readonly deadlineMs?: number
}

export interface AssistantConversationOutcome {
  readonly status: number
  readonly body: unknown
}

/**
 * Answers one conversation request. Returns the status and the public body; the
 * caller writes it with the Studio security headers. Every failure is mapped to
 * a code the person can act on, and nothing but catalogued text ever reaches
 * the client - no stack, no path, no id, no upstream message.
 */
export async function handleAssistantConversation(
  request: IncomingMessage,
  route: AssistantConversationRoute,
  config: AssistantConversationHttpConfig,
): Promise<AssistantConversationOutcome> {
  if (route.kind === 'method-not-allowed') return { status: 405, body: { error: t('assistant.methodNotAllowed') } }
  if (route.kind === 'not-found') return { status: 404, body: { error: t('assistant.conversationMissing') } }
  const identitySession = await authenticatedMutation(request, config.identity)
  const conversations = config.conversations
  if (conversations === undefined) return { status: 503, body: { error: t('assistant.serviceNotConfigured') } }
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, config.deadlineMs ?? REQUEST_TIMEOUT_MS)
  try {
    if (route.kind === 'open') {
      return { status: 200, body: await conversations.open(identitySession) }
    }
    if (route.kind === 'snapshot' || route.kind === 'stream') {
      // O `stream` NÃO é servido por aqui: quem segura a conexão é
      // `handleAssistantConversationStream`, porque esta função devolve um
      // corpo pronto e uma conexão que dura minutos não cabe nesse formato.
      // Ele chega aqui só quando o chamador não tratou o caso; responder o
      // retrato inteiro é a degradação certa - a tela recebe o que pediu,
      // só que de uma vez em vez de aos poucos.
      return { status: 200, body: await conversations.snapshot(identitySession, route.conversationId, controller.signal) }
    }
    if (route.kind === 'send') {
      const message = readMessagePayload(await readJsonBody(request, MAX_BODY_BYTES))
      return {
        status: 202,
        body: await conversations.send(
          identitySession, route.conversationId, message.text, controller.signal, message.attachments,
        ),
      }
    }
    if (route.kind === 'attach') {
      if (conversations.attach === undefined) return { status: 503, body: { error: t('assistant.serviceNotConfigured') } }
      const upload = readAttachmentUpload(await readJsonBody(request, MAX_ATTACHMENT_BODY_BYTES))
      return {
        status: 201,
        body: await conversations.attach(identitySession, route.conversationId, upload.filename, upload.bytes),
      }
    }
    if (route.kind === 'compact') {
      return { status: 202, body: await conversations.compact(identitySession, route.conversationId, controller.signal) }
    }
    return { status: 202, body: conversations.cancel(identitySession, route.conversationId) }
  } finally {
    clearTimeout(timer)
  }
}

export function assistantConversationStatus(error: unknown): number | undefined {
  if (!(error instanceof AssistantConversationError)) return undefined
  return ({ FORBIDDEN: 403, NOT_FOUND: 404, INVALID_MESSAGE: 400, SESSION_UNAVAILABLE: 503 } as const)[error.code]
}

/**
 * O corpo de um envio, com a MESMA garantia de antes numa forma maior.
 *
 * A regra nunca foi "conte uma chave": era "nenhuma chave inesperada passa", e
 * a contagem era só como ela se escrevia enquanto `text` era a única chave.
 * Agora o corpo é `{text}` ou `{text, attachments}`, e qualquer outra chave -
 * `tier`, `workspace_id`, `path`, um `__proto__` - continua matando o pedido.
 * O conjunto é fechado e comparado por inteiro: uma chave nova só passa a
 * existir aqui, à vista, e nunca por acidente.
 * @param body - o JSON já lido do corpo.
 * @returns o texto e as referências de anexo, ambos já validados.
 */
function readMessagePayload(body: unknown): { readonly text: string; readonly attachments: readonly string[] } {
  const record = plainRecord(body)
  const keys = Object.keys(record).sort()
  const shape = keys.join(',')
  if (shape !== 'text' && shape !== 'attachments,text') {
    throw new AssistantConversationError('INVALID_MESSAGE', t('assistant.invalidMessage'))
  }
  const text = record.text
  if (typeof text !== 'string') {
    throw new AssistantConversationError('INVALID_MESSAGE', t('assistant.invalidMessage'))
  }
  if (shape === 'text') return { text, attachments: [] }
  const attachments = record.attachments
  if (!Array.isArray(attachments) || attachments.length === 0 || attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new AssistantConversationError('INVALID_MESSAGE', t('assistant.invalidMessage'))
  }
  for (const id of attachments) {
    if (typeof id !== 'string' || !ATTACHMENT_ID.test(id)) {
      throw new AssistantConversationError('INVALID_MESSAGE', t('assistant.invalidMessage'))
    }
  }
  return { text, attachments: attachments as readonly string[] }
}

/**
 * O corpo de um anexo: exatamente `{filename, content_base64}`, e nada mais.
 *
 * Não existe `content_type` no contrato, e essa ausência é a regra: aceitar o
 * tipo declarado pelo cliente seria deixar quem envia escolher em que gaveta o
 * arquivo cai. Quem decide o tipo é o conteúdo, mais adiante. Não existe
 * `path`, `size` nem `id` pela mesma razão - todos seriam dado do cliente
 * governando o servidor.
 */
function readAttachmentUpload(body: unknown): { readonly filename: string; readonly bytes: Buffer } {
  const record = plainRecord(body)
  const keys = Object.keys(record).sort()
  if (keys.join(',') !== 'content_base64,filename') {
    throw new AssistantConversationError('INVALID_MESSAGE', t('assistant.attachmentInvalidRequest'))
  }
  const filename = record.filename
  const encoded = record.content_base64
  if (typeof filename !== 'string' || filename === '' || filename.length > 4096 || typeof encoded !== 'string') {
    throw new AssistantConversationError('INVALID_MESSAGE', t('assistant.attachmentInvalidRequest'))
  }
  // `Buffer.from(..., 'base64')` engole lixo em silêncio: reescrever e comparar
  // é o que separa "o cliente mandou base64" de "o cliente mandou qualquer
  // coisa e o Node aceitou os pedaços que reconheceu".
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.toString('base64') !== encoded.replaceAll(/\s/gu, '')) {
    throw new AssistantConversationError('INVALID_MESSAGE', t('assistant.attachmentInvalidRequest'))
  }
  return { filename, bytes }
}

/** Um objeto simples. Array e `null` são objetos em JavaScript e não servem. */
function plainRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AssistantConversationError('INVALID_MESSAGE', t('assistant.invalidMessage'))
  }
  return body as Record<string, unknown>
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  // Cabeçalho repetido é ambíguo: singleHeader devolve undefined e a
  // requisição morre aqui, em vez de escolher uma das cópias.
  const declared = singleHeader(request.headers['content-type'])
  if (declared?.toLowerCase().startsWith('application/json') !== true) {
    throw new AssistantConversationError('INVALID_MESSAGE', t('assistant.invalidMessage'))
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    /* v8 ignore next -- node:http request body chunks are Buffers. */
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += bytes.length
    if (size > maxBytes) throw new AssistantConversationError('INVALID_MESSAGE', t('assistant.messageTooLarge'))
    chunks.push(bytes)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new AssistantConversationError('INVALID_MESSAGE', t('assistant.invalidMessage'))
  }
}

/**
 * Serve a conexão que fica aberta enquanto a conversa acontece.
 *
 * Ela é separada de `handleAssistantConversation` porque aquela função devolve
 * um corpo PRONTO — status e objeto — e uma conexão que dura minutos não cabe
 * nesse formato. Aqui a resposta é escrita aos poucos, e é esta função que a
 * possui do começo ao fim.
 *
 * A autenticação e a posse continuam sendo as mesmas: a sessão é conferida
 * antes de qualquer byte, e o `snapshot` do serviço é quem verifica que a
 * conversa é de quem está pedindo. Uma conexão longa não é uma porta lateral.
 *
 * @param request - o pedido.
 * @param response - a resposta, que esta função passa a possuir.
 * @param route - a rota de fluxo já reconhecida.
 * @param config - identidade e serviço de conversas.
 * @returns quando a conexão termina.
 */
export async function handleAssistantConversationStream(
  request: IncomingMessage,
  response: ServerResponse,
  route: Extract<AssistantConversationRoute, { kind: 'stream' }>,
  config: AssistantConversationHttpConfig & { readonly stream?: Partial<AssistantStreamOptions> },
): Promise<void> {
  const conversations = config.conversations
  if (conversations === undefined) {
    response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ error: t('assistant.serviceNotConfigured') }))
    return
  }
  let identitySession
  try { identitySession = await authenticatedMutation(request, config.identity) }
  catch {
    // Nenhum byte de fluxo sai antes da identidade valer. Recusar em JSON, com
    // o mesmo texto de sempre, mantém o erro legível para a tela.
    response.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ error: t('assistant.forbidden') }))
    return
  }
  // A PRIMEIRA leitura acontece antes dos cabeçalhos de fluxo: se a conversa
  // não é desta pessoa, ou o Harness não responde, o certo é um erro HTTP
  // comum - e não um fluxo aberto que só depois confessa que não tem nada.
  const controller = new AbortController()
  const abort = () => { controller.abort() }
  request.once('close', abort)
  try { await conversations.snapshot(identitySession, route.conversationId, controller.signal) }
  catch (error) {
    const status = assistantConversationStatus(error) ?? 503
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ error: error instanceof AssistantConversationError ? error.message : t('assistant.readUnavailable') }))
    return
  }
  response.writeHead(200, { ...ASSISTANT_STREAM_HEADERS })
  await streamAssistantConversation({
    read: signal => conversations.snapshot(identitySession, route.conversationId, signal),
    sink: {
      write: chunk => { response.write(chunk) },
      end: () => { response.end() },
    },
    signal: controller.signal,
    ...config.stream,
  })
  request.off('close', abort)
}
