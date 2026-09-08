import { normalizeDelegationPath, type AgentProvider, type AgentRunRecord, type DelegationAccepted, type DelegationBudget, type DelegationRequest, type StudioAgentsRuntime } from '@dz23-studio/agents'
import type {
  AgentTeamRecord,
  AgentTeamRole,
  AgentTeamSnapshot,
  AgentTeamTaskRecord,
  StudioAgentTeamRuntime,
} from '@dz23-studio/agent-team'
import { roleAllows, type StudioRole } from '@dz23-studio/policy'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { t } from './i18n.js'
import { ASSISTANT_ALLOWED_PROVIDERS, type AssistantProvider } from './catalog.js'
import {
  approvalCode,
  approvalExcerpt,
  approvalFingerprint,
  approvalSubjectId,
  approvalSummary,
  requireTier3Approval,
  type AssistantApprovalAction,
  type AssistantApprovalPort,
} from './approval.js'

export type AssistantSensitiveOperation = 'secrets' | 'external-network'

export interface AssistantRepositoryConfig {
  readonly orgId: string
  readonly tenantId: string
  readonly workspaceId: string
  readonly repositoryPath: string
  readonly allowedPaths: readonly string[]
  readonly providers: readonly AssistantProvider[]
  readonly budget?: DelegationBudget
  readonly maxPaths?: number
}

export interface ValidatedRepositoryConfig extends Omit<AssistantRepositoryConfig, 'repositoryPath' | 'allowedPaths' | 'providers' | 'maxPaths'> {
  readonly repositoryPath: string
  readonly allowedPaths: readonly string[]
  readonly providers: ReadonlySet<AssistantProvider>
  readonly maxPaths: number
}

type AssistantAgent = DelegationRequest['parent']
type AssistantJobId = DelegationAccepted['jobId']

interface AssistantPrincipal {
  readonly userId: string
  readonly orgId: string
  readonly tenantId: string
  readonly sessionId: string
  readonly role: StudioRole
}

interface ActiveJob {
  readonly jobId: AssistantJobId
  readonly owner: AssistantAgent
  readonly userId: string
}

export interface AssistantRunSummary {
  readonly run_id: string
  readonly status: AgentRunRecord['status']
  readonly provider: AssistantProvider
  readonly changed_files: readonly string[]
  readonly diagnostic: string | null
  readonly created_at: string
  readonly updated_at: string
}

export interface AssistantRunReview extends AssistantRunSummary {
  readonly diff_text: string
  readonly main_changed_during_run: boolean
}

export interface AssistantTeamTaskInput {
  readonly taskId: string
  readonly title: string
  readonly role: AgentTeamRole
  readonly prompt: string
  readonly intendedPaths: readonly string[]
  readonly dependsOn: readonly string[]
}

export interface AssistantTeamSummary {
  readonly team_id: string
  readonly name: string
  readonly status: AgentTeamRecord['status']
  readonly required_tier: AgentTeamRecord['required_tier']
  readonly diagnostic: string | null
  readonly tasks: readonly Pick<AgentTeamTaskRecord, 'task_id' | 'title' | 'role' | 'status' | 'run_id' | 'depends_on' | 'diagnostic'>[]
  readonly created_at: string
  readonly updated_at: string
}

export class AssistantBridgeError extends Error {
  constructor(readonly code: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_CONFIGURED' | 'INVALID_REQUEST' | 'NOT_FOUND' | 'CANCEL_UNAVAILABLE', message: string) {
    super(message)
  }
}

export interface AssistantBridgeDependencies {
  resolvePrincipal(agent: AssistantAgent): Omit<AssistantPrincipal, 'role'> | undefined
  authorizationFor(userId: string, orgId: string, tenantId: string): { readonly role: StudioRole } | undefined
  readonly studioAgents: StudioAgentsRuntime
  readonly studioAgentTeams?: StudioAgentTeamRuntime
  /**
   * Autoridade de confirmação (M90-A), resolvida A CADA USO. Capturar o
   * serviço na montagem criava uma corrida silenciosa: se a autoridade
   * subisse depois deste plugin, toda operação T3 recusava com
   * NOT_CONFIGURED para sempre, sem nenhum sinal. Ausente no momento do uso,
   * a operação falha fechada - o bridge nunca se autoconcede o nível.
   */
  approvalAuthority?(): AssistantApprovalPort | undefined
  killJob(jobId: AssistantJobId, owner: AssistantAgent, reason: string): 'requested' | 'already-finished'
}

