import { randomUUID } from 'node:crypto'
import { roleAllows, type StudioRole } from '@dz23-studio/policy'
import { appSpecHash, type AppSpecV1 } from './appspec.js'
import { createDesignSpec, designSpecHash, designSpecV1Schema, type DesignLogo, type DesignSelection, type DesignSpecV1 } from './design.js'
import type {
  PromptToAppKey, ProjectState, StudioApproval, StudioAppSpecRecord, StudioEvidence,
  StudioDesignSpecRecord, StudioIntakeTurn, StudioPlan, StudioProject, StudioRun,
} from './model.js'
import { assertProjectTransition } from './state.js'
import { t } from './i18n.js'

export interface PromptToAppActor {
  readonly userId: string
  readonly orgId: string
  readonly tenantId: string
  readonly role: StudioRole
  readonly sessionId?: string
}

export interface PromptToAppRepository {
  projects(): readonly StudioProject[]
  putProject(value: StudioProject): Promise<void>
  specs(): readonly StudioAppSpecRecord[]
  putSpec(value: StudioAppSpecRecord): Promise<void>
  designs(): readonly StudioDesignSpecRecord[]
  putDesign(value: StudioDesignSpecRecord): Promise<void>
  turns(): readonly StudioIntakeTurn[]
  putTurn(value: StudioIntakeTurn): Promise<void>
  plans(): readonly StudioPlan[]
  putPlan(value: StudioPlan): Promise<void>
  runs(): readonly StudioRun[]
  putRun(value: StudioRun): Promise<void>
  evidence(): readonly StudioEvidence[]
  putEvidence(value: StudioEvidence): Promise<void>
  approvals(): readonly StudioApproval[]
  putApproval(value: StudioApproval): Promise<void>
}

export class PromptToAppError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'INVALID' | 'REPLAY', message: string) { super(message) }
}

export interface PromptToAppServiceOptions {
  readonly repository: PromptToAppRepository
  readonly now?: () => Date
  readonly createId?: () => string
}

export class PromptToAppService {
  readonly #repository: PromptToAppRepository
  readonly #now: () => Date
  readonly #createId: () => string
  constructor(options: PromptToAppServiceOptions) {
    this.#repository = options.repository
    this.#now = options.now ?? (() => new Date())
    this.#createId = options.createId ?? randomUUID
  }

  assertAuthorized(actor: PromptToAppActor, permission: 'project.read' | 'project.write'): void {
    this.#authorize(actor, permission)
  }

  listProjects(actor: PromptToAppActor): readonly StudioProject[] {
    this.#authorize(actor, 'project.read')
    return this.#repository.projects().filter(value => this.#sameScope(actor, value) && value.archived_at === null)
  }

  project(actor: PromptToAppActor, projectId: string): StudioProject {
    this.#authorize(actor, 'project.read')
    const value = this.#repository.projects().find(candidate => candidate.project_id === projectId && this.#sameScope(actor, candidate))
    if (value === undefined) throw new PromptToAppError('NOT_FOUND', t('errors.notFound'))
    return value
  }

  async createProject(actor: PromptToAppActor, input: Pick<StudioProject, 'name' | 'original_brief' | 'category' | 'privacy'>): Promise<StudioProject> {
    this.#authorize(actor, 'project.write')
    const now = this.#now().toISOString()
    const value: StudioProject = {
      project_id: this.#createId(), org_id: actor.orgId, tenant_id: actor.tenantId,
      ...input, state: 'DRAFT', created_by: actor.userId, created_at: now, updated_at: now, archived_at: null,
    }
    await this.#repository.putProject(value)
    return value
  }

  intakeTurns(actor: PromptToAppActor, projectId: string): readonly StudioIntakeTurn[] {
    this.project(actor, projectId)
    return this.#repository.turns().filter(value => value.project_id === projectId && this.#sameScope(actor, value))
  }

  async recordTurn(actor: PromptToAppActor, projectId: string, input: Pick<StudioIntakeTurn, 'question_id' | 'question' | 'answer' | 'recommended' | 'route' | 'model'>): Promise<StudioIntakeTurn> {
    this.#authorize(actor, 'project.write'); this.project(actor, projectId)
    const value: StudioIntakeTurn = {
      turn_id: this.#createId(), project_id: projectId, org_id: actor.orgId, tenant_id: actor.tenantId,
      ...input, created_at: this.#now().toISOString(),
    }
    await this.#repository.putTurn(value); return value
  }

