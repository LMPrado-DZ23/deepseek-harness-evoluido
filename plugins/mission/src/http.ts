import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  assertRequestTrust,
  authenticatedMutation,
  IdentityError,
  singleHeader,
  type StudioIdentityService,
} from '@dz23-studio/identity'
import { assertRouteContracts, type StudioRouteContract } from '@dz23-studio/policy'
import type { StudioTenancyService } from '@dz23-studio/tenancy'
import { z } from 'zod'
import { t } from './i18n.js'
import { CRITERION_STATES, type MissionRecord, type MissionRunUsage } from './model.js'
import { MissionError, missionCompletion, missionSpend, type MissionActor, type StudioMissionService } from './service.js'

const JSON_LIMIT = 64 * 1024
const PREFIX = '/api/studio/missions'

const createSchema = z.object({
  mission_id: z.string().min(1).max(120),
  objective: z.string().min(3).max(4_000),
  max_total_tokens: z.number().int().positive().nullable(),
  criteria: z.array(z.object({
    criterion_id: z.string().min(1).max(120),
    statement: z.string().min(3).max(2_000),
  }).strict()).min(1).max(200),
}).strict()

const criterionSchema = z.object({
  state: z.enum(CRITERION_STATES),
  evidence: z.string().min(1).max(2_000).nullable().optional(),
  blocked_reason: z.string().min(1).max(2_000).nullable().optional(),
}).strict()

/**
 * O que cada rota declara — e ONDE a permissão é conferida.
 *
 * O campo `permission` é DOCUMENTO, e não porta, pela mesma razão registrada em
 * `plugins/tenancy/src/http.ts`: papel neste produto é por espaço de trabalho, e
 * a porta é o `#authorize` do serviço. Aqui há um motivo a mais para não
 * conferir na rota: o motor de missão também é chamado pela COMPOSIÇÃO, quando
 * uma equipe aprovada liga uma execução à missão — e uma conferência que morasse
 * na rota não alcançaria esse caminho.
 *
 * `project.read` e `project.write` são as permissões existentes que descrevem o
 * que uma missão é: um conjunto de trabalho sobre projetos. Inventar uma
 * permissão nova (`mission.*`) obrigaria a redistribuí-la entre os quatro
 * papéis, e essa é uma decisão de produto que não é minha para tomar sozinho.
 */
export const MISSION_ROUTE_CONTRACTS = [
  { method: 'GET', path: '/missions', access: 'authorized', permission: 'project.read', scope: 'workspace' },
  { method: 'POST', path: '/missions', access: 'authorized', permission: 'project.write', scope: 'workspace' },
  { method: 'GET', path: '/missions/:missionId', access: 'authorized', permission: 'project.read', scope: 'workspace' },
  { method: 'POST', path: '/missions/:missionId/candidate', access: 'authorized', permission: 'project.write', scope: 'workspace' },
  { method: 'POST', path: '/missions/:missionId/complete', access: 'authorized', permission: 'project.write', scope: 'workspace' },
  { method: 'PATCH', path: '/missions/:missionId/criteria/:criterionId', access: 'authorized', permission: 'project.write', scope: 'workspace' },
] as const satisfies readonly StudioRouteContract[]

assertRouteContracts(MISSION_ROUTE_CONTRACTS)

export interface MissionHttpConfig {
  readonly service: StudioMissionService
  readonly identity: StudioIdentityService
  readonly tenancy: StudioTenancyService
  readonly allowedHosts: readonly string[]
  readonly allowedOrigins: readonly string[]
  /** As execuções conhecidas, para o painel poder mostrar quanto já custou. */
  runs(): readonly MissionRunUsage[]
}

const MISSION_ID = /^\/missions\/([^/]+)$/u
const CANDIDATE = /^\/missions\/([^/]+)\/candidate$/u
const COMPLETE = /^\/missions\/([^/]+)\/complete$/u
const CRITERION = /^\/missions\/([^/]+)\/criteria\/([^/]+)$/u

