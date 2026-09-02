import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { truncateIp } from './crypto.js'
import type { AuthenticationResponse, RegistrationResponse } from './passkey.js'
import type { SessionRecord } from './model.js'
import { IdentityError, type StudioIdentityService } from './service.js'

const JSON_LIMIT = 64 * 1024
export const SESSION_COOKIE = 'dz23_studio_session'
export const CSRF_COOKIE = 'dz23_studio_csrf'

const emailSchema = z.object({ email: z.email() }).strict()
const magicStartSchema = emailSchema
const magicVerifySchema = emailSchema.extend({
  code: z.string().regex(/^\d{6}$/),
  device_label: z.string().min(1).max(100),
}).strict()
const challengeSchema = z.object({ challenge_id: z.string().min(1), response: z.unknown() }).strict()
const registerVerifySchema = challengeSchema.extend({ device_label: z.string().min(1).max(100) }).strict()
const revokeSchema = z.object({ session_id: z.string().min(1) }).strict()
const bindSchema = z.object({ harness_session_id: z.string().min(1) }).strict()

export interface IdentityHttpConfig {
  readonly service: StudioIdentityService
  readonly bindHost: '127.0.0.1' | '0.0.0.0'
  readonly allowedHosts: readonly string[]
  readonly allowedOrigins: readonly string[]
}

export function serializeSessionCookies(token: string, csrfToken: string): readonly string[] {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/`,
    `${CSRF_COOKIE}=${encodeURIComponent(csrfToken)}; Secure; SameSite=Lax; Path=/`,
  ]
}

export function clearSessionCookies(): readonly string[] {
  return [
    `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
    `${CSRF_COOKIE}=; Secure; SameSite=Lax; Path=/; Max-Age=0`,
  ]
}

export function parseCookies(header: string | undefined): Readonly<Record<string, string>> {
  if (header === undefined) return {}
  return Object.fromEntries(header.split(';').map(part => {
    const at = part.indexOf('=')
    if (at < 1) return [part.trim(), '']
    const key = part.slice(0, at).trim()
    const raw = part.slice(at + 1).trim()
    try {
      return [key, decodeURIComponent(raw)]
    } catch {
      return [key, '']
    }
  }))
}

