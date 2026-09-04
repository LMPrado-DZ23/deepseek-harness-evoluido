import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@dz23-studio/preview'
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

export const name = 'dz23-studio-web'
export const inject = ['studioIdentity', 'studioPreview', 'webServer']

export interface StudioWebConfig {
  readonly distDirectory?: string
  readonly allowedHosts?: readonly string[]
  readonly previewFrameSources?: readonly string[]
}

export function createStudioWebHandler(config: {
  readonly distDirectory: string
  readonly identity: StudioIdentityService
  readonly allowedHosts: readonly string[]
  readonly previewFrameSources?: readonly string[]
}) {
  const frameSources = normalizePreviewFrameSources(config.previewFrameSources ?? [])
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      assertRequestTrust(request, { allowedHosts: config.allowedHosts, allowedOrigins: [] })
      if (request.method !== 'GET' && request.method !== 'HEAD') return send(response, 405, 'Método não permitido.', frameSources)
      await authenticatedMutation(request, config.identity)
      const root = await realpath(config.distDirectory)
      const pathname = new URL(request.url ?? '/studio', 'http://local').pathname
      const requested = pathname === '/studio' || pathname === '/studio/' ? 'index.html' : decodeURIComponent(pathname.slice('/studio/'.length))
      const candidate = safeTarget(root, requested)
      const selected = await selectFile(root, candidate, requested)
      const body = await readFile(selected)
      response.writeHead(200, securityHeaders(contentType(selected), frameSources))
      response.end(request.method === 'HEAD' ? undefined : body)
    } catch (error) {
      const status = error instanceof IdentityError ? error.code === 'locked' ? 429 : 401
        : error instanceof StaticFileError ? error.status : 500
      send(response, status, error instanceof Error ? error.message : 'Não foi possível abrir a interface.', frameSources)
    }
  }
}

export async function apply(ctx: Context, config: StudioWebConfig = {}): Promise<void> {
  const port = ctx.webServer.port
  const defaultHost = `127.0.0.1:${port}`
  const packagedClient = fileURLToPath(new URL('./client/', import.meta.url))
  const distDirectory = resolve(config.distDirectory ?? packagedClient)
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: '/studio',
    handler: createStudioWebHandler({
      distDirectory, identity: ctx.studioIdentity.service,
      allowedHosts: config.allowedHosts ?? [defaultHost, `localhost:${port}`],
      previewFrameSources: config.previewFrameSources ?? [ctx.studioPreview.frameSource],
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