export class StudioAssistantBridge {
  readonly #repositories: readonly ValidatedRepositoryConfig[]
  readonly #jobs = new Map<string, ActiveJob>()
  readonly #runsByJob = new Map<string, string>()

  private constructor(private readonly dependencies: AssistantBridgeDependencies, repositories: readonly ValidatedRepositoryConfig[]) {
    this.#repositories = repositories
  }

  static async create(dependencies: AssistantBridgeDependencies, repositories: readonly AssistantRepositoryConfig[]): Promise<StudioAssistantBridge> {
    const validated = await Promise.all(repositories.map(validateAssistantRepository))
    const keys = new Set<string>()
    for (const repository of validated) {
      const key = scopeKey(repository)
      if (keys.has(key)) throw new AssistantBridgeError('INVALID_REQUEST', t('errors.duplicateRepository', { scope: key }))
      keys.add(key)
    }
    return new StudioAssistantBridge(dependencies, validated)
  }

  async start(agent: AssistantAgent | undefined, input: {
    readonly provider: AssistantProvider
    readonly prompt: string
    readonly intendedPaths: readonly string[]
  }, sensitive?: AssistantSensitiveOperation) {
    const principal = this.#principal(agent, 'project.write')
    const repository = this.#repository(principal)
    const prompt = input.prompt.trim()
    if (prompt.length < 3 || prompt.length > 20_000) {
      throw new AssistantBridgeError('INVALID_REQUEST', t('errors.promptLength'))
    }
    if (!isAssistantProvider(input.provider)) {
      throw new AssistantBridgeError('NOT_CONFIGURED', t('errors.externalProviderNotConfigured'))
    }
    const maxPaths = repository.maxPaths
    if (input.intendedPaths.length === 0 || input.intendedPaths.length > maxPaths) {
      throw new AssistantBridgeError('INVALID_REQUEST', t('errors.pathCount', { max: maxPaths }))
    }
    const intendedPaths = [...new Set(input.intendedPaths.map(normalizeRelativePath))]
    if (intendedPaths.some(path => !repository.allowedPaths.some(allowed => withinAllowedPath(path, allowed)))) {
      throw new AssistantBridgeError('FORBIDDEN', t('errors.pathForbidden'))
    }
    const tier = sensitive === undefined ? 'T2' as const : 'T3' as const
    const approvedBy = sensitive === undefined
      ? principal.userId
      : await this.#tier3(principal, repository, `studio.agent.start.${sensitive}`, [input.provider, prompt, ...intendedPaths], [
        sensitive === 'secrets' ? t('summary.secrets') : t('summary.network'),
        t('summary.paths', { paths: intendedPaths.join(', ') }),
        t('summary.instruction', { prompt: approvalExcerpt(prompt) }),
      ])
    const accepted = this.dependencies.studioAgents.service.start({
      orgId: principal.orgId,
      tenantId: principal.tenantId,
      workspaceId: repository.workspaceId,
      repositoryPath: repository.repositoryPath,
      parent: agent!,
      provider: input.provider,
      prompt,
      intendedPaths,
      approval: { approved: true, tier, approvedBy },
      ...(sensitive === 'secrets' ? { touchesSecrets: true } : {}),
      ...(sensitive === 'external-network' ? { usesExternalNetwork: true } : {}),
      ...(repository.budget === undefined ? {} : { budget: repository.budget }),
      ...(input.provider === 'spawn-in-process' && sensitive !== 'external-network'
        ? { inProcess: { toolFilter: { deny: ['network'] }, persona: t('runtime.persona') } }
        : {}),
    })
    this.#jobs.set(accepted.runId, { jobId: accepted.jobId, owner: agent!, userId: principal.userId })
    this.#runsByJob.set(String(accepted.jobId), accepted.runId)
    return { run_id: accepted.runId, job_id: String(accepted.jobId), status: 'RUNNING' as const, required_tier: accepted.requiredTier }
  }

  async startTeam(agent: AssistantAgent | undefined, input: {
    readonly provider: AssistantProvider
    readonly name: string
    readonly tasks: readonly AssistantTeamTaskInput[]
  }, sensitive?: AssistantSensitiveOperation | 'deploy'): Promise<AssistantTeamSummary> {
    const principal = this.#principal(agent, 'project.write')
    const repository = this.#repository(principal)
    if (!isAssistantProvider(input.provider)) {
      throw new AssistantBridgeError('NOT_CONFIGURED', t('errors.externalProviderNotConfigured'))
    }
    const tasks = input.tasks.map(task => ({
      ...task,
      intendedPaths: this.#validatedPaths(task.intendedPaths, repository),
    }))
    const teamApprovedBy = sensitive === undefined
      ? principal.userId
      : await this.#tier3(principal, repository, `studio.team.start.${sensitive}`, [
        input.provider,
        input.name,
        ...tasks.map(task => [task.taskId, task.title, task.role, task.prompt, ...task.intendedPaths].join('\u0001')),
      ], [
        sensitive === 'deploy' ? t('summary.deploy') : sensitive === 'secrets' ? t('summary.secrets') : t('summary.network'),
        t('summary.paths', { paths: [...new Set(tasks.flatMap(task => task.intendedPaths))].join(', ') }),
        t('summary.team', { name: approvalExcerpt(input.name, 60), count: tasks.length }),
      ])
    const snapshot = await this.#teamsRuntime().service.start({
      orgId: principal.orgId,
      tenantId: principal.tenantId,
      workspaceId: repository.workspaceId,
      repositoryPath: repository.repositoryPath,
      parent: agent!,
      provider: input.provider,
      name: input.name,
      tasks,
      approval: {
        approved: true,
        tier: sensitive === undefined ? 'T2' : 'T3',
        approvedBy: teamApprovedBy,
      },
      ...(sensitive === undefined ? {} : { sensitive }),
      ...(repository.budget === undefined ? {} : { budget: repository.budget }),
    })
    return this.#summarizeTeam(snapshot, principal, repository)
  }

  /**
   * Traduz uma operação sensível em confirmação humana real. O descritor é
   * derivado AQUI, no servidor: o modelo não escolhe nível, ação, sujeito nem
   * impressão digital.
   */
  async #tier3(
    principal: AssistantPrincipal,
    repository: ValidatedRepositoryConfig,
    action: AssistantApprovalAction,
    parts: readonly string[],
    /**
     * A frase que a pessoa lê antes de decidir. Sem ela o pedido carregaria só
     * o nome da categoria, e duas operações sensíveis diferentes ficariam
     * indistinguíveis na tela - confirmar viraria um carimbo.
     */
    summary: readonly string[],
  ): Promise<string> {
    const authority = this.dependencies.approvalAuthority?.()
    if (authority === undefined) {
      throw new AssistantBridgeError('NOT_CONFIGURED', t('errors.approvalNotConfigured'))
    }
    // A impressão digital do QUE foi pedido vem primeiro, das partes cruas -
    // duas instruções diferentes são sempre dois pedidos diferentes, mesmo que
    // só divirjam depois do corte da frase.
    const asked = approvalFingerprint([action, repository.workspaceId, repository.repositoryPath, ...parts])
    // A frase carrega um código curto derivado dela: sem isso, o corte em 300
    // caracteres devolvia dois cartões gêmeos na tela.
    const sentence = approvalSummary([...summary, t('summary.code', { code: approvalCode(asked) })])
    const granted = await requireTier3Approval(authority, {
      principal: {
        userId: principal.userId,
        orgId: principal.orgId,
        tenantId: principal.tenantId,
        sessionId: principal.sessionId,
      },
      action,
      subjectId: approvalSubjectId(repository.workspaceId, repository.repositoryPath),
      // A impressão digital final cobre também a frase EXIBIDA: confirmar um
      // texto e executar outro é impossível pelos dois lados.
      fingerprint: approvalFingerprint([asked, sentence]),
      summary: sentence,
    })
    return granted.approvedBy
  }

  listTeams(agent: AssistantAgent | undefined): readonly AssistantTeamSummary[] {
    const principal = this.#principal(agent, 'project.read')
    const repository = this.#repository(principal)
    const runtime = this.#teamsRuntime()
    return runtime.teams()
      .filter(team => teamBelongsToRepository(team, principal, repository))
      .map(team => this.#summarizeTeam({
        team,
        tasks: runtime.tasks().filter(task => task.team_id === team.team_id),
      }, principal, repository))
  }

  async teamStatus(agent: AssistantAgent | undefined, teamId: string): Promise<AssistantTeamSummary> {
    const principal = this.#principal(agent, 'project.read')
    const repository = this.#repository(principal)
    this.#scopedTeam(teamId, principal, repository)
    return this.#summarizeTeam(await this.#teamsRuntime().service.status(teamId), principal, repository)
  }

  async continueTeam(agent: AssistantAgent | undefined, teamId: string, sensitive: boolean): Promise<AssistantTeamSummary> {
    const principal = this.#principal(agent, 'project.write')
    const repository = this.#repository(principal)
    const team = this.#scopedTeam(teamId, principal, repository)
    const expectedTier = sensitive ? 'T3' : 'T2'
    if (team.required_tier !== expectedTier) {
      throw new AssistantBridgeError('INVALID_REQUEST', t('errors.teamTier'))
    }
    const approvedBy = sensitive
      ? await this.#tier3(principal, repository, 'studio.team.continue.sensitive', [teamId], [
        t('summary.teamContinue', { name: approvalExcerpt(team.name, 60) }),
      ])
      : principal.userId
    return this.#summarizeTeam(await this.#teamsRuntime().service.continue(teamId, agent!, {
      approved: true,
      tier: expectedTier,
      approvedBy,
    }, repository.budget), principal, repository)
  }

  async cancelTeam(agent: AssistantAgent | undefined, teamId: string, reason?: string): Promise<AssistantTeamSummary> {
    const principal = this.#principal(agent, 'project.write')
    const repository = this.#repository(principal)
    this.#scopedTeam(teamId, principal, repository)
    return this.#summarizeTeam(await this.#teamsRuntime().service.cancel(teamId, principal.userId, reason), principal, repository)
  }

  list(agent: AssistantAgent | undefined): readonly AssistantRunSummary[] {
    const principal = this.#principal(agent, 'project.read')
    const repository = this.#repository(principal)
    return this.dependencies.studioAgents.runs()
      .filter(run => runBelongsToRepository(run, principal, repository))
      .map(summarize)
  }

  async review(agent: AssistantAgent | undefined, runId: string): Promise<AssistantRunReview> {
    const principal = this.#principal(agent, 'project.read')
    const repository = this.#repository(principal)
    const run = this.#scopedRun(runId, principal, repository)
    const diff = await this.dependencies.studioAgents.service.reviewProposal(runId).catch((error: unknown) => {
      if (isErrorCode(error, 'PROPOSAL_TAMPERED')) {
        throw new AssistantBridgeError('INVALID_REQUEST', t('errors.proposalTampered'))
      }
      throw error
    })
    return { ...summarize(run), diff_text: diff.text, main_changed_during_run: run.main_changed_during_run }
  }

  /**
   * A pessoa confirma que o programa externo realmente terminou - a única
   * saída do estado UNKNOWN. Nenhuma prova técnica sustentou essa conclusão,
   * então ela exige confirmação reforçada e um motivo escrito, e os dois ficam
   * gravados no registro da execução.
   * @param agent - a sessão do assistente que está pedindo.
   * @param runId - a execução parada em UNKNOWN.
   * @param reason - o que a pessoa verificou antes de decidir.
   * @returns a execução já encerrada, como ela ficou gravada.
   */
  async resolveUnknownRun(agent: AssistantAgent | undefined, runId: string, reason: string): Promise<AssistantRunSummary> {
    const principal = this.#principal(agent, 'project.write')
    const repository = this.#repository(principal)
    const run = this.#scopedRun(runId, principal, repository)
    if (run.status !== 'UNKNOWN') throw new AssistantBridgeError('INVALID_REQUEST', t('errors.notUnknown'))
    const trimmed = reason.trim()
    if (trimmed.length < 3 || trimmed.length > 500) {
      throw new AssistantBridgeError('INVALID_REQUEST', t('errors.resolveReason'))
    }
    // A impressão digital cobre o motivo: confirmar um encerramento e gravar
    // outra justificativa seriam duas coisas diferentes.
    await this.#tier3(principal, repository, 'studio.agent.resolve-unknown', [runId, trimmed], [
      t('summary.resolveUnknown', { run: runId }),
      t('summary.reason', { reason: approvalExcerpt(trimmed) }),
    ])
    await this.dependencies.studioAgents.service.resolveUnknownRun(runId, trimmed)
    // Relido pelo MESMO caminho escopado: o resumo devolvido é o que ficou
    // gravado, não o que este método achava que ia gravar.
    return summarize(this.#scopedRun(runId, principal, repository))
  }

  cancel(agent: AssistantAgent | undefined, runId: string, reason?: string) {
    const principal = this.#principal(agent, 'project.write')
    const repository = this.#repository(principal)
    const run = this.#scopedRun(runId, principal, repository)
    if (run.approved_by !== principal.userId) throw new AssistantBridgeError('FORBIDDEN', t('errors.cancelOwner'))
    const active = this.#jobs.get(runId)
    if (active === undefined) {
      if (run.status !== 'RUNNING') {
        return { run_id: runId, outcome: 'already-finished' as const, limitation: t('runtime.cancelReconciled') }
      }
      throw new AssistantBridgeError('CANCEL_UNAVAILABLE', t('errors.cancelUnavailable'))
    }
    if (active.userId !== principal.userId) throw new AssistantBridgeError('FORBIDDEN', t('errors.cancelOwner'))
    const outcome = this.dependencies.killJob(active.jobId, active.owner, reason?.trim() || t('runtime.cancelReason'))
    if (outcome === 'already-finished') this.releaseJob(active.jobId)
    return { run_id: runId, outcome, limitation: t('runtime.cancelBeta') }
  }

  /** Called by the authoritative Harness job lifecycle; it never changes a persisted run. */
  releaseJob(jobId: AssistantJobId): void {
    const key = String(jobId)
    const runId = this.#runsByJob.get(key)
    if (runId === undefined) return
    this.#runsByJob.delete(key)
    this.#jobs.delete(runId)
  }

  /** Bounded diagnostic used by the runtime proof to detect stale cancel handles. */
  activeJobCount(): number {
    return this.#jobs.size
  }

  async apply(agent: AssistantAgent | undefined, runId: string) {
    const principal = this.#principal(agent, 'project.write')
    const repository = this.#repository(principal)
    this.#scopedRun(runId, principal, repository)
    return this.dependencies.studioAgents.service.applyProposal(runId, {
      approved: true,
      tier: 'T2',
      approvedBy: principal.userId,
    })
  }

  #principal(agent: AssistantAgent | undefined, permission: 'project.read' | 'project.write'): AssistantPrincipal {
    if (agent === undefined) throw new AssistantBridgeError('UNAUTHENTICATED', t('errors.sessionRequired'))
    if (agent.session.header.agentPreset !== 'dz23-assistant'
      || agent.session.header.origin === 'subagent'
      || (agent.session.header.delegationDepth ?? 0) > 0) {
      throw new AssistantBridgeError('FORBIDDEN', t('errors.directPresetOnly'))
    }
    const principal = this.dependencies.resolvePrincipal(agent)
    if (principal === undefined) throw new AssistantBridgeError('UNAUTHENTICATED', t('errors.identityRequired'))
    const authorization = this.dependencies.authorizationFor(principal.userId, principal.orgId, principal.tenantId)
    if (authorization === undefined || !roleAllows(authorization.role, permission)) {
      throw new AssistantBridgeError('FORBIDDEN', t('errors.roleForbidden'))
    }
    return { ...principal, role: authorization.role }
  }

  #repository(principal: AssistantPrincipal): ValidatedRepositoryConfig {
    const repository = this.#repositories.find(candidate => candidate.orgId === principal.orgId
      && candidate.tenantId === principal.tenantId && candidate.workspaceId === principal.tenantId)
    if (repository === undefined) throw new AssistantBridgeError('NOT_CONFIGURED', t('errors.repositoryMissing'))
    return repository
  }

  #scopedRun(runId: string, principal: AssistantPrincipal, repository: ValidatedRepositoryConfig): AgentRunRecord & { readonly provider: AssistantProvider } {
    const run = this.dependencies.studioAgents.runs().find(candidate => candidate.run_id === runId)
    if (run === undefined || !runBelongsToRepository(run, principal, repository)) {
      throw new AssistantBridgeError('NOT_FOUND', t('errors.runMissing'))
    }
    return run
  }

  #scopedTeam(teamId: string, principal: AssistantPrincipal, repository: ValidatedRepositoryConfig): AgentTeamRecord {
    const team = this.#teamsRuntime().teams().find(candidate => candidate.team_id === teamId)
    if (team === undefined || !teamBelongsToRepository(team, principal, repository)) {
      throw new AssistantBridgeError('NOT_FOUND', t('errors.teamMissing'))
    }
    return team
  }

  #validatedPaths(paths: readonly string[], repository: ValidatedRepositoryConfig): string[] {
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > repository.maxPaths) {
      throw new AssistantBridgeError('INVALID_REQUEST', t('errors.pathCount', { max: repository.maxPaths }))
    }
    const normalized = [...new Set(paths.map(normalizeRelativePath))]
    if (normalized.some(path => !repository.allowedPaths.some(allowed => withinAllowedPath(path, allowed)))) {
      throw new AssistantBridgeError('FORBIDDEN', t('errors.pathForbidden'))
    }
    return normalized
  }

  #summarizeTeam(snapshot: AgentTeamSnapshot, principal: AssistantPrincipal, repository: ValidatedRepositoryConfig): AssistantTeamSummary {
    if (!teamBelongsToRepository(snapshot.team, principal, repository)
      || snapshot.tasks.some(task => !taskBelongsToTeam(task, snapshot.team))) {
      throw new AssistantBridgeError('NOT_FOUND', t('errors.teamMissing'))
    }
    return summarizeTeam(snapshot)
  }

  #teamsRuntime(): StudioAgentTeamRuntime {
    if (this.dependencies.studioAgentTeams === undefined) {
      throw new AssistantBridgeError('NOT_CONFIGURED', t('errors.teamNotConfigured'))
    }
    return this.dependencies.studioAgentTeams
  }
}

