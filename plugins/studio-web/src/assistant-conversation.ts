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
import type {
  AssistantAttachmentReference,
  AssistantAttachmentScope,
  AssistantAttachmentStore,
} from './assistant-attachments.js'
import { MAX_ATTACHMENTS_PER_MESSAGE } from './assistant-attachments.js'
import type { AssistantSessionLaunch, AssistantSessionLauncher } from './assistant-session.js'
import { t } from './i18n.js'

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
  /**
   * Projection of the Harness compaction lifecycle. The Studio never runs a
   * second compaction and never copies the summary: the summary itself arrives
   * as the ordinary replacement message right after `compaction/summary`. What
   * travels here is only the state and, once the summary exists, the real
   * counts. There is no progress fraction because the upstream contract does
   * not carry one - inventing a percentage would be inventing evidence.
   */
  | { readonly type: 'compaction.state'; readonly seq: number; readonly at: number; readonly compaction_id: string; readonly state: 'summarizing' | 'committing' | 'completed' | 'failed'; readonly items?: number; readonly tokens?: number }
  /**
   * O checkpoint: a mensagem que SUBSTITUIU o histórico antigo, escrita pelo
   * plugin de compactação, não pela pessoa. Ela chega como `user/message` com
   * `source.kind === 'plugin'` e por isso era descartada pela projeção - o
   * comentário acima já dizia que ela atravessava, e não atravessava. Sem ela,
   * a pessoa vê o histórico encolher e não tem como auditar o que ficou no
   * lugar. Tem tipo próprio porque afirmar que a pessoa escreveu isso seria
   * outra mentira.
   */
  | { readonly type: 'compaction.checkpoint'; readonly seq: number; readonly at: number; readonly id: string; readonly text: string; readonly truncated: boolean }

export interface AssistantConversationSnapshot {
  readonly conversation_id: string
  readonly cursor: number
  readonly events: readonly AssistantPublicEvent[]
  readonly truncated: boolean
}

/**
 * A compactação de verdade do Harness. Antes disto, o botão "Organizar
 * conversa agora" mandava a STRING `/compact` como mensagem para o modelo, e o
 * controlador de sessão não faz parsing de comando: a conversa recebia um texto
 * estranho e nada era organizado.
 */
