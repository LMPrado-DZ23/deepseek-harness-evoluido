import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import {
  normalizeDelegationPath,
  type AgentProvider,
  type AgentRunRecord,
  type DelegationApproval,
  type DelegationBudget,
  type StudioAgentsRuntime,
} from '@dz23-studio/agents'
import { randomUUID } from 'node:crypto'
import type { AgentTeamRecord, AgentTeamRole, AgentTeamTaskRecord } from './model.js'
import { AGENT_TEAM_ROLES, roleToolRestriction } from './roles.js'
import { t } from './i18n.js'

export interface AgentTeamTaskInput {
  readonly taskId: string
  readonly title: string
  readonly role: AgentTeamRole
  readonly prompt: string
  readonly intendedPaths: readonly string[]
  readonly dependsOn: readonly string[]
}

export interface AgentTeamStartRequest {
  readonly orgId: string
  readonly tenantId: string
  readonly workspaceId: string
  readonly repositoryPath: string
  readonly parent: Agent
  readonly provider: AgentProvider
  readonly name: string
  readonly tasks: readonly AgentTeamTaskInput[]
  readonly approval: DelegationApproval
  readonly sensitive?: 'secrets' | 'external-network' | 'deploy'
  readonly budget?: DelegationBudget
  /**
   * O teto de tokens da EQUIPE inteira. `budget.maxTokens` é por TAREFA, e uma
   * equipe tem até oito: sem este, oito execuções cada uma dentro do combinado
   * gastam oito vezes o que a pessoa aprovou.
   */
  readonly maxTotalTokens?: number
  /**
   * A missão a que esta equipe pertence, quando pertence a alguma.
   *
   * Declarar uma missão sujeita a equipe ao teto DELA, além do próprio — e numa
   * instalação sem motor de missão a equipe é recusada, em vez de correr com um
   * teto que ninguém consegue conferir.
   */
  readonly missionId?: string
}

/**
 * O teto da MISSÃO, visto de fora do plugin de missão.
 *
 * Estrutural de propósito: `agent-team` não depende de `@dz23-studio/mission`,
 * do mesmo jeito que não depende de `storage-postgres`. Quem compõe liga os
 * dois; aqui só existe a forma.
 *
 * `MISSION_MISSING` é um veredito, e não um `undefined`. Uma equipe que aponta
 * para uma missão que sumiu NÃO pode passar a gastar sem teto: perder o
 * registro da missão é exatamente quando o teto mais importa, e devolver
 * "não sei" como se fosse "pode" é como um teto some sem ninguém desligá-lo.
 */
export type MissionBudgetVerdict =
  | { readonly kind: 'NO_LIMIT' }
  | { readonly kind: 'WITHIN'; readonly spent: number; readonly limit: number }
  | { readonly kind: 'EXCEEDED'; readonly spent: number; readonly limit: number }
  | { readonly kind: 'UNMEASURED'; readonly runId: string; readonly limit: number }
  | { readonly kind: 'MISSION_MISSING'; readonly missionId: string }

export interface MissionBudgetPort {
  /**
   * O veredito do teto desta missão agora.
   * @param missionId - a missão.
   * @returns o veredito.
   */
  verdictFor(missionId: string): MissionBudgetVerdict
  /**
   * Registra na missão uma execução que acabou de começar.
   * @param missionId - a missão.
   * @param runId - a execução.
   */
  noteRun(missionId: string, runId: string): Promise<void>
}

export interface AgentTeamRepository {
  teams(): readonly AgentTeamRecord[]
  tasks(): readonly AgentTeamTaskRecord[]
  putTeam(record: AgentTeamRecord): Promise<void>
  putTask(record: AgentTeamTaskRecord): Promise<void>
}

export interface AgentTeamSnapshot {
  readonly team: AgentTeamRecord
  readonly tasks: readonly AgentTeamTaskRecord[]
  /**
   * As etapas que NUNCA vao andar sozinhas, com o motivo.
   *
   * Vem no retrato, e nao da tela, porque a regra e desta camada: quem sabe o
   * que significa uma dependencia fantasma e quem define dependencia. O painel
   * e desacoplado de proposito (le formas estruturais, sem depender deste
   * pacote), e recalcular a regra la criaria uma segunda verdade que diverge no
   * primeiro conserto.
   *
   * Campo DERIVADO: nao entra no registro gravado nem sobe versao de dominio.
   */
  readonly blocked: readonly AgentTeamBlockedTask[]
}

