import { randomUUID } from 'node:crypto'
import { roleAllows, type StudioRole } from '@dz23-studio/policy'
import { appSpecHash, type AppSpecV1 } from './appspec.js'
import type {
  PromptToAppKey, ProjectState, StudioApproval, StudioAppSpecRecord, StudioEvidence,
  StudioIntakeTurn, StudioPlan, StudioProject, StudioRun,
} from './model.js'
import { assertProjectTransition } from './state.js'

export interface PromptToAppActor {
  readonly userId: string
  readonly orgId: string
  readonly tenantId: string
  readonly role: StudioRole
}

export interface PromptToAppRepository {
  projects(): readonly StudioProject[]
  putProject(value: StudioProject): Promise<void>
  specs(): readonly StudioAppSpecRecord[]
  putSpec(value: StudioAppSpecRecord): Promise<void>
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

  listProjects(actor: PromptToAppActor): readonly StudioProject[] {
    this.#authorize(actor, 'project.read')
    return this.#repository.projects().filter(value => this.#sameScope(actor, value) && value.archived_at === null)
  }

  project(actor: PromptToAppActor, projectId: string): StudioProject {
    this.#authorize(actor, 'project.read')
    const value = this.#repository.projects().find(candidate => candidate.project_id === projectId && this.#sameScope(actor, candidate))
    if (value === undefined) throw new PromptToAppError('NOT_FOUND', 'Projeto não encontrado neste espaço de trabalho.')
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
    if (value === undefined) throw new PromptToAppError('NOT_FOUND', 'A especificação deste projeto ainda não existe.')
    return value
  }

  async proposePlan(actor: PromptToAppActor, projectId: string, slices: StudioPlan['slices']): Promise<StudioPlan> {
    this.#authorize(actor, 'project.write')
    const spec = this.latestSpec(actor, projectId); const now = this.#now().toISOString()
    const project = this.project(actor, projectId)
    const existing = this.#repository.plans().filter(candidate => candidate.project_id === projectId && this.#sameScope(actor, candidate))
    const previous = [...existing].sort((left, right) => (right.revision ?? 0) - (left.revision ?? 0) || right.created_at.localeCompare(left.created_at))[0]
    const revising = project.state === 'PLAN_PROPOSED' && previous?.status === 'CHANGE_REQUESTED'
    if (project.state !== 'SPEC_READY' && !revising) throw new PromptToAppError('INVALID', 'O plano só pode ser criado depois das perguntas ou de um pedido de mudança.')
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
    if (value === undefined) throw new PromptToAppError('NOT_FOUND', 'O plano deste projeto ainda não existe.')
    return value
  }

  async approvePlan(actor: PromptToAppActor, projectId: string): Promise<StudioPlan> {
    this.#authorize(actor, 'project.write'); const value = this.plan(actor, projectId)
    if (value.status !== 'PROPOSED') throw new PromptToAppError('REPLAY', 'Este plano não está disponível para aprovação.')
    const updated = { ...value, status: 'APPROVED' as const, updated_at: this.#now().toISOString() }
    await this.#repository.putPlan(updated)
    await this.#approval(actor, projectId, 'plan', value.plan_id, 'T1', false)
    await this.transition(actor, projectId, 'PLAN_APPROVED')
    return updated
  }

  async requestPlanChange(actor: PromptToAppActor, projectId: string, reason: string): Promise<StudioPlan> {
    this.#authorize(actor, 'project.write')
    if (reason.trim().length < 3 || reason.trim().length > 2_000) throw new PromptToAppError('INVALID', 'Explique a mudança em até 2.000 caracteres.')
    const value = this.plan(actor, projectId)
    if (value.status !== 'PROPOSED') throw new PromptToAppError('REPLAY', 'Este plano não aceita outro pedido de mudança.')
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

  async archive(actor: PromptToAppActor, projectId: string): Promise<StudioProject> {
    if (actor.role !== 'owner' && actor.role !== 'admin') throw new PromptToAppError('FORBIDDEN', 'Seu papel não permite arquivar projetos.')
    const value = this.project(actor, projectId); const updated = { ...value, archived_at: this.#now().toISOString(), updated_at: this.#now().toISOString() }
    await this.#repository.putProject(updated); return updated
  }

  #authorize(actor: PromptToAppActor, permission: 'project.read' | 'project.write'): void {
    if (!roleAllows(actor.role, permission)) throw new PromptToAppError('FORBIDDEN', 'Seu papel não permite esta ação.')
  }
  #sameScope(actor: PromptToAppActor, value: { org_id: string; tenant_id: string }): boolean { return value.org_id === actor.orgId && value.tenant_id === actor.tenantId }
  #assertOwned(actor: PromptToAppActor, value: { org_id: string; tenant_id: string }): void { if (!this.#sameScope(actor, value)) throw new PromptToAppError('FORBIDDEN', 'A ação tentou acessar outro espaço de trabalho.') }
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