export async function validateAssistantRepository(input: AssistantRepositoryConfig): Promise<ValidatedRepositoryConfig> {
  assertExactObject(input, ['orgId', 'tenantId', 'workspaceId', 'repositoryPath', 'allowedPaths', 'providers', 'budget', 'maxPaths'], 'repository')
  if (![input.orgId, input.tenantId, input.workspaceId, input.repositoryPath].every(value => typeof value === 'string')) {
    throw new AssistantBridgeError('INVALID_REQUEST', t('errors.repositoryStrings'))
  }
  if (![input.orgId, input.tenantId, input.workspaceId].every(value => /^\S+$/.test(value))) {
    throw new AssistantBridgeError('INVALID_REQUEST', t('errors.scopeRequired'))
  }
  if (input.workspaceId !== input.tenantId) {
    throw new AssistantBridgeError('INVALID_REQUEST', t('errors.workspaceConstraint'))
  }
  if (!isAbsolute(input.repositoryPath)) throw new AssistantBridgeError('INVALID_REQUEST', t('errors.absoluteRepository'))
  const repositoryPath = await realpath(resolve(input.repositoryPath))
  const info = await stat(repositoryPath)
  if (!info.isDirectory()) throw new AssistantBridgeError('INVALID_REQUEST', t('errors.repositoryDirectory'))
  await validateGitBoundary(repositoryPath)
  if (!Array.isArray(input.allowedPaths) || input.allowedPaths.some(value => typeof value !== 'string')) {
    throw new AssistantBridgeError('INVALID_REQUEST', t('errors.allowedPathsType'))
  }
  const allowedPaths = input.allowedPaths.map(normalizeRelativePath)
  if (allowedPaths.length === 0) throw new AssistantBridgeError('INVALID_REQUEST', t('errors.allowedPathsType'))
  if (new Set(allowedPaths).size !== allowedPaths.length) throw new AssistantBridgeError('INVALID_REQUEST', t('errors.duplicatePaths'))
  const validProviders: readonly AgentProvider[] = ['spawn-in-process', 'codex', 'claude-code']
  if (!Array.isArray(input.providers) || input.providers.some(provider => typeof provider !== 'string')) {
    throw new AssistantBridgeError('INVALID_REQUEST', t('errors.providersType'))
  }
  if (input.providers.some(provider => !validProviders.includes(provider))) {
    throw new AssistantBridgeError('INVALID_REQUEST', t('errors.unknownProvider'))
  }
  if (input.providers.some(provider => !isAssistantProvider(provider))) {
    throw new AssistantBridgeError('NOT_CONFIGURED', t('errors.externalProviderNotConfigured'))
  }
  const providers = new Set(input.providers as readonly AssistantProvider[])
  if (providers.size === 0) throw new AssistantBridgeError('INVALID_REQUEST', t('errors.providerRequired'))
  if (providers.size !== input.providers.length) throw new AssistantBridgeError('INVALID_REQUEST', t('errors.duplicateProviders'))
  const maxPaths = input.maxPaths ?? 20
  if (!Number.isSafeInteger(maxPaths) || maxPaths < 1 || maxPaths > 50) {
    throw new AssistantBridgeError('INVALID_REQUEST', t('errors.maxPaths'))
  }
  validateBudget(input.budget)
  return { ...input, repositoryPath, allowedPaths, providers, maxPaths }
}