export interface AgentTeamBlockedTask {
  readonly task_id: string
  readonly title: string
  readonly reason: 'MISSING_DEPENDENCY' | 'DEPENDENCY_FAILED'
  readonly dependencies: readonly string[]
}

export interface AgentTeamRestartReconciliation {
  readonly updatedTasks: number
  readonly updatedTeams: number
  readonly reconciledAt: string
}

interface ActiveTask {
  readonly jobId: JobId
  readonly owner: Agent
}

export class AgentTeamError extends Error {
  constructor(readonly code: 'APPROVAL_REQUIRED' | 'INVALID_PLAN' | 'NOT_FOUND' | 'INVALID_STATE' | 'FORBIDDEN', message: string) {
    super(message)
  }
}

const FAILURE_STATUSES = new Set<AgentTeamTaskRecord['status']>([
  'FAILED', 'CANCELLED', 'BUDGET_EXCEEDED', 'REJECTED',
  // UNKNOWN pede atencao humana: a equipe nao pode ser dada como concluida
  // enquanto uma tarefa nao tiver encerramento comprovado.
  'UNKNOWN',
])

type DerivedTeamStatus = Exclude<AgentTeamRecord['status'], 'CANCELLED'>

const STATUS_DIAGNOSTIC_KEYS: Readonly<Record<DerivedTeamStatus, string>> = {
  RUNNING: 'status.running',
  WAITING_FOR_APPROVAL: 'status.waiting',
  NEEDS_ATTENTION: 'status.attention',
  COMPLETED: 'status.completed',
}

export class StudioAgentTeamService {
  readonly #active = new Map<string, ActiveTask>()
  readonly #locks = new Map<string, Promise<void>>()

  constructor(private readonly dependencies: {
    readonly repository: AgentTeamRepository
    readonly agents: StudioAgentsRuntime
    killJob(jobId: JobId, owner: Agent, reason: string): 'requested' | 'already-finished'
    readonly now?: () => Date
    readonly createId?: () => string
    /**
     * O teto da missão, quando há composição que o forneça.
     *
     * Ausente quer dizer que esta instalação não tem motor de missão — e não
     * que a missão não tem teto. A diferença aparece em `#missionVerdict`: sem
     * a porta, uma equipe que declara `mission_id` é RECUSADA, em vez de correr
     * com um teto que ninguém consegue conferir.
     */
    readonly missions?: MissionBudgetPort
  }) {}

  teams(): readonly AgentTeamRecord[] { return this.dependencies.repository.teams() }
  tasks(): readonly AgentTeamTaskRecord[] { return this.dependencies.repository.tasks() }

