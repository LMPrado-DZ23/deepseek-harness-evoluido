import type { ServerResponse } from 'node:http'
import { z } from 'zod'
import type { PromptToAppHttpExtension, PromptToAppHttpExtensionRequest } from '@dz23-studio/prompt-to-app'
import { assertRouteContracts, type StudioRouteContract } from '@dz23-studio/policy'
import { StagingError, type StagingService } from './service.js'
import { StagingSourceError } from './source.js'
import { t } from './i18n.js'

/**
 * As rotas de staging.
 *
 * Elas entram como EXTENSÃO do prompt-to-app, e não como uma segunda
 * autoridade sobre `/api/studio/apps`: quem confere sessão, CSRF e papel
 * continua sendo o núcleo, e esta fatia só responde pelo seu sufixo.
 *
 * Não existe rota de APAGAR uma publicação. Um release é um registro do que
 * aconteceu com um efeito fora do Studio, e apagá-lo não desfaz o efeito -
 * desfazer é `rollback`, que publica uma geração NOVA com o artefato anterior.
 */

const publishSchema = z.object({
  operation_id: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  approval_id: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  run_id: z.string().min(1).max(160).optional(),
}).strict()

const rollbackSchema = z.object({
  operation_id: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  approval_id: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
}).strict()

export const STAGING_ROUTE_CONTRACTS = [
  { method: 'GET', path: '/projects/:projectId/staging/releases', access: 'authorized', permission: 'project.read', scope: 'project' },
  { method: 'POST', path: '/projects/:projectId/staging/releases', access: 'authorized', permission: 'project.publish_staging', scope: 'project' },
  { method: 'GET', path: '/projects/:projectId/staging/releases/:releaseId', access: 'authorized', permission: 'project.read', scope: 'project' },
  { method: 'POST', path: '/projects/:projectId/staging/releases/:releaseId/rollback', access: 'authorized', permission: 'project.publish_staging', scope: 'project' },
  { method: 'POST', path: '/projects/:projectId/staging/releases/:releaseId/reconcile', access: 'authorized', permission: 'project.publish_staging', scope: 'project' },
] as const satisfies readonly StudioRouteContract[]

assertRouteContracts(STAGING_ROUTE_CONTRACTS)

/**
 * Liga o serviço de staging à porta HTTP do prompt-to-app.
 * @param service - o serviço, ou `undefined` quando o staging não está configurado.
 * @returns a extensão.
 */
export function createStagingHttpExtension(service: () => StagingService | undefined): PromptToAppHttpExtension {
  return async (input): Promise<boolean> => {
    if (!input.suffix.startsWith('/staging/releases')) return false
    try {
      const current = service()
      // Ausente é 503 com o motivo, e não 404: a rota EXISTE, o que falta é a
      // pasta de publicação escolhida por quem administra.
      if (current === undefined) throw new StagingError('INVALID', t('http.notConfigured'))
      const actor = { ...input.actor, sessionId: input.actor.sessionId ?? '' }
      // Sem sessão auditável não há quem responda pela publicação depois.
      if (actor.sessionId === '') throw new StagingError('FORBIDDEN', t('http.auditableSession'))
      if (input.suffix === '/staging/releases') {
        if (input.request.method === 'GET') {
          return respond(input.response, 200, { releases: current.list(actor, input.projectId) })
        }
        if (input.request.method === 'POST') {
          const body = publishSchema.parse(await readJson(input))
          const release = await current.publish(actor, {
            projectId: input.projectId, operationId: body.operation_id, approvalId: body.approval_id,
            ...(body.run_id === undefined ? {} : { runId: body.run_id }),
          })
          return respond(input.response, 200, { release })
        }
        return false
      }
      const match = /^\/staging\/releases\/([^/]+)(\/(?:rollback|reconcile))?$/u.exec(input.suffix)
      if (match === null) return false
      const releaseId = decodeURIComponent(match[1]!)
      if (input.request.method === 'GET' && match[2] === undefined) {
        return respond(input.response, 200, { release: current.get(actor, input.projectId, releaseId) })
      }
      if (input.request.method === 'POST' && match[2] === '/rollback') {
        const body = rollbackSchema.parse(await readJson(input))
        const release = await current.rollback(actor, {
          projectId: input.projectId, operationId: body.operation_id,
          approvalId: body.approval_id, targetReleaseId: releaseId,
        })
        return respond(input.response, 200, { release })
      }
      if (input.request.method === 'POST' && match[2] === '/reconcile') {
        return respond(input.response, 200, { release: await current.reconcile(actor, input.projectId, releaseId) })
      }
      return false
    } catch (error) {
      return respond(input.response, statusOf(error), { error: safeMessage(error), code: codeOf(error) })
    }
  }
}

async function readJson(input: PromptToAppHttpExtensionRequest): Promise<unknown> {
  const contentType = input.request.headers['content-type']
  if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
    throw new StagingError('INVALID', t('http.jsonRequired'))
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of input.request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Buffer)
    size += bytes.length
    if (size > 8 * 1024) throw new StagingError('INVALID', t('http.requestTooLarge'))
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

/**
 * O status de uma falha.
 *
 * A recusa da ORIGEM é 409 e não 400: o pedido está correto, o que falta é uma
 * versão verificada. Mandar a pessoa "corrigir o pedido" quando o que ela
 * precisa é gerar o aplicativo de novo seria mandá-la para o lugar errado.
 * @param error - a falha.
 * @returns o status HTTP.
 */
export function statusOf(error: unknown): number {
  if (error instanceof StagingError) {
    return { NOT_FOUND: 404, FORBIDDEN: 403, CONFLICT: 409, INVALID: 400 }[error.code]
  }
  if (error instanceof StagingSourceError) return 409
  if (error instanceof z.ZodError || error instanceof SyntaxError) return 400
  return 500
}

/** O código viaja junto: a tela precisa saber QUAL gesto a recusa pede. */
export function codeOf(error: unknown): string | undefined {
  if (error instanceof StagingError) return error.code
  if (error instanceof StagingSourceError) return error.code
  return undefined
}

function safeMessage(error: unknown): string {
  if (error instanceof StagingError || error instanceof z.ZodError || error instanceof SyntaxError) return error.message
  if (error instanceof StagingSourceError) {
    return {
      NO_VERIFIED_RUN: t('source.noVerifiedRun'),
      RUN_NOT_VERIFIED: t('source.runNotVerified'),
      ATTESTATIONS_MISSING: t('source.attestationsMissing'),
      TEMPLATE_INTEGRITY_FAILED: t('source.templateIntegrityFailed'),
      ARTIFACT_MISSING: t('source.artifactMissing'),
    }[error.code]
  }
  // Qualquer outra falha vira uma frase fixa: a mensagem de um erro
  // inesperado pode carregar caminho, consulta ou credencial.
  return t('http.operationFailed')
}