export function normalizeRelativePath(value: string): string {
  return normalizeDelegationPath(value, false,
    path => new AssistantBridgeError('INVALID_REQUEST', t('errors.invalidPath', { path })))
}

function withinAllowedPath(candidate: string, allowed: string): boolean {
  return candidate === allowed || candidate.startsWith(`${allowed}/`)
}

function validateBudget(budget: DelegationBudget | undefined): void {
  if (budget === undefined) return
  assertExactObject(budget, ['timeoutMs', 'maxFiles', 'maxDiffBytes', 'maxTokens'], 'budget')
  const limits: ReadonlyArray<[keyof DelegationBudget, number]> = [
    ['timeoutMs', 60 * 60_000],
    ['maxFiles', 50],
    ['maxDiffBytes', 2 * 1024 * 1024],
    ['maxTokens', 2_000_000],
  ]
  for (const [key, maximum] of limits) {
    const value = budget[key] as number | undefined
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > maximum)) {
      throw new AssistantBridgeError('INVALID_REQUEST', t('errors.budget', { field: key, max: maximum }))
    }
  }
}

async function validateGitBoundary(repositoryPath: string): Promise<void> {
  const gitMarker = resolve(repositoryPath, '.git')
  const marker = await lstat(gitMarker).catch(() => undefined)
  if (marker === undefined || marker.isSymbolicLink()) {
    throw new AssistantBridgeError('INVALID_REQUEST', t('errors.gitRoot'))
  }
  if (marker.isDirectory()) {
    await validateGitEntries(gitMarker, gitMarker)
    return
  }
  if (!marker.isFile() || marker.size < 8 || marker.size > 4_096) {
    throw new AssistantBridgeError('INVALID_REQUEST', t('errors.gitRoot'))
  }
  const descriptor = await readFile(gitMarker, 'utf8')
  const match = /^gitdir: ([^\r\n\0]+)\r?\n?$/u.exec(descriptor)
  if (match === null) throw new AssistantBridgeError('INVALID_REQUEST', t('errors.gitRoot'))
  const adminDeclared = resolve(repositoryPath, match[1]!)
  const adminDeclaredInfo = await lstat(adminDeclared).catch(() => undefined)
  if (adminDeclaredInfo === undefined || adminDeclaredInfo.isSymbolicLink()) {
    throw new AssistantBridgeError('INVALID_REQUEST', t('errors.gitRoot'))
  }
  const adminPath = await realpath(adminDeclared)
  const admin = await lstat(adminPath)
  if (admin.isSymbolicLink() || !admin.isDirectory()) throw new AssistantBridgeError('INVALID_REQUEST', t('errors.gitRoot'))
  const commonDescriptor = await readFile(resolve(adminPath, 'commondir'), 'utf8').catch(() => '')
  if (commonDescriptor.length === 0 || commonDescriptor.length > 1_024 || /[\r\n\0]/u.test(commonDescriptor.trim())) {
    throw new AssistantBridgeError('INVALID_REQUEST', t('errors.gitRoot'))
  }
  const commonDeclared = resolve(adminPath, commonDescriptor.trim())
  const commonDeclaredInfo = await lstat(commonDeclared).catch(() => undefined)
  if (commonDeclaredInfo === undefined || commonDeclaredInfo.isSymbolicLink()) {
    throw new AssistantBridgeError('INVALID_REQUEST', t('errors.gitRoot'))
  }
  const commonPath = await realpath(commonDeclared)
  const worktreesPath = resolve(commonPath, 'worktrees')
  const worktreesInfo = await lstat(worktreesPath).catch(() => undefined)
  if (worktreesInfo === undefined || worktreesInfo.isSymbolicLink() || !worktreesInfo.isDirectory()) {
    throw new AssistantBridgeError('INVALID_REQUEST', t('errors.gitRoot'))
  }
  const canonicalWorktrees = await realpath(worktreesPath)
  if (!sameCanonicalPath(dirname(adminPath), canonicalWorktrees)) {
    throw new AssistantBridgeError('INVALID_REQUEST', t('errors.gitRoot'))
  }
  const reciprocalDescriptor = await readFile(resolve(adminPath, 'gitdir'), 'utf8').catch(() => '')
  if (reciprocalDescriptor.length === 0 || reciprocalDescriptor.length > 4_096 || /[\r\n\0]/u.test(reciprocalDescriptor.trim())) {
    throw new AssistantBridgeError('INVALID_REQUEST', t('errors.gitRoot'))
  }
  const reciprocalPath = await realpath(resolve(adminPath, reciprocalDescriptor.trim())).catch(() => undefined)
  // repositoryPath is already canonical and .git was lstat-verified as a
  // regular file, so resolving the marker again only introduced a TOCTOU gap.
  if (reciprocalPath === undefined || !sameCanonicalPath(reciprocalPath, gitMarker)) {
    throw new AssistantBridgeError('INVALID_REQUEST', t('errors.gitRoot'))
  }
  await validateGitEntries(adminPath, commonPath)
}

