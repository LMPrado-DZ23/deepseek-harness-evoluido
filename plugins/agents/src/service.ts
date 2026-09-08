import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import { createHash, randomUUID } from 'node:crypto'
import type { AgentLeaseRecord, AgentRunRecord } from './model.js'
import { t } from './i18n.js'

export { GitWorktreeManager } from './git.js'

export type AgentProvider = 'spawn-in-process' | 'codex' | 'claude-code'
export type ApprovalTier = 'T2' | 'T3'

export interface DelegationApproval {
  readonly approved: boolean
  readonly tier: ApprovalTier
  readonly approvedBy: string
}

export interface DelegationBudget {
  readonly timeoutMs?: number
  readonly maxFiles?: number
  readonly maxDiffBytes?: number
  readonly maxTokens?: number
}

export interface DelegationRequest {
  readonly orgId: string
  readonly tenantId: string
  readonly workspaceId: string
  readonly repositoryPath: string
  readonly parent: Agent
  readonly provider: AgentProvider
  readonly prompt: string
  readonly intendedPaths: readonly string[]
  readonly approval: DelegationApproval
  readonly touchesDeploy?: boolean
  readonly touchesSecrets?: boolean
  readonly usesExternalNetwork?: boolean
  readonly budget?: DelegationBudget
  readonly inProcess?: {
    readonly toolFilter?: unknown
    readonly persona?: string
  }
}

export interface WorktreeSnapshot {
  readonly repositoryPath: string
  readonly worktreePath: string
  readonly baseCommit: string
  readonly mainFingerprint: string
}

export interface WorktreeDiff {
  readonly text: string
  readonly bytes: number
  readonly files: readonly string[]
}

export interface WorktreePort {
  create(repositoryPath: string, runId: string): Promise<WorktreeSnapshot>
  diff(snapshot: WorktreeSnapshot): Promise<WorktreeDiff>
  mainFingerprint(repositoryPath: string): Promise<string>
  applyProposal(record: AgentRunRecord): Promise<void>
}

export interface CoordinatorHandle {
  readonly sessionId: SessionId
  readonly agent: Agent
  dispose(): Promise<void>
}

export interface CoordinatorPort {
  create(cwd: string, parentSessionId: SessionId, provider: AgentProvider, approvedTier: ApprovalTier): Promise<CoordinatorHandle>
}

export interface SubagentPort {
  start(provider: AgentProvider, request: {
    readonly parent: Agent
    readonly prompt: ContentBlock[]
    readonly signal: AbortSignal
    readonly inProcess?: DelegationRequest['inProcess']
  }): Promise<SubagentRun>
}

export interface UsagePort {
  tokensFor(run: SubagentRun): number | undefined
}

export interface StrongIdentityPort {
  strongIdentityVerified(parentSessionId: SessionId): boolean
}

export interface AgentRepository {
  runs(): readonly AgentRunRecord[]
  leases(): readonly AgentLeaseRecord[]
  putRun(record: AgentRunRecord): Promise<void>
  putLease(record: AgentLeaseRecord): Promise<void>
}

export interface JobPort {
  hasLiveJobs(): boolean
  start(spec: {
    readonly kind: 'studio-agent'
    readonly label: string
    readonly owner: Agent
    run(): { cancel(reason?: string): void; done: Promise<JobOutcome> }
  }): JobId
}

export interface DelegationAccepted {
  readonly runId: string
  readonly jobId: JobId
  readonly requiredTier: ApprovalTier
}

export interface ProposalApplied {
  readonly runId: string
  readonly status: 'APPLIED'
  readonly changedFiles: readonly string[]
}

export interface AgentRestartReconciliation {
  readonly interruptedRuns: number
  readonly releasedLeases: number
  /**
   * Execucoes cujo trabalhador externo nao pode ser provado morto. Elas NAO
   * viram falha e a reserva de arquivos delas NAO e liberada.
   */
  readonly unresolvedRuns: number
  readonly keptLeases: number
  readonly reconciledAt: string
}

/**
 * Prazo para o encerramento ativo. O que continuar vivo depois disso nao e
 * declarado morto: fica para a reconciliacao do proximo inicio.
 */
export const SHUTDOWN_DEADLINE_MS = 15_000

