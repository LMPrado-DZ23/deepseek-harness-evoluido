import { routePrivacyProfile } from '@dz23-studio/route-health'
import { describe, expect, it, vi } from 'vitest'
import type { AppSpecV1 } from '../src/appspec.js'
import { IntakeEngine, nextIntakeQuestion } from '../src/intake.js'
import type { StudioApproval, StudioAppSpecRecord, StudioDesignSpecRecord, StudioEvidence, StudioIntakeTurn, StudioPlan, StudioProject, StudioRun } from '../src/model.js'
import { studioProjectSchema } from '../src/model.js'
import { type SkillCard } from '../src/skill-registry.ts'
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
    expect(await service.intakeTurns(ownerA, project.project_id)).toHaveLength(1)
    expect((await service.latestSpec(ownerA, project.project_id)).version).toBe(1)
  })

  it('acrescenta uma etapa que a PESSOA descreveu, com os arquivos escritos pelo PLANEJADOR', async () => {
    // A edição do plano não conseguia acrescentar nada. E `planned_files` não
    // pode vir do pedido: essa lista é a autorização de escrita do gerador, e
    // um campo de formulário que a alimentasse viraria escrita arbitrária no
    // espaço de trabalho. A pessoa descreve em português; o planejador escreve
    // a etapa.
    const { repository, service } = fixture()
    const project = await service.createProject(ownerA, { name: 'Site', original_brief: 'Quero apresentar meus serviços.', category: 'landing-page', privacy: 'any' })
    await service.saveSpec(ownerA, project.project_id, validSpec, 'intake')
    await service.proposePlan(ownerA, project.project_id, [
      { slice_id: 'slice-1', title: 'Serviços', description: 'Listar', acceptance_criteria: ['aparece'], planned_files: ['src/GeneratedApp.tsx'] },
    ])
    const approvalsBefore = repository.approvalRows.length

    const planner = {
      slice: vi.fn(async () => ({
        slice_id: 'slice-2', title: 'Depoimentos', description: 'Mostrar o que dizem',
        acceptance_criteria: ['os depoimentos aparecem'], planned_files: ['src/depoimentos.tsx'],
      })),
    }
    const updated = await service.addPlanSlice(ownerA, project.project_id, 'faltou mostrar o que meus clientes dizem', planner, 'any')

    expect(updated.slices.map(slice => slice.slice_id)).toEqual(['slice-1', 'slice-2'])
    expect(updated.slices[0]).toMatchObject({ title: 'Serviços' })
    // O planejador recebeu o plano atual, para não repetir o que já existe.
    expect(planner.slice).toHaveBeenCalledWith(
      { orgId: 'org-a', tenantId: 'tenant-a' }, 'any', validSpec,
      [{ title: 'Serviços', planned_files: ['src/GeneratedApp.tsx'] }],
      'faltou mostrar o que meus clientes dizem', 'landing-page',
    )
    // E a edição ficou REGISTRADA: sem isso o repositório sabia que o plano
    // tinha mudado e nunca por quem.
    expect(repository.approvalRows.length).toBe(approvalsBefore + 1)
    expect(repository.approvalRows.at(-1)).toMatchObject({ subject: 'plan', approved_by: 'user-a', tier: 'T1' })
  })

  it('recusa pedido de etapa curto demais antes de gastar uma chamada de modelo', async () => {
    // Uma palavra não descreve etapa nenhuma. Recusar aqui evita pagar o modelo
    // para ele descobrir isso sozinho.
    const { service } = fixture()
    const project = await service.createProject(ownerA, { name: 'Site', original_brief: 'Quero apresentar meus serviços.', category: 'landing-page', privacy: 'any' })
    await service.saveSpec(ownerA, project.project_id, validSpec, 'intake')
    await service.proposePlan(ownerA, project.project_id, [
      { slice_id: 'slice-1', title: 'Serviços', description: 'Listar', acceptance_criteria: ['aparece'], planned_files: ['src/GeneratedApp.tsx'] },
    ])
    const planner = { slice: vi.fn() }
    await expect(service.addPlanSlice(ownerA, project.project_id, 'x', planner as never, 'any')).rejects.toMatchObject({ code: 'INVALID' })
    expect(planner.slice).not.toHaveBeenCalled()
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
    expect((await service.designOrDefault(ownerA, project.project_id)).preset).toBe('modern')
    await expect(service.latestDesign(ownerA, project.project_id)).rejects.toThrow(PromptToAppError)
    const first = await service.saveDesign(ownerA, project.project_id, { preset: 'brand', primary: { h: 31, s: 92, l: 44 }, font: 'source-serif', tone: 'formal' })
    expect(first).toMatchObject({ version: 1, design_spec: { preset: 'brand', typography: { family: 'source-serif' } } })
    const logo = {
      sha256: 'a'.repeat(64), relative_path: `logos/${'b'.repeat(64)}/${'a'.repeat(64)}.png`, mime: 'image/png' as const,
      size_bytes: 100, width: 10, height: 10, extracted_primary: { h: 31, s: 92, l: 44 },
    }
    const second = await service.attachLogo(ownerA, project.project_id, logo)
    expect(second).toMatchObject({ version: 2, design_spec: { logo } })
    expect((await service.latestDesign(ownerA, project.project_id)).design_id).toBe(second.design_id)
    await expect(service.saveDesign(viewerA, project.project_id, { preset: 'modern' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(service.latestDesign(builderB, project.project_id)).rejects.toThrow(PromptToAppError)
  })

  it('reconciles orphaned executions once without crossing tenant boundaries', async () => {
    const { repository, service } = fixture()
    const base: StudioProject = {
      project_id: 'project-a', org_id: 'org-a', tenant_id: 'tenant-a', name: 'A', state: 'GENERATING',
      original_brief: 'Aplicativo A', category: 'landing-page', created_by: 'owner-a', privacy: 'local-only',
      created_at: '2026-09-03T11:00:00.000Z', updated_at: '2026-09-03T11:00:00.000Z', archived_at: null,
    }
    repository.projectRows = [base, { ...base, project_id: 'project-b', org_id: 'org-b', tenant_id: 'tenant-b', name: 'B', state: 'PLAN_APPROVED' }]
    repository.runRows = [{
      run_id: 'run-a', operation_id: 'operation-a', owner_session_id: 'old-process', plan_id: 'plan-a',
      project_id: 'project-a', org_id: 'org-a', tenant_id: 'tenant-a', stage: 'build', attempt: 1,
      state: 'RUNNING', started_at: '2026-09-03T11:00:00.000Z', finished_at: null, sandbox: 'full',
      route: null, model: null, input_tokens: null, output_tokens: null, estimated_cost_usd: null,
      run_directory: 'run-a', artifact_sha256: null, failure_code: null, acceptance_checks: [],
    }]

    await expect(service.reconcileInterruptedExecutions()).resolves.toEqual({ runs: 1, projects: 1 })
    expect(repository.runRows).toContainEqual(expect.objectContaining({ run_id: 'run-a', state: 'FAILED', failure_code: 'STUDIO_RESTARTED_DURING_RUN' }))
    expect(repository.projectRows.find(row => row.project_id === 'project-a')?.state).toBe('INTERRUPTED')
    expect(repository.projectRows.find(row => row.project_id === 'project-b')?.state).toBe('PLAN_APPROVED')
    expect(repository.approvalRows).toContainEqual(expect.objectContaining({ approved_by: 'studio-system-recovery', from_state: 'GENERATING', to_state: 'INTERRUPTED' }))
    await expect(service.reconcileInterruptedExecutions()).resolves.toEqual({ runs: 0, projects: 0 })
    expect(repository.approvalRows).toHaveLength(1)
  })

  it('derives collision-resistant recovery keys from the full structured scope', async () => {
    const { repository, service } = fixture()
    const base: StudioProject = {
      project_id: 'd', org_id: 'a:b', tenant_id: 'c', name: 'A', state: 'BUILD_OK', original_brief: 'A',
      category: 'landing-page', created_by: 'owner', privacy: 'local-only', created_at: '2026-09-03T11:00:00.000Z',
      updated_at: '2026-09-03T11:00:00.000Z', archived_at: null,
    }
    repository.projectRows = [base, { ...base, org_id: 'a', tenant_id: 'b:c', name: 'B' }]
    await expect(service.reconcileInterruptedExecutions()).resolves.toEqual({ runs: 2, projects: 2 })
    expect(new Set(repository.runRows.map(run => run.run_id)).size).toBe(2)
    expect(new Set(repository.approvalRows.map(row => row.approval_id)).size).toBe(2)
    expect(repository.projectRows.every(row => row.state === 'INTERRUPTED')).toBe(true)
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
    expect(complete.mock.calls[2]?.[3]).toContain('não planeje arquivos CSS')
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
    }, 'form-database')).resolves.toMatchObject({ slices: [{ slice_id: 'form' }] })
    await expect(planner.plan({ orgId: 'o', tenantId: 't' }, 'local-only', databaseSpec, 'crud-panel')).resolves.toMatchObject({ slices: [{ slice_id: 'form' }] })
    expect(complete.mock.calls.at(-1)?.[3]).toContain('login')
    complete.mockResolvedValueOnce({ value: { slices: [{ slice_id: 'bad', title: 'Incompleto', description: 'Sem entrada', acceptance_criteria: ['Visível'], planned_files: ['content/app.json'] }] }, route: 'ollama', model: 'qwen' })
    await expect(planner.plan({ orgId: 'o', tenantId: 't' }, 'local-only', databaseSpec, 'form-database')).rejects.toMatchObject({ code: 'FORM_ENTRY_FILE_REQUIRED' })
  })

})