export interface AssistantCompactionPort {
  /**
   * @param sessionId - a conversa a organizar.
   * @param signal - cancelamento desta requisição.
   * @returns quanto foi organizado, ou `null` quando não havia histórico útil.
   */
  compactNow(sessionId: SessionId, signal: AbortSignal): Promise<{ readonly items: number; readonly tokens: number } | null>
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
  /**
   * Resolvido preguiçosamente de propósito: se o plugin de compactação subir
   * DEPOIS da interface, capturar o serviço no `apply` deixaria o botão morto
   * para sempre, sem log que apontasse a causa.
   */
  readonly compaction?: () => AssistantCompactionPort | undefined
  /**
   * O guarda-anexos. Opcional porque uma instalação sem ele continua
   * conversando: sem anexos a rota de envio recusa qualquer referência, em vez
   * de aceitar e descartar em silêncio.
   */
  readonly attachments?: AssistantAttachmentStore
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
    this.#authorize(identitySession, 'project.write')
    return this.options.launcher.launchTenantConversation(identitySession)
  }

  async snapshot(
    identitySession: SessionRecord,
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<AssistantConversationSnapshot> {
    this.#assertOwned(identitySession, conversationId, 'project.read')
    try {
      const inspected = await this.options.sessions.inspect(conversationId as SessionId, signal)
      return sanitizeAssistantSnapshot(conversationId, inspected.events)
    } catch {
      // A POSSE já foi verificada acima. Uma falha aqui é do Harness, não da
      // pessoa: dizer "conversa não encontrada" faria alguém acreditar que a
      // própria conversa sumiu por causa de uma indisponibilidade passageira -
      // e ainda tiraria dela o botão de tentar de novo.
      throw new AssistantConversationError('SESSION_UNAVAILABLE', t('assistant.readUnavailable'))
    }
  }

  /**
   * Guarda um arquivo e devolve a referência opaca que a conversa vai carregar.
   *
   * O CAMINHO nunca existe: os bytes chegam decodificados, o nome recebido é
   * tratado como texto hostil e vira um nome só de exibição, e o que volta para
   * o navegador é um identificador que não descreve lugar nenhum.
   * @param identitySession - a sessão de quem anexou; é dela que sai o escopo.
   * @param conversationId - a conversa dona do anexo.
   * @param filename - o nome dado pela pessoa, sem nenhuma confiança.
   * @param bytes - o conteúdo do arquivo.
   * @returns a referência que a tela mostra e que o envio aceita.
   */
  async attach(
    identitySession: SessionRecord,
    conversationId: string,
    filename: string,
    bytes: Buffer,
  ): Promise<AssistantAttachmentReference> {
    this.#assertOwned(identitySession, conversationId, 'project.write')
    const attachments = this.options.attachments
    if (attachments === undefined) {
      throw new AssistantConversationError('SESSION_UNAVAILABLE', t('assistant.serviceNotConfigured'))
    }
    return attachments.put(attachmentScope(identitySession, conversationId), filename, bytes)
  }

  /**
   * @param identitySession - a sessão de quem enviou.
   * @param conversationId - a conversa.
   * @param text - o texto da mensagem.
   * @param signal - cancelamento da requisição.
   * @param attachmentIds - referências opacas já guardadas por `attach`. Vêm
   * DEPOIS do sinal para não mudar a posição de nenhum argumento que já existia.
   */
  async send(
    identitySession: SessionRecord,
    conversationId: string,
    text: string,
    signal: AbortSignal,
    attachmentIds: readonly string[] = [],
  ): Promise<{ readonly accepted: true; readonly request_id: string }> {
    this.#assertOwned(identitySession, conversationId, 'project.write')
    assertPromptText(text)
    if (attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new AssistantConversationError('INVALID_MESSAGE', t('assistant.attachmentTooMany'))
    }
    const scope = attachmentScope(identitySession, conversationId)
    // Resolver ANTES de falar com o Harness: uma referência de outro escopo tem
    // de matar o envio inteiro, e não deixar meia mensagem entrar na conversa.
    const attached = attachmentIds.length === 0 ? [] : this.#resolveAttachments(scope, attachmentIds)
    const requestId = this.#createRequestId()
    try {
      await this.options.sessions.prompt({
        requestId: requestId as SessionRequestId,
        sessionId: conversationId as SessionId,
        mode: 'queue',
        content: [{ type: 'text', text }, ...attached.map(item => promptPart(item))],
      }, signal)
    } catch {
      throw new AssistantConversationError('SESSION_UNAVAILABLE', t('assistant.sendUnavailable'))
    }
    // Só depois do aceite: um envio que falhou deixa a referência viva para a
    // pessoa tentar de novo sem escolher o arquivo outra vez.
    this.options.attachments?.consume(scope, attachmentIds)
    return { accepted: true, request_id: requestId }
  }

  #resolveAttachments(
    scope: AssistantAttachmentScope,
    attachmentIds: readonly string[],
  ): readonly { readonly reference: AssistantAttachmentReference; readonly bytes: Buffer }[] {
    const attachments = this.options.attachments
    if (attachments === undefined) {
      // Sem guarda-anexos, TODA referência é desconhecida. A frase é a mesma de
      // uma referência vencida, porque para quem enviou o efeito é o mesmo.
      throw new AssistantConversationError('NOT_FOUND', t('assistant.attachmentMissing'))
    }
    return attachments.resolve(scope, attachmentIds)
  }

  /**
   * Organiza a conversa chamando a compactação real do Harness.
   * @param identitySession - a sessão de quem pediu.
   * @param conversationId - a conversa.
   * @param signal - cancelamento da requisição.
   * @returns `organized: false` quando não havia histórico útil - o que não é
   * erro, e a tela precisa saber para não anunciar um trabalho que não houve.
   */
  async compact(
    identitySession: SessionRecord,
    conversationId: string,
    signal: AbortSignal,
  ): Promise<{ readonly accepted: true; readonly organized: boolean; readonly items?: number; readonly tokens?: number }> {
    this.#assertOwned(identitySession, conversationId, 'project.write')
    const compaction = this.options.compaction?.()
    if (compaction === undefined) {
      throw new AssistantConversationError('SESSION_UNAVAILABLE', t('assistant.compactUnavailable'))
    }
    let result: { readonly items: number; readonly tokens: number } | null
    try {
      result = await compaction.compactNow(conversationId as SessionId, signal)
    } catch {
      // Toda falha da compactação preserva o original; a frase diz isso.
      throw new AssistantConversationError('SESSION_UNAVAILABLE', t('assistant.compactUnavailable'))
    }
    if (result === null) return { accepted: true, organized: false }
    return { accepted: true, organized: true, items: result.items, tokens: result.tokens }
  }

  cancel(identitySession: SessionRecord, conversationId: string): { readonly accepted: true } {
    this.#assertOwned(identitySession, conversationId, 'project.write')
    try {
      return this.options.sessions.cancel({ sessionId: conversationId as SessionId })
    } catch {
      throw new AssistantConversationError('SESSION_UNAVAILABLE', t('assistant.cancelUnavailable'))
    }
  }

  #assertOwned(
    identitySession: SessionRecord,
    conversationId: string,
    permission: 'project.read' | 'project.write',
  ): void {
    this.#authorize(identitySession, permission)
    if (!this.options.identity.ownsHarnessSession(identitySession, conversationId)) {
      throw new AssistantConversationError('NOT_FOUND', t('assistant.conversationMissing'))
    }
  }

  #authorize(identitySession: SessionRecord, permission: 'project.read' | 'project.write'): void {
    const authorization = this.options.tenancy.authorizationFor(
      identitySession.user_id,
      identitySession.org_id,
      identitySession.tenant_id,
    )
    if (authorization === undefined || !roleAllows(authorization.role, permission)) {
      throw new AssistantConversationError('FORBIDDEN', t('assistant.projectForbidden'))
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
    // O marcador do checkpoint é o contrato do upstream
    // (`compactCheckpointSource`): kind `plugin`, plugin `compact`.
    if (source?.kind === 'plugin' && source.plugin === 'compact') {
      const checkpoint = publicMessage(data)
      if (checkpoint === undefined) return undefined
      return { type: 'compaction.checkpoint', seq, at, ...checkpoint }
    }
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
      type: 'tool.state', seq, at, call_id: callId, label: t('assistant.genericAction'),
      state: data.error === undefined ? 'succeeded' : 'failed',
    }
  }

  if (type === 'approval/asked') {
    const requestId = safeIdentifier(data.id)
    if (requestId === undefined) return undefined
    return {
      type: 'approval.requested', seq, at, request_id: requestId,
      tool_label: publicToolLabel(typeof data.toolName === 'string' ? data.toolName : ''),
      explanation: t('assistant.approvalExplanation'),
    }
  }

  if (type === 'compaction/start') {
    const compactionId = safeIdentifier(data.compactionId)
    if (compactionId === undefined) return undefined
    return { type: 'compaction.state', seq, at, compaction_id: compactionId, state: 'summarizing' }
  }

  if (type === 'compaction/summary') {
    // `summary`, `rawOutput`, `provider`, `model`, `usage` and `maxTokens` stay
    // on the server. Only how much was organized crosses to the browser.
    const compactionId = safeIdentifier(data.compactionId)
    if (compactionId === undefined) return undefined
    const items = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : undefined
    const tokens = safeCount(data.shadowedTokenCount)
    return {
      type: 'compaction.state', seq, at, compaction_id: compactionId, state: 'committing',
      ...(items === undefined ? {} : { items }),
      ...(tokens === undefined ? {} : { tokens }),
    }
  }

  if (type === 'compaction/end') {
    // `error` is an upstream string: it can carry a path or a provider detail,
    // so only its PRESENCE crosses. The screen says the catalogued sentence.
    const compactionId = safeIdentifier(data.compactionId)
    if (compactionId === undefined) return undefined
    return {
      type: 'compaction.state', seq, at, compaction_id: compactionId,
      state: data.error === undefined ? 'completed' : 'failed',
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

function safeCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.includes('\0')
    ? value
    : undefined
}

function publicToolLabel(name: string): string {
  if (name === 'studio_agent_list') return t('assistant.toolList')
  if (name === 'studio_agent_start') return t('assistant.toolStart')
  if (name === 'studio_agent_status') return t('assistant.toolStatus')
  if (name === 'studio_agent_cancel') return t('assistant.toolCancel')
  if (name === 'studio_agent_apply') return t('assistant.toolApply')
  if (name.startsWith('studio_team_')) return t('assistant.toolTeam')
  if (name.startsWith('studio_')) return t('assistant.toolStudio')
  return t('assistant.genericAction')
}

function isApprovalOutcome(value: unknown): value is 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' {
  return value === 'allowed-once' || value === 'rejected' || value === 'cancelled' || value === 'unavailable'
}