/**
 * `spawn-in-process` morre junto com o Studio, entao um reinicio ja e prova de
 * que terminou. `codex` e `claude-code` sao processos do sistema operacional
 * com vida propria: o pin do Harness nao entrega identidade de processo pelo
 * seam publico, entao o Studio NAO consegue provar que eles morreram - e nao
 * vai fingir que consegue.
 */
export function survivesRestart(provider: AgentProvider): boolean {
  return provider !== 'spawn-in-process'
}

export class DelegationError extends Error {
  constructor(readonly code: 'APPROVAL_REQUIRED' | 'WRITE_CONFLICT' | 'INVALID_PATH' | 'INVALID_STATE' | 'PROPOSAL_TAMPERED' | 'WORKTREE_TAMPERED', message: string) {
    super(message)
  }
}

const DEFAULT_TIMEOUT_MS = 20 * 60_000
const MAX_TIMEOUT_MS = 60 * 60_000
const DEFAULT_MAX_FILES = 50
const DEFAULT_MAX_DIFF_BYTES = 2 * 1024 * 1024

function requiredTier(request: DelegationRequest): ApprovalTier {
  return request.touchesDeploy || request.touchesSecrets || request.usesExternalNetwork ? 'T3' : 'T2'
}

export function normalizeDelegationPath(
  value: string,
  allowWildcard = true,
  invalid: (path: string) => Error = path => new DelegationError('INVALID_PATH', t('delegation.invalidPath', { path })),
): string {
  if (value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw invalid(value)
  }
  const normalized = value.replaceAll('\\', '/')
  if (allowWildcard && normalized === '*') return '*'
  if (normalized === '' || normalized === '*' || normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) {
    throw invalid(value)
  }
  const segments = normalized.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw invalid(value)
  }
  return normalized
}

function pathsOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some(a => right.some(b => a === '*' || b === '*' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)))
}

function terminalText(result: SubagentResult): string {
  return result.output.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
}

export class StudioAgentService {
  readonly #activePaths = new Map<string, { readonly workspaceId: string; readonly repositoryPath: string; readonly paths: readonly string[] }>()
  readonly #inFlight = new Map<string, { cancel(reason: string): void; readonly done: Promise<JobOutcome> }>()
  readonly #applyingWorkspaces = new Set<string>()
  #ready: boolean
  #reconciliation: Promise<AgentRestartReconciliation> | undefined

  constructor(private readonly dependencies: {
    readonly repository: AgentRepository
    readonly worktrees: WorktreePort
    readonly coordinators: CoordinatorPort
    readonly subagents: SubagentPort
    readonly identity: StrongIdentityPort
    readonly usage?: UsagePort
    readonly jobs: JobPort
    readonly now?: () => Date
    readonly createId?: () => string
  }) {
    this.#ready = !this.#hasPersistedWork() && !dependencies.jobs.hasLiveJobs()
  }

