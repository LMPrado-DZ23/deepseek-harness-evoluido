import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-storage-domain'
import {
  APPROVAL_PREFIX,
  ActionApprovalError,
  approvalStatus,
  handleApproval,
  routeApproval,
  type StudioActionApprovalService,
} from '@dz23-studio/action-approval'
import type {} from '@dz23-studio/preview'
import type {} from '@dz23-studio/tenancy'
import {
  IdentityError,
  authenticatedMutation,
  assertRequestTrust,
  type StudioIdentityService,
} from '@dz23-studio/identity'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { extname, relative, resolve, sep } from 'node:path'
import { t } from './i18n.js'
import { fileURLToPath } from 'node:url'
import {
  AssistantSessionLaunchError,
  AssistantSessionLauncher,
  type AssistantRepositoryLaunchConfig,
} from './assistant-session.js'
import { AssistantConversationError, AssistantConversationService } from './assistant-conversation.js'
import {
  StuckRunsError,
  handleStuckRuns,
  routeStuckRuns,
  stuckRunsStatus,
  type StuckRunsSource,
} from './stuck-runs.js'
import {
  assistantConversationStatus,
  handleAssistantConversation,
  routeAssistantConversation,
  type AssistantConversationHttpConfig,
} from './assistant-http.js'

export * from './assistant-session.js'
export * from './assistant-conversation.js'
export * from './assistant-http.js'
export * from './stuck-runs.js'

export const name = 'dz23-studio-web'
export const inject = ['sessionController', 'studioIdentity', 'studioPreview', 'studioTenancy', 'webServer']

export const ASSISTANT_SESSION_PATH = '/studio/assistant/session'

export interface StudioWebConfig {
  readonly distDirectory?: string
  readonly allowedHosts?: readonly string[]
  readonly allowedOrigins?: readonly string[]
  readonly previewFrameSources?: readonly string[]
  readonly assistantRepositories?: readonly AssistantRepositoryLaunchConfig[]
}