function sameCanonicalPath(left: string, right: string): boolean {
  return relative(resolve(left), resolve(right)) === ''
}

function isAssistantProvider(provider: AgentProvider): provider is typeof ASSISTANT_ALLOWED_PROVIDERS[number] {
  return ASSISTANT_ALLOWED_PROVIDERS.includes(provider as typeof ASSISTANT_ALLOWED_PROVIDERS[number])
}

async function validateGitEntries(adminPath: string, commonPath: string): Promise<void> {
  const head = await lstat(resolve(adminPath, 'HEAD')).catch(() => undefined)
  if (head === undefined || head.isSymbolicLink() || !head.isFile()) {
    throw new AssistantBridgeError('INVALID_REQUEST', t('errors.gitRoot'))
  }
  for (const name of ['objects', 'refs']) {
    const entry = await lstat(resolve(commonPath, name)).catch(() => undefined)
    if (entry === undefined || entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new AssistantBridgeError('INVALID_REQUEST', t('errors.gitRoot'))
    }
  }
  for (const name of ['config', 'index']) {
    const path = resolve(name === 'config' ? commonPath : adminPath, name)
    const entry = await lstat(path).catch(() => undefined)
    if (entry !== undefined && (entry.isSymbolicLink() || !entry.isFile())) {
      throw new AssistantBridgeError('INVALID_REQUEST', t('errors.gitRoot'))
    }
  }
}

