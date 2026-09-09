import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import {
  CSRF_COOKIE, IdentityError, assertRequestTrust, parseCookies, requiredSessionToken, singleHeader, type StudioIdentityService,
} from '@dz23-studio/identity'
import { assertRouteContracts, type StudioRouteContract } from '@dz23-studio/policy'
import { TenancyError, type StudioTenancyService } from '@dz23-studio/tenancy'
import { z } from 'zod'
import { t } from './i18n.js'
import { ExportError } from './export.js'
import { INTEGRATIONS_PAGE_MAX, SEARCH_MAX_LENGTH, type IntegrationQuery } from './catalog.js'
import { integrationKindSchema, verificationSchema } from './model.js'
import { integrationHealth } from './runtime.js'
import { EVENTS_PAGE_MAX, HubError, strongIdentityFresh, type HubActor, type IntegrationHubService } from './service.js'

const JSON_LIMIT = 64 * 1024

/** Declared once, checked at startup: every route carries its access, permission and scope. */
export const HUB_ROUTE_CONTRACTS = [
  { method: 'GET', path: '/integrations', access: 'authorized', permission: 'workspace.read', scope: 'workspace' },
  { method: 'POST', path: '/integrations', access: 'authorized', permission: 'integrations.manage', scope: 'workspace' },
  { method: 'POST', path: '/integrations/:integrationId/enabled', access: 'authorized', permission: 'integrations.manage', scope: 'workspace' },
  // X-04: testar e remover fecham o ciclo de vida. `DELETE` e não um `POST
  // /remove` porque o método já diz o que acontece: um intermediário que
  // reenvia um POST por conta própria não pode apagar nada por engano.
  { method: 'POST', path: '/integrations/:integrationId/test', access: 'authorized', permission: 'integrations.manage', scope: 'workspace' },
  { method: 'DELETE', path: '/integrations/:integrationId', access: 'authorized', permission: 'integrations.manage', scope: 'workspace' },
  { method: 'GET', path: '/smtp', access: 'authorized', permission: 'workspace.read', scope: 'workspace' },
  { method: 'POST', path: '/approvals', access: 'authorized', permission: 'integrations.manage', scope: 'workspace' },
  { method: 'POST', path: '/smtp', access: 'authorized', permission: 'integrations.manage', scope: 'workspace' },
  { method: 'POST', path: '/smtp/test', access: 'authorized', permission: 'integrations.manage', scope: 'workspace' },
  { method: 'GET', path: '/projects/:projectId/exports', access: 'authorized', permission: 'project.read', scope: 'project' },
  { method: 'POST', path: '/projects/:projectId/exports', access: 'authorized', permission: 'project.write', scope: 'project' },
  { method: 'GET', path: '/projects/:projectId/exports/:exportId/download', access: 'authorized', permission: 'project.read', scope: 'project' },
  { method: 'GET', path: '/events', access: 'authorized', permission: 'audit.read', scope: 'workspace' },
  // O desligamento por ALCANCE (X-07). Ler exige só leitura de projeto: quem
  // acompanha precisa saber que as integrações estão desligadas — descobrir
  // isso por uma chamada que falha seria descobrir tarde demais.
  { method: 'GET', path: '/scope-switches', access: 'authorized', permission: 'project.read', scope: 'workspace' },
  { method: 'POST', path: '/scope-switches/organization', access: 'authorized', permission: 'project.write', scope: 'workspace' },
  { method: 'POST', path: '/scope-switches/projects/:projectId', access: 'authorized', permission: 'project.write', scope: 'project' },
] as const satisfies readonly StudioRouteContract[]

/**
 * O corpo do desligamento por alcance.
 *
 * O motivo é opcional NO ESQUEMA e obrigatório para RELIGAR — a regra fica no
 * serviço, e não aqui, porque ela vale por qualquer porta: uma chamada interna
 * que religasse sem motivo passaria por cima de um esquema de HTTP.
 */