function assertPromptText(text: string): void {
  if (text.trim() === '' || text.includes('\0') || Buffer.byteLength(text, 'utf8') > MAX_PROMPT_BYTES) {
    throw new AssistantConversationError('INVALID_MESSAGE', t('assistant.invalidMessage'))
  }
}

/** O escopo do anexo sai SEMPRE da sessão do servidor, nunca do corpo do pedido. */
function attachmentScope(identitySession: SessionRecord, conversationId: string): AssistantAttachmentScope {
  return {
    userId: identitySession.user_id,
    orgId: identitySession.org_id,
    tenantId: identitySession.tenant_id,
    conversationId,
  }
}

/**
 * O bloco que o Harness recebe.
 *
 * A imagem viaja como bytes (o Host os promove para uma referência durável
 * dele); o texto viaja como texto, com o nome exibível anunciado antes do
 * conteúdo para que o modelo saiba o que está lendo. Em nenhum dos dois casos
 * atravessa um caminho: não existe caminho a atravessar.
 */
function promptPart(item: { readonly reference: AssistantAttachmentReference; readonly bytes: Buffer }): {
  readonly type: 'text'; readonly text: string
} | {
  readonly type: 'image'; readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; readonly data: string; readonly name: string
} {
  const { reference, bytes } = item
  if (reference.media_type === 'text/plain') {
    return { type: 'text', text: `${reference.name}\n${bytes.toString('utf8')}` }
  }
  return {
    type: 'image',
    mediaType: reference.media_type,
    data: bytes.toString('base64'),
    name: reference.name,
  }
}
