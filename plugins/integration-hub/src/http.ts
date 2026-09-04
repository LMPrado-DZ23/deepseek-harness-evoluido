import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  CSRF_COOKIE, IdentityError, assertRequestTrust, parseCookies, requiredSessionToken, singleHeader, type StudioIdentityService,
} from '@dz23-studio/identity'
import { assertRouteContracts, type StudioRouteContract } from '@dz23-studio/policy'
import { TenancyError, type StudioTenancyService } from '@dz23-studio/tenancy'
import { z } from 'zod'
import { t } from './i18n.js'
import { ExportError } from './export.js'
import { HubError, type HubActor, type IntegrationHubService } from './service.js'

const JSON_LIMIT = 64 * 1024

/** Declared once, checked at startup: every route carries its access, permission and scope. */
export const HUB_ROUTE_CONTRACTS = [
  { method: 'GET', path: '/integrations', access: 'authorized', permission: 'workspace.read', scope: 'workspace' },
  { method: 'POST', path: '/integrations', access: 'authorized', permission: 'integrations.manage', scope: 'workspace' },
  { method: 'POST', path: '/integrations/:integrationId/enabled', access: 'authorized', permission: 'integrations.manage', scope: 'workspace' },
  { method: 'GET', path: '/smtp', access: 'authorized', permission: 'workspace.read', scope: 'workspace' },
  { method: 'POST', path: '/smtp', access: 'authorized', permission: 'integrations.manage', scope: 'workspace' },
  { method: 'POST', path: '/smtp/test', access: 'authorized', permission: 'integrations.manage', scope: 'workspace' },
  { method: 'GET', path: '/projects/:projectId/exports', access: 'authorized', permission: 'project.read', scope: 'project' },
  { method: 'POST', path: '/projects/:projectId/exports', access: 'authorized', permission: 'project.write', scope: 'project' },
  { method: 'GET', path: '/projects/:projectId/exports/:exportId/download', access: 'authorized', permission: 'project.read', scope: 'project' },
  { method: 'GET', path: '/events', access: 'authorized', permission: 'audit.read', scope: 'workspace' },
] as const satisfies readonly StudioRouteContract[]

export interface HubHttpConfig {
  readonly service: IntegrationHubService
  readonly identity: StudioIdentityService
  readonly tenancy: StudioTenancyService
  readonly allowedHosts: readonly string[]
  readonly allowedOrigins: readonly string[]
  readonly prefix?: string
}

const enabledSchema = z.object({ enabled: z.boolean() }).strict()
const smtpSchema = z.object({ secret_ref: z.string() }).strict()
const smtpTestSchema = z.object({ to: z.string() }).strict()

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
        // `can_enable` is the server's decision (signature + channel) so the interface never guesses policy.
        return json(response, 200, { channel: service.channel, integrations: service.list(actor).map(item => ({ ...item, can_enable: service.canEnable(item) })) })
      }
      if (method === 'POST' && route === '/integrations') {
        const registered = await service.register(actor, await readJson(request))
        return json(response, 201, registered)
      }
      const enabledMatch = /^\/integrations\/([^/]+)\/enabled$/u.exec(route)
      if (method === 'POST' && enabledMatch !== null) {
        const body = enabledSchema.parse(await readJson(request))
        const integration = await service.setEnabled(actor, decodeURIComponent(enabledMatch[1]!), body.enabled)
        return json(response, 200, { integration: { ...integration, can_enable: service.canEnable(integration) } })
      }
      if (method === 'GET' && route === '/smtp') return json(response, 200, service.smtp(actor))
      if (method === 'POST' && route === '/smtp') {
        const body = smtpSchema.parse(await readJson(request))
        const record = await service.configureSmtp(actor, body.secret_ref)
        return json(response, 200, { configured: true, secret_ref: record.secret_ref, tier: record.effective_tier })
      }
      if (method === 'POST' && route === '/smtp/test') {
        const body = smtpTestSchema.parse(await readJson(request))
        return json(response, 200, await service.testSmtp(actor, body.to))
      }
      const exportsMatch = /^\/projects\/([^/]+)\/exports(?:\/([^/]+)\/download)?$/u.exec(route)
      if (exportsMatch !== null) {
        const projectId = decodeURIComponent(exportsMatch[1]!)
        if (method === 'GET' && exportsMatch[2] === undefined) return json(response, 200, { exports: service.listExports(actor, projectId).map(publicExport) })
        if (method === 'POST' && exportsMatch[2] === undefined) return json(response, 201, { export: publicExport(await service.createExport(actor, projectId)) })
        if (method === 'GET' && exportsMatch[2] !== undefined) {
          const record = service.exportRecord(actor, projectId, decodeURIComponent(exportsMatch[2]))
          const info = await stat(record.path).catch(() => undefined)
          if (info === undefined || !info.isFile()) throw new HubError('NOT_FOUND', t('errors.exportUnavailable'))
          response.writeHead(200, {
            'content-type': 'application/zip', 'content-length': String(info.size), 'cache-control': 'no-store',
            'x-content-type-options': 'nosniff', 'content-disposition': `attachment; filename="${safeFileName(record.file_name)}"`,
            'x-dz23-sha256': record.sha256,
          })
          const stream = createReadStream(record.path)
          stream.on('error', () => response.destroy())
          stream.pipe(response)
          return
        }
      }
      if (method === 'GET' && route === '/events') return json(response, 200, { events: service.events(actor) })
      return json(response, 404, { error: t('errors.routeNotFound') })
    } catch (error) {
      json(response, statusOf(error), { error: publicMessage(error) })
    }
  }
}

function publicExport(record: ReturnType<IntegrationHubService['exportRecord']>) {
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
  return { ...authorization, sessionId: session.session_id }
}

/** Only errors this module knows carry their message to the client; everything else becomes a fixed sentence (no paths, no stack details). */
function publicMessage(error: unknown): string {
  if (error instanceof IdentityError || error instanceof TenancyError || error instanceof HubError) return error.message
  if (error instanceof ExportError) return error.code === 'INVALID_PATH' ? t('errors.internal') : error.message
  if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof URIError) return t('errors.invalidRequest')
  if (error instanceof Error && 'code' in error && ((error as { code?: string }).code === 'NOT_FOUND' || (error as { code?: string }).code === 'FORBIDDEN')) return error.message
  return t('errors.internal')
}

function statusOf(error: unknown): number {
  if (error instanceof IdentityError) return error.code === 'locked' ? 429 : 401
  if (error instanceof TenancyError) return error.code === 'not-found' ? 404 : error.code === 'forbidden' ? 403 : 400
  if (error instanceof HubError) return error.code === 'NOT_FOUND' ? 404 : error.code === 'FORBIDDEN' ? 403 : error.code === 'CONFLICT' ? 409 : error.code === 'NOT_EXECUTED' ? 200 : 400
  if (error instanceof ExportError) return error.code === 'RUN_MISSING' ? 409 : error.code === 'TOO_LARGE' ? 413 : 500
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

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  response.end(JSON.stringify(body))
}