  async start(request: AgentTeamStartRequest): Promise<AgentTeamSnapshot> {
    const normalized = validateRequest(request)
    const requiredTier = request.sensitive === undefined ? 'T2' as const : 'T3' as const
    assertApproval(request.approval, requiredTier)
    const teamId = this.dependencies.createId?.() ?? randomUUID()
    const timestamp = this.#now()
    const team: AgentTeamRecord = {
      team_id: teamId,
      org_id: request.orgId,
      tenant_id: request.tenantId,
      workspace_id: request.workspaceId,
      repository_path: request.repositoryPath,
      parent_session_id: String(request.parent.session.id),
      name: normalized.name,
      provider: 'spawn-in-process',
      required_tier: requiredTier,
      sensitive_operation: request.sensitive ?? null,
      status: 'RUNNING',
      approved_by: request.approval.approvedBy,
      approved_at: timestamp,
      diagnostic: t('status.running'),
      max_total_tokens: request.maxTotalTokens ?? null,
      mission_id: request.missionId ?? null,
      created_at: timestamp,
      updated_at: timestamp,
    }
    const tasks = normalized.tasks.map<AgentTeamTaskRecord>(task => ({
      task_id: task.taskId,
      team_id: teamId,
      org_id: request.orgId,
      tenant_id: request.tenantId,
      workspace_id: request.workspaceId,
      title: task.title,
      role: task.role,
      prompt: task.prompt,
      intended_paths: [...task.intendedPaths],
      depends_on: [...task.dependsOn],
      status: 'QUEUED',
      run_id: null,
      job_id: null,
      diagnostic: null,
      created_at: timestamp,
      updated_at: timestamp,
    }))
    await this.dependencies.repository.putTeam(team)
    await Promise.all(tasks.map(task => this.dependencies.repository.putTask(task)))
    return this.#exclusive(teamId, async () => {
      await this.#launchReady(team, tasks, request.parent, request.approval, request.sensitive, request.budget)
      return this.#refreshAndPersist(teamId)
    })
  }

  async status(teamId: string): Promise<AgentTeamSnapshot> {
    return this.#exclusive(teamId, () => this.#refreshAndPersist(teamId))
  }

  async continue(teamId: string, parent: Agent, approval: DelegationApproval, budget?: DelegationBudget): Promise<AgentTeamSnapshot> {
    return this.#exclusive(teamId, async () => {
      let snapshot = await this.#refreshAndPersist(teamId)
      if (snapshot.team.status === 'CANCELLED' || snapshot.team.status === 'COMPLETED') {
        throw new AgentTeamError('INVALID_STATE', t('errors.state'))
      }
      if (snapshot.team.approved_by !== approval.approvedBy) throw new AgentTeamError('FORBIDDEN', t('errors.owner'))
      assertApproval(approval, snapshot.team.required_tier)
      const sensitive = snapshot.team.sensitive_operation ?? undefined
      const ready = readyTasks(snapshot.tasks)
      if (ready.length === 0) throw new AgentTeamError('INVALID_STATE', t('errors.nothingReady'))
      await this.#launchReady(snapshot.team, snapshot.tasks, parent, approval, sensitive, budget)
      snapshot = await this.#refreshAndPersist(teamId)
      return snapshot
    })
  }

  async cancel(teamId: string, approvedBy: string, reason?: string): Promise<AgentTeamSnapshot> {
    return this.#exclusive(teamId, async () => {
      const team = this.#team(teamId)
      if (team.approved_by !== approvedBy) throw new AgentTeamError('FORBIDDEN', t('errors.owner'))
      const timestamp = this.#now()
      const tasks = this.#teamTasks(teamId)
      for (const task of tasks) {
        const key = taskKey(teamId, task.task_id)
        const active = this.#active.get(key)
        if (active !== undefined) {
          const outcome = this.dependencies.killJob(active.jobId, active.owner, reason?.trim() || t('status.cancelReason'))
          if (outcome === 'already-finished') this.#active.delete(key)
        }
        if (task.status === 'QUEUED') {
          await this.dependencies.repository.putTask({ ...task, status: 'CANCELLED', diagnostic: reason?.trim() || t('status.cancelReason'), updated_at: timestamp })
        }
      }
      const cancelled = { ...team, status: 'CANCELLED' as const, diagnostic: t('status.cancelled'), updated_at: timestamp }
      await this.dependencies.repository.putTeam(cancelled)
      const cancelledTasks = this.#teamTasks(teamId)
      return { team: cancelled, tasks: cancelledTasks, blocked: blockedSummary(cancelledTasks) }
    })
  }

  releaseJob(jobId: JobId): void {
    for (const [key, active] of this.#active) {
      if (String(active.jobId) === String(jobId)) this.#active.delete(key)
    }
  }

  activeTaskCount(): number { return this.#active.size }

  async reconcileInterruptedTeams(): Promise<AgentTeamRestartReconciliation> {
    const runs = new Map(this.dependencies.agents.runs().map(run => [run.run_id, run]))
    const interruptedTasks = this.dependencies.repository.tasks()
      .filter(task => task.status === 'RUNNING')
      .sort((left, right) => taskKey(left.team_id, left.task_id).localeCompare(taskKey(right.team_id, right.task_id)))
    if (interruptedTasks.some(task => task.run_id !== null && runs.get(task.run_id)?.status === 'RUNNING')) {
      throw new AgentTeamError('INVALID_STATE', t('errors.reconciliationIncomplete'))
    }
    const reconciledAt = this.#now()
    for (const task of interruptedTasks) {
      const run = task.run_id === null ? undefined : runs.get(task.run_id)
      const status = run === undefined ? 'FAILED' as const : taskStatus(run.status)
      await this.dependencies.repository.putTask({
        ...task,
        status,
        diagnostic: run?.diagnostic ?? (status === 'FAILED' ? t('status.processLost') : null),
        updated_at: run?.updated_at ?? reconciledAt,
      })
    }
    let updatedTeams = 0
    for (const team of this.dependencies.repository.teams()
      .filter(candidate => candidate.status !== 'CANCELLED' && candidate.status !== 'COMPLETED')
      .sort((left, right) => left.team_id.localeCompare(right.team_id))) {
      const status = deriveTeamStatus(this.#teamTasks(team.team_id))
      const diagnostic = statusDiagnostic(status)
      if (status === team.status && diagnostic === team.diagnostic) continue
      await this.dependencies.repository.putTeam({ ...team, status, diagnostic, updated_at: reconciledAt })
      updatedTeams += 1
    }
    return { updatedTasks: interruptedTasks.length, updatedTeams, reconciledAt }
  }

  async #launchReady(
    team: AgentTeamRecord,
    tasks: readonly AgentTeamTaskRecord[],
    parent: Agent,
    approval: DelegationApproval,
    sensitive: AgentTeamStartRequest['sensitive'],
    budget: DelegationBudget | undefined,
  ): Promise<void> {
    for (const task of readyTasks(tasks)) {
      // O teto e conferido A CADA tarefa, e nao uma vez antes do laco: as
      // tarefas desta leva terminam DENTRO dele, e conferir so na entrada
      // deixaria a equipe estourar o combinado sem nunca perceber.
      const spend = teamSpend(team, this.#teamTasks(team.team_id), this.dependencies.agents.runs())
      if (spend.kind !== 'NO_LIMIT' && spend.kind !== 'WITHIN') {
        const diagnostic = spend.kind === 'EXCEEDED'
          ? t('errors.teamBudgetExceeded', { spent: String(spend.spent), limit: String(spend.limit) })
          : t('errors.teamBudgetUnmeasured', { run: spend.runId })
        await this.dependencies.repository.putTask({
          ...task, status: 'BUDGET_EXCEEDED', diagnostic, updated_at: this.#now(),
        })
        continue
      }
      // E o teto da MISSAO, tambem a cada tarefa e pela mesma razao: tres
      // equipes dentro do proprio teto estouram o da missao sem que nenhuma
      // delas esteja errada.
      const missionDiagnostic = this.#missionRefusal(team)
      if (missionDiagnostic !== undefined) {
        await this.dependencies.repository.putTask({
          ...task, status: 'BUDGET_EXCEEDED', diagnostic: missionDiagnostic, updated_at: this.#now(),
        })
        continue
      }
      try {
        const accepted = this.dependencies.agents.service.start({
          orgId: team.org_id,
          tenantId: team.tenant_id,
          workspaceId: team.workspace_id,
          repositoryPath: team.repository_path,
          parent,
          provider: team.provider,
          prompt: `${t(`roles.${task.role}`)}\n\n${task.prompt}`,
          intendedPaths: task.intended_paths,
          approval,
          ...(sensitive === 'secrets' ? { touchesSecrets: true } : {}),
          ...(sensitive === 'external-network' ? { usesExternalNetwork: true } : {}),
          ...(sensitive === 'deploy' ? { touchesDeploy: true } : {}),
          ...(budget === undefined ? {} : { budget }),
          inProcess: {
            // A-06: a recusa é POR PAPEL e por NOME REAL de ferramenta. O que
            // havia aqui era `deny: ['network']` — um nome que não existe no
            // Harness, ou seja, uma recusa que não recusava nada.
            toolFilter: roleToolRestriction(task.role, sensitive === 'external-network'),
            persona: t(`roles.${task.role}`),
          },
        })
        const running: AgentTeamTaskRecord = {
          ...task,
          status: 'RUNNING',
          run_id: accepted.runId,
          job_id: String(accepted.jobId),
          diagnostic: null,
          updated_at: this.#now(),
        }
        try {
          await this.dependencies.repository.putTask(running)
          // A execucao entra na missao DEPOIS de gravada e antes de a proxima
          // tarefa conferir o teto: sem isso `missionSpend` olharia para uma
          // lista vazia e o teto da missao nunca apertaria.
          if (team.mission_id !== null && team.mission_id !== undefined && this.dependencies.missions !== undefined) {
            await this.dependencies.missions.noteRun(team.mission_id, accepted.runId)
          }
          this.#active.set(taskKey(team.team_id, task.task_id), { jobId: accepted.jobId, owner: parent })
        } catch (error) {
          this.dependencies.killJob(accepted.jobId, parent, t('errors.persistence'))
          throw error
        }
      } catch (error) {
        await this.dependencies.repository.putTask({
          ...task,
          status: 'FAILED',
          diagnostic: error instanceof Error ? error.message : String(error),
          updated_at: this.#now(),
        })
      }
    }
  }

  /**
   * A frase que impede esta equipe de gastar mais pela missão, se houver.
   * @param team - a equipe.
   * @returns a frase, ou `undefined` quando pode seguir.
   */
  #missionRefusal(team: AgentTeamRecord): string | undefined {
    const missionId = team.mission_id
    if (missionId === null || missionId === undefined) return undefined
    const port = this.dependencies.missions
    // Equipe que declara missao numa instalacao SEM motor de missao nao corre:
    // ela foi aprovada sob um teto, e aqui nao ha como conferir esse teto.
    if (port === undefined) return t('errors.missionUnavailable')
    const verdict = port.verdictFor(missionId)
    switch (verdict.kind) {
      case 'NO_LIMIT':
      case 'WITHIN': return undefined
      case 'EXCEEDED': return t('errors.missionBudgetExceeded', { spent: String(verdict.spent), limit: String(verdict.limit) })
      case 'UNMEASURED': return t('errors.missionBudgetUnmeasured', { run: verdict.runId })
      case 'MISSION_MISSING': return t('errors.missionMissing')
    }
  }

  async #refreshAndPersist(teamId: string): Promise<AgentTeamSnapshot> {
    let team = this.#team(teamId)
    const agentRuns = new Map(this.dependencies.agents.runs().map(run => [run.run_id, run]))
    for (const task of this.#teamTasks(teamId)) {
      if (task.run_id === null) continue
      const run = agentRuns.get(task.run_id)
      if (run === undefined) continue
      const status = taskStatus(run.status)
      if (status !== task.status || run.diagnostic !== task.diagnostic) {
        await this.dependencies.repository.putTask({ ...task, status, diagnostic: run.diagnostic, updated_at: run.updated_at })
      }
      if (status !== 'RUNNING') this.#active.delete(taskKey(teamId, task.task_id))
    }
    const tasks = this.#teamTasks(teamId)
    if (team.status !== 'CANCELLED') {
      const status = deriveTeamStatus(tasks)
      const diagnostic = statusDiagnostic(status)
      if (status !== team.status || diagnostic !== team.diagnostic) {
        team = { ...team, status, diagnostic, updated_at: this.#now() }
        await this.dependencies.repository.putTeam(team)
      }
    }
    return { team, tasks, blocked: blockedSummary(tasks) }
  }

  #team(teamId: string): AgentTeamRecord {
    const team = this.dependencies.repository.teams().find(candidate => candidate.team_id === teamId)
    if (team === undefined) throw new AgentTeamError('NOT_FOUND', t('errors.notFound'))
    return team
  }

  #teamTasks(teamId: string): AgentTeamTaskRecord[] {
    return this.dependencies.repository.tasks()
      .filter(task => task.team_id === teamId)
      .sort((left, right) => left.task_id.localeCompare(right.task_id))
  }

  #now(): string { return (this.dependencies.now?.() ?? new Date()).toISOString() }

  async #exclusive<T>(teamId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(teamId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => current)
    this.#locks.set(teamId, tail)
    await previous
    try {
      return await action()
    } finally {
      release()
      if (this.#locks.get(teamId) === tail) this.#locks.delete(teamId)
    }
  }
}