export function createStudioWebHandler(config: {
  readonly distDirectory: string
  readonly identity: StudioIdentityService
  readonly allowedHosts: readonly string[]
  readonly allowedOrigins: readonly string[]
  readonly previewFrameSources?: readonly string[]
  readonly assistantSessions?: Pick<AssistantSessionLauncher, 'launch'>
  readonly assistantConversations?: AssistantConversationHttpConfig['conversations']
  /**
   * Autoridade de confirmação (M90-A), resolvida A CADA PEDIDO. Capturar o
   * serviço na montagem criava uma corrida silenciosa com a ordem de
   * montagem dos plugins. Ausente no momento do pedido, a rota responde 503.
   */
  actionApprovals?(): StudioActionApprovalService | undefined
  /** Runtime de agentes, resolvido a cada pedido. Ausente, a rota responde 503. */
  agentRuns?(): StuckRunsSource | undefined
  readonly assistantDeadlineMs?: number
}) {
  const frameSources = normalizePreviewFrameSources(config.previewFrameSources ?? [])
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let conversationRoute: ReturnType<typeof routeAssistantConversation>
    try {
      assertRequestTrust(request, { allowedHosts: config.allowedHosts, allowedOrigins: config.allowedOrigins })
      const pathname = new URL(request.url ?? '/studio', 'http://local').pathname
      conversationRoute = routeAssistantConversation(request.method, pathname)
      if (conversationRoute !== undefined) {
        const outcome = await handleAssistantConversation(request, conversationRoute, {
          identity: config.identity,
          ...(config.assistantConversations === undefined ? {} : { conversations: config.assistantConversations }),
          ...(config.assistantDeadlineMs === undefined ? {} : { deadlineMs: config.assistantDeadlineMs }),
        })
        return sendJson(response, outcome.status, outcome.body, frameSources)
      }
      const stuckRoute = routeStuckRuns(request.method, pathname)
      if (stuckRoute !== undefined) {
        const agents = config.agentRuns?.()
        const outcome = await handleStuckRuns(request, stuckRoute, {
          identity: config.identity,
          ...(agents === undefined ? {} : { agents }),
        })
        return sendJson(response, outcome.status, outcome.body, frameSources)
      }
      const approvalRoute = routeApproval(request.method, pathname)
      if (approvalRoute !== undefined) {
        const approvals = config.actionApprovals?.()
        if (approvals === undefined) {
          return sendJson(response, 503, { error: t('approvals.notConfigured') }, frameSources)
        }
        const outcome = await handleApproval(request, approvalRoute, {
          service: approvals,
          // Identidade e escopo saem do cookie de sessão; o cliente não
          // contribui com usuário, organização nem inquilino.
          authenticate: async current => {
            const session = await authenticatedMutation(current, config.identity)
            return {
              userId: session.user_id, orgId: session.org_id,
              tenantId: session.tenant_id, sessionId: session.session_id,
            }
          },
          // `authenticatedMutation` já validou o CSRF do método mutante.
          assertCsrf: () => {},
        })
        return sendJson(response, outcome.status, outcome.body, frameSources)
      }
      if (pathname === ASSISTANT_SESSION_PATH) {
        if (request.method !== 'POST') return send(response, 405, 'Método não permitido.', frameSources)
        const identitySession = await authenticatedMutation(request, config.identity)
        if (config.assistantSessions === undefined) {
          return sendJson(response, 503, { error: t('assistant.serviceNotConfigured') }, frameSources)
        }
        const launched = await config.assistantSessions.launch(identitySession)
        return sendJson(response, 200, launched, frameSources)
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return send(response, 405, 'Método não permitido.', frameSources)
      await authenticatedMutation(request, config.identity)
      const root = await realpath(config.distDirectory)
      const requested = pathname === '/studio' || pathname === '/studio/' ? 'index.html' : decodeURIComponent(pathname.slice('/studio/'.length))
      const candidate = safeTarget(root, requested)
      const selected = await selectFile(root, candidate, requested)
      const body = await readFile(selected)
      response.writeHead(200, securityHeaders(contentType(selected), frameSources))
      response.end(request.method === 'HEAD' ? undefined : body)
    } catch (error) {
      const stuckStatus = stuckRunsStatus(error)
      if (stuckStatus !== undefined && error instanceof StuckRunsError) {
        return sendJson(response, stuckStatus, { error: error.message }, frameSources)
      }
      const approvalErrorStatus = approvalStatus(error)
      if (approvalErrorStatus !== undefined && error instanceof ActionApprovalError) {
        // O código viaja junto: sem ele a tela não distingue "falta a chave de
        // acesso" de "isto não é seu", e mandaria a pessoa usar a passkey
        // contra um erro que a passkey não resolve.
        return sendJson(response, approvalErrorStatus, { error: error.message, code: error.code }, frameSources)
      }
      const conversationStatus = assistantConversationStatus(error)
      if (conversationStatus !== undefined && error instanceof AssistantConversationError) {
        return sendJson(response, conversationStatus, { error: error.message }, frameSources)
      }
      const status = error instanceof IdentityError ? error.code === 'locked' ? 429 : 401
        : error instanceof AssistantSessionLaunchError ? ({
          NOT_CONFIGURED: 503,
          FORBIDDEN: 403,
          SESSION_CONFLICT: 409,
          SESSION_UNAVAILABLE: 503,
        } as const)[error.code]
        : error instanceof StaticFileError ? error.status : 500
      if (error instanceof AssistantSessionLaunchError) {
        sendJson(response, status, { error: error.message }, frameSources)
      } else {
        // Só texto de catálogo chega ao cliente. A mensagem de um erro
        // inesperado pode carregar caminho local, segredo ou detalhe de
        // implementação, e não é ela que ajuda quem está usando o Studio.
        const catalogued = error instanceof IdentityError || error instanceof StaticFileError
        const message = catalogued ? error.message : t('assistant.interfaceUnavailable')
        // Quem chamou uma rota da conversa espera JSON. Responder `text/plain`
        // faz o cliente perder a mensagem e mostrar um erro genérico no lugar
        // de "entre de novo" ou "aguarde um instante".
        if (conversationRoute !== undefined) sendJson(response, status, { error: message }, frameSources)
        else send(response, status, message, frameSources)
      }
    }
  }
}

