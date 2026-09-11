import { chmod, lstat, mkdir, readFile, unlink } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, posix, resolve } from 'node:path'
import { decodeForwardBody, parseSupervisorDataRequest, type SupervisorForwardRequest } from './protocol.js'

const REQUEST_LIMIT = 3 * 1024 * 1024
const RESPONSE_LIMIT = 8 * 1024 * 1024
const MESSAGE_FILE_LIMIT = 64 * 1024

export interface PreviewProxyOptions {
  readonly socketPath: string
  readonly runtimeRef: string
  readonly runtimeHost: string
  readonly previewId: string
  readonly dataRoot: string
  readonly runtimeTimeoutMs?: number
}

export async function listenPreviewProxy(options: PreviewProxyOptions): Promise<{ readonly server: Server; close(): Promise<void> }> {
  validateOptions(options)
  await mkdir(dirname(options.socketPath), { recursive: true, mode: 0o770 })
  const occupied = await lstat(options.socketPath).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (occupied !== undefined && !occupied.isSocket()) throw new Error('PROXY_SOCKET_PATH_OCCUPIED')
  if (occupied?.isSocket() === true) await unlink(options.socketPath)
  const server = createServer((request, response) => { void handle(request, response, options).catch(() => json(response, 502, { error: 'PREVIEW_UNAVAILABLE' })) })
  server.requestTimeout = 20_000; server.headersTimeout = 10_000; server.maxHeadersCount = 64
  await new Promise<void>((ready, reject) => {
    server.once('error', reject)
    server.listen(options.socketPath, () => { server.off('error', reject); ready() })
  })
  await chmod(options.socketPath, 0o660)
  return {
    server,
    close: async () => {
      await new Promise<void>((ready, reject) => server.close(error => error === undefined ? ready() : reject(error)))
      await unlink(options.socketPath).catch(() => undefined)
    },
  }
}

async function handle(request: IncomingMessage, response: ServerResponse, options: PreviewProxyOptions): Promise<void> {
  if (request.method !== 'POST' || request.url !== '/v1/data') return json(response, 404, { error: 'NOT_FOUND' })
  const controller = new AbortController()
  request.once('aborted', () => controller.abort())
  response.once('close', () => { if (!response.writableEnded) controller.abort() })
  let decoded: unknown
  try { decoded = JSON.parse((await readBounded(request)).toString('utf8')) as unknown } catch { return json(response, 400, { error: 'INVALID_REQUEST' }) }
  let parsed
  try { parsed = parseSupervisorDataRequest(decoded) } catch { return json(response, 400, { error: 'INVALID_REQUEST' }) }
  if (parsed.body.runtime_ref !== options.runtimeRef) return json(response, 400, { error: 'INVALID_REQUEST' })
  if (parsed.operation === 'verification-messages') {
    return json(response, 200, { messages: await readMessages(options) })
  }
  const forwarded = await forwardToRuntime(parsed.body, options.runtimeHost, controller.signal, options.runtimeTimeoutMs ?? 15_000)
  return json(response, 200, forwarded)
}

async function forwardToRuntime(input: SupervisorForwardRequest, runtimeHost: string, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
  const body = decodeForwardBody(input)
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  return new Promise((resolveResult, reject) => {
    const request = httpRequest({
      hostname: runtimeHost, port: 3000, path: input.path, method: input.method,
      setDefaultHeaders: false,
      headers: { host: `${runtimeHost}:3000`, 'content-length': String(body.byteLength), ...safeRequestHeaders(input.headers) },
      signal: boundedSignal,
    }, response => {
      const chunks: Buffer[] = []; let size = 0
      response.on('data', chunk => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.byteLength
        if (size > RESPONSE_LIMIT) request.destroy(new Error('RUNTIME_RESPONSE_TOO_LARGE')); else chunks.push(bytes)
      })
      response.once('end', () => resolveResult({
        status: response.statusCode ?? 502,
        headers: safeResponseHeaders(response),
        body_base64: Buffer.concat(chunks).toString('base64'),
      }))
    })
    request.once('error', reject)
    request.end(body)
  })
}

function safeRequestHeaders(headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const allowed = new Set(['accept', 'accept-language', 'content-type', 'if-none-match', 'range', 'user-agent', 'cookie', 'next-action', 'next-router-state-tree', 'next-url', 'rsc', 'x-nextjs-data'])
  const result: Record<string, string> = {}
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase()
    if (!allowed.has(name) || value.length > 4_096 || value.includes('\0')) continue
    result[name] = name === 'cookie' ? stripAdmissionCookie(value) : value
  }
  return result
}

/**
 * O prefixo de TODO cookie que pertence a plataforma, e nao ao aplicativo gerado.
 *
 * Familia, e nao nome exato, de proposito. A versao anterior comparava com
 * `__Host-dz23_preview=` enquanto o cookie real se chama
 * `__Host-dz23_preview_admission` (ver `PREVIEW_COOKIE` e
 * `SECURE_PREVIEW_COOKIE` em `plugins/preview/src/gateway.ts`): o `=` nao casa
 * com o `_`, e a camada NUNCA removeu nada. Um nome exato volta a nao casar no
 * proximo rename do sufixo; um prefixo sobrevive a ele.
 *
 * Cortar demais e o lado seguro: nenhum cookie da plataforma tem motivo para
 * chegar ao codigo gerado, que nao e confiavel.
 */
const PLATFORM_COOKIE_PREFIX = 'dz23_preview'

