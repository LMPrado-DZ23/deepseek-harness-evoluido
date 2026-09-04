import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import { randomUUID } from 'node:crypto'
import { t } from './i18n.js'
import type { CodeGeneratorPort, PipelineResult, PromptToAppPipeline } from './pipeline.js'
import { PromptToAppError, type PromptToAppActor, type PromptToAppService } from './service.js'
import { canStartGeneration } from './state.js'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap { 'studio-prompt-to-app': 'studio-prompt-to-app' }
}

export interface PromptToAppJobRegistry {
  start(spec: {
    readonly kind: 'studio-prompt-to-app'
    readonly label: string
    readonly owner: Agent
    run(): { cancel(reason?: string): void; done: Promise<JobOutcome> }
  }): JobId
  kill(id: JobId, owner: Agent, reason?: string): 'requested' | 'already-finished'
}

export interface PromptToAppJobOwnerHandle { readonly owner: Agent; dispose(): Promise<void> }
export interface PromptToAppJobOwnerPort { create(actor: PromptToAppActor, runId: string): Promise<PromptToAppJobOwnerHandle> }

export interface PromptToAppJobAccepted { readonly runId: string; readonly jobId: JobId }

export class PromptToAppJobService {
  readonly #active = new Map<string, {
    readonly actor: PromptToAppActor
    readonly jobId: JobId
    readonly owner: Agent
    readonly runId: string
  }>()
  readonly #reserved = new Set<string>()

  constructor(private readonly options: {
    readonly service: PromptToAppService
    readonly pipeline: PromptToAppPipeline
    readonly registry: PromptToAppJobRegistry
    readonly owners: PromptToAppJobOwnerPort
    readonly createId?: () => string
  }) {}

  async start(actor: PromptToAppActor, projectId: string, generator: CodeGeneratorPort): Promise<PromptToAppJobAccepted> {
    this.options.service.assertAuthorized(actor, 'project.write')
    const project = this.options.service.project(actor, projectId)
    const plan = this.options.service.plan(actor, projectId)
    if (!canStartGeneration(project.state) || plan.status !== 'APPROVED') throw new PromptToAppError('INVALID', t('errors.planRequired'))
    const key = scopeKey(actor, projectId)
    if (this.#active.has(key) || this.#reserved.has(key)) throw new PromptToAppError('REPLAY', t('errors.activeGeneration'))
    this.#reserved.add(key)
    const runId = this.options.createId?.() ?? randomUUID()
    const controller = new AbortController()
    let ownerHandle: PromptToAppJobOwnerHandle
    try { ownerHandle = await this.options.owners.create(actor, runId) } catch (error) { this.#reserved.delete(key); throw error }
    let jobId: JobId
    try {
      jobId = this.options.registry.start({
        kind: 'studio-prompt-to-app', label: 'studio-prompt-to-app', owner: ownerHandle.owner,
        run: () => {
          const done = this.options.pipeline.run(actor, projectId, generator, {
            operationId: runId, ownerSessionId: actor.sessionId ?? 'browser-session-unavailable', signal: controller.signal,
          }).then(toOutcome, error => ({ status: 'failed' as const, detail: error instanceof Error ? error.message : String(error) }))
            .finally(() => {
              this.#active.delete(key); this.#reserved.delete(key)
              const timer = setTimeout(() => { void ownerHandle.dispose().catch(() => undefined) }, 0)
              timer.unref()
            })
          return { cancel: reason => controller.abort(reason ?? t('pipeline.cancelledReason')), done }
        },
      })
    } catch (error) {
      controller.abort('job-registration-failed')
      this.#reserved.delete(key)
      await ownerHandle.dispose()
      throw error
    }
    this.#reserved.delete(key)
    this.#active.set(key, { actor, jobId, owner: ownerHandle.owner, runId })
    return { runId, jobId }
  }

  cancel(actor: PromptToAppActor, projectId: string): 'requested' | 'already-finished' {
    this.options.service.assertAuthorized(actor, 'project.write')
    this.options.service.project(actor, projectId)
    const active = this.#active.get(scopeKey(actor, projectId))
    if (active === undefined) throw new PromptToAppError('NOT_FOUND', t('errors.generationNotActive'))
    return this.options.registry.kill(active.jobId, active.owner, t('pipeline.cancelledReason'))
  }
}

function scopeKey(actor: PromptToAppActor, projectId: string): string {
  return `${actor.orgId}:${actor.tenantId}:${projectId}`
}

function toOutcome(result: PipelineResult): JobOutcome {
  if (result.state === 'VERIFIED_PROTOTYPE') return { status: 'completed', output: result.message }
  if (result.state === 'CANCELLED') return { status: 'killed', detail: result.message }
  return { status: 'failed', detail: result.message }
}