describe('M-05: o perfil de rota é do projeto', () => {
  it('grava o nome do perfil e continua lendo o valor binário antigo', async () => {
    const { repository, service } = fixture()
    // Gravação nova sai com o NOME; o binário antigo entrou por uma tela que
    // ainda existe em navegador aberto, e ele não pode ser recusado.
    const created = await service.createProject(ownerA, {
      name: 'Privado', original_brief: 'Quero um cadastro que fique no meu computador.',
      category: 'landing-page', privacy: 'local-only',
    })
    expect(created.privacy).toBe('privado-local')
    const best = await service.createProject(ownerA, {
      name: 'Melhor', original_brief: 'Quero a melhor qualidade possível.',
      category: 'landing-page', privacy: 'any',
    })
    expect(best.privacy).toBe('melhor-qualidade')
    const named = await service.createProject(ownerA, {
      name: 'Equilibrado', original_brief: 'Quero equilíbrio entre privacidade e qualidade.',
      category: 'landing-page', privacy: 'equilibrado',
    })
    expect(named.privacy).toBe('equilibrado')

    // E o registro JÁ gravado em disco com o valor antigo continua legível:
    // subir a versão do domínio para renomeá-lo faria `open()` falhar com
    // `version-mismatch` em toda instalação existente.
    const stored: StudioProject = {
      ...created, project_id: 'projeto-antigo', name: 'Antigo', privacy: 'local-only',
    }
    await repository.putProject(stored)
    const read = service.project(ownerA, 'projeto-antigo')
    expect(read.privacy).toBe('local-only')
    expect(studioProjectSchema.safeParse(read).success).toBe(true)
    expect(routePrivacyProfile(read.privacy)).toBe('privado-local')
    // Dois projetos do mesmo espaço de trabalho, dois perfis diferentes.
    expect(new Set(service.listProjects(ownerA).map(project => routePrivacyProfile(project.privacy))))
      .toEqual(new Set(['privado-local', 'melhor-qualidade', 'equilibrado']))
  })
})