export async function apply(ctx: Context, config: StudioWebConfig = {}): Promise<void> {
  const port = ctx.webServer.port
  const defaultHost = `127.0.0.1:${port}`
  const defaultOrigins = [`http://localhost:${port}`, `http://${defaultHost}`]
  const packagedClient = fileURLToPath(new URL('./client/', import.meta.url))
  const distDirectory = resolve(config.distDirectory ?? packagedClient)
  const assistantSessions = await AssistantSessionLauncher.create({
    identity: ctx.studioIdentity.service,
    tenancy: ctx.studioTenancy.service,
    sessions: ctx.sessionController,
    repositories: config.assistantRepositories ?? [],
    reportFailure: (phase, error) => {
      ctx.logger.warn(`dz23-studio-web: assistant session ${phase} failed: ${String(error)}`)
    },
  })
  const assistantConversations = new AssistantConversationService({
    identity: ctx.studioIdentity.service,
    tenancy: ctx.studioTenancy.service,
    launcher: assistantSessions,
    sessions: ctx.sessionController,
  })
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: '/studio',
    handler: createStudioWebHandler({
      distDirectory, identity: ctx.studioIdentity.service,
      assistantConversations,
      allowedHosts: config.allowedHosts ?? [defaultHost, `localhost:${port}`],
      allowedOrigins: config.allowedOrigins ?? defaultOrigins,
      previewFrameSources: config.previewFrameSources ?? [ctx.studioPreview.frameSource],
      // Lidos a cada pedido, nunca capturados na montagem: a ordem entre
      // plugins não é garantida, e um serviço que sobe depois deste precisa
      // ser encontrado. Ausente no pedido, a rota responde NOT_CONFIGURED em
      // vez de sumir num 404 confuso.
      actionApprovals: () => ctx.get('studioActionApproval')?.service,
      agentRuns: () => ctx.get('studioAgents'),
      assistantSessions,
    }),
  }), 'dz23-studio-web.http')
}

class StaticFileError extends Error {
  constructor(readonly status: 400 | 404, message: string) { super(message) }
}

function safeTarget(root: string, requested: string): string {
  if (requested === '' || requested.includes('\0') || requested.includes('\\')) throw new StaticFileError(400, 'Caminho inválido.')
  const target = resolve(root, requested)
  if (!target.startsWith(`${root}${sep}`) || relative(root, target).startsWith('..')) throw new StaticFileError(400, 'Caminho inválido.')
  return target
}

async function selectFile(root: string, candidate: string, requested: string): Promise<string> {
  const info = await lstat(candidate).catch(() => undefined)
  if (info?.isSymbolicLink()) throw new StaticFileError(400, 'Links simbólicos não são servidos.')
  if (info?.isFile()) return candidate
  if (extname(requested) !== '') throw new StaticFileError(404, 'Arquivo não encontrado.')
  const index = resolve(root, 'index.html')
  const indexInfo = await lstat(index).catch(() => undefined)
  if (!indexInfo?.isFile() || indexInfo.isSymbolicLink()) throw new StaticFileError(404, 'Interface ainda não foi compilada.')
  return index
}

function contentType(path: string): string {
  return ({
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  } as Readonly<Record<string, string>>)[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

function securityHeaders(type: string, frameSources: readonly string[]): Record<string, string> {
  const frameSource = frameSources.length === 0 ? "'none'" : frameSources.join(' ')
  return {
    'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
    'content-security-policy': `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src ${frameSource}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
  }
}

function normalizePreviewFrameSources(values: readonly string[]): readonly string[] {
  return [...new Set(values.map(value => {
    const local = /^http:\/\/\*\.dz23\.localhost(?::([1-9]\d{0,4}))?$/u.exec(value)
    if (local !== null && (local[1] === undefined || Number(local[1]) <= 65_535)) return value
    const hosted = /^https:\/\/\*\.preview\.([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/u.exec(value)
    if (hosted !== null && hosted[1]!.includes('.') && !hosted[1]!.includes('..')) return value
    throw new Error(t('config.invalidPreviewFrameSource'))
  }))]
}

function send(response: ServerResponse, status: number, message: string, frameSources: readonly string[] = []): void {
  if (response.writableEnded) return
  response.writeHead(status, securityHeaders('text/plain; charset=utf-8', frameSources))
  response.end(message)
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  frameSources: readonly string[] = [],
): void {
  if (response.writableEnded) return
  response.writeHead(status, securityHeaders('application/json; charset=utf-8', frameSources))
  response.end(JSON.stringify(body))
}
