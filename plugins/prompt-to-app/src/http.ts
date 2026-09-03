import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  CSRF_COOKIE,
  IdentityError,
  assertRequestTrust,
  parseCookies,
  requiredSessionToken,
  singleHeader,
  type StudioIdentityService,
} from '@dz23-studio/identity'
import { assertRouteContracts, type StudioRouteContract } from '@dz23-studio/policy'
import { TenancyError, type StudioTenancyService } from '@dz23-studio/tenancy'
import { z } from 'zod'
import { intakeAnswerSchema, nextIntakeQuestion, type IntakeConversation, type IntakeEngine } from './intake.js'
import type { CodeGeneratorPort, PipelineResult, PromptToAppPipeline } from './pipeline.js'
import type { PlannerEngine } from './planner.js'
import { PromptToAppError, type PromptToAppActor, type PromptToAppService } from './service.js'
import { InvalidTransitionError } from './state.js'

const JSON_LIMIT = 64 * 1024
const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  original_brief: z.string().trim().min(10).max(10_000),
  category: z.enum(['landing-page', 'catalog']),
  privacy: z.enum(['local-only', 'any']),
}).strict()
const answerSchema = intakeAnswerSchema.extend({ confirm_sensitive: z.boolean().optional() }).strict()
const changeRequestSchema = z.object({ reason: z.string().trim().min(3).max(2_000) }).strict()

export interface StudioAppsHealth {
  readonly state: 'OK' | 'ATTENTION'
  readonly route: string | null
  readonly builder: 'OK' | 'BLOCKED_EXTERNAL'
  readonly disk: 'OK' | 'ATTENTION'
}

export const PROMPT_TO_APP_ROUTE_CONTRACTS = [
  { method: 'GET', path: '/health', access: 'authorized', permission: 'project.read', scope: 'workspace' },
  { method: 'GET', path: '/projects', access: 'authorized', permission: 'project.read', scope: 'workspace' },
  { method: 'POST', path: '/projects', access: 'authorized', permission: 'project.write', scope: 'workspace' },
  { method: 'GET', path: '/projects/:projectId', access: 'authorized', permission: 'project.read', scope: 'project' },
  { method: 'POST', path: '/projects/:projectId/intake/answer', access: 'authorized', permission: 'project.write', scope: 'project' },
  { method: 'POST', path: '/projects/:projectId/plan', access: 'authorized', permission: 'project.write', scope: 'project' },
  { method: 'POST', path: '/projects/:projectId/plan/approve', access: 'authorized', permission: 'project.write', scope: 'project' },
  { method: 'POST', path: '/projects/:projectId/plan/change', access: 'authorized', permission: 'project.write', scope: 'project' },
  { method: 'POST', path: '/projects/:projectId/generate', access: 'authorized', permission: 'project.write', scope: 'project' },
  { method: 'DELETE', path: '/projects/:projectId', access: 'authorized', permission: 'project.delete', scope: 'project' },
] as const satisfies readonly StudioRouteContract[]

assertRouteContracts(PROMPT_TO_APP_ROUTE_CONTRACTS)

export interface PromptToAppHttpConfig {
  readonly service: PromptToAppService
  readonly identity: StudioIdentityService
  readonly tenancy: StudioTenancyService
  readonly intake: IntakeEngine
  readonly planner: PlannerEngine
  readonly pipeline: PromptToAppPipeline
  readonly generatorFor: (actor: PromptToAppActor, projectId: string) => CodeGeneratorPort
  readonly health: (actor: PromptToAppActor) => Promise<StudioAppsHealth>
  readonly allowedHosts: readonly string[]
  readonly allowedOrigins: readonly string[]
}

