import type { IncomingMessage, ServerResponse } from 'node:http'
import type { StudioPreviewService } from './service.js'
import { DOMINIO_DA_PREVIA, PADRAO_DO_HOST_DA_PREVIA } from './model.js'
import { t } from './i18n.js'
import { CAMINHO_DO_ROTEIRO, comRoteiroDeSelecao, scriptDeSelecao } from './selecao.js'

export const PREVIEW_COOKIE = 'dz23_preview_admission'
export const SECURE_PREVIEW_COOKIE = '__Host-dz23_preview_admission'
/*
  DERIVADO do padrão do modelo, e não escrito de novo.

  Esta era a SEGUNDA cópia do host da prévia: o modelo tinha a dele e o portão
  tinha esta, e trocar o domínio num só lugar produziria um portão que recusa
  todo host que o serviço cria. É a segunda verdade mais barata de evitar — uma
  linha — e a mais cara de descobrir depois.
*/
const HOST_PATTERN = new RegExp(PADRAO_DO_HOST_DA_PREVIA.source.replace(/\$$/u, '(?::\\d+)?$'), 'u')
const BODY_LIMIT = 8 * 1024
const FORWARD_BODY_LIMIT = 2 * 1024 * 1024
const RESPONSE_BODY_LIMIT = 8 * 1024 * 1024

export interface PreviewForwardRequest {
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: Buffer
}

export interface PreviewForwardResponse {
  readonly status: number
  readonly headers?: Readonly<Record<string, string | readonly string[] | undefined>>
  readonly body: Buffer
}

export interface PreviewForwardPort {
  forward(runtimeRef: string, request: PreviewForwardRequest): Promise<PreviewForwardResponse>
}

export interface PreviewGatewayOptions {
  readonly service: StudioPreviewService
  readonly forward: PreviewForwardPort
  readonly studioOrigin: string
}

export function createPreviewGatewayHttpHandler(options: PreviewGatewayOptions) {
  const studioOrigin = exactStudioOrigin(options.studioOrigin)
  const publicScheme = new URL(studioOrigin).protocol === 'https:' ? 'https' : 'http'
  const secureCookies = publicScheme === 'https'
  const admissionCookieName = secureCookies ? SECURE_PREVIEW_COOKIE : PREVIEW_COOKIE
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const host = singleHeader(request.headers.host)?.toLowerCase()
    if (host === undefined || !validPreviewHost(host)) return plain(response, 421, t('gateway.invalidHost'))
    const origin = `${publicScheme}://${host}`
    const target = originForm(request.url)
    if (target === undefined) return plain(response, 400, t('gateway.invalidTarget'))
    if (!isAllowedMethod(request.method)) return plain(response, 405, t('gateway.invalidMethod'))
    const pathname = new URL(target, origin).pathname
    const headers = previewHeaders(studioOrigin)

    if (request.method === 'GET' && pathname === '/__dz23/admission') {
      return html(response, 200, ADMISSION_PAGE, headers)
    }
    if (request.method === 'GET' && pathname === '/__dz23/admission.js') {
      return javascript(response, 200, admissionScript(studioOrigin), headers)
    }
    /*
      O roteiro da SELEÇÃO VISUAL é servido, e não copiado para o template.

      Um roteiro dentro do template ficaria congelado na versão do dia em que o
      aplicativo nasceu, e a próxima correção só alcançaria os criados depois —
      os que já existem ficariam com a versão velha para sempre. Servido, ele é
      UM. É também o único jeito de a origem do FRIGG entrar nele: o template
      não a conhece, e não deve conhecer.

      Ele NÃO exige admissão, e isso é deliberado: é um arquivo de texto sem
      segredo nenhum, igual ao `admission.js` logo acima, e exigir o cookie
      criaria uma dependência de ordem entre carregar a página e ter a sessão.
    */
    if (request.method === 'GET' && pathname === CAMINHO_DO_ROTEIRO) {
      return javascript(response, 200, scriptDeSelecao(studioOrigin), headers)
    }
    if (request.method === 'POST' && pathname === '/__dz23/admission') {
      if (singleHeader(request.headers.origin) !== origin) return plain(response, 403, t('gateway.invalidOrigin'), headers)
      try {
        const payload = JSON.parse(await readBody(request)) as unknown
        const ticket = typeof payload === 'object' && payload !== null && 'ticket' in payload
          ? (payload as { readonly ticket?: unknown }).ticket
          : undefined
        if (typeof ticket !== 'string' || ticket.length < 20 || ticket.length > 200) return plain(response, 400, t('gateway.invalidTicket'), headers)
        const exchanged = await options.service.exchange(host, ticket)
        response.writeHead(204, {
          ...headers,
          'set-cookie': localCookie(admissionCookieName, encodeURIComponent(exchanged.cookie), exchanged.maxAge, secureCookies),
          'cache-control': 'no-store',
        })
        response.end()
        return
      } catch {
        return plain(response, 404, t('gateway.unavailable'), headers)
      }
    }

    if (request.method === 'GET' && pathname === '/__dz23/refresh') {
      const cookie = parseCookie(singleHeader(request.headers.cookie), admissionCookieName)
      if (cookie === undefined) return plain(response, 401, t('gateway.signIn'), headers)
      try {
        const authorized = options.service.authorize(host, cookie)
        response.writeHead(204, {
          ...headers,
          'set-cookie': localCookie(admissionCookieName, encodeURIComponent(cookie), authorized.maxAge, secureCookies),
          'cache-control': 'no-store',
        })
        response.end()
        return
      } catch {
        return plain(response, 401, t('gateway.signInAgain'), headers)
      }
    }

    if (isUnsafeMethod(request.method) && singleHeader(request.headers.origin) !== origin) {
      return plain(response, 403, t('gateway.invalidOrigin'), headers)
    }
    const cookie = parseCookie(singleHeader(request.headers.cookie), admissionCookieName)
    if (cookie === undefined) return plain(response, 401, t('gateway.signIn'), headers)
    try {
      const authorized = options.service.authorize(host, cookie)
      const forwarded = await options.forward.forward(authorized.runtimeRef, {
        method: normalizedMethod(request.method),
        path: target,
        headers: forwardedRequestHeaders(request, cookie, admissionCookieName),
        body: await readBoundedBody(request, FORWARD_BODY_LIMIT),
      })
      writeForwardedResponse(
        response,
        forwarded,
        headers,
        localCookie(admissionCookieName, encodeURIComponent(cookie), authorized.maxAge, secureCookies),
        secureCookies,
      )
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'UNAUTHENTICATED') {
        return plain(response, 401, t('gateway.signInAgain'), headers)
      }
      return plain(response, 404, t('gateway.unavailable'), headers)
    }
  }
}