describe('T-07: o planejador monta o prompt com TETO e com registro', () => {
  const spec = (problem: string): AppSpecV1 => ({
    schema_version: 1, problem, audience: 'Equipe', journeys: ['Usar'],
    pages: [{ name: 'Início', sections: ['Topo'] }], entities: [],
    sensitive_data: { detected: [], confirmed_by_user: false },
    accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true },
    language: 'pt-BR', acceptance_criteria: ['Funciona para a equipe'],
  })
  const responder = () => vi.fn().mockResolvedValue({
    value: { slices: [{ slice_id: 'pagina', title: 'Página', description: 'A página', acceptance_criteria: ['Aparece'], planned_files: ['content/app.json'] }] },
    route: 'ollama', model: 'qwen',
  })

  it('registra o que entrou no prompt, com procedência', async () => {
    // A pergunta "o que exatamente o modelo viu?" passa a ter resposta sem
    // precisar reproduzir a execução.
    const planner = new PlannerEngine({ complete: responder() })
    await planner.plan({ orgId: 'o', tenantId: 't' }, 'local-only', spec('Organizar contatos.'))
    expect(planner.lastLedger).toBeDefined()
    expect(planner.lastLedger!.included.map(item => item.id)).toContain('plan.spec')
    expect(planner.lastLedger!.included.find(item => item.id === 'plan.spec')?.source).toBe('app-spec')
    expect(planner.lastLedger!.included.some(item => item.kind === 'schema')).toBe(true)
    expect(planner.lastLedger!.dropped).toEqual([])
  })

  it('uma especificação ENORME falha dizendo que é de tamanho, e não de formato', async () => {
    // Antes disto o prompt crescia sem teto: `JSON.stringify(spec)` entrava
    // inteiro. Com contexto grande demais, o modelo devolve algo que o `parse`
    // recusa, e a pessoa lia "formato inválido" sobre um problema de TAMANHO.
    const complete = responder()
    const planner = new PlannerEngine({ complete }, 500)
    await expect(planner.plan({ orgId: 'o', tenantId: 't' }, 'local-only', spec('x'.repeat(5_000))))
      .rejects.toMatchObject({ code: 'CONTEXT_BUDGET_EXCEEDED' })
    // E o modelo NÃO foi chamado: recusar antes de gastar é parte do conserto.
    expect(complete).not.toHaveBeenCalled()
  })

  it('o prompt continua tendo instrução e schema — o teto não come o essencial', async () => {
    const complete = responder()
    const planner = new PlannerEngine({ complete })
    await planner.plan({ orgId: 'o', tenantId: 't' }, 'local-only', spec('Organizar contatos.'))
    const prompt = complete.mock.calls[0]![3] as string
    expect(prompt).toContain('schema_version')
    expect(prompt.length).toBeLessThanOrEqual(planner.lastLedger!.budget)
  })
})