function validateRequest(request: AgentTeamStartRequest): { name: string; tasks: AgentTeamTaskInput[] } {
  if (request.provider !== 'spawn-in-process') throw new AgentTeamError('INVALID_PLAN', t('errors.provider'))
  if (typeof request.name !== 'string') throw new AgentTeamError('INVALID_PLAN', t('errors.teamName'))
  const name = request.name.trim()
  if (name.length < 3 || name.length > 100) throw new AgentTeamError('INVALID_PLAN', t('errors.teamName'))
  if (!Array.isArray(request.tasks) || request.tasks.length < 1 || request.tasks.length > 8) {
    throw new AgentTeamError('INVALID_PLAN', t('errors.taskCount'))
  }
  const tasks = request.tasks.map(task => {
    if (task === null || typeof task !== 'object' || Array.isArray(task)) {
      throw new AgentTeamError('INVALID_PLAN', t('errors.taskId'))
    }
    if (typeof task.taskId !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/u.test(task.taskId)) {
      throw new AgentTeamError('INVALID_PLAN', t('errors.taskId'))
    }
    if (typeof task.title !== 'string') throw new AgentTeamError('INVALID_PLAN', t('errors.taskTitle'))
    const title = task.title.trim()
    if (title.length < 3 || title.length > 120) throw new AgentTeamError('INVALID_PLAN', t('errors.taskTitle'))
    if (typeof task.prompt !== 'string') throw new AgentTeamError('INVALID_PLAN', t('errors.taskPrompt'))
    const prompt = task.prompt.trim()
    if (prompt.length < 3 || prompt.length > 20_000) throw new AgentTeamError('INVALID_PLAN', t('errors.taskPrompt'))
    if (!(AGENT_TEAM_ROLES as readonly string[]).includes(task.role)) throw new AgentTeamError('INVALID_PLAN', t('errors.taskRole'))
    if (!Array.isArray(task.intendedPaths) || task.intendedPaths.length < 1 || task.intendedPaths.length > 20
      || task.intendedPaths.some((path: unknown) => typeof path !== 'string')) {
      throw new AgentTeamError('INVALID_PLAN', t('errors.taskPaths'))
    }
    const intendedPaths = [...new Set<string>(task.intendedPaths.map((path: string) => normalizeDelegationPath(path)))]
    if (!Array.isArray(task.dependsOn) || task.dependsOn.some((id: unknown) => typeof id !== 'string')) {
      throw new AgentTeamError('INVALID_PLAN', t('errors.dependency', { task: task.taskId }))
    }
    const dependsOn = [...new Set<string>(task.dependsOn)]
    return { ...task, title, prompt, intendedPaths, dependsOn }
  })
  const ids = new Set(tasks.map(task => task.taskId))
  if (ids.size !== tasks.length) throw new AgentTeamError('INVALID_PLAN', t('errors.taskId'))
  for (const task of tasks) {
    if (task.dependsOn.some((id: string) => id === task.taskId || !ids.has(id))) {
      throw new AgentTeamError('INVALID_PLAN', t('errors.dependency', { task: task.taskId }))
    }
  }
  const ancestors = dependencyAncestors(tasks)
  for (let left = 0; left < tasks.length; left += 1) {
    for (let right = left + 1; right < tasks.length; right += 1) {
      const a = tasks[left]!
      const b = tasks[right]!
      const ordered = ancestors.get(a.taskId)!.has(b.taskId) || ancestors.get(b.taskId)!.has(a.taskId)
      if (!ordered && pathsOverlap(a.intendedPaths, b.intendedPaths)) {
        throw new AgentTeamError('INVALID_PLAN', t('errors.parallelConflict', { left: a.taskId, right: b.taskId }))
      }
    }
  }
  return { name, tasks }
}

