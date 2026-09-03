import type { IncomingMessage, ServerResponse } from 'node:http'
import type { StudioPreviewService } from './service.js'

export const PREVIEW_COOKIE = '__Host-dz23_preview'
const HOST_PATTERN = /^p-[a-f0-9]{24}\.localhost(?::\d+)?$/u
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
  const studioOrigin = exactHttpOrigin(options.studioOrigin)
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const host = singleHeader(request.headers.host)?.toLowerCase()
    if (host === undefined || !validPreviewHost(host)) return plain(response, 421, 'Host de prévia inválido.')
    const origin = `http://${host}`
    const target = originForm(request.url)
    if (target === undefined) return plain(response, 400, 'Destino de prévia inválido.')
    if (!isAllowedMethod(request.method)) return plain(response, 405, 'Método de prévia inválido.')
    const pathname = new URL(target, origin).pathname
    const headers = previewHeaders(studioOrigin)

    if (request.method === 'GET' && pathname === '/__dz23/admission') {
      return html(response, 200, ADMISSION_PAGE, headers)
    }
    if (request.method === 'GET' && pathname === '/__dz23/admission.js') {
      return javascript(response, 200, admissionScript(studioOrigin), headers)
    }
    if (request.method === 'POST' && pathname === '/__dz23/admission') {
      if (singleHeader(request.headers.origin) !== origin) return plain(response, 403, 'Origem de prévia inválida.', headers)
      try {
        const payload = JSON.parse(await readBody(request)) as unknown
        const ticket = typeof payload === 'object' && payload !== null && 'ticket' in payload
          ? (payload as { readonly ticket?: unknown }).ticket
          : undefined
        if (typeof ticket !== 'string' || ticket.length < 20 || ticket.length > 200) return plain(response, 400, 'Convite de prévia inválido.', headers)
        const exchanged = await options.service.exchange(host, ticket)
        response.writeHead(204, {
          ...headers,
          'set-cookie': `${PREVIEW_COOKIE}=${encodeURIComponent(exchanged.cookie)}; Path=/; Max-Age=${exchanged.maxAge}; HttpOnly; Secure; SameSite=Lax`,
          'cache-control': 'no-store',
        })
        response.end()
        return
      } catch {
        return plain(response, 404, 'Prévia indisponível.', headers)
      }
    }

    if (isUnsafeMethod(request.method) && singleHeader(request.headers.origin) !== origin) {
      return plain(response, 403, 'Origem de prévia inválida.', headers)
    }
    const cookie = parseCookie(singleHeader(request.headers.cookie), PREVIEW_COOKIE)
    if (cookie === undefined) return plain(response, 401, 'Entre no DZ23 STUDIO para ver esta prévia.', headers)
    try {
      const authorized = options.service.authorize(host, cookie)
      const forwarded = await options.forward.forward(authorized.runtimeRef, {
        method: normalizedMethod(request.method),
        path: target,
        headers: forwardedRequestHeaders(request, cookie),
        body: await readBoundedBody(request, FORWARD_BODY_LIMIT),
      })
      writeForwardedResponse(response, forwarded, headers)
    } catch {
      return plain(response, 404, 'Prévia indisponível.', headers)
    }
  }
}

function validPreviewHost(host: string): boolean {
  if (!HOST_PATTERN.test(host)) return false
  try {
    const parsed = new URL(`http://${host}`)
    return parsed.hostname.endsWith('.localhost') && (parsed.port === '' || (Number(parsed.port) >= 1 && Number(parsed.port) <= 65_535))
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

function forwardedRequestHeaders(request: IncomingMessage, admissionCookie: string): Readonly<Record<string, string>> {
  const allowed = ['accept', 'accept-language', 'content-type', 'if-none-match', 'range', 'user-agent'] as const
  const result: Record<string, string> = {}
  for (const name of allowed) {
    const value = singleHeader(request.headers[name])
    if (value !== undefined && value.length <= 4_096) result[name] = value
  }
  const applicationCookies = withoutAdmissionCookie(singleHeader(request.headers.cookie), admissionCookie)
  if (applicationCookies !== '') result.cookie = applicationCookies
  return result
}

function withoutAdmissionCookie(header: string | undefined, admissionCookie: string): string {
  if (header === undefined) return ''
  return header.split(';').map(part => part.trim()).filter(part => {
    const separator = part.indexOf('=')
    if (separator < 0) return false
    const name = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    return name !== PREVIEW_COOKIE && value !== encodeURIComponent(admissionCookie) && value !== admissionCookie
  }).join('; ')
}

function writeForwardedResponse(response: ServerResponse, forwarded: PreviewForwardResponse, enforced: Readonly<Record<string, string>>): void {
  const status = Number.isInteger(forwarded.status) && forwarded.status >= 200 && forwarded.status <= 599 ? forwarded.status : 502
  const validBody = Buffer.isBuffer(forwarded.body) && forwarded.body.byteLength <= RESPONSE_BODY_LIMIT
  const body = validBody ? forwarded.body : Buffer.from('Resposta da prévia inválida.', 'utf8')
  const safe: Record<string, string | readonly string[]> = {}
  const contentType = singleResponseHeader(forwarded.headers?.['content-type'])
  if (contentType !== undefined && contentType.length <= 200) safe['content-type'] = contentType
  const etag = singleResponseHeader(forwarded.headers?.etag)
  if (etag !== undefined && etag.length <= 200) safe.etag = etag
  const lastModified = singleResponseHeader(forwarded.headers?.['last-modified'])
  if (lastModified !== undefined && lastModified.length <= 100) safe['last-modified'] = lastModified
  const location = singleResponseHeader(forwarded.headers?.location)
  if (location !== undefined && originForm(location) !== undefined) safe.location = location
  const cookies = sanitizeApplicationCookies(forwarded.headers?.['set-cookie'])
  if (cookies.length > 0) safe['set-cookie'] = cookies
  response.writeHead(validBody ? status : 502, { ...safe, ...enforced, 'content-length': String(body.byteLength) })
  response.end(body)
}

function singleResponseHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.length === 1 ? value[0] : undefined
}

function sanitizeApplicationCookies(value: string | readonly string[] | undefined): readonly string[] {
  const values = value === undefined ? [] : typeof value === 'string' ? [value] : value
  return values.slice(0, 10).flatMap(cookie => {
    if (cookie.length > 4_096) return []
    const [pair] = cookie.split(';', 1)
    const separator = pair?.indexOf('=') ?? -1
    const name = separator < 1 ? '' : pair!.slice(0, separator).trim()
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || name === PREVIEW_COOKIE || /;\s*domain=/iu.test(cookie)) return []
    return [`${pair}; Path=/; HttpOnly; Secure; SameSite=Lax`]
  })
}

function previewHeaders(studioOrigin: string): Readonly<Record<string, string>> {
  return {
    'content-security-policy': `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-src 'none'; frame-ancestors ${studioOrigin}`,
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

const ADMISSION_PAGE = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Carregando prévia</title></head><body><p>Carregando sua prévia segura…</p><script src="/__dz23/admission.js" defer></script></body></html>'

function exactHttpOrigin(value: string): string {
  const parsed = new URL(value)
  if (parsed.protocol !== 'http:' || parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new Error('studioOrigin deve ser uma origem HTTP local exata.')
  }
  if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') throw new Error('studioOrigin local deve usar localhost ou 127.0.0.1.')
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
