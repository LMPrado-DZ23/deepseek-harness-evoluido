import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  authenticatedMutation,
  IdentityError,
  assertRequestTrust,
  singleHeader,
  type StudioIdentityService,
} from '@dz23-studio/identity'
import { assertRouteContracts, type StudioRouteContract } from '@dz23-studio/policy'
import { TenancyError, type StudioTenancyService } from '@dz23-studio/tenancy'
import { z } from 'zod'
import { designSelectionSchema } from './design.js'
import { t } from './i18n.js'
import { intakeAnswerSchema, nextIntakeQuestion, type IntakeConversation, type IntakeEngine } from './intake.js'
import type { CodeGeneratorPort } from './pipeline.js'
import type { PromptToAppJobService } from './jobs.js'
import { FormCategoryCapabilityError, type PlannerEngine } from './planner.js'
import { studioProjectCategorySchema } from './model.js'
import type { LogoProcessorPort } from './logo.js'
import { PromptToAppError, type PromptToAppActor, type PromptToAppService } from './service.js'
import { InvalidTransitionError } from './state.js'

const JSON_LIMIT = 64 * 1024
const LOGO_LIMIT = 2 * 1024 * 1024
const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  original_brief: z.string().trim().min(10).max(10_000),
  category: studioProjectCategorySchema,
  privacy: z.enum(['local-only', 'any']),
}).strict()
const answerSchema = intakeAnswerSchema.extend({ confirm_sensitive: z.boolean().optional() }).strict()
const changeRequestSchema = z.object({ reason: z.string().trim().min(3).max(2_000) }).strict()

export interface PromptToAppHttpExtensionRequest {
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly actor: PromptToAppActor
  readonly projectId: string
  readonly suffix: string
}

export type PromptToAppHttpExtension = (input: PromptToAppHttpExtensionRequest) => Promise<boolean>
const HTTP_EXTENSIONS = new Set<PromptToAppHttpExtension>()

/** Registers a Studio-owned vertical slice without adding another `/api/studio/apps` authority. */
export function registerPromptToAppHttpExtension(extension: PromptToAppHttpExtension): () => void {
  HTTP_EXTENSIONS.add(extension)
  return () => { HTTP_EXTENSIONS.delete(extension) }
}

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
  { method: 'POST', path: '/projects/:projectId/design', access: 'authorized', permission: 'project.write', scope: 'project' },
  { method: 'POST', path: '/projects/:projectId/design/logo', access: 'authorized', permission: 'project.write', scope: 'project' },
  { method: 'POST', path: '/projects/:projectId/plan', access: 'authorized', permission: 'project.write', scope: 'project' },
  { method: 'POST', path: '/projects/:projectId/plan/approve', access: 'authorized', permission: 'project.write', scope: 'project' },
  { method: 'POST', path: '/projects/:projectId/plan/change', access: 'authorized', permission: 'project.write', scope: 'project' },
  { method: 'POST', path: '/projects/:projectId/generate', access: 'authorized', permission: 'project.write', scope: 'project' },
  { method: 'POST', path: '/projects/:projectId/generate/cancel', access: 'authorized', permission: 'project.write', scope: 'project' },
  { method: 'DELETE', path: '/projects/:projectId', access: 'authorized', permission: 'project.delete', scope: 'project' },
] as const satisfies readonly StudioRouteContract[]

assertRouteContracts(PROMPT_TO_APP_ROUTE_CONTRACTS)