function dependencyAncestors(tasks: readonly AgentTeamTaskInput[]): Map<string, Set<string>> {
  const byId = new Map(tasks.map(task => [task.taskId, task]))
  const result = new Map<string, Set<string>>()
  const visit = (id: string, trail: Set<string>): Set<string> => {
    const cached = result.get(id)
    if (cached !== undefined) return cached
    if (trail.has(id)) throw new AgentTeamError('INVALID_PLAN', t('errors.cycle'))
    const nextTrail = new Set(trail).add(id)
    const ancestors = new Set<string>()
    for (const dependency of byId.get(id)!.dependsOn) {
      ancestors.add(dependency)
      for (const ancestor of visit(dependency, nextTrail)) ancestors.add(ancestor)
    }
    result.set(id, ancestors)
    return ancestors
  }
  for (const task of tasks) visit(task.taskId, new Set())
  return result
}

function pathsOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some(a => right.some(b => a === '*' || b === '*' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)))
}

/**
 * Por que uma tarefa na fila ainda não rodou.
 *
 * `READY`, `WAITING` e `BLOCKED` são coisas diferentes e o código não as
 * distinguia: `depends_on.every(id => byId.get(id)?.status === 'APPLIED')` é
 * falso tanto para a dependência que ainda está rodando quanto para a
 * dependência que **não existe** ou que **falhou**. Nos três casos a tarefa
 * ficava `QUEUED` — e as consequências são opostas.
 *
 * Uma dependência fantasma nunca vai virar `APPLIED`. Uma dependência que
 * FALHOU também não, enquanto ninguém agir. As duas produziam uma tarefa que
 * espera **para sempre**, e esperar para sempre com a mesma aparência de quem
 * está só aguardando a vez é como um plano trava sem ninguém perceber.
 */
