import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { truncateIp } from './crypto.js'
import type { AuthenticationResponse, RegistrationResponse } from './passkey.js'
import type { SessionRecord } from './model.js'
import { IdentityError, type StudioIdentityService } from './service.js'
import { assertRouteContracts, type StudioRouteContract } from '@dz23-studio/policy'
import { CSRF_COOKIE, parseCookies, parseCookieValues, SESSION_COOKIE } from './cookies.js'
import { InMemoryIdentityRateLimiter, rateLimitBuckets, rateLimitKey } from './rate-limit.js'

const JSON_LIMIT = 64 * 1024
export { CSRF_COOKIE, parseCookies, parseCookieValues, SESSION_COOKIE } from './cookies.js'

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

export const IDENTITY_ROUTE_CONTRACTS = [
  { method: 'POST', path: '/magic/start', access: 'public', permission: null, scope: 'none' },
  { method: 'POST', path: '/magic/verify', access: 'public', permission: null, scope: 'none' },
  { method: 'POST', path: '/passkey/login/options', access: 'public', permission: null, scope: 'none' },
  { method: 'POST', path: '/passkey/login/verify', access: 'public', permission: null, scope: 'none' },
  { method: 'GET', path: '/session', access: 'public', permission: null, scope: 'identity' },
  { method: 'GET', path: '/csrf', access: 'authorized', permission: 'identity.self', scope: 'identity' },
  { method: 'GET', path: '/harness/session', access: 'authorized', permission: 'identity.self', scope: 'identity' },
  { method: 'POST', path: '/passkey/register/options', access: 'authorized', permission: 'identity.self', scope: 'identity' },
  { method: 'POST', path: '/passkey/register/verify', access: 'authorized', permission: 'identity.self', scope: 'identity' },
  { method: 'POST', path: '/passkey/step-up/options', access: 'authorized', permission: 'identity.self', scope: 'identity' },
  { method: 'POST', path: '/passkey/step-up/verify', access: 'authorized', permission: 'identity.self', scope: 'identity' },
  { method: 'GET', path: '/devices', access: 'authorized', permission: 'identity.self', scope: 'identity' },
  { method: 'POST', path: '/devices/revoke', access: 'authorized', permission: 'identity.self', scope: 'identity' },
  { method: 'POST', path: '/devices/revoke-all', access: 'authorized', permission: 'identity.self', scope: 'identity' },
  { method: 'POST', path: '/bind-agent', access: 'authorized', permission: 'identity.self', scope: 'identity' },
] as const satisfies readonly StudioRouteContract[]

assertRouteContracts(IDENTITY_ROUTE_CONTRACTS)

export interface IdentityHttpConfig {
  readonly service: StudioIdentityService
  readonly bindHost: '127.0.0.1' | '0.0.0.0'
  readonly allowedHosts: readonly string[]
  readonly allowedOrigins: readonly string[]
  readonly edgeRequired?: boolean
  readonly resolveEdgeSecret?: () => Promise<string | undefined>
  readonly harnessAuthenticationUrl?: (baseUrl: string) => string | undefined
  readonly rateLimiter?: InMemoryIdentityRateLimiter
  readonly secureCookies?: boolean
}

