import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import { randomUUID } from 'node:crypto'
import { CapacityGovernorError, MemoryCapacityGovernor, type CapacityGovernor, type LeaseReference } from '@dz23-studio/runtime-governor'
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

/**
 * A pergunta que todo trabalho novo faz antes de começar.
 *
 * É uma interface estrutural, e não uma dependência do pacote de parada de
 * emergência: assim o prompt-to-app continua subindo em qualquer perfil que não
 * tenha aquele plugin, e a seta de dependência aponta em um sentido só.
 *
 * Contrato da recusa: `assertRunning` lança um `Error` com `code === 'STOPPED'`
 * e uma mensagem já escrita para uma pessoa. É por esse código que a camada
 * HTTP a distingue de uma falha interna - e por essa promessa que ela pode
 * deixar a frase atravessar.
 */
export interface EmergencyStopGuard {
  assertRunning(scope: { readonly orgId: string; readonly tenantId: string }): void
}

/** O que uma parada de emergência conseguiu pedir para parar neste escopo. */
export interface PromptToAppScopeCancellation {
  readonly requested: number
  readonly alreadyFinished: number
}

export class PromptToAppJobService {
  readonly #active = new Map<string, {
    readonly actor: PromptToAppActor
    readonly jobId: JobId
    readonly owner: Agent
    readonly runId: string
  }>()
  readonly #reserved = new Set<string>()
  readonly #governor: CapacityGovernor

  constructor(private readonly options: {
    readonly service: PromptToAppService
    readonly pipeline: PromptToAppPipeline
    readonly registry: PromptToAppJobRegistry
    readonly owners: PromptToAppJobOwnerPort
    readonly createId?: () => string
    readonly governor?: CapacityGovernor
    /** Ausente = nenhum botão de emergência montado neste perfil, e nada a perguntar. */
    readonly emergencyStop?: EmergencyStopGuard
  }) { this.#governor = options.governor ?? new MemoryCapacityGovernor() }

  async start(actor: PromptToAppActor, projectId: string, generator: CodeGeneratorPort): Promise<PromptToAppJobAccepted> {
    // Antes de qualquer reserva de capacidade e antes de qualquer dono de
    // trabalho ser criado: um escopo parado não pode nem chegar a segurar
    // recurso, senão a parada de emergência seria uma fila de espera.
    this.options.emergencyStop?.assertRunning({ orgId: actor.orgId, tenantId: actor.tenantId })
    this.options.service.assertAuthorized(actor, 'project.write')
    const project = this.options.service.project(actor, projectId)
    const plan = this.options.service.plan(actor, projectId)
    if (!canStartGeneration(project.state) || plan.status !== 'APPROVED') throw new PromptToAppError('INVALID', t('errors.planRequired'))
    const key = scopeKey(actor, projectId)
    if (this.#active.has(key) || this.#reserved.has(key)) throw new PromptToAppError('REPLAY', t('errors.activeGeneration'))
    this.#reserved.add(key)
    const runId = this.options.createId?.() ?? randomUUID()
    const controller = new AbortController()
    let lease: LeaseReference
    try {
      lease = await this.#governor.acquireBundle({
        ownerId: runId, scope: { orgId: actor.orgId, tenantId: actor.tenantId, projectId },
        requests: [{ resource: 'prompt-job' }, { resource: 'build' }],
      })
    } catch (error) {
      this.#reserved.delete(key)
      if (error instanceof CapacityGovernorError && error.code === 'CAPACITY_EXCEEDED') {
        throw new PromptToAppError('CAPACITY', t('errors.capacityExceeded'))
      }
      throw error
    }
    let ownerHandle: PromptToAppJobOwnerHandle
    try { ownerHandle = await this.options.owners.create(actor, runId) } catch (error) {
      this.#reserved.delete(key); await this.#governor.release(lease).catch(() => undefined); throw error
    }
    let jobId: JobId
    try {
      jobId = this.options.registry.start({
        kind: 'studio-prompt-to-app', label: 'studio-prompt-to-app', owner: ownerHandle.owner,
        run: () => {
          const heartbeat = setInterval(() => {
            void this.#governor.heartbeat(lease).catch(() => controller.abort('capacity-lease-lost'))
          }, 40_000)
          heartbeat.unref()
          const done = this.options.pipeline.run(actor, projectId, generator, {
            operationId: runId, ownerSessionId: actor.sessionId ?? 'browser-session-unavailable', signal: controller.signal,
          }).then(toOutcome, error => ({ status: 'failed' as const, detail: error instanceof Error ? error.message : String(error) }))
            .finally(() => {
              clearInterval(heartbeat)
              void this.#governor.release(lease).catch(() => undefined)
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
      await this.#governor.release(lease).catch(() => undefined)
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

  /**
   * Cancela TODA criação em voo de um escopo, sem passar por permissão.
   *
   * Não é uma segunda porta para o cancelamento comum: `cancel` continua sendo
   * o caminho de uma pessoa cancelando o próprio projeto, com papel conferido e
   * projeto existente. Este aqui é o braço da parada de emergência, que já
   * autorizou uma vez e agora precisa alcançar projeto por projeto - inclusive
   * os que a pessoa que apertou o botão não abriria.
   *
   * O recorte é `org_id:tenant_id`: a parada de uma organização nunca toca a
   * criação de outra.
   * @param scope - a organização e o inquilino parados.
   * @returns quantas pararam por pedido e quantas já tinham terminado.
   */
  cancelScope(scope: { readonly orgId: string; readonly tenantId: string }): PromptToAppScopeCancellation {
    let requested = 0
    let alreadyFinished = 0
    for (const active of [...this.#active.values()]) {
      if (active.actor.orgId !== scope.orgId || active.actor.tenantId !== scope.tenantId) continue
      const outcome = this.options.registry.kill(active.jobId, active.owner, t('pipeline.cancelledReason'))
      if (outcome === 'requested') requested += 1; else alreadyFinished += 1
    }
    return { requested, alreadyFinished }
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