export type TaskReadiness =
  | { readonly kind: 'READY' }
  | { readonly kind: 'WAITING'; readonly pending: readonly string[] }
  | { readonly kind: 'BLOCKED'; readonly reason: 'MISSING_DEPENDENCY' | 'DEPENDENCY_FAILED'; readonly dependencies: readonly string[] }
  | { readonly kind: 'NOT_QUEUED' }

/**
 * O que a equipe já gastou, e se dá para provar.
 *
 * Três respostas, e a do meio é a que costuma faltar num orçamento:
 * `WITHIN` (cabe), `EXCEEDED` (estourou) e `UNMEASURED` (uma execução da
 * equipe terminou sem o provedor relatar consumo). `UNMEASURED` NÃO é zero:
 * tratar não-medido como nada gasto faria o teto parar de estourar por falta
 * de medição, em vez de por estar dentro do combinado — e um teto que só vale
 * quando dá para medir não é um teto, é uma esperança.
 */
export type TeamSpendVerdict =
  | { readonly kind: 'NO_LIMIT' }
  | { readonly kind: 'WITHIN'; readonly spent: number; readonly limit: number }
  | { readonly kind: 'EXCEEDED'; readonly spent: number; readonly limit: number }
  | { readonly kind: 'UNMEASURED'; readonly runId: string; readonly limit: number }