describe('T-25: intake e etapa nova tambem passam pelo motor de contexto', () => {
  const conversation = (brief: string, answers: Record<string, string> = {}) => ({
    project: {
      project_id: 'p', org_id: 'o', tenant_id: 't', name: 'Projeto', original_brief: brief,
      category: 'landing-page' as const, privacy: 'local-only' as const,
    },
    answers,
  })

  it('o intake registra o que entrou, com procedencia', async () => {
    const complete = vi.fn().mockResolvedValue({ value: JSON.stringify(validSpec), route: 'ollama', model: 'qwen' })
    const intake = new IntakeEngine({ complete })
    await intake.buildSpec(conversation('Quero um site para a padaria.') as never)
    expect(intake.lastLedger).toBeDefined()
    const ids = intake.lastLedger!.included.map(item => item.id)
    expect(ids).toContain('spec.idea')
    expect(ids).toContain('spec.answers')
    expect(intake.lastLedger!.included.find(item => item.id === 'spec.idea')?.source).toBe('original-brief')
  })

  it('a deteccao de dado sensivel e INSTRUCAO: nunca cai por falta de espaco', async () => {
    // Corta-la produziria um aplicativo que trata CPF como campo comum, e a
    // pessoa nao teria como saber que a instrucao existiu e sumiu.
    const complete = vi.fn().mockResolvedValue({ value: JSON.stringify(validSpec), route: 'ollama', model: 'qwen' })
    const intake = new IntakeEngine({ complete })
    await intake.buildSpec(conversation('Preciso guardar o CPF dos clientes.', { a: 'x'.repeat(2_000) }) as never)
    const sensitive = intake.lastLedger!.included.find(item => item.id === 'spec.sensitive')
    expect(sensitive).toBeDefined()
    expect(sensitive!.kind).toBe('instruction')
  })

  it('um pedido ENORME no intake falha por tamanho, e o modelo nao e chamado', async () => {
    const complete = vi.fn()
    const intake = new IntakeEngine({ complete }, 400)
    await expect(intake.buildSpec(conversation('y'.repeat(10_000)) as never))
      .rejects.toMatchObject({ code: 'CONTEXT_BUDGET_EXCEEDED' })
    expect(complete).not.toHaveBeenCalled()
  })

  it('na etapa nova, o PEDIDO da pessoa tem a maior prioridade', async () => {
    const complete = vi.fn().mockResolvedValue({
      value: { slice: { slice_id: 'nova', title: 'Etapa nova', description: 'O que faltava', acceptance_criteria: ['Aparece'], planned_files: ['content/extra.json'] } },
      route: 'ollama', model: 'qwen',
    })
    const planner = new PlannerEngine({ complete })
    await planner.slice({ orgId: 'o', tenantId: 't' }, 'local-only', validSpec, [], 'quero uma seção de contato')
    const ledger = planner.lastLedger!
    const request = ledger.included.find(item => item.id === 'slice.request')
    expect(request).toBeDefined()
    expect(request!.source).toBe('slice-request')
    expect(ledger.dropped).toEqual([])
  })
})