export function createPromptToAppHttpHandler(config: PromptToAppHttpConfig) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      assertRequestTrust(request, config)
      const path = new URL(request.url ?? '/', 'http://local').pathname
      const route = path.slice('/api/studio/apps'.length)
      const matched = matchRoute(request.method, route)
      if (matched === undefined) return json(response, 404, { error: 'Rota não encontrada.' })
      const actor = await authenticatedActor(request, config)

      if (request.method === 'GET' && route === '/health') return json(response, 200, await config.health(actor))
      if (request.method === 'GET' && route === '/projects') return json(response, 200, { projects: config.service.listProjects(actor) })
      if (request.method === 'POST' && route === '/projects') {
        const input = createProjectSchema.parse(await readJson(request))
        const project = await config.service.createProject(actor, input)
        return json(response, 201, { project, next: nextIntakeQuestion({ project, answers: {} }) })
      }

      const projectId = matched.projectId
      if (projectId === undefined) return json(response, 404, { error: 'Rota não encontrada.' })
      if (request.method === 'GET' && matched.suffix === '') {
        const project = config.service.project(actor, projectId)
        return json(response, 200, {
          project,
          turns: config.service.intakeTurns(actor, projectId),
          plan: optional(() => config.service.plan(actor, projectId)),
          runs: config.service.runs(actor, projectId),
          evidence: config.service.evidence(actor, projectId),
        })
      }
      if (request.method === 'POST' && matched.suffix === '/intake/answer') {
        return await answerIntake(request, response, config, actor, projectId)
      }
      if (request.method === 'POST' && matched.suffix === '/plan') {
        const project = config.service.project(actor, projectId)
        const spec = config.service.latestSpec(actor, projectId)
        const previous = optional(() => config.service.plan(actor, projectId))
        const output = await config.planner.plan(
          { orgId: actor.orgId, tenantId: actor.tenantId }, project.privacy, spec.app_spec,
          previous?.status === 'CHANGE_REQUESTED' ? previous.change_request ?? undefined : undefined,
        )
        return json(response, 201, { plan: await config.service.proposePlan(actor, projectId, output.slices) })
      }
      if (request.method === 'POST' && matched.suffix === '/plan/change') {
        const input = changeRequestSchema.parse(await readJson(request))
        return json(response, 200, { plan: await config.service.requestPlanChange(actor, projectId, input.reason) })
      }
      if (request.method === 'POST' && matched.suffix === '/plan/approve') {
        return json(response, 200, { plan: await config.service.approvePlan(actor, projectId) })
      }
      if (request.method === 'POST' && matched.suffix === '/generate') {
        const plan = config.service.plan(actor, projectId)
        if (plan.status !== 'APPROVED') throw new PromptToAppError('INVALID', 'A criação só começa depois que você aprovar o plano.')
        const result: PipelineResult = await config.pipeline.run(actor, projectId, config.generatorFor(actor, projectId))
        return json(response, result.state === 'BLOCKED_EXTERNAL' ? 503 : result.state === 'VERIFIED_PROTOTYPE' ? 200 : 422, result)
      }
      if (request.method === 'DELETE' && matched.suffix === '') {
        return json(response, 200, { project: await config.service.archive(actor, projectId) })
      }
      return json(response, 404, { error: 'Rota não encontrada.' })
    } catch (error) {
      return json(response, statusOf(error), { error: error instanceof Error ? error.message : 'Solicitação inválida.' })
    }
  }
}