  reconcileInterruptedRuns(): Promise<AgentRestartReconciliation> {
    if (this.#reconciliation !== undefined) return this.#reconciliation
    const reconciliation = this.#performRestartReconciliation()
    this.#reconciliation = reconciliation
    void reconciliation.finally(() => {
      this.#reconciliation = undefined
    }).catch(() => undefined)
    return reconciliation
  }

  start(request: DelegationRequest): DelegationAccepted {
    if (!this.#ready) {
      throw new DelegationError('INVALID_STATE', t('recovery.required'))
    }
    const tier = requiredTier(request)
    if (!request.approval.approved || request.approval.tier !== tier) {
      throw new DelegationError('APPROVAL_REQUIRED', tier === 'T3'
        ? t('delegation.sensitiveNeedsStrongConfirmation')
        : t('delegation.confirmBeforeIsolatedCopy'))
    }
    if (tier === 'T3' && !this.dependencies.identity.strongIdentityVerified(request.parent.session.id)) {
      throw new DelegationError('APPROVAL_REQUIRED', t('delegation.confirmWithPasskey'))
    }
    const paths = request.intendedPaths.map(path => normalizeDelegationPath(path))
    if (paths.length === 0) throw new DelegationError('INVALID_PATH', 'Declare ao menos um caminho que o assistente pretende alterar.')
    // O conflito é do espaço de trabalho e do repositório. Sem esse recorte,
    // duas organizações diferentes que por acaso editam `src` bloqueariam uma
    // à outra - e cada uma saberia que a outra está trabalhando ali.
    for (const active of this.#activePaths.values()) {
      if (active.workspaceId !== request.workspaceId || active.repositoryPath !== request.repositoryPath) continue
      if (pathsOverlap(active.paths, paths)) {
        throw new DelegationError('WRITE_CONFLICT', t('delegation.filesAlreadyLeased'))
      }
    }
    // A reserva durável também vale. Sem esta checagem, uma reserva preservada
    // por uma execução em estado desconhecido não protegeria nada: bastaria
    // reiniciar o Studio para que a memória esquecesse o conflito.
    for (const lease of this.dependencies.repository.leases()) {
      if (!lease.active) continue
      if (lease.workspace_id !== request.workspaceId || lease.repository_path !== request.repositoryPath) continue
      if (pathsOverlap(lease.paths, paths)) {
        throw new DelegationError('WRITE_CONFLICT', t('recovery.blockedByUnknown'))
      }
    }
    const runId = this.dependencies.createId?.() ?? randomUUID()
    this.#activePaths.set(runId, { workspaceId: request.workspaceId, repositoryPath: request.repositoryPath, paths })
    const controller = new AbortController()
    const done = this.#execute(runId, request, paths, controller.signal)
      .finally(() => { this.#activePaths.delete(runId); this.#inFlight.delete(runId) })
    this.#inFlight.set(runId, { cancel: reason => { controller.abort(reason) }, done })
    try {
      const jobId = this.dependencies.jobs.start({
        kind: 'studio-agent',
        label: `Assistente ${request.provider}: ${request.prompt.slice(0, 80)}`,
        owner: request.parent,
        run: () => ({
          cancel: reason => controller.abort(reason ?? 'cancelled-by-user'),
          done,
        }),
      })
      return { runId, jobId, requiredTier: tier }
    } catch (error) {
      controller.abort('job-registration-failed')
      this.#activePaths.delete(runId)
      throw error
    }
  }

  /** Recompute and verify a proposal without applying it or persisting its body. */
  async reviewProposal(runId: string): Promise<WorktreeDiff> {
    const record = this.dependencies.repository.runs().find(candidate => candidate.run_id === runId)
    if (record === undefined || record.status !== 'PROPOSED') {
      throw new DelegationError('INVALID_STATE', 'Somente uma proposta pendente pode ser revisada.')
    }
    const snapshot: WorktreeSnapshot = {
      repositoryPath: record.repository_path,
      worktreePath: record.worktree_path,
      baseCommit: record.base_commit,
      mainFingerprint: '',
    }
    const current = await this.dependencies.worktrees.diff(snapshot)
    const currentHash = createHash('sha256').update(current.text).digest('hex')
    if (currentHash !== record.diff_sha256
      || current.bytes !== record.diff_bytes
      || JSON.stringify([...current.files].sort()) !== JSON.stringify([...record.changed_files].sort())) {
      throw new DelegationError('PROPOSAL_TAMPERED', 'PROPOSAL_TAMPERED')
    }
    return current
  }

  async applyProposal(runId: string, approval: DelegationApproval): Promise<ProposalApplied> {
    if (!approval.approved || approval.tier !== 'T2') {
      throw new DelegationError('APPROVAL_REQUIRED', t('delegation.confirmBeforeApply'))
    }
    const record = this.dependencies.repository.runs().find(candidate => candidate.run_id === runId)
    if (record === undefined || record.status !== 'PROPOSED') {
      throw new DelegationError('INVALID_STATE', t('delegation.proposalNotApplicable'))
    }
    const workspaceKey = `${record.org_id}:${record.tenant_id}:${record.workspace_id}`
    if (this.#applyingWorkspaces.has(workspaceKey)) {
      throw new DelegationError('WRITE_CONFLICT', t('delegation.anotherProposalApplying'))
    }
    this.#applyingWorkspaces.add(workspaceKey)
    try {
      await this.dependencies.worktrees.applyProposal(record)
      const updatedAt = (this.dependencies.now?.() ?? new Date()).toISOString()
      await this.dependencies.repository.putRun({ ...record, status: 'APPLIED', diagnostic: null, updated_at: updatedAt })
      return { runId, status: 'APPLIED', changedFiles: record.changed_files }
    } finally {
      this.#applyingWorkspaces.delete(workspaceKey)
    }
  }

  async #performRestartReconciliation(): Promise<AgentRestartReconciliation> {
    this.#ready = false
    if (this.dependencies.jobs.hasLiveJobs()) {
      throw new DelegationError('INVALID_STATE', t('recovery.liveJobs'))
    }
    const interrupted = this.dependencies.repository.runs()
      .filter(run => run.status === 'RUNNING')
      .sort((left, right) => left.run_id.localeCompare(right.run_id))
    if (this.dependencies.jobs.hasLiveJobs()) {
      throw new DelegationError('INVALID_STATE', t('recovery.liveJobs'))
    }
    const reconciledAt = (this.dependencies.now?.() ?? new Date()).toISOString()
    const unresolved = new Set<string>()
    for (const run of interrupted) {
      const provable = !survivesRestart(run.provider)
      if (!provable) unresolved.add(run.run_id)
      await this.dependencies.repository.putRun({
        ...run,
        status: provable ? 'FAILED' : 'UNKNOWN',
        diagnostic: provable ? t('recovery.interrupted') : t('recovery.unknownExternal'),
        updated_at: reconciledAt,
      })
    }
    // A reserva de arquivos so e liberada quando ha prova de encerramento. Sem
    // prova ela FICA: liberar aqui seria abrir caminho para dois processos
    // escrevendo no mesmo lugar, com o registro dizendo que o primeiro falhou.
    let released = 0
    let kept = 0
    for (const lease of this.dependencies.repository.leases()
      .filter(item => item.active)
      .sort((left, right) => left.lease_id.localeCompare(right.lease_id))) {
      if (unresolved.has(lease.run_id)) { kept += 1; continue }
      released += 1
      await this.dependencies.repository.putLease({ ...lease, active: false, released_at: reconciledAt })
    }
    if (this.#hasPersistedWork() || this.dependencies.jobs.hasLiveJobs()) {
      throw new DelegationError('INVALID_STATE', t('recovery.incomplete'))
    }
    this.#ready = true
    return {
      interruptedRuns: interrupted.length - unresolved.size,
      releasedLeases: released,
      unresolvedRuns: unresolved.size,
      keptLeases: kept,
      reconciledAt,
    }
  }

  /**
   * Uma pessoa confirma que o programa externo terminou. E a unica saida do
   * estado UNKNOWN, e exige motivo: o registro precisa dizer quem decidiu e
   * por que, porque nenhuma prova tecnica sustentou essa conclusao.
   */
  async resolveUnknownRun(runId: string, reason: string): Promise<void> {
    const trimmed = reason.trim()
    if (trimmed === '') throw new DelegationError('INVALID_STATE', t('recovery.resolveReason'))
    const run = this.dependencies.repository.runs().find(candidate => candidate.run_id === runId)
    if (run === undefined || run.status !== 'UNKNOWN') {
      throw new DelegationError('INVALID_STATE', t('recovery.resolveNotUnknown'))
    }
    const now = (this.dependencies.now?.() ?? new Date()).toISOString()
    await this.dependencies.repository.putRun({
      ...run, status: 'FAILED', diagnostic: `${t('recovery.resolved')}${trimmed}`, updated_at: now,
    })
    for (const lease of this.dependencies.repository.leases().filter(item => item.active && item.run_id === runId)) {
      await this.dependencies.repository.putLease({ ...lease, active: false, released_at: now })
    }
  }

  /**
   * Encerramento ativo com prazo. Pede cancelamento a tudo que esta em voo e
   * espera ate `SHUTDOWN_DEADLINE_MS`. O que sobreviver ao prazo NAO e
   * declarado morto - fica para a reconciliacao do proximo inicio.
   */
  async shutdown(deadlineMs = SHUTDOWN_DEADLINE_MS): Promise<{ readonly stopped: number; readonly pending: number }> {
    const inFlight = [...this.#inFlight.entries()]
    for (const [, entry] of inFlight) entry.cancel('shutdown')
    let stopped = 0
    await Promise.all(inFlight.map(async ([runId, entry]) => {
      const finished = await Promise.race([
        /* v8 ignore start -- o braço de rejeição não é alcançável hoje (#execute sempre resolve); existe para que uma rejeição futura não vire unhandled rejection nem prenda o encerramento até o prazo. */
        entry.done.then(() => true, () => true),
        /* v8 ignore stop */
        new Promise<false>(resolve => { setTimeout(() => { resolve(false) }, deadlineMs).unref?.() }),
      ])
      if (finished) { stopped += 1; this.#inFlight.delete(runId) }
    }))
    return { stopped, pending: inFlight.length - stopped }
  }

  #hasPersistedWork(): boolean {
    if (this.dependencies.repository.runs().some(run => run.status === 'RUNNING')) return true
    const active = this.dependencies.repository.leases().filter(lease => lease.active)
    if (active.length === 0) return false
    // O conjunto é construído UMA vez. Dentro do predicado, ele seria
    // reconstruído sobre todas as execuções a cada reserva ativa.
    const unknown = this.#unknownRunIds()
    return active.some(lease => !unknown.has(lease.run_id))
  }

  #unknownRunIds(): ReadonlySet<string> {
    return new Set(this.dependencies.repository.runs()
      .filter(run => run.status === 'UNKNOWN')
      .map(run => run.run_id))
  }

  async #execute(
    runId: string,
    request: DelegationRequest,
    paths: readonly string[],
    signal: AbortSignal,
  ): Promise<JobOutcome> {
    const now = this.dependencies.now ?? (() => new Date())
    const timeoutMs = Math.min(request.budget?.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const maxFiles = request.budget?.maxFiles ?? DEFAULT_MAX_FILES
    const maxDiffBytes = request.budget?.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES
    const parentSessionId = request.parent.session.id
    let snapshot: WorktreeSnapshot | undefined
    let coordinator: CoordinatorHandle | undefined
    let child: SubagentRun | undefined
    let timeout: NodeJS.Timeout | undefined
    const timed = new AbortController()
    const forwardAbort = () => timed.abort(signal.reason)
    signal.addEventListener('abort', forwardAbort, { once: true })
    timeout = setTimeout(() => timed.abort('timeout'), timeoutMs)
    const createdAt = now().toISOString()
    try {
      snapshot = await this.dependencies.worktrees.create(request.repositoryPath, runId)
      coordinator = await this.dependencies.coordinators.create(snapshot.worktreePath, parentSessionId, request.provider, requiredTier(request))
      const lease: AgentLeaseRecord = {
        lease_id: `lease-${runId}`, run_id: runId,
        org_id: request.orgId, tenant_id: request.tenantId, workspace_id: request.workspaceId,
        repository_path: snapshot.repositoryPath, paths: [...paths], active: true,
        created_at: createdAt, released_at: null,
      }
      await this.dependencies.repository.putLease(lease)
      await this.dependencies.repository.putRun({
        run_id: runId, org_id: request.orgId, tenant_id: request.tenantId,
        workspace_id: request.workspaceId, parent_session_id: String(parentSessionId),
        coordinator_session_id: String(coordinator.sessionId), provider: request.provider,
        worktree_path: snapshot.worktreePath, repository_path: snapshot.repositoryPath, base_commit: snapshot.baseCommit,
        status: 'RUNNING', changed_files: [], diff_bytes: 0, diff_sha256: createHash('sha256').update('').digest('hex'), diagnostic: null,
        main_changed_during_run: false, approved_by: request.approval.approvedBy, approved_at: createdAt,
        created_at: createdAt, updated_at: createdAt,
      })
      child = await this.dependencies.subagents.start(request.provider, {
        parent: coordinator.agent,
        prompt: [{ type: 'text', text: request.prompt }],
        signal: timed.signal,
        ...(request.provider === 'spawn-in-process' && request.inProcess !== undefined
          ? { inProcess: request.inProcess }
          : {}),
      })
      const result = await child.result
      if (timed.signal.aborted) {
        const timedOut = timed.signal.reason === 'timeout'
        return await this.#finish(runId, request, snapshot, coordinator, lease,
          timedOut ? 'BUDGET_EXCEEDED' : 'CANCELLED', String(timed.signal.reason), now)
      }
      if (result.stopReason !== 'completed') {
        return await this.#finish(runId, request, snapshot, coordinator, lease, 'FAILED', result.diagnostic ?? result.stopReason, now)
      }
      const diff = await this.dependencies.worktrees.diff(snapshot)
      const mainAfter = await this.dependencies.worktrees.mainFingerprint(snapshot.repositoryPath)
      const outsideChanged = mainAfter !== snapshot.mainFingerprint
      const pathViolation = diff.files.some(file => !pathsOverlap(paths, [file]))
      const measuredTokens = this.dependencies.usage?.tokensFor(child)
      const tokenExceeded = request.budget?.maxTokens !== undefined
        && measuredTokens !== undefined && measuredTokens > request.budget.maxTokens
      if (pathViolation || diff.files.length > maxFiles || diff.bytes > maxDiffBytes || tokenExceeded) {
        const reason = pathViolation ? t('delegation.pathOutsideApproved')
            : tokenExceeded ? 'limite de tokens excedido'
              : diff.files.length > maxFiles ? 'limite de arquivos excedido' : 'limite de bytes do diff excedido'
        return await this.#finish(runId, request, snapshot, coordinator, lease, 'BUDGET_EXCEEDED', reason, now, diff, outsideChanged)
      }
      const diagnostic = outsideChanged
        ? t('delegation.projectChangedDuringRun')
        : terminalText(result)
      return await this.#finish(runId, request, snapshot, coordinator, lease, 'PROPOSED', diagnostic, now, diff, outsideChanged)
    } catch (error) {
      if (snapshot === undefined || coordinator === undefined) {
        return { status: signal.aborted || timed.signal.aborted ? 'killed' : 'failed', detail: String(error) }
      }
      const lease = this.dependencies.repository.leases().find(item => item.run_id === runId)
      if (lease === undefined) return { status: 'failed', detail: String(error) }
      const timedOut = timed.signal.reason === 'timeout'
      return this.#finish(runId, request, snapshot, coordinator, lease,
        timedOut ? 'BUDGET_EXCEEDED' : signal.aborted || timed.signal.aborted ? 'CANCELLED' : 'FAILED', String(error), now)
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', forwardAbort)
      await child?.dispose().catch(() => undefined)
      await coordinator?.dispose().catch(() => undefined)
    }
  }