export function serializeSessionCookies(token: string, csrfToken: string, secure = true): readonly string[] {
  void csrfToken
  const secureAttribute = secure ? '; Secure' : ''
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly${secureAttribute}; SameSite=Lax; Path=/`,
    `${CSRF_COOKIE}=${secureAttribute}; SameSite=Lax; Path=/; Max-Age=0`,
  ]
}

export function clearSessionCookies(secure = true): readonly string[] {
  const secureAttribute = secure ? '; Secure' : ''
  return [
    `${SESSION_COOKIE}=; HttpOnly${secureAttribute}; SameSite=Lax; Path=/; Max-Age=0`,
    `${CSRF_COOKIE}=${secureAttribute}; SameSite=Lax; Path=/; Max-Age=0`,
  ]
}

export function createIdentityHttpHandler(config: IdentityHttpConfig) {
  const limiter = config.rateLimiter ?? new InMemoryIdentityRateLimiter()
  const secureCookies = config.secureCookies !== false
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      await assertEdgeTrust(request, config)
      assertRequestTrust(request, config)
      /* v8 ignore next -- node:http always supplies a URL for server requests. */
      const path = new URL(request.url ?? '/', 'http://local').pathname
      const route = path.slice('/api/studio/identity'.length)
      if (!IDENTITY_ROUTE_CONTRACTS.some(contract => contract.method === request.method && contract.path === route)) {
        json(response, 404, { error: 'Rota não encontrada.' })
        return
      }
      const forwardedAddress = config.edgeRequired === true
        ? singleHeader(request.headers['x-forwarded-for'])?.split(',')[0]?.trim()
        : undefined
      const key = rateLimitKey(request, forwardedAddress)
      for (const bucket of rateLimitBuckets(route)) {
        const decision = limiter.consume(bucket, key)
        if (!decision.allowed) {
          response.setHeader('retry-after', String(decision.retryAfterSeconds))
          response.setHeader('x-ratelimit-limit', String(decision.limit))
          response.setHeader('x-ratelimit-remaining', '0')
          json(response, 429, { error: 'Muitas tentativas. Aguarde um pouco e tente novamente.' })
          return
        }
      }
      if (request.method === 'POST' && route === '/magic/start') {
        const body = magicStartSchema.parse(await readJson(request))
        await config.service.requestMagicCode(body.email)
        json(response, 202, { message: 'Se o e-mail puder receber acesso, enviaremos um código temporário.' })
        return
      }
      if (request.method === 'POST' && route === '/magic/verify') {
        const body = magicVerifySchema.parse(await readJson(request))
        const issued = await config.service.verifyMagicCode(body.email, body.code, deviceOf(request, body.device_label))
        response.setHeader('set-cookie', serializeSessionCookies(issued.token, issued.csrfToken, secureCookies))
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
        response.setHeader('set-cookie', serializeSessionCookies(issued.token, issued.csrfToken, secureCookies))
        json(response, 200, { session_id: issued.session.session_id, csrf_token: issued.csrfToken })
        return
      }
      if (request.method === 'GET' && route === '/session') {
        const tokens = parseCookieValues(request.headers.cookie, SESSION_COOKIE)
        if (tokens.length === 0) {
          const principal = config.edgeRequired === true
            ? undefined
            : config.service.personalPrincipal(config.bindHost)
          if (principal === undefined) throw new IdentityError('invalid', 'Entre para continuar.')
          json(response, 200, { mode: 'personal', principal })
          return
        }
        const { session } = await authenticateCookieRequest(request, config.service)
        json(response, 200, { mode: 'authenticated', principal: principalOf(session) })
        return
      }

      if (request.method === 'GET' && route === '/csrf') {
        const { session } = await authenticateCookieRequest(request, config.service)
        json(response, 200, { csrf_token: await config.service.csrfTokenFor(session) })
        return
      }

      if (request.method === 'GET' && route === '/harness/session') {
        const identitySession = await authenticatedMutation(request, config.service)
        if (!config.service.isSharedHarnessClientAllowed(identitySession)) {
          json(response, 403, { error: 'A interface do Harness ainda não está disponível.' })
          return
        }
        const host = singleHeader(request.headers.host)!
        const forwardedProtocol = config.edgeRequired === true
          ? singleHeader(request.headers['x-forwarded-proto'])
          : undefined
        const protocol = forwardedProtocol === 'https' || forwardedProtocol === 'http'
          ? forwardedProtocol
          : config.bindHost === '127.0.0.1' ? 'http' : 'https'
        const location = config.harnessAuthenticationUrl?.(`${protocol}://${host}/`)
        if (location === undefined) {
          json(response, 503, { error: 'A interface do Harness ainda não está disponível.' })
          return
        }
        response.writeHead(303, {
          'cache-control': 'no-store',
          location,
          'referrer-policy': 'no-referrer',
        })
        response.end()
        return
      }

      const authentication = await authenticateCookieRequest(request, config.service)
      const session = authentication.session
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        config.service.validateCsrfToken(session, singleHeader(request.headers['x-dz23-csrf']))
      }
      if (request.method === 'POST' && route === '/passkey/register/options') {
        json(response, 200, await config.service.beginPasskeyRegistration(authentication.token))
        return
      }
      if (request.method === 'POST' && route === '/passkey/register/verify') {
        const body = registerVerifySchema.parse(await readJson(request))
        await config.service.finishPasskeyRegistration(
          authentication.token, body.challenge_id, body.response as RegistrationResponse, body.device_label,
        )
        json(response, 200, { message: 'Chave de acesso criada com segurança.' })
        return
      }
      if (request.method === 'POST' && route === '/passkey/step-up/options') {
        json(response, 200, await config.service.beginStepUp(authentication.token))
        return
      }
      if (request.method === 'POST' && route === '/passkey/step-up/verify') {
        const body = challengeSchema.parse(await readJson(request))
        await config.service.finishStepUp(authentication.token, body.challenge_id, body.response as AuthenticationResponse)
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
        if (body.session_id === session.session_id) response.setHeader('set-cookie', clearSessionCookies(secureCookies))
        json(response, 200, { message: 'Dispositivo desconectado.' })
        return
      }
      if (request.method === 'POST' && route === '/devices/revoke-all') {
        await config.service.revokeAllSessions(session)
        response.setHeader('set-cookie', clearSessionCookies(secureCookies))
        json(response, 200, { message: 'Todos os dispositivos foram desconectados.' })
        return
      }
      const body = bindSchema.parse(await readJson(request))
      await config.service.bindHarnessSession(session, body.harness_session_id)
      json(response, 200, { message: 'Sessão de trabalho protegida.' })
    } catch (error) {
      const status = error instanceof IdentityError
        ? error.code === 'not-found' ? 404 : error.code === 'locked' ? 429 : 401
        : error instanceof z.ZodError ? 400 : 400
      json(response, status, { error: error instanceof Error ? error.message : 'Solicitação inválida.' })
    }
  }
}

