import type { IncomingMessage, ServerResponse } from 'node:http'
import { authenticatedMutation, singleHeader, type StudioIdentityService } from '@dz23-studio/identity'
import {
  AssistantConversationError,
  type AssistantConversationService,
} from './assistant-conversation.js'
import { t } from './i18n.js'

export const ASSISTANT_CONVERSATION_PREFIX = '/studio/assistant/conversation'

/** Bounded so an authenticated caller cannot stream an unbounded prompt body. */
const MAX_BODY_BYTES = 64 * 1024
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
  | { readonly kind: 'cancel'; readonly conversationId: string }
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
  if (segments.length !== 2) return { kind: 'not-found' }
  const action = segments[1]
  if (action === 'events') return method === 'GET' ? { kind: 'snapshot', conversationId } : { kind: 'method-not-allowed' }
  if (action === 'messages') return method === 'POST' ? { kind: 'send', conversationId } : { kind: 'method-not-allowed' }
  if (action === 'cancel') return method === 'POST' ? { kind: 'cancel', conversationId } : { kind: 'method-not-allowed' }
  return { kind: 'not-found' }
}

export interface AssistantConversationHttpConfig {
  readonly identity: StudioIdentityService
  readonly conversations?: Pick<AssistantConversationService, 'open' | 'snapshot' | 'send' | 'cancel'>
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
    if (route.kind === 'snapshot') {
      return { status: 200, body: await conversations.snapshot(identitySession, route.conversationId, controller.signal) }
    }
    if (route.kind === 'send') {
      const text = readMessageText(await readJsonBody(request))
      return { status: 202, body: await conversations.send(identitySession, route.conversationId, text, controller.signal) }
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

function readMessageText(body: unknown): string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AssistantConversationError('INVALID_MESSAGE', t('assistant.invalidMessage'))
  }
  const keys = Object.keys(body)
  if (keys.length !== 1 || keys[0] !== 'text') {
    throw new AssistantConversationError('INVALID_MESSAGE', t('assistant.invalidMessage'))
  }
  const text = (body as { readonly text: unknown }).text
  if (typeof text !== 'string') {
    throw new AssistantConversationError('INVALID_MESSAGE', t('assistant.invalidMessage'))
  }
  return text
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
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
    if (size > MAX_BODY_BYTES) throw new AssistantConversationError('INVALID_MESSAGE', t('assistant.messageTooLarge'))
    chunks.push(bytes)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new AssistantConversationError('INVALID_MESSAGE', t('assistant.invalidMessage'))
  }
}