  async #finish(
    runId: string,
    request: DelegationRequest,
    snapshot: WorktreeSnapshot,
    coordinator: CoordinatorHandle,
    lease: AgentLeaseRecord,
    status: AgentRunRecord['status'],
    diagnostic: string,
    now: () => Date,
    diff: WorktreeDiff = { text: '', bytes: 0, files: [] },
    mainChangedDuringRun = false,
  ): Promise<JobOutcome> {
    const updatedAt = now().toISOString()
    await this.dependencies.repository.putRun({
      run_id: runId, org_id: request.orgId, tenant_id: request.tenantId,
      workspace_id: request.workspaceId, parent_session_id: String(request.parent.session.id),
      coordinator_session_id: String(coordinator.sessionId), provider: request.provider,
      worktree_path: snapshot.worktreePath, repository_path: snapshot.repositoryPath, base_commit: snapshot.baseCommit,
      status, changed_files: [...diff.files], diff_bytes: diff.bytes,
      diff_sha256: createHash('sha256').update(diff.text).digest('hex'), diagnostic,
      main_changed_during_run: mainChangedDuringRun,
      approved_by: request.approval.approvedBy,
      approved_at: this.dependencies.repository.runs().find(record => record.run_id === runId)?.approved_at ?? updatedAt,
      created_at: this.dependencies.repository.runs().find(record => record.run_id === runId)?.created_at ?? updatedAt,
      updated_at: updatedAt,
    })
    await this.dependencies.repository.putLease({ ...lease, active: false, released_at: updatedAt })
    if (status === 'PROPOSED') return { status: 'completed', output: diff.text }
    if (status === 'CANCELLED') return { status: 'killed', detail: diagnostic }
    return { status: 'failed', detail: diagnostic }
  }
}