export function createIdentityHttpHandler(config: IdentityHttpConfig) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      assertRequestTrust(request, config)
      /* v8 ignore next -- node:http always supplies a URL for server requests. */
      const path = new URL(request.url ?? '/', 'http://local').pathname
      const route = path.slice('/api/studio/identity'.length)
      if (request.method === 'POST' && route === '/magic/start') {
        const body = magicStartSchema.parse(await readJson(request))
        await config.service.requestMagicCode(body.email)
        json(response, 202, { message: 'Se o e-mail puder receber acesso, enviaremos um código temporário.' })
        return
      }
      if (request.method === 'POST' && route === '/magic/verify') {
        const body = magicVerifySchema.parse(await readJson(request))
        const issued = await config.service.verifyMagicCode(body.email, body.code, deviceOf(request, body.device_label))
        response.setHeader('set-cookie', serializeSessionCookies(issued.token, issued.csrfToken))
        json(response, 200, { session_id: issued.session.session_id, csrf_token: issued.csrfToken })
        return
      }
      if (request.method === 'POST' && route === '/passkey/login/options') {
        const body = emailSchema.parse(await readJson(request))
        json(response, 200, await config.service.beginPasskeyLogin(body.email))
        return
      }
      if (request.method === 'POST' && route === '/passkey/login/verify') {
        const body = challengeSchema.parse(await readJson(request))
        const issued = await config.service.finishPasskeyLogin(
          body.challenge_id,
          body.response as AuthenticationResponse,
          deviceOf(request, 'Chave de acesso'),
        )
        response.setHeader('set-cookie', serializeSessionCookies(issued.token, issued.csrfToken))
        json(response, 200, { session_id: issued.session.session_id, csrf_token: issued.csrfToken })
        return
      }
      if (request.method === 'GET' && route === '/session') {
        const token = parseCookies(request.headers.cookie)[SESSION_COOKIE]
        if (token === undefined) {
          const principal = config.service.personalPrincipal(config.bindHost)
          if (principal === undefined) throw new IdentityError('invalid', 'Entre para continuar.')
          json(response, 200, { mode: 'personal', principal })
          return
        }
        const session = await config.service.authenticate(token)
        json(response, 200, { mode: 'authenticated', principal: principalOf(session) })
        return
      }

      const session = await authenticatedMutation(request, config.service)
      if (request.method === 'POST' && route === '/passkey/register/options') {
        json(response, 200, await config.service.beginPasskeyRegistration(requiredSessionToken(request)))
        return
      }
      if (request.method === 'POST' && route === '/passkey/register/verify') {
        const body = registerVerifySchema.parse(await readJson(request))
        await config.service.finishPasskeyRegistration(
          requiredSessionToken(request), body.challenge_id, body.response as RegistrationResponse, body.device_label,
        )
        json(response, 200, { message: 'Chave de acesso criada com segurança.' })
        return
      }
      if (request.method === 'POST' && route === '/passkey/step-up/options') {
        json(response, 200, await config.service.beginStepUp(requiredSessionToken(request)))
        return
      }
      if (request.method === 'POST' && route === '/passkey/step-up/verify') {
        const body = challengeSchema.parse(await readJson(request))
        await config.service.finishStepUp(requiredSessionToken(request), body.challenge_id, body.response as AuthenticationResponse)
        json(response, 200, { message: 'Ação sensível confirmada.' })
        return
      }
      if (request.method === 'GET' && route === '/devices') {
        json(response, 200, { devices: config.service.listDevices(session.user_id) })
        return
      }
      if (request.method === 'POST' && route === '/devices/revoke') {
        const body = revokeSchema.parse(await readJson(request))
        await config.service.revokeSession(session, body.session_id)
        if (body.session_id === session.session_id) response.setHeader('set-cookie', clearSessionCookies())
        json(response, 200, { message: 'Dispositivo desconectado.' })
        return
      }
      if (request.method === 'POST' && route === '/devices/revoke-all') {
        await config.service.revokeAllSessions(session)
        response.setHeader('set-cookie', clearSessionCookies())
        json(response, 200, { message: 'Todos os dispositivos foram desconectados.' })
        return
      }
      if (request.method === 'POST' && route === '/bind-agent') {
        const body = bindSchema.parse(await readJson(request))
        await config.service.bindHarnessSession(session, body.harness_session_id)
        json(response, 200, { message: 'Sessão de trabalho protegida.' })
        return
      }
      json(response, 404, { error: 'Rota não encontrada.' })
    } catch (error) {
      const status = error instanceof IdentityError
        ? error.code === 'not-found' ? 404 : error.code === 'locked' ? 429 : 401
        : error instanceof z.ZodError ? 400 : 400
      json(response, status, { error: error instanceof Error ? error.message : 'Solicitação inválida.' })
    }
  }
}

async function authenticatedMutation(request: IncomingMessage, service: StudioIdentityService): Promise<SessionRecord> {
  const token = requiredSessionToken(request)
  const session = await service.authenticate(token)
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const cookies = parseCookies(request.headers.cookie)
    const header = singleHeader(request.headers['x-dz23-csrf'])
    service.validateCsrf(session, cookies[CSRF_COOKIE], header)
  }
  return session
}

function requiredSessionToken(request: IncomingMessage): string {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE]
  if (token === undefined || token === '') throw new IdentityError('invalid', 'Entre para continuar.')
  return token
}

function assertRequestTrust(request: IncomingMessage, config: IdentityHttpConfig): void {
  const host = singleHeader(request.headers.host)?.toLowerCase()
  if (host === undefined || !config.allowedHosts.map(value => value.toLowerCase()).includes(host)) {
    throw new IdentityError('invalid', 'Host não autorizado.')
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const origin = singleHeader(request.headers.origin)
    if (origin === undefined || !config.allowedOrigins.includes(origin)) {
      throw new IdentityError('invalid', 'Origem não autorizada.')
    }
  }
}

export function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.length === 1 ? value[0] : undefined : value
}

export function deviceOf(request: IncomingMessage, label: string) {
  return {
    label,
    userAgent: singleHeader(request.headers['user-agent']) ?? '',
    ipTruncated: truncateIp(request.socket.remoteAddress),
  }
}

function principalOf(session: SessionRecord) {
  return {
    userId: session.user_id,
    orgId: session.org_id,
    tenantId: session.tenant_id,
    sessionId: session.session_id,
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!singleHeader(request.headers['content-type'])?.toLowerCase().startsWith('application/json')) {
    throw new Error('Envie os dados em formato JSON.')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    /* v8 ignore next -- node:http request body chunks are Buffers. */
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > JSON_LIMIT) throw new Error('Solicitação grande demais.')
    chunks.push(bytes)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('JSON inválido.')
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  /* v8 ignore next -- each handler owns exactly one response settlement. */
  if (response.writableEnded) return
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(body))
}