const scopeSwitchSchema = z.object({
  disabled: z.boolean(),
  reason: z.string().min(1).max(500).optional(),
}).strict()

export interface HubHttpConfig {
  readonly service: IntegrationHubService
  readonly identity: StudioIdentityService
  readonly tenancy: StudioTenancyService
  readonly allowedHosts: readonly string[]
  readonly allowedOrigins: readonly string[]
  readonly prefix?: string
  readonly now?: () => Date
}

/** What the client presents: the id of an approval the SERVER issued for this exact action. */
const approvalSchema = z.object({ approval_id: z.string().min(1) }).strict()
/**
 * What the decision is about: the alias for `smtp.configured`, the recipient for
 * `smtp.tested`. It never reaches storage or the history — the server keeps only
 * a digest of it in the ticket — and it is what stops a confirmation given for
 * one target from being spent on another.
 */
const approvalRequestSchema = z.object({
  action: z.enum(['integration.enabled', 'integration.removed', 'smtp.configured', 'smtp.tested']),
  subject_id: z.string().min(1),
  payload: z.string().min(1).max(320).optional(),
}).strict()
const eventsPageSchema = z.object({ limit: z.coerce.number().int().positive().max(EVENTS_PAGE_MAX).optional(), cursor: z.string().min(1).max(512).optional() }).strict()
/**
 * A pergunta que o catálogo aceita (X-01): busca, filtros e posição.
 *
 * Cada filtro chega como uma lista separada por vírgula, e um valor que não é
 * um tipo (ou uma verificação) conhecido é RECUSADO em vez de ignorado: um
 * filtro silenciosamente descartado devolve uma lista maior do que a pedida e
 * quem lê a tela acredita que aquilo é o resultado do filtro.
 */
const catalogQuerySchema = z.object({
  q: z.string().max(SEARCH_MAX_LENGTH).optional(),
  kind: z.string().max(120).optional(),
  status: z.enum(['all', 'enabled', 'disabled']).optional(),
  verification: z.string().max(120).optional(),
  limit: z.coerce.number().int().positive().max(INTEGRATIONS_PAGE_MAX).optional(),
  cursor: z.string().min(1).max(512).optional(),
}).strict()
const enabledSchema = z.object({ enabled: z.boolean(), approval: approvalSchema.optional() }).strict()
const smtpSchema = z.object({ secret_ref: z.string(), approval: approvalSchema.optional() }).strict()
const smtpTestSchema = z.object({ to: z.string(), approval: approvalSchema.optional() }).strict()
const removeSchema = z.object({ approval: approvalSchema.optional() }).strict()