/**
 * Soma o consumo das execuções desta equipe e decide se cabe mais trabalho.
 *
 * Conta as execuções TERMINADAS: uma em curso ainda não relatou consumo, e
 * contá-la como zero seria a mesma mentira que `UNMEASURED` existe para não
 * contar. O efeito prático é que o teto é conferido ANTES de cada disparo, com
 * o que já se sabe — conferir depois só descobriria o estouro tendo gasto.
 * @param team - a equipe, com o teto que ela declarou.
 * @param tasks - as tarefas dela.
 * @param runs - as execuções conhecidas.
 * @returns o veredito.
 */
export function teamSpend(
  team: Pick<AgentTeamRecord, 'max_total_tokens'>,
  tasks: readonly AgentTeamTaskRecord[],
  runs: readonly AgentRunRecord[],
): TeamSpendVerdict {
  const limit = team.max_total_tokens
  if (limit === null || limit === undefined) return { kind: 'NO_LIMIT' }
  const mine = new Set(tasks.map(task => task.run_id).filter((id): id is string => id !== null))
  let spent = 0
  for (const run of runs) {
    if (!mine.has(run.run_id) || run.status === 'RUNNING') continue
    const used = run.tokens_used
    if (used === null || used === undefined) return { kind: 'UNMEASURED', runId: run.run_id, limit }
    spent += used
  }
  return spent >= limit ? { kind: 'EXCEEDED', spent, limit } : { kind: 'WITHIN', spent, limit }
}

/**
 * O estado de execução de UMA tarefa diante das dependências dela.
 *
 * A ordem das perguntas é a que importa: bloqueio vem antes de espera, porque
 * uma tarefa cuja dependência morreu não está esperando nada — dizer que está
 * esperando seria a mentira mais cara desta função.
 * @param task - a tarefa avaliada.
 * @param byId - todas as tarefas da equipe, por id.
 * @returns o estado, com os ids que o justificam.
 */