describe('as habilidades chegam ao prompt do planejamento', () => {
  const ATOR = { orgId: 'o', tenantId: 't', userId: 'u1', role: 'owner' }
  const TEXTO = 'Sempre escreva o rotulo acima do campo, e nunca dentro dele.'

  function ficha(over: Partial<SkillCard> = {}): SkillCard {
    return {
      skill_id: 'formularios', name: 'Formularios acessiveis',
      // `validSpec.problem` fala de fotos e de salao; o gatilho precisa casar
      // com o que a PESSOA descreveu, e nao com vocabulario tecnico.
      trigger: 'salao fotos servicos', body_chars: TEXTO.length,
      source: 'integration:hub-1', enabled: true, ...over,
    }
  }

  function planejador(over: { cards?: readonly SkillCard[]; load?: (actor: unknown, id: string) => Promise<string> } = {}) {
    const complete = vi.fn().mockResolvedValue({
      value: { slices: [{ slice_id: 's', title: 'Pagina', description: 'Montar', acceptance_criteria: ['Compila'], planned_files: ['src/GeneratedApp.tsx', 'content/app.json'] }] },
      route: 'ollama', model: 'qwen',
    })
    const planner = new PlannerEngine({ complete }, undefined, {
      cards: async () => over.cards ?? [ficha()],
      load: over.load ?? (async () => TEXTO),
    })
    return { planner, complete }
  }

  it('a habilidade que casa entra no prompt, com o texto conferido', async () => {
    const f = planejador()
    await f.planner.plan(ATOR, 'local-only', validSpec)
    expect(f.complete.mock.calls[0]![3]).toContain(TEXTO)
    expect(f.planner.lastSkills?.loaded).toEqual(['skill:formularios'])
  })

  it('SEM ator completo o registro NAO e consultado', async () => {
    // O registro confere papel. Montar um ator aqui para conseguir ler seria
    // contornar essa conferencia por dentro.
    const cards = vi.fn(async () => [ficha()])
    const planner = new PlannerEngine(
      { complete: vi.fn().mockResolvedValue({ value: { slices: [{ slice_id: 's', title: 'P', description: 'M', acceptance_criteria: ['C'], planned_files: ['src/GeneratedApp.tsx'] }] }, route: 'ollama', model: 'qwen' }) },
      undefined, { cards, load: async () => TEXTO },
    )
    await planner.plan({ orgId: 'o', tenantId: 't' }, 'local-only', validSpec)
    expect(cards).not.toHaveBeenCalled()
    expect(planner.lastSkills).toBeUndefined()
  })

  it('habilidade que NAO casa nao entra, e o prompt continua o mesmo', async () => {
    const semCasar = planejador({ cards: [ficha({ trigger: 'contabilidade imposto nota' })] })
    await semCasar.planner.plan(ATOR, 'local-only', validSpec)
    expect(semCasar.complete.mock.calls[0]![3]).not.toContain(TEXTO)
    expect(semCasar.planner.lastSkills?.selection.skipped).toEqual([{ skill_id: 'formularios', reason: 'NO_MATCH' }])
  })

  it('a recusa do registro NAO derruba o planejamento', async () => {
    // Uma habilidade desligada nao pode levar junto o trabalho de quem pediu.
    const f = planejador({ load: async () => { throw new Error('Esta habilidade esta desligada.') } })
    await expect(f.planner.plan(ATOR, 'local-only', validSpec)).resolves.toMatchObject({ slices: [{ slice_id: 's' }] })
    expect(f.planner.lastSkills?.refused).toEqual([
      { skill_id: 'formularios', reason: 'LOAD_FAILED', detail: 'Esta habilidade esta desligada.' },
    ])
    expect(f.complete.mock.calls[0]![3]).not.toContain(TEXTO)
  })

  it('o relatorio das habilidades e ZERADO entre planejamentos', async () => {
    // Um relatorio que sobrevive ao planejamento seguinte responde a pergunta
    // "o que o modelo viu?" com o que ele viu da OUTRA vez.
    const f = planejador()
    await f.planner.plan(ATOR, 'local-only', validSpec)
    expect(f.planner.lastSkills?.loaded).toHaveLength(1)
    await f.planner.plan({ orgId: 'o', tenantId: 't' }, 'local-only', validSpec)
    expect(f.planner.lastSkills).toBeUndefined()
  })

  it('a procedencia da habilidade aparece no registro do contexto', async () => {
    const f = planejador()
    await f.planner.plan(ATOR, 'local-only', validSpec)
    const linha = f.planner.lastLedger?.included.find(item => item.id === 'skill:formularios')
    expect(linha?.source).toBe('integration:hub-1')
    expect(linha?.kind).toBe('instruction')
  })

  it('o casamento le o que a PESSOA descreveu, e nao nomes de coluna', async () => {
    // Um gatilho que casa com `telefone` porque existe um CAMPO chamado
    // telefone e uma habilidade escolhida por vocabulario tecnico, e nao
    // porque o assunto e aquele — e o que ela traz e uma REGRA que o agente
    // vai seguir.
    const comEntidade: AppSpecV1 = { ...validSpec, entities: [{
      name: 'Contato', kind: 'database', sensitive: false,
      fields: [{ name: 'telefone', type: 'text', required: true }],
    }] }
    const f = planejador({ cards: [ficha({ trigger: 'telefone Contato' })] })
    await f.planner.plan(ATOR, 'local-only', comEntidade, 'form-database')
    expect(f.planner.lastSkills?.selection.skipped).toEqual([{ skill_id: 'formularios', reason: 'NO_MATCH' }])
    expect(f.complete.mock.calls[0]![3]).not.toContain(TEXTO)
  })

  it('as habilidades so podem ocupar uma FATIA do teto, e nao o teto inteiro', async () => {
    // O que sobra tem de caber o pedido INTEIRO: instrucao de terceiro nunca
    // pode empurrar para fora o que a pessoa pediu. Com a fatia em trinta por
    // cento e o limite por habilidade num quarto dela, uma habilidade de 800
    // nao cabe num teto de 10.000 — e caberia se a fatia fosse o teto todo.
    const complete = vi.fn().mockResolvedValue({
      value: { slices: [{ slice_id: 's', title: 'P', description: 'M', acceptance_criteria: ['C'], planned_files: ['src/GeneratedApp.tsx'] }] },
      route: 'ollama', model: 'qwen',
    })
    const planner = new PlannerEngine({ complete }, 10_000, {
      cards: async () => [ficha({ body_chars: 800 })],
      load: async () => 'x'.repeat(800),
    })
    await planner.plan(ATOR, 'local-only', validSpec)
    expect(planner.lastSkills?.selection.skipped).toEqual([{ skill_id: 'formularios', reason: 'OVERSIZED' }])
    expect(planner.lastSkills?.loaded).toEqual([])
  })

  it('sem registro montado, o planejamento acontece exatamente como antes', async () => {
    const complete = vi.fn().mockResolvedValue({
      value: { slices: [{ slice_id: 's', title: 'P', description: 'M', acceptance_criteria: ['C'], planned_files: ['src/GeneratedApp.tsx'] }] },
      route: 'ollama', model: 'qwen',
    })
    const planner = new PlannerEngine({ complete })
    await expect(planner.plan(ATOR, 'local-only', validSpec)).resolves.toMatchObject({ slices: [{ slice_id: 's' }] })
    expect(planner.lastSkills).toBeUndefined()
  })
})