async function answerIntake(
  request: IncomingMessage,
  response: ServerResponse,
  config: PromptToAppHttpConfig,
  actor: PromptToAppActor,
  projectId: string,
): Promise<void> {
  const input = answerSchema.parse(await readJson(request))
  const conversation = conversationFor(config.service, actor, projectId)
  const question = nextIntakeQuestion(conversation)
  if (question === undefined) throw new PromptToAppError('REPLAY', 'As perguntas deste projeto já foram respondidas.')
  if (question.id === 'sensitive-confirmation') {
    if (input.confirm_sensitive === undefined) throw new PromptToAppError('INVALID', 'Confirme se o uso desses dados sensíveis é necessário.')
    await config.service.recordTurn(actor, projectId, {
      question_id: question.id, question: question.text,
      answer: input.confirm_sensitive ? 'confirmado' : 'não confirmado', recommended: false, route: null, model: null,
    })
    if (!input.confirm_sensitive) {
      return json(response, 200, { blocked: true, message: 'O projeto não continuará com dados sensíveis sem sua confirmação.' })
    }
  } else {
    let answer = input.answer.trim(); let route: string | null = null; let model: string | null = null
    if (input.recommend) {
      const result = await config.intake.recommend(conversation, question)
      answer = z.string().trim().min(1).max(2_000).parse(result.value)
      route = result.route; model = result.model
    }
    if (answer === '') throw new PromptToAppError('INVALID', 'Responda à pergunta para continuar.')
    await config.service.recordTurn(actor, projectId, {
      question_id: question.id, question: question.text, answer, recommended: input.recommend, route, model,
    })
  }

  const updated = conversationFor(config.service, actor, projectId)
  const next = nextIntakeQuestion(updated)
  if (next !== undefined) return json(response, 200, { next })
  const built = await config.intake.buildSpec(updated)
  const spec = await config.service.saveSpec(actor, projectId, built.spec, 'intake')
  return json(response, 201, { spec, next: null })
}

function conversationFor(service: PromptToAppService, actor: PromptToAppActor, projectId: string): IntakeConversation {
  const project = service.project(actor, projectId)
  const turns = service.intakeTurns(actor, projectId)
  const answers = Object.fromEntries(turns.filter(turn => turn.question_id !== 'sensitive-confirmation').map(turn => [turn.question_id, turn.answer]))
  const sensitive = turns.find(turn => turn.question_id === 'sensitive-confirmation')
  return {
    project, answers,
    ...(sensitive === undefined ? {} : { sensitiveConfirmed: sensitive.answer === 'confirmado' }),
  }
}

async function authenticatedActor(request: IncomingMessage, config: PromptToAppHttpConfig): Promise<PromptToAppActor> {
  const session = await config.identity.authenticate(requiredSessionToken(request))
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const cookies = parseCookies(request.headers.cookie)
    config.identity.validateCsrf(session, cookies[CSRF_COOKIE], singleHeader(request.headers['x-dz23-csrf']))
  }
  const authorization = config.tenancy.authorizationFor(session.user_id, session.org_id, session.tenant_id)
  if (authorization === undefined) throw new PromptToAppError('FORBIDDEN', 'Você não participa deste espaço de trabalho.')
  return authorization
}

function matchRoute(method: string | undefined, path: string): { readonly projectId?: string; readonly suffix: string } | undefined {
  if ((method === 'GET' && (path === '/health' || path === '/projects')) || (method === 'POST' && path === '/projects')) return { suffix: path }
  const match = /^\/projects\/([^/]+)(\/intake\/answer|\/plan\/approve|\/plan\/change|\/plan|\/generate)?$/u.exec(path)
  if (match === null) return undefined
  const suffix = match[2] ?? ''
  const allowed = (method === 'GET' && suffix === '') || (method === 'DELETE' && suffix === '') || (method === 'POST' && suffix !== '')
  if (!allowed) return undefined
  return { projectId: decodeURIComponent(match[1]!), suffix }
}

function optional<T>(read: () => T): T | null {
  try { return read() } catch (error) { if (error instanceof PromptToAppError && error.code === 'NOT_FOUND') return null; throw error }
}

function statusOf(error: unknown): number {
  if (error instanceof IdentityError) return error.code === 'locked' ? 429 : 401
  if (error instanceof TenancyError) return error.code === 'not-found' ? 404 : error.code === 'forbidden' ? 403 : 400
  if (error instanceof PromptToAppError) return error.code === 'NOT_FOUND' ? 404 : error.code === 'FORBIDDEN' ? 403 : error.code === 'REPLAY' ? 409 : 400
  if (error instanceof InvalidTransitionError) return 409
  if (error instanceof z.ZodError || error instanceof SyntaxError) return 400
  return 500
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!singleHeader(request.headers['content-type'])?.toLowerCase().startsWith('application/json')) throw new Error('Envie os dados em formato JSON.')
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > JSON_LIMIT) throw new Error('Solicitação grande demais.')
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(body))
}