/** Os prefixos de atributo que o navegador permite em nome de cookie. */
const COOKIE_NAME_PREFIXES = ['__Host-', '__Secure-'] as const

/**
 * Se este nome de cookie pertence a plataforma.
 * @param name - o nome, ja sem espacos em volta.
 * @returns `true` quando o cookie nao pode chegar ao aplicativo gerado.
 */
export function isPlatformCookieName(name: string): boolean {
  let bare = name
  for (const prefix of COOKIE_NAME_PREFIXES) {
    if (bare.startsWith(prefix)) { bare = bare.slice(prefix.length); break }
  }
  return bare.startsWith(PLATFORM_COOKIE_PREFIX)
}

/**
 * Remove do cabecalho `cookie` tudo que e da plataforma.
 *
 * Segunda camada: quem faz o trabalho hoje e `withoutAdmissionCookie` no
 * gateway. Esta existe para o dia em que o gateway regredir — e por isso ela
 * precisa funcionar de verdade, e nao so parecer que funciona.
 * @param value - o cabecalho `cookie` recebido.
 * @returns o cabecalho sem os cookies da plataforma.
 */
function stripAdmissionCookie(value: string): string {
  return value
    .split(';')
    .map(item => item.trim())
    .filter(item => item !== '' && !isPlatformCookieName(item.split('=', 1)[0]!.trim()))
    .join('; ')
}

function safeResponseHeaders(response: IncomingMessage): Readonly<Record<string, string | readonly string[]>> {
  const result: Record<string, string | readonly string[]> = {}
  for (const key of ['content-type', 'etag', 'last-modified', 'location'] as const) {
    const value = response.headers[key]
    if (typeof value === 'string' && value.length <= 4_096) result[key] = value
  }
  const cookies = response.headers['set-cookie']
  if (Array.isArray(cookies) && cookies.length <= 10 && cookies.every(value => value.length <= 4_096)) result['set-cookie'] = cookies
  return result
}

async function readMessages(options: PreviewProxyOptions): Promise<readonly unknown[]> {
  const path = resolve(options.dataRoot, options.previewId, 'preview-capture.json')
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MESSAGE_FILE_LIMIT) return []
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!Array.isArray(parsed) || parsed.length > 20) return []
    return parsed.filter(isCapturedCode).map(item => ({
      kind: 'code', email: item.email, code: item.code, expiresAt: item.expiresAt,
    }))
  } catch { return [] }
}

/**
 * O tamanho maximo de um endereco de email, pelo RFC 5321.
 *
 * Existe porque `preview-capture.json` e escrito pelo aplicativo GERADO, que
 * nao e confiavel, e o que sai daqui aparece na tela do Studio. Sem teto, um
 * unico endereco podia ocupar o arquivo inteiro.
 */
const EMAIL_MAX_LENGTH = 254

/**
 * A forma aceita de endereco de email vindo do aplicativo gerado.
 *
 * Deliberadamente mais estreita que o RFC: a anterior — `[^\s@]+@[^\s@]+\.[^\s@]+`
 * — aceitava `<`, `>`, `"`, `/` e `=`, e o texto aceito aqui e renderizado no
 * Studio. Endereco legitimo nao usa nenhum desses caracteres; recusa-los custa
 * nada e fecha a porta de injecao antes da renderizacao, em vez de depender
 * dela.
 */
const EMAIL_SHAPE = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~.]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/u

/**
 * Se este endereco pode ser mostrado.
 * @param value - o endereco vindo do arquivo escrito pelo aplicativo gerado.
 * @returns `true` quando tem tamanho e forma aceitaveis.
 */
function isDisplayableEmail(value: string): boolean {
  return value.length <= EMAIL_MAX_LENGTH && !value.includes('<') && !value.includes('>') && EMAIL_SHAPE.test(value)
}

function isCapturedCode(value: unknown): value is { readonly kind: 'code'; readonly email: string; readonly code: string; readonly expiresAt: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return Object.keys(row).sort().join(',') === 'code,email,expiresAt,kind'
    && row.kind === 'code' && typeof row.email === 'string' && isDisplayableEmail(row.email)
    && typeof row.code === 'string' && /^\d{6}$/u.test(row.code)
    && typeof row.expiresAt === 'string' && !Number.isNaN(Date.parse(row.expiresAt))
}

async function readBounded(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.byteLength
    if (size > REQUEST_LIMIT) throw new Error('REQUEST_TOO_LARGE')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

function validateOptions(options: PreviewProxyOptions): void {
  if (!posix.isAbsolute(options.socketPath) || options.socketPath.includes('\\') || options.socketPath.includes('\0')) throw new Error('INVALID_PROXY_SOCKET')
  if (!/^[A-Za-z0-9_.:-]{1,200}$/u.test(options.runtimeRef)) throw new Error('INVALID_RUNTIME_REF')
  if (!/^[a-z0-9][a-z0-9.-]{0,99}$/u.test(options.runtimeHost)) throw new Error('INVALID_RUNTIME_HOST')
  if (!/^[A-Za-z0-9-]{1,100}$/u.test(options.previewId) || !posix.isAbsolute(options.dataRoot)) throw new Error('INVALID_PROXY_CONFIG')
  if (options.runtimeTimeoutMs !== undefined && (!Number.isSafeInteger(options.runtimeTimeoutMs) || options.runtimeTimeoutMs < 50 || options.runtimeTimeoutMs > 30_000)) throw new Error('INVALID_PROXY_TIMEOUT')
}

function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.writableEnded) return
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': String(body.byteLength), 'cache-control': 'no-store' })
  response.end(body)
}