export interface PromptToAppHttpConfig {
  readonly service: PromptToAppService
  readonly identity: StudioIdentityService
  readonly tenancy: StudioTenancyService
  readonly intake: IntakeEngine
  readonly planner: PlannerEngine
  readonly jobs: PromptToAppJobService
  readonly logos: LogoProcessorPort
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
      // The core authenticates every extension request, but each extension owns
      // its exact suffix grammar. This prevents a second route list from drifting.
      const extension = matched === undefined ? /^\/projects\/([^/]+)(\/.+)$/u.exec(route) : null
      if (matched === undefined && extension === null) return json(response, 404, { error: t('errors.routeNotFound') })
      const actor = await authenticatedActor(request, config)
      if (extension !== null) {
        const input: PromptToAppHttpExtensionRequest = {
          request, response, actor,
          projectId: decodeURIComponent(extension[1]!), suffix: extension[2]!,
        }
        for (const handler of HTTP_EXTENSIONS) {
          if (await handler(input)) return
        }
        return json(response, 404, { error: t('errors.routeNotFound') })
      }
      if (matched === undefined) return json(response, 404, { error: t('errors.routeNotFound') })

      if (request.method === 'GET' && route === '/health') return json(response, 200, await config.health(actor))
      if (request.method === 'GET' && route === '/projects') return json(response, 200, { projects: config.service.listProjects(actor) })
      if (request.method === 'POST' && route === '/projects') {
        const input = createProjectSchema.parse(await readJson(request))
        const project = await config.service.createProject(actor, input)
        return json(response, 201, { project, next: nextIntakeQuestion({ project, answers: {} }) })
      }

      const projectId = matched.projectId
      if (projectId === undefined) return json(response, 404, { error: t('errors.routeNotFound') })
      if (request.method === 'GET' && matched.suffix === '') {
        const project = config.service.project(actor, projectId)
        const runs = config.service.runs(actor, projectId)
        const currentRun = [...runs].sort((left, right) => right.started_at.localeCompare(left.started_at) || right.attempt - left.attempt)[0] ?? null
        const verificationCodes = project.state === 'VERIFIED_PROTOTYPE' && currentRun?.state === 'PASSED'
          ? await capturedVerificationCodes(currentRun.run_directory)
          : []
        return json(response, 200, {
          project,
          turns: config.service.intakeTurns(actor, projectId),
          plan: optional(() => config.service.plan(actor, projectId)),
          design: optional(() => config.service.latestDesign(actor, projectId)),
          runs,
          current_run: currentRun === null ? null : { ...currentRun, verification_codes: verificationCodes },
          evidence: config.service.evidence(actor, projectId),
        })
      }
      if (request.method === 'POST' && matched.suffix === '/intake/answer') {
        return await answerIntake(request, response, config, actor, projectId)
      }
      if (request.method === 'POST' && matched.suffix === '/design') {
        const input = designSelectionSchema.parse(await readJson(request))
        return json(response, 200, { design: await config.service.saveDesign(actor, projectId, input) })
      }
      if (request.method === 'POST' && matched.suffix === '/design/logo') {
        config.service.assertAuthorized(actor, 'project.write'); config.service.project(actor, projectId)
        const contentType = singleHeader(request.headers['content-type'])?.split(';', 1)[0]?.toLowerCase() ?? ''
        const logo = await config.logos.process({ orgId: actor.orgId, tenantId: actor.tenantId }, await readBytes(request, LOGO_LIMIT), contentType)
        return json(response, 200, { design: await config.service.attachLogo(actor, projectId, logo) })
      }
      if (request.method === 'POST' && matched.suffix === '/plan') {
        const project = config.service.project(actor, projectId)
        const spec = config.service.latestSpec(actor, projectId)
        const previous = optional(() => config.service.plan(actor, projectId))
        const output = await config.planner.plan(
          { orgId: actor.orgId, tenantId: actor.tenantId }, project.privacy, spec.app_spec, project.category,
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
        if (plan.status !== 'APPROVED') throw new PromptToAppError('INVALID', t('errors.planRequired'))
        const accepted = await config.jobs.start(actor, projectId, config.generatorFor(actor, projectId))
        return json(response, 202, { run_id: accepted.runId })
      }
      if (request.method === 'POST' && matched.suffix === '/generate/cancel') {
        return json(response, 202, { status: config.jobs.cancel(actor, projectId) })
      }
      if (request.method === 'DELETE' && matched.suffix === '') {
        return json(response, 200, { project: await config.service.archive(actor, projectId) })
      }
      return json(response, 404, { error: t('errors.routeNotFound') })
    } catch (error) {
      return json(response, statusOf(error), { error: error instanceof Error ? error.message : t('errors.invalidRequest') })
    }
  }
}