export function createHubHttpHandler(config: HubHttpConfig) {
  assertRouteContracts(HUB_ROUTE_CONTRACTS)
  const prefix = config.prefix ?? '/api/studio/hub'
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      assertRequestTrust(request, { allowedHosts: config.allowedHosts, allowedOrigins: config.allowedOrigins })
      const url = new URL(request.url ?? '/', 'http://local')
      const route = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) || '/' : url.pathname
      const actor = await authenticatedActor(request, config)
      const method = request.method ?? 'GET'
      const { service } = config

      if (method === 'GET' && route === '/integrations') {
        // A busca, o filtro e o corte acontecem AQUI: o cliente recebe uma
        // página, nunca o escopo inteiro para filtrar na tela.
        const page = await service.searchIntegrations(actor, catalogQuery(url.searchParams))
        // `can_enable` is the server's decision (signature + channel) so the interface never guesses policy.
        // `health` é derivada dos contadores gravados: nunca `OK` sem nunca ter sido chamada.
        return json(response, 200, {
          channel: service.channel,
          integrations: page.integrations.map(item => ({ ...item, can_enable: service.canEnable(item), requires_approval_tier: service.requiredApprovalTier(item), health: integrationHealth(item) })),
          next_cursor: page.next_cursor,
          // Os dois totais separam "nada encontrado para o que você procurou" de
          // "você ainda não tem integração": uma lista vazia sozinha não diz qual das duas é.
          total: page.total,
          matched: page.matched,
        })
      }
      if (method === 'POST' && route === '/integrations') {
        const registered = await service.register(actor, await readJson(request))
        return json(response, 201, registered)
      }
      const enabledMatch = /^\/integrations\/([^/]+)\/enabled$/u.exec(route)
      if (method === 'POST' && enabledMatch !== null) {
        const body = enabledSchema.parse(await readJson(request))
        const integration = await service.setEnabled(actor, decodeURIComponent(enabledMatch[1]!), body.enabled, asApproval(body.approval))
        return json(response, 200, { integration: { ...integration, can_enable: service.canEnable(integration), requires_approval_tier: service.requiredApprovalTier(integration) } })
      }
      const testMatch = /^\/integrations\/([^/]+)\/test$/u.exec(route)
      if (method === 'POST' && testMatch !== null) {
        return json(response, 200, await service.testIntegration(actor, decodeURIComponent(testMatch[1]!)))
      }
      const removeMatch = /^\/integrations\/([^/]+)$/u.exec(route)
      if (method === 'DELETE' && removeMatch !== null) {
        // O corpo é OPCIONAL: a confirmação só existe quando o nível exige, e
        // um DELETE sem corpo é o caso normal de uma integração T0/T1.
        const body = removeSchema.parse(await readJsonOrEmpty(request))
        return json(response, 200, { removed: await service.removeIntegration(actor, decodeURIComponent(removeMatch[1]!), asApproval(body.approval)) })
      }
      if (method === 'GET' && route === '/scope-switches') {
        return json(response, 200, { switches: service.scopeSwitches(actor) })
      }
      if (method === 'POST' && route === '/scope-switches/organization') {
        const body = scopeSwitchSchema.parse(await readJson(request))
        return json(response, 200, {
          switch: await service.setScopeDisabled(actor, { level: 'organization' }, body.disabled, body.reason),
        })
      }
      const scopeProjectMatch = /^\/scope-switches\/projects\/([^/]+)$/u.exec(route)
      if (method === 'POST' && scopeProjectMatch !== null) {
        const body = scopeSwitchSchema.parse(await readJson(request))
        return json(response, 200, {
          switch: await service.setScopeDisabled(
            actor, { level: 'project', projectId: decodeURIComponent(scopeProjectMatch[1]!) }, body.disabled, body.reason,
          ),
        })
      }
      if (method === 'POST' && route === '/approvals') {
        const body = approvalRequestSchema.parse(await readJson(request))
        // The fingerprint stays on the server: the client gets what it needs to show the decision
        // and to present it back, never a digest of somebody's alias to compare offline.
        const { fingerprint: _fingerprint, ...ticket } = await service.requestApproval(actor, body.action, body.subject_id, body.payload)
        return json(response, 201, ticket)
      }
      if (method === 'GET' && route === '/smtp') return json(response, 200, await service.smtp(actor))
      if (method === 'POST' && route === '/smtp') {
        const body = smtpSchema.parse(await readJson(request))
        const record = await service.configureSmtp(actor, body.secret_ref, asApproval(body.approval))
        return json(response, 200, { configured: true, secret_ref: record.secret_ref, tier: record.effective_tier })
      }
      if (method === 'POST' && route === '/smtp/test') {
        const body = smtpTestSchema.parse(await readJson(request))
        return json(response, 200, await service.testSmtp(actor, body.to, asApproval(body.approval)))
      }
      const exportsMatch = /^\/projects\/([^/]+)\/exports(?:\/([^/]+)\/download)?$/u.exec(route)
      if (exportsMatch !== null) {
        const projectId = decodeURIComponent(exportsMatch[1]!)
        if (method === 'GET' && exportsMatch[2] === undefined) return json(response, 200, { exports: (await service.listExports(actor, projectId)).map(publicExport) })
        if (method === 'POST' && exportsMatch[2] === undefined) return json(response, 201, { export: publicExport(await service.createExport(actor, projectId)) })
        if (method === 'GET' && exportsMatch[2] !== undefined) {
          const record = await service.exportRecord(actor, projectId, decodeURIComponent(exportsMatch[2]))
          // The path stored in the row is data: the service resolves it, confines it and hands back
          // an OPEN handle it already checked. Nothing here reopens the file by name.
          const { handle, size } = await service.exportFile(actor, projectId, decodeURIComponent(exportsMatch[2]))
          // Everything from here to the `finally` runs with a descriptor open, so nothing in
          // between may leave without closing it — `pipe` did exactly that: it does not destroy
          // its SOURCE when the destination dies, so closing the tab in the middle of a download
          // left the read stream, and the descriptor under it, alive until the garbage collector
          // happened to run (Node already warns about that, DEP0137). A `pipeline` tears both
          // ends down on any outcome; the `finally` covers the rest, including an exception
          // thrown between the open and the first byte.
          try {
            response.writeHead(200, {
              'content-type': 'application/zip', 'content-length': String(size), 'cache-control': 'no-store',
              'x-content-type-options': 'nosniff', 'content-disposition': `attachment; filename="${safeFileName(record.file_name)}"`,
              'x-dz23-sha256': record.sha256,
            })
            await pipeline(handle.createReadStream({ autoClose: false }), response)
          } catch {
            // The headers are already on the wire: there is no status left to send. The client
            // going away is the normal case here, not an error worth a log line.
            if (!response.writableEnded) response.destroy()
          } finally {
            await handle.close().catch(() => undefined)
          }
          return
        }
      }
      if (method === 'GET' && route === '/events') {
        const page = eventsPageSchema.parse(Object.fromEntries(url.searchParams))
        return json(response, 200, await service.events(actor, page))
      }
      return json(response, 404, { error: t('errors.routeNotFound') })
    } catch (error) {
      json(response, statusOf(error), { error: publicMessage(error) })
    }
  }
}