  async saveSpec(actor: PromptToAppActor, projectId: string, spec: AppSpecV1, origin: 'intake' | 'edit'): Promise<StudioAppSpecRecord> {
    this.#authorize(actor, 'project.write'); this.project(actor, projectId)
    const previous = this.#repository.specs().filter(value => value.project_id === projectId && this.#sameScope(actor, value))
    const value: StudioAppSpecRecord = {
      spec_id: this.#createId(), project_id: projectId, org_id: actor.orgId, tenant_id: actor.tenantId,
      version: previous.length + 1, app_spec: spec, sha256: appSpecHash(spec), origin, created_at: this.#now().toISOString(),
    }
    await this.#repository.putSpec(value)
    const project = this.project(actor, projectId)
    if (project.state === 'DRAFT') await this.transition(actor, projectId, 'SPEC_READY')
    return value
  }

  latestSpec(actor: PromptToAppActor, projectId: string): StudioAppSpecRecord {
    this.project(actor, projectId)
    const value = this.#repository.specs().filter(candidate => candidate.project_id === projectId && this.#sameScope(actor, candidate))
      .sort((left, right) => right.version - left.version)[0]
    if (value === undefined) throw new PromptToAppError('NOT_FOUND', t('errors.specNotFound'))
    return value
  }

  async saveDesign(actor: PromptToAppActor, projectId: string, input: DesignSelection): Promise<StudioDesignSpecRecord> {
    return this.#saveDesign(actor, projectId, createDesignSpec(input))
  }

  async attachLogo(actor: PromptToAppActor, projectId: string, logo: DesignLogo): Promise<StudioDesignSpecRecord> {
    const current = this.designOrDefault(actor, projectId)
    return this.#saveDesign(actor, projectId, designSpecV1Schema.parse({ ...current, logo }))
  }

  latestDesign(actor: PromptToAppActor, projectId: string): StudioDesignSpecRecord {
    this.project(actor, projectId)
    const value = this.#repository.designs().filter(candidate => candidate.project_id === projectId && this.#sameScope(actor, candidate))
      .sort((left, right) => right.version - left.version)[0]
    if (value === undefined) throw new PromptToAppError('NOT_FOUND', t('errors.designNotFound'))
    return value
  }

  designOrDefault(actor: PromptToAppActor, projectId: string): DesignSpecV1 {
    this.project(actor, projectId)
    try { return this.latestDesign(actor, projectId).design_spec } catch (error) {
      if (!(error instanceof PromptToAppError) || error.code !== 'NOT_FOUND') throw error
      return createDesignSpec({ preset: 'modern' })
    }
  }

  async proposePlan(actor: PromptToAppActor, projectId: string, slices: StudioPlan['slices']): Promise<StudioPlan> {
    this.#authorize(actor, 'project.write')
    const spec = this.latestSpec(actor, projectId); const now = this.#now().toISOString()
    const project = this.project(actor, projectId)
    const existing = this.#repository.plans().filter(candidate => candidate.project_id === projectId && this.#sameScope(actor, candidate))
    const previous = [...existing].sort((left, right) => (right.revision ?? 0) - (left.revision ?? 0) || right.created_at.localeCompare(left.created_at))[0]
    const revising = project.state === 'PLAN_PROPOSED' && previous?.status === 'CHANGE_REQUESTED'
    if (project.state !== 'SPEC_READY' && !revising) throw new PromptToAppError('INVALID', t('errors.planOrder'))
    const value: StudioPlan = {
      plan_id: this.#createId(), spec_id: spec.spec_id, project_id: projectId, org_id: actor.orgId, tenant_id: actor.tenantId,
      revision: existing.length + 1, slices, status: 'PROPOSED', created_at: now, updated_at: now,
    }
    await this.#repository.putPlan(value)
    if (!revising) await this.transition(actor, projectId, 'PLAN_PROPOSED')
    return value
  }

