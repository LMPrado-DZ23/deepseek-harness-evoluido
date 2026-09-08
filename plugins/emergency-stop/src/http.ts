import type { ServerResponse } from 'node:http'
import { z } from 'zod'
import type {
  PromptToAppWorkspaceHttpExtension,
  PromptToAppWorkspaceHttpExtensionRequest,
} from '@dz23-studio/prompt-to-app'
import { assertRouteContracts, type StudioRouteContract } from '@dz23-studio/policy'
import { t } from './i18n.js'
import { EmergencyStopError, type StudioEmergencyStopService } from './service.js'

const engageSchema = z.object({ reason: z.string().max(500).optional() }).strict()
const releaseSchema = z.object({ reason: z.string().min(1).max(500) }).strict()

/**
 * Parar pede `project.write`; retomar pede `project.write` MAIS identidade
 * forte, que o contrato de rota não sabe expressar e o serviço exige. O
 * contrato aqui é o piso, nunca o teto.
 */
export const EMERGENCY_STOP_ROUTE_CONTRACTS = [
  { method: 'GET', path: '/emergency-stop', access: 'authorized', permission: 'project.read', scope: 'workspace' },
  { method: 'POST', path: '/emergency-stop/engage', access: 'authorized', permission: 'project.write', scope: 'workspace' },
  { method: 'POST', path: '/emergency-stop/release', access: 'authorized', permission: 'project.write', scope: 'workspace' },
] as const satisfies readonly StudioRouteContract[]

assertRouteContracts(EMERGENCY_STOP_ROUTE_CONTRACTS)

/**
 * A rota do botão, registrada como fatia do Studio.
 *
 * Ela não abre uma segunda autoridade sobre `/api/studio/apps`: quem
 * autentica, valida CSRF e resolve o papel continua sendo o núcleo do
 * prompt-to-app. Esta função só decide o que fazer com um pedido já
 * autenticado - e por isso a mutação daqui herda o mesmo CSRF de todas as
 * outras, em vez de inventar o dela.
 * @param service - o serviço de parada de emergência.
 * @returns a extensão de escopo pronta para registro.
 */
export function createEmergencyStopHttpExtension(service: StudioEmergencyStopService): PromptToAppWorkspaceHttpExtension {
  return async (input): Promise<boolean> => {
    if (input.suffix !== '/emergency-stop' && !input.suffix.startsWith('/emergency-stop/')) return false
    try {
      const scope = { orgId: input.actor.orgId, tenantId: input.actor.tenantId }
      if (input.request.method === 'GET' && input.suffix === '/emergency-stop') {
        return respond(input.response, 200, { emergency_stop: service.state(scope) })
      }
      if (input.request.method === 'POST' && input.suffix === '/emergency-stop/engage') {
        const body = engageSchema.parse(await readJson(input))
        const engaged = await service.engage(input.actor, body.reason)
        return respond(input.response, 200, { emergency_stop: engaged.state, surfaces: engaged.surfaces })
      }
      if (input.request.method === 'POST' && input.suffix === '/emergency-stop/release') {
        const body = releaseSchema.parse(await readJson(input))
        return respond(input.response, 200, { emergency_stop: await service.release(input.actor, body.reason) })
      }
      return respond(input.response, 404, { error: t('errors.routeNotFound') })
    } catch (error) {
      return respond(input.response, statusOf(error), { error: safeMessage(error) })
    }
  }
}

async function readJson(input: PromptToAppWorkspaceHttpExtensionRequest): Promise<unknown> {
  const contentType = input.request.headers['content-type']
  if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
    throw new EmergencyStopError('INVALID', t('errors.jsonRequired'))
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of input.request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += bytes.length
    if (size > 8 * 1024) throw new EmergencyStopError('INVALID', t('errors.requestTooLarge'))
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
  if (error instanceof EmergencyStopError) {
    if (error.code === 'FORBIDDEN') return 403
    // Falta de identidade forte é 401: não é "você não pode", é "prove de novo
    // quem você é". A tela precisa da diferença para mandar a pessoa à chave de
    // acesso em vez de a um administrador.
    if (error.code === 'STRONG_IDENTITY_REQUIRED') return 401
    if (error.code === 'STOPPED') return 409
    return 400
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) return 400
  return 500
}

function safeMessage(error: unknown): string {
  if (error instanceof EmergencyStopError || error instanceof z.ZodError || error instanceof SyntaxError) return error.message
  return t('errors.operationFailed')
}