export async function authenticatedMutation(request: IncomingMessage, service: StudioIdentityService): Promise<SessionRecord> {
  const { session } = await authenticateCookieRequest(request, service)
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const header = singleHeader(request.headers['x-dz23-csrf'])
    service.validateCsrfToken(session, header)
  }
  return session
}

export function requiredSessionToken(request: IncomingMessage): string {
  const token = parseCookieValues(request.headers.cookie, SESSION_COOKIE)[0]
  if (token === undefined || token === '') throw new IdentityError('invalid', 'Entre para continuar.')
  return token
}

async function authenticateCookieRequest(request: IncomingMessage, service: StudioIdentityService): Promise<{ readonly token: string; readonly session: SessionRecord }> {
  const candidates = [...new Set(parseCookieValues(request.headers.cookie, SESSION_COOKIE))]
  if (candidates.length === 0 || candidates.length > 64) throw new IdentityError('invalid', 'Entre para continuar.')
  let lastError: IdentityError | undefined
  for (const token of candidates) {
    if (token === '') continue
    try { return { token, session: await service.authenticate(token) } }
    catch (error) { if (!(error instanceof IdentityError)) throw error; lastError = error }
  }
  throw lastError ?? new IdentityError('invalid', 'Entre para continuar.')
}

async function assertEdgeTrust(
  request: IncomingMessage,
  config: Pick<IdentityHttpConfig, 'edgeRequired' | 'resolveEdgeSecret'>,
): Promise<void> {
  if (config.edgeRequired === true) {
    const actual = singleHeader(request.headers['x-dz23-edge'])
    const expected = await config.resolveEdgeSecret?.()
    if (actual === undefined || expected === undefined || expected === '' || !secretMatches(actual, expected)) {
      throw new IdentityError('invalid', 'Borda de acesso não autorizada.')
    }
  }
}

export function assertRequestTrust(
  request: IncomingMessage,
  config: Pick<IdentityHttpConfig, 'allowedHosts' | 'allowedOrigins'>,
): void {
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

function secretMatches(actual: string, expected: string): boolean {
  const actualDigest = createHash('sha256').update(actual).digest()
  const expectedDigest = createHash('sha256').update(expected).digest()
  return timingSafeEqual(actualDigest, expectedDigest)
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