  plan(actor: PromptToAppActor, projectId: string): StudioPlan {
    this.project(actor, projectId)
    const value = this.#repository.plans().filter(candidate => candidate.project_id === projectId && this.#sameScope(actor, candidate))
      .sort((left, right) => (right.revision ?? 0) - (left.revision ?? 0) || right.created_at.localeCompare(left.created_at))[0]
    if (value === undefined) throw new PromptToAppError('NOT_FOUND', t('errors.planNotFound'))
    return value
  }

  async approvePlan(actor: PromptToAppActor, projectId: string): Promise<StudioPlan> {
    this.#authorize(actor, 'project.write'); const value = this.plan(actor, projectId)
    if (value.status !== 'PROPOSED') throw new PromptToAppError('REPLAY', t('errors.planUnavailable'))
    const updated = { ...value, status: 'APPROVED' as const, updated_at: this.#now().toISOString() }
    await this.#repository.putPlan(updated)
    await this.#approval(actor, projectId, 'plan', value.plan_id, 'T1', false)
    await this.transition(actor, projectId, 'PLAN_APPROVED')
    return updated
  }

  async requestPlanChange(actor: PromptToAppActor, projectId: string, reason: string): Promise<StudioPlan> {
    this.#authorize(actor, 'project.write')
    if (reason.trim().length < 3 || reason.trim().length > 2_000) throw new PromptToAppError('INVALID', t('errors.planChangeLength'))
    const value = this.plan(actor, projectId)
    if (value.status !== 'PROPOSED') throw new PromptToAppError('REPLAY', t('errors.planChangeUnavailable'))
    const updated = { ...value, status: 'CHANGE_REQUESTED' as const, change_request: reason.trim(), updated_at: this.#now().toISOString() }
    await this.#repository.putPlan(updated)
    return updated
  }

  async transition(actor: PromptToAppActor, projectId: string, to: ProjectState): Promise<StudioProject> {
    this.#authorize(actor, 'project.write'); const value = this.project(actor, projectId)
    assertProjectTransition(value.state, to)
    const updated = { ...value, state: to, updated_at: this.#now().toISOString() }
    await this.#repository.putProject(updated)
    await this.#approval(actor, projectId, 'transition', `${value.state}:${to}`, 'T1', false, value.state, to)
    return updated
  }

  async putRun(actor: PromptToAppActor, value: StudioRun): Promise<void> {
    this.#authorize(actor, 'project.write'); this.#assertOwned(actor, value); await this.#repository.putRun(value)
  }
  async putEvidence(actor: PromptToAppActor, value: StudioEvidence): Promise<void> {
    this.#authorize(actor, 'project.write'); this.#assertOwned(actor, value); await this.#repository.putEvidence(value)
  }
  runs(actor: PromptToAppActor, projectId: string) { this.project(actor, projectId); return this.#repository.runs().filter(value => value.project_id === projectId && this.#sameScope(actor, value)) }
  evidence(actor: PromptToAppActor, projectId: string) { this.project(actor, projectId); return this.#repository.evidence().filter(value => value.project_id === projectId && this.#sameScope(actor, value)) }

  async reconcileInterruptedExecutions(): Promise<{ readonly runs: number; readonly projects: number }> {
    const now = this.#now().toISOString()
    let recoveredRuns = 0
    let recoveredProjects = 0
    for (const run of this.#repository.runs().filter(value => value.state === 'PENDING' || value.state === 'RUNNING')) {
      await this.#repository.putRun({
        ...run, state: 'FAILED', finished_at: now, artifact_sha256: null,
        failure_code: 'STUDIO_RESTARTED_DURING_RUN',
      })
      recoveredRuns++
    }
    for (const project of this.#repository.projects()) {
      if (project.state !== 'GENERATING' && project.state !== 'BUILD_OK' && project.state !== 'TESTS_OK') continue
      const projectRuns = this.#repository.runs().filter(run => run.project_id === project.project_id && run.org_id === project.org_id && run.tenant_id === project.tenant_id)
      const latest = [...projectRuns].sort((left, right) => right.started_at.localeCompare(left.started_at))[0]
      const operationId = latest?.operation_id ?? `recovery-${project.project_id}`
      const markerId = `recovery:${project.org_id}:${project.tenant_id}:${project.project_id}:${operationId}`
      if (!projectRuns.some(run => run.failure_code === 'STUDIO_RESTARTED_DURING_RUN' && run.operation_id === operationId)) {
        await this.#repository.putRun({
          run_id: markerId, operation_id: operationId, owner_session_id: 'studio-system-recovery',
          plan_id: latest?.plan_id ?? 'recovery-unavailable', project_id: project.project_id,
          org_id: project.org_id, tenant_id: project.tenant_id, stage: latest?.stage ?? 'verify',
          attempt: latest?.attempt ?? 1, state: 'FAILED', started_at: latest?.started_at ?? now, finished_at: now,
          sandbox: latest?.sandbox ?? 'unavailable', route: latest?.route ?? null, model: latest?.model ?? null,
          input_tokens: latest?.input_tokens ?? null, output_tokens: latest?.output_tokens ?? null,
          estimated_cost_usd: latest?.estimated_cost_usd ?? null, run_directory: latest?.run_directory ?? 'not-created',
          artifact_sha256: null, failure_code: 'STUDIO_RESTARTED_DURING_RUN', acceptance_checks: latest?.acceptance_checks ?? [],
        })
        recoveredRuns++
      }
      await this.#repository.putApproval({
        approval_id: `recovery-transition:${project.org_id}:${project.tenant_id}:${project.project_id}:${operationId}`,
        project_id: project.project_id, org_id: project.org_id, tenant_id: project.tenant_id,
        subject: 'transition', subject_id: `${project.state}:INTERRUPTED:${operationId}`,
        approved_by: 'studio-system-recovery', approved_at: now, tier: 'T1', strong_identity: false,
        from_state: project.state, to_state: 'INTERRUPTED',
      })
      await this.#repository.putProject({ ...project, state: 'INTERRUPTED', updated_at: now })
      recoveredProjects++
    }
    return { runs: recoveredRuns, projects: recoveredProjects }
  }

  async archive(actor: PromptToAppActor, projectId: string): Promise<StudioProject> {
    if (actor.role !== 'owner' && actor.role !== 'admin') throw new PromptToAppError('FORBIDDEN', t('errors.archiveForbidden'))
    const value = this.project(actor, projectId); const updated = { ...value, archived_at: this.#now().toISOString(), updated_at: this.#now().toISOString() }
    await this.#repository.putProject(updated); return updated
  }

  async #saveDesign(actor: PromptToAppActor, projectId: string, designSpec: DesignSpecV1): Promise<StudioDesignSpecRecord> {
    this.#authorize(actor, 'project.write'); this.project(actor, projectId)
    const previous = this.#repository.designs().filter(value => value.project_id === projectId && this.#sameScope(actor, value))
    const value: StudioDesignSpecRecord = {
      design_id: this.#createId(), project_id: projectId, org_id: actor.orgId, tenant_id: actor.tenantId,
      version: previous.length + 1, design_spec: designSpecV1Schema.parse(designSpec), sha256: designSpecHash(designSpec),
      created_by: actor.userId, created_at: this.#now().toISOString(),
    }
    await this.#repository.putDesign(value)
    return value
  }

  #authorize(actor: PromptToAppActor, permission: 'project.read' | 'project.write'): void {
    if (!roleAllows(actor.role, permission)) throw new PromptToAppError('FORBIDDEN', t('errors.forbidden'))
  }
  #sameScope(actor: PromptToAppActor, value: { org_id: string; tenant_id: string }): boolean { return value.org_id === actor.orgId && value.tenant_id === actor.tenantId }
  #assertOwned(actor: PromptToAppActor, value: { org_id: string; tenant_id: string }): void { if (!this.#sameScope(actor, value)) throw new PromptToAppError('FORBIDDEN', t('errors.crossTenant')) }
  async #approval(actor: PromptToAppActor, projectId: string, subject: StudioApproval['subject'], subjectId: string, tier: StudioApproval['tier'], strong: boolean, from: ProjectState | null = null, to: ProjectState | null = null) {
    const approval: StudioApproval = {
      approval_id: this.#createId(), project_id: projectId, org_id: actor.orgId, tenant_id: actor.tenantId,
      subject, subject_id: subjectId, approved_by: actor.userId, approved_at: this.#now().toISOString(), tier,
      strong_identity: strong, from_state: from, to_state: to,
    }
    await this.#repository.putApproval(approval)
  }
}

export function values<T>(table: { entries(): IterableIterator<[PromptToAppKey, T]> }): T[] { return [...table.entries()].map(([, value]) => value) }