function assertExactObject(value: unknown, allowedKeys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AssistantBridgeError('INVALID_REQUEST', t('errors.objectRequired', { label }))
  }
  const allowed = new Set(allowedKeys)
  const unexpected = Object.keys(value).filter(key => !allowed.has(key))
  if (unexpected.length > 0) {
    throw new AssistantBridgeError('INVALID_REQUEST', t('errors.unknownFields', { label, fields: unexpected.join(', ') }))
  }
}

function scopeKey(config: Pick<ValidatedRepositoryConfig, 'orgId' | 'tenantId' | 'workspaceId'>): string {
  return `${config.orgId}:${config.tenantId}:${config.workspaceId}`
}

function belongsTo(run: AgentRunRecord, principal: AssistantPrincipal, workspaceId: string): boolean {
  return run.org_id === principal.orgId && run.tenant_id === principal.tenantId && run.workspace_id === workspaceId
}

function summarize(run: AgentRunRecord & { readonly provider: AssistantProvider }): AssistantRunSummary {
  return {
    run_id: run.run_id,
    status: run.status,
    provider: run.provider,
    changed_files: run.changed_files,
    diagnostic: run.diagnostic,
    created_at: run.created_at,
    updated_at: run.updated_at,
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function runBelongsToRepository(
  run: AgentRunRecord,
  principal: AssistantPrincipal,
  repository: ValidatedRepositoryConfig,
): run is AgentRunRecord & { readonly provider: AssistantProvider } {
  if (!belongsTo(run, principal, repository.workspaceId)
    || !isAssistantProvider(run.provider)
    || typeof run.repository_path !== 'string'
    || !sameCanonicalPath(run.repository_path, repository.repositoryPath)
    || !Array.isArray(run.changed_files)) {
    return false
  }
  return run.changed_files.every(path => {
    if (typeof path !== 'string') return false
    try {
      const normalized = normalizeRelativePath(path)
      return normalized === path && repository.allowedPaths.some(allowed => withinAllowedPath(normalized, allowed))
    } catch {
      return false
    }
  })
}

function teamBelongsToRepository(
  team: AgentTeamRecord,
  principal: AssistantPrincipal,
  repository: ValidatedRepositoryConfig,
): boolean {
  return team.org_id === principal.orgId
    && team.tenant_id === principal.tenantId
    && team.workspace_id === repository.workspaceId
    && team.provider === 'spawn-in-process'
    && sameCanonicalPath(team.repository_path, repository.repositoryPath)
}

function taskBelongsToTeam(task: AgentTeamTaskRecord, team: AgentTeamRecord): boolean {
  return task.team_id === team.team_id
    && task.org_id === team.org_id
    && task.tenant_id === team.tenant_id
    && task.workspace_id === team.workspace_id
}

function summarizeTeam(snapshot: AgentTeamSnapshot): AssistantTeamSummary {
  return {
    team_id: snapshot.team.team_id,
    name: snapshot.team.name,
    status: snapshot.team.status,
    required_tier: snapshot.team.required_tier,
    diagnostic: snapshot.team.diagnostic,
    tasks: snapshot.tasks.map(task => ({
      task_id: task.task_id,
      title: task.title,
      role: task.role,
      status: task.status,
      run_id: task.run_id,
      depends_on: task.depends_on,
      diagnostic: task.diagnostic,
    })),
    created_at: snapshot.team.created_at,
    updated_at: snapshot.team.updated_at,
  }
}