export function taskReadiness(task: AgentTeamTaskRecord, byId: ReadonlyMap<string, AgentTeamTaskRecord>): TaskReadiness {
  if (task.status !== 'QUEUED') return { kind: 'NOT_QUEUED' }
  const missing = task.depends_on.filter(id => !byId.has(id))
  if (missing.length > 0) return { kind: 'BLOCKED', reason: 'MISSING_DEPENDENCY', dependencies: missing }
  const failed = task.depends_on.filter(id => FAILURE_STATUSES.has(byId.get(id)!.status))
  if (failed.length > 0) return { kind: 'BLOCKED', reason: 'DEPENDENCY_FAILED', dependencies: failed }
  const pending = task.depends_on.filter(id => byId.get(id)!.status !== 'APPLIED')
  return pending.length === 0 ? { kind: 'READY' } : { kind: 'WAITING', pending }
}

/**
 * As tarefas que podem começar agora.
 * @param tasks - todas as tarefas da equipe.
 * @returns as que estão prontas, sem as bloqueadas e sem as que aguardam.
 */
function readyTasks(tasks: readonly AgentTeamTaskRecord[]): AgentTeamTaskRecord[] {
  const byId = new Map(tasks.map(task => [task.task_id, task]))
  return tasks.filter(task => taskReadiness(task, byId).kind === 'READY')
}

/**
 * O resumo do que trava a equipe, pronto para atravessar a fronteira.
 *
 * Devolve dado simples — id, título, motivo e culpados — porque quem consome é
 * a tela, e a tela não deve precisar do tipo `AgentTeamTaskRecord` para
 * entender por que um plano parou.
 * @param tasks - todas as tarefas da equipe.
 * @returns uma linha por etapa bloqueada.
 */
function blockedSummary(tasks: readonly AgentTeamTaskRecord[]): readonly AgentTeamBlockedTask[] {
  return blockedTasks(tasks).map(item => ({
    task_id: item.task.task_id,
    title: item.task.title,
    reason: item.readiness.reason,
    dependencies: item.readiness.dependencies,
  }))
}

/**
 * As tarefas que NUNCA vão rodar sem alguém agir, com o motivo.
 *
 * Existe para que o bloqueio tenha nome. Sem esta lista, a única evidência de
 * um plano travado é uma equipe que não termina.
 * @param tasks - todas as tarefas da equipe.
 * @returns cada tarefa bloqueada com o motivo e as dependências culpadas.
 */
export function blockedTasks(tasks: readonly AgentTeamTaskRecord[]): readonly { readonly task: AgentTeamTaskRecord; readonly readiness: Extract<TaskReadiness, { kind: 'BLOCKED' }> }[] {
  const byId = new Map(tasks.map(task => [task.task_id, task]))
  const blocked: { task: AgentTeamTaskRecord; readiness: Extract<TaskReadiness, { kind: 'BLOCKED' }> }[] = []
  for (const task of tasks) {
    const readiness = taskReadiness(task, byId)
    if (readiness.kind === 'BLOCKED') blocked.push({ task, readiness })
  }
  return blocked
}

function taskStatus(status: AgentRunRecord['status']): AgentTeamTaskRecord['status'] {
  if (status === 'PENDING_APPROVAL') return 'QUEUED'
  return status
}

function deriveTeamStatus(tasks: readonly AgentTeamTaskRecord[]): DerivedTeamStatus {
  if (tasks.length > 0 && tasks.every(task => task.status === 'APPLIED')) return 'COMPLETED'
  if (tasks.some(task => task.status === 'RUNNING')) return 'RUNNING'
  if (tasks.some(task => FAILURE_STATUSES.has(task.status))) return 'NEEDS_ATTENTION'
  return 'WAITING_FOR_APPROVAL'
}

function statusDiagnostic(status: DerivedTeamStatus): string {
  return t(STATUS_DIAGNOSTIC_KEYS[status]!)
}

function assertApproval(approval: DelegationApproval, tier: 'T2' | 'T3'): void {
  if (!approval.approved || approval.tier !== tier || approval.approvedBy.trim() === '') {
    throw new AgentTeamError('APPROVAL_REQUIRED', approval.tier === tier ? t('errors.approval') : t('errors.tier'))
  }
}

function taskKey(teamId: string, taskId: string): string { return `${teamId}:${taskId}` }
