import type { ServerResponse } from 'node:http'
import { z } from 'zod'
import type { PromptToAppHttpExtension, PromptToAppHttpExtensionRequest } from '@dz23-studio/prompt-to-app'
import { PreviewError, type StudioPreviewService } from './service.js'

const startSchema = z.object({ run_id: z.string().min(1).max(200).optional() }).strict()

export function createPreviewProjectHttpExtension(service: StudioPreviewService): PromptToAppHttpExtension {
  return async (input): Promise<boolean> => {
    if (!input.suffix.startsWith('/previews')) return false
    try {
      const actor = { ...input.actor, sessionId: input.actor.sessionId ?? '' }
      if (actor.sessionId === '') throw new PreviewError('FORBIDDEN', 'Sessão auditável obrigatória para a prévia.')
      if (input.suffix === '/previews') {
        if (input.request.method === 'GET') return respond(input.response, 200, { previews: service.list(actor, input.projectId) })
        if (input.request.method === 'POST') {
          const body = startSchema.parse(await readJson(input))
          const started = await service.start(actor, input.projectId, body.run_id)
          return respond(input.response, 202, {
            preview: started.preview,
            admission: { ticket: started.admissionTicket, transport: 'post-message-exchange' },
          })
        }
        return false
      }
      const match = /^\/previews\/([^/]+)(\/(?:logs|messages))?$/u.exec(input.suffix)
      if (match === null) return false
      const previewId = decodeURIComponent(match[1]!)
      if (input.request.method === 'GET' && match[2] === '/logs') {
        return respond(input.response, 200, { lines: await service.logs(actor, input.projectId, previewId) })
      }
      if (input.request.method === 'GET' && match[2] === '/messages') {
        const messages = await service.verificationMessages(actor, input.projectId, previewId)
        return respond(input.response, 200, {
          messages: messages.map(message => ({ email: message.email, code: message.code, expires_at: message.expiresAt })),
        })
      }
      if (input.request.method === 'GET' && match[2] === undefined) {
        return respond(input.response, 200, { preview: await service.health(actor, input.projectId, previewId) })
      }
      if (input.request.method === 'DELETE' && match[2] === undefined) {
        return respond(input.response, 200, { preview: await service.stop(actor, input.projectId, previewId) })
      }
      return false
    } catch (error) {
      return respond(input.response, statusOf(error), { error: safeMessage(error) })
    }
  }
}

async function readJson(input: PromptToAppHttpExtensionRequest): Promise<unknown> {
  const contentType = input.request.headers['content-type']
  if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) throw new PreviewError('INVALID', 'Envie os dados da prévia em JSON.')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of input.request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > 8 * 1024) throw new PreviewError('INVALID', 'A solicitação da prévia é grande demais.')
    chunks.push(bytes)
  }
  const value = Buffer.concat(chunks).toString('utf8')
  return value === '' ? {} : JSON.parse(value)
}

function respond(response: ServerResponse, status: number, body: unknown): true {
  if (!response.writableEnded) {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    response.end(JSON.stringify(body))
  }
  return true
}

function statusOf(error: unknown): number {
  if (error instanceof PreviewError) {
    if (error.code === 'NOT_FOUND') return 404
    if (error.code === 'FORBIDDEN') return 403
    if (error.code === 'CONFLICT') return 409
    if (error.code === 'UNAVAILABLE') return 503
    return 400
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) return 400
  return 500
}

function safeMessage(error: unknown): string {
  if (error instanceof PreviewError || error instanceof z.ZodError || error instanceof SyntaxError) return error.message
  return 'Não foi possível concluir a operação de prévia.'
}