function validPreviewHost(host: string): boolean {
  if (!HOST_PATTERN.test(host)) return false
  try {
    const parsed = new URL(`http://${host}`)
    return parsed.hostname.endsWith(`.${DOMINIO_DA_PREVIA}`) && (parsed.port === '' || (Number(parsed.port) >= 1 && Number(parsed.port) <= 65_535))
  } catch { return false }
}

function originForm(value: string | undefined): string | undefined {
  const target = value ?? '/'
  if (!target.startsWith('/') || target.startsWith('//') || target.includes('\\') || /[\u0000-\u001f\u007f]/u.test(target)) return undefined
  try {
    const parsed = new URL(target, 'http://preview.invalid')
    return `${parsed.pathname}${parsed.search}`
  } catch { return undefined }
}

function normalizedMethod(method: string | undefined): string {
  return method!
}

function isAllowedMethod(method: string | undefined): boolean {
  return /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/u.test(method ?? '')
}

function forwardedRequestHeaders(request: IncomingMessage, admissionCookie: string, admissionCookieName: string): Readonly<Record<string, string>> {
  const allowed = [
    'accept', 'accept-language', 'content-type', 'if-none-match', 'range', 'user-agent',
    'next-action', 'next-router-state-tree', 'next-url', 'rsc', 'x-nextjs-data',
  ] as const
  const result: Record<string, string> = {}
  for (const name of allowed) {
    const value = singleHeader(request.headers[name])
    if (value !== undefined && value.length <= 4_096) result[name] = value
  }
  const applicationCookies = withoutAdmissionCookie(singleHeader(request.headers.cookie), admissionCookie, admissionCookieName)
  if (applicationCookies !== '') result.cookie = applicationCookies
  return result
}

function withoutAdmissionCookie(header: string | undefined, admissionCookie: string, admissionCookieName: string): string {
  if (header === undefined) return ''
  return header.split(';').map(part => part.trim()).filter(part => {
    const separator = part.indexOf('=')
    if (separator < 0) return false
    const name = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    return name !== admissionCookieName && name !== PREVIEW_COOKIE && name !== SECURE_PREVIEW_COOKIE && value !== encodeURIComponent(admissionCookie) && value !== admissionCookie
  }).join('; ')
}