/**
 * A pergunta do catálogo, lida da barra de endereço.
 *
 * Uma lista vazia depois de separar por vírgula (`?kind=`) é "sem filtro", não
 * "filtro que nada satisfaz" — senão limpar a caixa na tela devolveria zero
 * resultados em vez do catálogo inteiro.
 */
export function catalogQuery(params: URLSearchParams): IntegrationQuery {
  const raw = catalogQuerySchema.parse(Object.fromEntries(params))
  return {
    search: raw.q,
    kinds: raw.kind === undefined ? undefined : z.array(integrationKindSchema).parse(splitList(raw.kind)),
    status: raw.status,
    verifications: raw.verification === undefined ? undefined : z.array(verificationSchema).parse(splitList(raw.verification)),
    limit: raw.limit,
    cursor: raw.cursor,
  }
}

function splitList(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(item => item !== '')
}

function asApproval(value: { approval_id: string } | undefined) {
  return value === undefined ? undefined : { approvalId: value.approval_id }
}

function publicExport(record: Awaited<ReturnType<IntegrationHubService['exportRecord']>>) {
  const { path: _path, ...rest } = record
  return rest
}

async function authenticatedActor(request: IncomingMessage, config: HubHttpConfig): Promise<HubActor> {
  const session = await config.identity.authenticate(requiredSessionToken(request))
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const cookies = parseCookies(request.headers.cookie)
    config.identity.validateCsrf(session, cookies[CSRF_COOKIE], singleHeader(request.headers['x-dz23-csrf']))
  }
  const authorization = config.tenancy.authorizationFor(session.user_id, session.org_id, session.tenant_id)
  if (authorization === undefined) throw new HubError('FORBIDDEN', t('errors.membershipRequired'))
  // Strong identity is read from the session that was just authenticated — never from anything the client sends.
  return { ...authorization, sessionId: session.session_id, strongIdentityVerified: strongIdentityFresh(session, config.now?.() ?? new Date()) }
}

