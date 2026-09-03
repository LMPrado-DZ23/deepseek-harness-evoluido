import { describe, expect, it, vi } from 'vitest'
import type { AppSpecV1 } from '../src/appspec.js'
import { IntakeEngine, nextIntakeQuestion } from '../src/intake.js'
import type { StudioApproval, StudioAppSpecRecord, StudioDesignSpecRecord, StudioEvidence, StudioIntakeTurn, StudioPlan, StudioProject, StudioRun } from '../src/model.js'
import { PlannerEngine } from '../src/planner.js'
import type { PromptModelPort } from '../src/ports.js'
import { PromptToAppError, PromptToAppService, type PromptToAppActor, type PromptToAppRepository } from '../src/service.js'

class MemoryRepository implements PromptToAppRepository {
  projectRows: StudioProject[] = []; specRows: StudioAppSpecRecord[] = []; designRows: StudioDesignSpecRecord[] = []; turnRows: StudioIntakeTurn[] = []
  planRows: StudioPlan[] = []; runRows: StudioRun[] = []; evidenceRows: StudioEvidence[] = []; approvalRows: StudioApproval[] = []
  projects = () => this.projectRows; specs = () => this.specRows; designs = () => this.designRows; turns = () => this.turnRows; plans = () => this.planRows
  runs = () => this.runRows; evidence = () => this.evidenceRows; approvals = () => this.approvalRows
  putProject = async (v: StudioProject) => { this.projectRows = upsert(this.projectRows, v, 'project_id') }
  putSpec = async (v: StudioAppSpecRecord) => { this.specRows = upsert(this.specRows, v, 'spec_id') }
  putDesign = async (v: StudioDesignSpecRecord) => { this.designRows = upsert(this.designRows, v, 'design_id') }
  putTurn = async (v: StudioIntakeTurn) => { this.turnRows = upsert(this.turnRows, v, 'turn_id') }
  putPlan = async (v: StudioPlan) => { this.planRows = upsert(this.planRows, v, 'plan_id') }
  putRun = async (v: StudioRun) => { this.runRows = upsert(this.runRows, v, 'run_id') }
  putEvidence = async (v: StudioEvidence) => { this.evidenceRows = upsert(this.evidenceRows, v, 'evidence_id') }
  putApproval = async (v: StudioApproval) => { this.approvalRows = upsert(this.approvalRows, v, 'approval_id') }
}

function upsert<T, K extends keyof T>(rows: T[], value: T, key: K): T[] { return [...rows.filter(row => row[key] !== value[key]), value] }
const ownerA: PromptToAppActor = { userId: 'user-a', orgId: 'org-a', tenantId: 'tenant-a', role: 'owner' }
const builderB: PromptToAppActor = { userId: 'user-b', orgId: 'org-b', tenantId: 'tenant-b', role: 'builder' }
const viewerA: PromptToAppActor = { ...ownerA, userId: 'viewer-a', role: 'viewer' }

const validSpec: AppSpecV1 = {
  schema_version: 1, problem: 'Apresentar serviços para novos clientes.', audience: 'Clientes locais',
  journeys: ['Conhecer os serviços'], pages: [{ name: 'Início', sections: ['Serviços', 'Contato'] }],
  entities: [], sensitive_data: { detected: [], confirmed_by_user: false },
  accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true }, language: 'pt-BR',
  acceptance_criteria: ['A página apresenta os serviços com clareza.'],
}

function fixture() {
  const repository = new MemoryRepository(); let id = 0
  const service = new PromptToAppService({ repository, now: () => new Date('2026-09-03T12:00:00.000Z'), createId: () => `id-${++id}` })
  return { repository, service }
}