function writeForwardedResponse(
  response: ServerResponse,
  forwarded: PreviewForwardResponse,
  enforced: Readonly<Record<string, string>>,
  admissionCookie: string,
  secureCookies: boolean,
): void {
  const status = Number.isInteger(forwarded.status) && forwarded.status >= 200 && forwarded.status <= 599 ? forwarded.status : 502
  const validBody = Buffer.isBuffer(forwarded.body) && forwarded.body.byteLength <= RESPONSE_BODY_LIMIT
  const contentType = singleResponseHeader(forwarded.headers?.['content-type'])
  /*
    A etiqueta do roteiro entra SÓ em página HTML, e só quando ela tem corpo
    para fechar. Reescrever bytes de uma resposta que não pediu para ser
    reescrita quebra o aplicativo de um jeito que ninguém depura: o
    código-fonte está certo e o navegador mostra outra coisa.
  */
  const body = validBody ? comRoteiroDeSelecao(forwarded.body, contentType) : Buffer.from(t('gateway.invalidResponse'), 'utf8')
  const safe: Record<string, string | readonly string[]> = {}
  if (contentType !== undefined && contentType.length <= 200) safe['content-type'] = contentType
  const etag = singleResponseHeader(forwarded.headers?.etag)
  if (etag !== undefined && etag.length <= 200) safe.etag = etag
  const lastModified = singleResponseHeader(forwarded.headers?.['last-modified'])
  if (lastModified !== undefined && lastModified.length <= 100) safe['last-modified'] = lastModified
  const location = singleResponseHeader(forwarded.headers?.location)
  if (location !== undefined && originForm(location) !== undefined) safe.location = location
  safe['set-cookie'] = [...sanitizeApplicationCookies(forwarded.headers?.['set-cookie'], secureCookies), admissionCookie]
  response.writeHead(validBody ? status : 502, { ...safe, ...enforced, 'content-length': String(body.byteLength) })
  response.end(body)
}

function singleResponseHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.length === 1 ? value[0] : undefined
}

function sanitizeApplicationCookies(value: string | readonly string[] | undefined, secure: boolean): readonly string[] {
  const values = value === undefined ? [] : typeof value === 'string' ? [value] : value
  return values.slice(0, 10).flatMap(cookie => {
    if (cookie.length > 4_096) return []
    const [pair] = cookie.split(';', 1)
    const separator = pair?.indexOf('=') ?? -1
    const name = separator < 1 ? '' : pair!.slice(0, separator).trim()
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || name === PREVIEW_COOKIE || name === SECURE_PREVIEW_COOKIE || /;\s*domain=/iu.test(cookie)) return []
    return [`${pair}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`]
  })
}

function localCookie(name: string, value: string, maxAge: number, secure: boolean): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`
}

function previewHeaders(studioOrigin: string): Readonly<Record<string, string>> {
  return {
    // Next emits inline bootstrap and critical-style blocks. External scripts,
    // eval, child frames and cross-origin connections remain forbidden.
    'content-security-policy': `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-src 'none'; frame-ancestors ${studioOrigin}`,
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-site',
    'cache-control': 'no-store',
  }
}

function admissionScript(studioOrigin: string): string {
  return `"use strict";window.addEventListener("message",async(event)=>{if(event.origin!==${JSON.stringify(studioOrigin)}||event.source!==window.parent)return;const ticket=event.data&&event.data.type==="DZ23_PREVIEW_ADMISSION"?event.data.ticket:null;if(typeof ticket!=="string")return;const response=await fetch("/__dz23/admission",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ticket})});if(response.ok){window.parent.postMessage({type:"DZ23_PREVIEW_ADMITTED"},${JSON.stringify(studioOrigin)});window.location.replace("/");}});window.parent.postMessage({type:"DZ23_PREVIEW_READY"},${JSON.stringify(studioOrigin)});`
}

const ADMISSION_PAGE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${t('gateway.loadingTitle')}</title></head><body><p>${t('gateway.loadingBody')}</p><script src="/__dz23/admission.js" defer></script></body></html>`

function exactStudioOrigin(value: string): string {
  const parsed = new URL(value)
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new Error(t('gateway.invalidStudioOrigin'))
  }
  if (parsed.hostname !== 'studio.dz23.localhost') throw new Error(t('gateway.invalidStudioHost'))
  return parsed.origin
}

function isUnsafeMethod(method: string | undefined): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'
}

function singleHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : Array.isArray(value) && value.length === 1 ? value[0] : undefined
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue
    try { return decodeURIComponent(part.slice(separator + 1).trim()) } catch { return undefined }
  }
  return undefined
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > BODY_LIMIT) throw new Error('BODY_TOO_LARGE')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readBoundedBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  if (request.method === 'GET' || request.method === 'HEAD') return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > limit) throw new Error('FORWARD_BODY_TOO_LARGE')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

function plain(response: ServerResponse, status: number, body: string, headers: Readonly<Record<string, string>> = {}): void {
  if (response.writableEnded) return
  response.writeHead(status, { ...headers, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  response.end(body)
}

function html(response: ServerResponse, status: number, body: string, headers: Readonly<Record<string, string>>): void {
  response.writeHead(status, { ...headers, 'content-type': 'text/html; charset=utf-8' })
  response.end(body)
}

function javascript(response: ServerResponse, status: number, body: string, headers: Readonly<Record<string, string>>): void {
  response.writeHead(status, { ...headers, 'content-type': 'text/javascript; charset=utf-8' })
  response.end(body)
}
