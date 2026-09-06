import { randomUUID } from 'node:crypto'
import type {
  SessionCancelRequest,
  SessionPromptRequest,
  SessionPromptValue,
  SessionRequestId,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRecord, StudioIdentityService } from '@dz23-studio/identity'
import { roleAllows } from '@dz23-studio/policy'
import type { StudioTenancyService } from '@dz23-studio/tenancy'
import type { AssistantSessionLaunch, AssistantSessionLauncher } from './assistant-session.js'

const MAX_PROMPT_BYTES = 32 * 1024
const MAX_PUBLIC_EVENTS = 500
const MAX_PUBLIC_TEXT_CHARS = 64 * 1024

export type AssistantPublicEvent =
  | { readonly type: 'message.user'; readonly seq: number; readonly at: number; readonly id: string; readonly text: string; readonly truncated: boolean }
  | { readonly type: 'message.assistant'; readonly seq: number; readonly at: number; readonly id: string; readonly text: string; readonly interrupted: boolean; readonly truncated: boolean }
  | { readonly type: 'turn.state'; readonly seq: number; readonly at: number; readonly state: 'working' | 'idle' }
  | { readonly type: 'tool.state'; readonly seq: number; readonly at: number; readonly call_id: string; readonly label: string; readonly state: 'running' | 'succeeded' | 'failed' }
  | { readonly type: 'approval.requested'; readonly seq: number; readonly at: number; readonly request_id: string; readonly tool_label: string; readonly explanation: string }
  | { readonly type: 'approval.resolved'; readonly seq: number; readonly at: number; readonly request_id: string; readonly outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' }

export interface AssistantConversationSnapshot {
  readonly conversation_id: string
  readonly cursor: number
  readonly events: readonly AssistantPublicEvent[]
  readonly truncated: boolean
}

export interface AssistantConversationControllerPort {
  inspect(sessionId: SessionId, signal?: AbortSignal): Promise<{ readonly events: SessionEvent[] }>
  prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue>
  cancel(request: SessionCancelRequest): { readonly accepted: true }
}

export interface AssistantConversationServiceOptions {
  readonly identity: Pick<StudioIdentityService, 'ownsHarnessSession'>
  readonly tenancy: Pick<StudioTenancyService, 'authorizationFor'>
  readonly launcher: Pick<AssistantSessionLauncher, 'launchTenantConversation'>
  readonly sessions: AssistantConversationControllerPort
  readonly createRequestId?: () => string
}

export class AssistantConversationError extends Error {
  constructor(
    readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID_MESSAGE' | 'SESSION_UNAVAILABLE',
    message: string,
  ) {
    super(message)
  }
}

/**
 * Tenant-aware application service for the Studio-owned conversation surface.
 * It never exposes the upstream Remote transport or its raw Session journal.
 */
export class AssistantConversationService {
  readonly #createRequestId: () => string

  constructor(private readonly options: AssistantConversationServiceOptions) {
    this.#createRequestId = options.createRequestId ?? randomUUID
  }

  async open(identitySession: SessionRecord): Promise<AssistantSessionLaunch> {
    this.#authorize(identitySession)
    return this.options.launcher.launchTenantConversation(identitySession)
  }

  async snapshot(
    identitySession: SessionRecord,
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<AssistantConversationSnapshot> {
    this.#assertOwned(identitySession, conversationId)
    try {
      const inspected = await this.options.sessions.inspect(conversationId as SessionId, signal)
      return sanitizeAssistantSnapshot(conversationId, inspected.events)
    } catch {
      throw new AssistantConversationError('NOT_FOUND', 'Conversa não encontrada.')
    }
  }

  async send(
    identitySession: SessionRecord,
    conversationId: string,
    text: string,
    signal: AbortSignal,
  ): Promise<{ readonly accepted: true; readonly request_id: string }> {
    this.#assertOwned(identitySession, conversationId)
    assertPromptText(text)
    const requestId = this.#createRequestId()
    try {
      await this.options.sessions.prompt({
        requestId: requestId as SessionRequestId,
        sessionId: conversationId as SessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, signal)
      return { accepted: true, request_id: requestId }
    } catch {
      throw new AssistantConversationError('SESSION_UNAVAILABLE', 'Não foi possível enviar sua mensagem agora.')
    }
  }

  cancel(identitySession: SessionRecord, conversationId: string): { readonly accepted: true } {
    this.#assertOwned(identitySession, conversationId)
    try {
      return this.options.sessions.cancel({ sessionId: conversationId as SessionId })
    } catch {
      throw new AssistantConversationError('SESSION_UNAVAILABLE', 'Não foi possível interromper esta tarefa agora.')
    }
  }

  #assertOwned(identitySession: SessionRecord, conversationId: string): void {
    this.#authorize(identitySession)
    if (!this.options.identity.ownsHarnessSession(identitySession, conversationId)) {
      throw new AssistantConversationError('NOT_FOUND', 'Conversa não encontrada.')
    }
  }

  #authorize(identitySession: SessionRecord): void {
    const authorization = this.options.tenancy.authorizationFor(
      identitySession.user_id,
      identitySession.org_id,
      identitySession.tenant_id,
    )
    if (authorization === undefined || !roleAllows(authorization.role, 'project.read')) {
      throw new AssistantConversationError('FORBIDDEN', 'Você não tem acesso ao assistente neste projeto.')
    }
  }
}

export function sanitizeAssistantSnapshot(
  conversationId: string,
  records: readonly unknown[],
): AssistantConversationSnapshot {
  const projected = records.flatMap(record => {
    const event = sanitizeAssistantEvent(record)
    return event === undefined ? [] : [event]
  })
  const cursor = records.reduce<number>((latest, record) => {
    const seq = eventEnvelope(record)?.seq
    return seq === undefined ? latest : Math.max(latest, seq)
  }, -1)
  const truncated = projected.length > MAX_PUBLIC_EVENTS
  return {
    conversation_id: conversationId,
    cursor,
    events: truncated ? projected.slice(-MAX_PUBLIC_EVENTS) : projected,
    truncated,
  }
}

export function sanitizeAssistantEvent(value: unknown): AssistantPublicEvent | undefined {
  const event = eventEnvelope(value)
  if (event === undefined) return undefined
  const { type, seq, time: at, data } = event
  if (type === 'turn/start') return { type: 'turn.state', seq, at, state: 'working' }
  if (type === 'turn/end') return { type: 'turn.state', seq, at, state: 'idle' }

  if (type === 'user/message') {
    const source = objectValue(data.source)
    if (source?.kind !== 'user') return undefined
    const message = publicMessage(data)
    if (message === undefined) return undefined
    return { type: 'message.user', seq, at, ...message }
  }

  if (type === 'assistant/message') {
    const messageData = objectValue(data.message)
    const message = messageData === undefined ? undefined : publicMessage(messageData)
    if (message === undefined) return undefined
    return {
      type: 'message.assistant', seq, at, ...message,
      interrupted: data.interrupted === true,
    }
  }

  if (type === 'tool/call') {
    const callId = safeIdentifier(data.callId)
    if (callId === undefined) return undefined
    return {
      type: 'tool.state', seq, at, call_id: callId,
      label: publicToolLabel(typeof data.name === 'string' ? data.name : ''),
      state: 'running',
    }
  }

  if (type === 'tool/result') {
    const message = objectValue(data.message)
    const source = message === undefined ? undefined : objectValue(message.source)
    const callId = source === undefined ? undefined : safeIdentifier(source.callId)
    if (callId === undefined) return undefined
    return {
      type: 'tool.state', seq, at, call_id: callId, label: 'Ação do assistente',
      state: data.error === undefined ? 'succeeded' : 'failed',
    }
  }

  if (type === 'approval/asked') {
    const requestId = safeIdentifier(data.id)
    if (requestId === undefined) return undefined
    return {
      type: 'approval.requested', seq, at, request_id: requestId,
      tool_label: publicToolLabel(typeof data.toolName === 'string' ? data.toolName : ''),
      explanation: 'Esta ação precisa da sua confirmação antes de continuar.',
    }
  }

  if (type === 'approval/decided') {
    const requestId = safeIdentifier(data.id)
    const outcome = data.outcome
    if (requestId === undefined || !isApprovalOutcome(outcome)) return undefined
    return { type: 'approval.resolved', seq, at, request_id: requestId, outcome }
  }

  return undefined
}

function eventEnvelope(value: unknown): { readonly type: string; readonly seq: number; readonly time: number; readonly data: Record<string, unknown> } | undefined {
  const event = objectValue(value)
  if (event === undefined || typeof event.type !== 'string'
    || typeof event.seq !== 'number' || !Number.isSafeInteger(event.seq) || event.seq < 0
    || typeof event.time !== 'number' || !Number.isFinite(event.time)) return undefined
  const data = objectValue(event.data)
  if (data === undefined) return undefined
  return { type: event.type, seq: event.seq, time: event.time, data }
}

function publicMessage(value: Record<string, unknown>): { readonly id: string; readonly text: string; readonly truncated: boolean } | undefined {
  const id = safeIdentifier(value.id)
  if (id === undefined || !Array.isArray(value.content)) return undefined
  const text = value.content.flatMap(block => {
    const candidate = objectValue(block)
    return candidate?.type === 'text' && typeof candidate.text === 'string' ? [candidate.text] : []
  }).join('')
  if (text === '') return undefined
  return {
    id,
    text: text.slice(0, MAX_PUBLIC_TEXT_CHARS),
    truncated: text.length > MAX_PUBLIC_TEXT_CHARS,
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.includes('\0')
    ? value
    : undefined
}

function publicToolLabel(name: string): string {
  if (name === 'studio_agent_list') return 'Consultar assistentes disponíveis'
  if (name === 'studio_agent_start') return 'Iniciar um assistente especializado'
  if (name === 'studio_agent_status') return 'Acompanhar o trabalho do assistente'
  if (name === 'studio_agent_cancel') return 'Interromper o trabalho do assistente'
  if (name === 'studio_agent_apply') return 'Aplicar uma proposta ao projeto'
  if (name.startsWith('studio_team_')) return 'Coordenar uma equipe de assistentes'
  if (name.startsWith('studio_')) return 'Executar uma ação do DZ23 STUDIO'
  return 'Ação do assistente'
}

function isApprovalOutcome(value: unknown): value is 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' {
  return value === 'allowed-once' || value === 'rejected' || value === 'cancelled' || value === 'unavailable'
}

function assertPromptText(text: string): void {
  if (text.trim() === '' || text.includes('\0') || Buffer.byteLength(text, 'utf8') > MAX_PROMPT_BYTES) {
    throw new AssistantConversationError('INVALID_MESSAGE', 'Escreva uma mensagem válida de até 32 KB.')
  }
}