describe('PromptToAppService', () => {
  it('keeps every route scoped and prevents tenant B from reading or changing tenant A', async () => {
    const { repository, service } = fixture()
    const project = await service.createProject(ownerA, { name: 'Site', original_brief: 'Quero apresentar meu trabalho de fotografia.', category: 'landing-page', privacy: 'local-only' })
    await expect(service.recordTurn(builderB, project.project_id, { question_id: 'audience', question: 'q', answer: 'a', recommended: false, route: null, model: null })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(service.saveSpec(builderB, project.project_id, validSpec, 'intake')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(service.proposePlan(builderB, project.project_id, [{ slice_id: 's', title: 'Página', description: 'Criar página', acceptance_criteria: ['Compila'], planned_files: ['src/GeneratedApp.tsx'] }])).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(() => service.project(builderB, project.project_id)).toThrow(PromptToAppError)
    expect(service.listProjects(builderB)).toEqual([])
    await expect(service.putRun(builderB, { run_id: 'r', operation_id: 'op', owner_session_id: 'session', plan_id: 'p', project_id: project.project_id, org_id: 'org-a', tenant_id: 'tenant-a', stage: 'build', attempt: 1, state: 'RUNNING', started_at: '2026-09-03T12:00:00.000Z', finished_at: null, sandbox: 'full', route: null, model: null, input_tokens: null, output_tokens: null, estimated_cost_usd: null, run_directory: 'run', failure_code: null, acceptance_checks: [] })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(repository.projectRows).toHaveLength(1)
  })

  it('runs DRAFT through approved plan with a T1 approval and audited transitions', async () => {
    const { repository, service } = fixture()
    const project = await service.createProject(ownerA, { name: 'Catálogo', original_brief: 'Quero mostrar meus produtos artesanais.', category: 'catalog', privacy: 'any' })
    await service.recordTurn(ownerA, project.project_id, { question_id: 'audience', question: 'Para quem?', answer: 'Clientes', recommended: false, route: 'ollama', model: 'qwen' })
    await service.saveSpec(ownerA, project.project_id, validSpec, 'intake')
    const plan = await service.proposePlan(ownerA, project.project_id, [{ slice_id: 'slice-1', title: 'Catálogo', description: 'Mostrar itens', acceptance_criteria: ['Itens visíveis'], planned_files: ['src/GeneratedApp.tsx'] }])
    await expect(service.requestPlanChange(ownerA, project.project_id, 'x')).rejects.toMatchObject({ code: 'INVALID' })
    expect((await service.requestPlanChange(ownerA, project.project_id, 'Destacar o contato.')).status).toBe('CHANGE_REQUESTED')
    const revised = await service.proposePlan(ownerA, project.project_id, [{ slice_id: 'slice-2', title: 'Catálogo revisado', description: 'Mostrar contato', acceptance_criteria: ['Contato visível'], planned_files: ['src/GeneratedApp.tsx'] }])
    const approved = await service.approvePlan(ownerA, project.project_id)
    expect(approved.status).toBe('APPROVED'); expect(plan.status).toBe('PROPOSED'); expect(revised.revision).toBe(2)
    expect(service.project(ownerA, project.project_id).state).toBe('PLAN_APPROVED')
    expect(repository.approvalRows.some(row => row.subject === 'plan' && row.tier === 'T1')).toBe(true)
    expect(repository.approvalRows.filter(row => row.subject === 'transition').map(row => row.to_state)).toEqual(['SPEC_READY', 'PLAN_PROPOSED', 'PLAN_APPROVED'])
    expect(service.intakeTurns(ownerA, project.project_id)).toHaveLength(1)
    expect(service.latestSpec(ownerA, project.project_id).version).toBe(1)
  })

  it('enforces viewer and archive roles and rejects approval replay', async () => {
    const { service } = fixture()
    await expect(service.createProject(viewerA, { name: 'x', original_brief: 'brief', category: 'catalog', privacy: 'any' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const project = await service.createProject(ownerA, { name: 'x', original_brief: 'brief', category: 'catalog', privacy: 'any' })
    await expect(service.archive({ ...ownerA, role: 'builder' }, project.project_id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await service.saveSpec(ownerA, project.project_id, validSpec, 'intake')
    await service.proposePlan(ownerA, project.project_id, [{ slice_id: 's', title: 't', description: 'd', acceptance_criteria: ['a'], planned_files: ['src/GeneratedApp.tsx'] }])
    await service.approvePlan(ownerA, project.project_id)
    await expect(service.approvePlan(ownerA, project.project_id)).rejects.toMatchObject({ code: 'REPLAY' })
    expect((await service.archive(ownerA, project.project_id)).archived_at).not.toBeNull()
  })

  it('versions tenant-scoped design choices and attaches a sanitized logo', async () => {
    const { service } = fixture()
    const project = await service.createProject(ownerA, { name: 'Marca', original_brief: 'Quero criar uma página para minha marca.', category: 'landing-page', privacy: 'local-only' })
    expect(service.designOrDefault(ownerA, project.project_id).preset).toBe('modern')
    expect(() => service.latestDesign(ownerA, project.project_id)).toThrow(PromptToAppError)
    const first = await service.saveDesign(ownerA, project.project_id, { preset: 'brand', primary: { h: 31, s: 92, l: 44 }, font: 'source-serif', tone: 'formal' })
    expect(first).toMatchObject({ version: 1, design_spec: { preset: 'brand', typography: { family: 'source-serif' } } })
    const logo = {
      sha256: 'a'.repeat(64), relative_path: `logos/${'b'.repeat(64)}/${'a'.repeat(64)}.png`, mime: 'image/png' as const,
      size_bytes: 100, width: 10, height: 10, extracted_primary: { h: 31, s: 92, l: 44 },
    }
    const second = await service.attachLogo(ownerA, project.project_id, logo)
    expect(second).toMatchObject({ version: 2, design_spec: { logo } })
    expect(service.latestDesign(ownerA, project.project_id).design_id).toBe(second.design_id)
    await expect(service.saveDesign(viewerA, project.project_id, { preset: 'modern' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(() => service.latestDesign(builderB, project.project_id)).toThrow(PromptToAppError)
  })
})

describe('intake and planner', () => {
  const project: StudioProject = { project_id: 'p', org_id: 'o', tenant_id: 't', name: 'n', state: 'DRAFT', original_brief: 'Catálogo de fotografia', category: 'catalog', created_by: 'u', privacy: 'local-only', created_at: '2026-09-03T12:00:00.000Z', updated_at: '2026-09-03T12:00:00.000Z', archived_at: null }

  it('asks one question at a time and puts sensitive confirmation first', () => {
    expect(nextIntakeQuestion({ project: { ...project, original_brief: 'Cadastro de pacientes' }, answers: {} })?.id).toBe('sensitive-confirmation')
    expect(nextIntakeQuestion({ project, answers: {} })?.id).toBe('audience')
    expect(nextIntakeQuestion({ project, answers: { audience: 'Clientes' } })?.id).toBe('goal')
    expect(nextIntakeQuestion({ project, answers: { audience: 'Clientes', goal: 'Ver itens' } })?.id).toBe('content')
    expect(nextIntakeQuestion({ project, answers: { audience: 'Clientes', goal: 'Ver itens', content: 'Fotos' } })).toBeUndefined()
  })

  it('uses the selected route for recommendation, AppSpec and plan', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce({ value: 'Clientes locais', route: 'ollama', model: 'qwen' })
      .mockResolvedValueOnce({ value: validSpec, route: 'ollama', model: 'qwen' })
      .mockResolvedValueOnce({ value: { slices: [{ slice_id: 's', title: 'Página', description: 'Montar a página', acceptance_criteria: ['Compila sem erro'], planned_files: ['src/GeneratedApp.tsx', 'content/app.json'] }] }, route: 'ollama', model: 'qwen' })
    const model: PromptModelPort = { complete }
    const intake = new IntakeEngine(model)
    await expect(intake.recommend({ project, answers: {} }, { id: 'audience', text: 'Para quem?' })).resolves.toMatchObject({ value: 'Clientes locais' })
    const built = await intake.buildSpec({ project, answers: { audience: 'Clientes', goal: 'Ver', content: 'Fotos' } })
    expect(built.spec).toEqual(validSpec)
    await expect(new PlannerEngine(model).plan({ orgId: 'o', tenantId: 't' }, 'local-only', validSpec)).resolves.toMatchObject({ slices: [{ title: 'Página' }] })
    expect(complete.mock.calls.every(call => call[2] === 'local-only')).toBe(true)
  })

  it('plans the public form category and refuses sensitive or incomplete forms until login exists', async () => {
    const databaseSpec: AppSpecV1 = { ...validSpec, entities: [{
      name: 'Contato', kind: 'database', sensitive: false,
      fields: [{ name: 'Nome', type: 'text', required: true }, { name: 'E-mail', type: 'email', required: false }],
    }] }
    const complete = vi.fn().mockResolvedValue({
      value: { slices: [{ slice_id: 'form', title: 'Cadastro e lista', description: 'Cadastrar e consultar', acceptance_criteria: ['O cadastro aparece na lista'], planned_files: ['src/GeneratedApp.tsx'] }] },
      route: 'ollama', model: 'qwen',
    })
    const planner = new PlannerEngine({ complete })
    await expect(planner.plan({ orgId: 'o', tenantId: 't' }, 'local-only', databaseSpec, 'form-database')).resolves.toMatchObject({ slices: [{ slice_id: 'form' }] })
    expect(complete.mock.calls[0]![3]).toContain('@/src/components/generated/')
    await expect(planner.plan({ orgId: 'o', tenantId: 't' }, 'local-only', validSpec, 'form-database')).rejects.toMatchObject({ code: 'FORM_DATABASE_REQUIRED' })
    await expect(planner.plan({ orgId: 'o', tenantId: 't' }, 'local-only', {
      ...databaseSpec, sensitive_data: { detected: ['financial'], confirmed_by_user: true },
    }, 'form-database')).rejects.toMatchObject({ code: 'AUTH_REQUIRED_FOR_SENSITIVE_FORM' })
    complete.mockResolvedValueOnce({ value: { slices: [{ slice_id: 'bad', title: 'Incompleto', description: 'Sem entrada', acceptance_criteria: ['Visível'], planned_files: ['content/app.json'] }] }, route: 'ollama', model: 'qwen' })
    await expect(planner.plan({ orgId: 'o', tenantId: 't' }, 'local-only', databaseSpec, 'form-database')).rejects.toMatchObject({ code: 'FORM_ENTRY_FILE_REQUIRED' })
  })
})