/** Only errors this module knows carry their message to the client; everything else becomes a fixed sentence (no paths, no stack details). */
function publicMessage(error: unknown): string {
  if (error instanceof IdentityError || error instanceof TenancyError || error instanceof HubError) return error.message
  if (error instanceof ExportError) return error.code === 'INVALID_PATH' ? t('errors.internal') : error.message
  if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof URIError) return t('errors.invalidRequest')
  // Another plugin's error is NOT this module's message: duck-typing on `code` meant whatever text
  // that plugin happened to put in it — a server path, say — went straight to the network. The
  // status still distinguishes the cases (see `statusOf`); the sentence comes from our catalogue.
  if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'NOT_FOUND') return t('errors.projectNotFound')
  if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'FORBIDDEN') return t('errors.forbidden')
  return t('errors.internal')
}

function statusOf(error: unknown): number {
  if (error instanceof IdentityError) return error.code === 'locked' ? 429 : 401
  if (error instanceof TenancyError) return error.code === 'not-found' ? 404 : error.code === 'forbidden' ? 403 : 400
  if (error instanceof HubError) {
    if (error.code === 'NOT_FOUND') return 404
    if (error.code === 'FORBIDDEN') return 403
    if (error.code === 'CONFLICT' || error.code === 'SECRET_DETECTED') return 409
    if (error.code === 'TOO_LARGE') return 413
    if (error.code === 'RATE_LIMITED') return 429
    // The Studio stopped waiting for a packaging call that never came back: it is a gateway
    // timeout, not a bad request — nothing the client sent was wrong.
    if (error.code === 'TIMEOUT') return 504
    if (error.code === 'NOT_EXECUTED') return 200
    return 400
  }
  if (error instanceof ExportError) return error.code === 'RUN_MISSING' ? 409 : error.code === 'TOO_LARGE' ? 413 : error.code === 'SECRET_DETECTED' ? 409 : 500
  if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof URIError) return 400
  if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'NOT_FOUND') return 404
  if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'FORBIDDEN') return 403
  return 500
}

/** ASCII-only token for the Content-Disposition header: no quotes, separators or control characters can reach the header line. */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/gu, '_').replace(/^_+|_+$/gu, '')
  return cleaned === '' ? 'prototipo.zip' : cleaned
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!singleHeader(request.headers['content-type'])?.toLowerCase().startsWith('application/json')) throw new HubError('INVALID', t('errors.invalidRequest'))
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > JSON_LIMIT) throw new HubError('INVALID', t('errors.invalidRequest'))
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * O corpo de um pedido que pode não ter corpo (X-04: `DELETE`).
 *
 * Sem corpo vale como `{}`, e não como erro: exigir `content-type` e um `{}`
 * literal para apagar uma integração que não precisa de confirmação seria uma
 * cerimônia que não protege nada. Um corpo PRESENTE continua passando pelas
 * mesmas regras de tamanho e de tipo.
 * @param request - o pedido.
 * @returns o corpo lido, ou um objeto vazio quando não veio nenhum.
 */
async function readJsonOrEmpty(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > JSON_LIMIT) throw new HubError('INVALID', t('errors.invalidRequest'))
    chunks.push(bytes)
  }
  const body = Buffer.concat(chunks).toString('utf8').trim()
  // Corpo vazio vale como `{}` mesmo com `content-type` declarado: um cliente
  // que sempre manda o cabeçalho (e a maioria manda) não devia ser obrigado a
  // inventar um `{}` literal para apagar algo que não pede confirmação.
  if (body === '') return {}
  if (!singleHeader(request.headers['content-type'])?.toLowerCase().startsWith('application/json')) throw new HubError('INVALID', t('errors.invalidRequest'))
  return JSON.parse(body)
}

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  response.end(JSON.stringify(body))
}