const capturedMessageSchema = z.array(z.object({
  kind: z.enum(['code', 'invitation']), email: z.string().email(), code: z.string().regex(/^\d{6}$/u).optional(), expiresAt: z.iso.datetime(),
}).passthrough()).max(20)

async function capturedVerificationCodes(runDirectory: string): Promise<readonly { email: string; code: string; expires_at: string }[]> {
  try {
    const decoded = capturedMessageSchema.parse(JSON.parse(await readFile(resolveRunCapture(runDirectory), 'utf8')))
    return decoded.filter((message): message is typeof message & { code: string } => message.kind === 'code' && message.code !== undefined)
      .map(message => ({ email: message.email, code: message.code, expires_at: message.expiresAt }))
  } catch { return [] }
}

function resolveRunCapture(runDirectory: string): string {
  if (runDirectory === 'not-created') throw new Error('RUN_DIRECTORY_NOT_CREATED')
  return resolve(runDirectory, 'data', 'studio-capture.json')
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
  if (question === undefined) throw new PromptToAppError('REPLAY', t('errors.questionsAnswered'))
  if (question.id === 'sensitive-confirmation') {
    if (input.confirm_sensitive === undefined) throw new PromptToAppError('INVALID', t('errors.sensitiveConfirmation'))
    await config.service.recordTurn(actor, projectId, {
      question_id: question.id, question: question.text,
      answer: input.confirm_sensitive ? t('values.confirmed') : t('values.notConfirmed'), recommended: false, route: null, model: null,
    })
    if (!input.confirm_sensitive) {
      return json(response, 200, { blocked: true, message: t('errors.sensitiveBlocked') })
    }
  } else {
    let answer = input.answer.trim(); let route: string | null = null; let model: string | null = null
    if (input.recommend) {
      const result = await config.intake.recommend(conversation, question)
      answer = z.string().trim().min(1).max(2_000).parse(result.value)
      route = result.route; model = result.model
    }
    if (answer === '') throw new PromptToAppError('INVALID', t('errors.answerRequired'))
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
    ...(sensitive === undefined ? {} : { sensitiveConfirmed: sensitive.answer === t('values.confirmed') }),
  }
}

async function authenticatedActor(request: IncomingMessage, config: PromptToAppHttpConfig): Promise<PromptToAppActor> {
  const session = await authenticatedMutation(request, config.identity)
  const authorization = config.tenancy.authorizationFor(session.user_id, session.org_id, session.tenant_id)
  if (authorization === undefined) throw new PromptToAppError('FORBIDDEN', t('errors.membershipRequired'))
  return { ...authorization, sessionId: session.session_id }
}

function matchRoute(method: string | undefined, path: string): { readonly projectId?: string; readonly suffix: string } | undefined {
  if ((method === 'GET' && (path === '/health' || path === '/projects')) || (method === 'POST' && path === '/projects')) return { suffix: path }
  const match = /^\/projects\/([^/]+)(\/intake\/answer|\/design\/logo|\/design|\/plan\/approve|\/plan\/change|\/plan|\/generate\/cancel|\/generate)?$/u.exec(path)
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
  if (error instanceof FormCategoryCapabilityError) return 409
  if (error instanceof InvalidTransitionError) return 409
  if (error instanceof z.ZodError || error instanceof SyntaxError) return 400
  return 500
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!singleHeader(request.headers['content-type'])?.toLowerCase().startsWith('application/json')) throw new Error(t('errors.jsonRequired'))
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > JSON_LIMIT) throw new Error(t('errors.requestTooLarge'))
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function readBytes(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > limit) throw new PromptToAppError('INVALID', t('errors.invalidLogo'))
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(body))
}