export function createMissionHttpHandler(config: MissionHttpConfig) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      assertRequestTrust(request, config)
      const path = new URL(request.url ?? '/', 'http://local').pathname
      const route = path.slice(PREFIX.length)
      const method = request.method ?? 'GET'
      const session = await authenticatedMutation(request, config.identity)
      const authorization = config.tenancy.authorizationFor(session.user_id, session.org_id, session.tenant_id)
      // Sem matrícula não há papel, e sem papel não há o que conferir. Recusar
      // aqui é o mesmo que o hub faz, e é o lado seguro: seguir sem papel
      // obrigaria a inventar um.
      if (authorization === undefined) throw new MissionError('FORBIDDEN', t('errors.semMatricula'))
      const actor: MissionActor = {
        userId: session.user_id, orgId: session.org_id, tenantId: session.tenant_id, role: authorization.role,
      }

      if (method === 'GET' && route === '/missions') {
        return json(response, 200, { missions: config.service.missions(actor).map(record => view(record, config.runs())) })
      }
      if (method === 'POST' && route === '/missions') {
        const body = createSchema.parse(await readJson(request))
        const created = await config.service.create(actor, {
          missionId: body.mission_id, objective: body.objective, maxTotalTokens: body.max_total_tokens,
          criteria: body.criteria,
        })
        return json(response, 201, { mission: view(created, config.runs()) })
      }
      const candidate = CANDIDATE.exec(route)
      if (method === 'POST' && candidate !== null) {
        const updated = await config.service.declareCandidate(actor, decodeURIComponent(candidate[1]!))
        return json(response, 200, { mission: view(updated, config.runs()) })
      }
      const complete = COMPLETE.exec(route)
      if (method === 'POST' && complete !== null) {
        const updated = await config.service.complete(actor, decodeURIComponent(complete[1]!))
        return json(response, 200, { mission: view(updated, config.runs()) })
      }
      const criterion = CRITERION.exec(route)
      if (method === 'PATCH' && criterion !== null) {
        const body = criterionSchema.parse(await readJson(request))
        const updated = await config.service.recordCriterion(
          actor, decodeURIComponent(criterion[1]!), decodeURIComponent(criterion[2]!),
          {
            state: body.state,
            ...(body.evidence === undefined ? {} : { evidence: body.evidence }),
            ...(body.blocked_reason === undefined ? {} : { blockedReason: body.blocked_reason }),
          },
        )
        return json(response, 200, { mission: view(updated, config.runs()) })
      }
      const single = MISSION_ID.exec(route)
      if (method === 'GET' && single !== null) {
        return json(response, 200, { mission: view(config.service.mission(actor, decodeURIComponent(single[1]!)), config.runs()) })
      }
      return json(response, 404, { error: t('http.rotaNaoEncontrada') })
    } catch (error) {
      // Só texto de CATÁLOGO chega ao cliente: um erro do armazenamento carrega
      // caminho de arquivo do servidor, e um `ZodError` carrega o JSON das
      // issues. Os dois erros abaixo são nossos e já falam a língua da pessoa.
      const catalogued = error instanceof MissionError || error instanceof IdentityError
      return json(response, statusOf(error), { error: catalogued ? error.message : t('http.solicitacaoInvalida') })
    }
  }
}

function statusOf(error: unknown): number {
  if (error instanceof MissionError) {
    switch (error.code) {
      case 'NOT_FOUND': return 404
      case 'FORBIDDEN': return 403
      case 'INVALID_STATE': return 409
      case 'BUDGET_EXCEEDED': return 409
      case 'INVALID': return 400
    }
  }
  if (error instanceof IdentityError) return error.code === 'locked' ? 429 : 401
  return 400
}

/**
 * A missão no recorte que a tela usa, com o que é DERIVADO calculado aqui.
 *
 * `spend` e `completion` não entram no registro gravado: são funções do estado
 * atual das execuções, e gravá-las criaria uma segunda verdade que diverge no
 * primeiro conserto. É a mesma decisão que o retrato de equipe já tomou para
 * `blocked`.
 * @param record - a missão gravada.
 * @param runs - as execuções conhecidas.
 * @returns o recorte.
 */
export function view(record: MissionRecord, runs: readonly MissionRunUsage[]) {
  return { ...record, spend: missionSpend(record, runs), completion: missionCompletion(record.criteria) }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!singleHeader(request.headers['content-type'])?.toLowerCase().startsWith('application/json')) {
    throw new MissionError('INVALID', t('http.jsonBodyRequired'))
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > JSON_LIMIT) throw new MissionError('INVALID', t('http.solicitacaoGrandeDemais'))
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(body))
}
