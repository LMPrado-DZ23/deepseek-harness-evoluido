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
  readonly #activePaths = new Map<string, readonly string[]>()
  readonly #applyingWorkspaces = new Set<string>()

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
  }) {}

  start(request: DelegationRequest): DelegationAccepted {
    const tier = requiredTier(request)
    if (!request.approval.approved || request.approval.tier !== tier) {
      throw new DelegationError('APPROVAL_REQUIRED', tier === 'T3'
        ? 'Esta tarefa sensível precisa de confirmação reforçada antes de começar.'
        : 'Confirme antes de o assistente trabalhar numa cópia do projeto.')
    }
    if (tier === 'T3' && !this.dependencies.identity.strongIdentityVerified(request.parent.session.id)) {
      throw new DelegationError('APPROVAL_REQUIRED', 'Confirme com sua passkey antes de iniciar esta tarefa sensível.')
    }
    const paths = request.intendedPaths.map(path => normalizeDelegationPath(path))
    if (paths.length === 0) throw new DelegationError('INVALID_PATH', 'Declare ao menos um caminho que o assistente pretende alterar.')
    for (const active of this.#activePaths.values()) {
      if (pathsOverlap(active, paths)) {
        throw new DelegationError('WRITE_CONFLICT', 'Outro assistente já está trabalhando nos mesmos arquivos.')
      }
    }
    const runId = this.dependencies.createId?.() ?? randomUUID()
    this.#activePaths.set(runId, paths)
    const controller = new AbortController()
    const done = this.#execute(runId, request, paths, controller.signal)
      .finally(() => { this.#activePaths.delete(runId) })
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
      throw new DelegationError('APPROVAL_REQUIRED', 'Confirme antes de aplicar a proposta ao seu projeto.')
    }
    const record = this.dependencies.repository.runs().find(candidate => candidate.run_id === runId)
    if (record === undefined || record.status !== 'PROPOSED') {
      throw new DelegationError('INVALID_STATE', 'Esta proposta não está disponível para aplicação.')
    }
    const workspaceKey = `${record.org_id}:${record.tenant_id}:${record.workspace_id}`
    if (this.#applyingWorkspaces.has(workspaceKey)) {
      throw new DelegationError('WRITE_CONFLICT', 'Outra proposta está sendo aplicada neste espaço de trabalho.')
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
        const reason = pathViolation ? 'arquivo fora dos caminhos aprovados'
            : tokenExceeded ? 'limite de tokens excedido'
              : diff.files.length > maxFiles ? 'limite de arquivos excedido' : 'limite de bytes do diff excedido'
        return await this.#finish(runId, request, snapshot, coordinator, lease, 'BUDGET_EXCEEDED', reason, now, diff, outsideChanged)
      }
      const diagnostic = outsideChanged
        ? 'Seu projeto mudou enquanto o assistente trabalhava; confira antes de aplicar.'
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
