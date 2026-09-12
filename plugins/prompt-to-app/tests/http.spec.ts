import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CSRF_COOKIE, IdentityError, SESSION_COOKIE, type SessionRecord, type StudioIdentityService } from '@dz23-studio/identity'
import type { StudioTenancyService } from '@dz23-studio/tenancy'
import type { AppSpecV1 } from '../src/appspec.js'
import { buildCodeIndex } from '../src/code-intelligence.js'
import { createPromptToAppHttpHandler, type PromptToAppHttpConfig, registerPromptToAppWorkspaceHttpExtension, PROMPT_TO_APP_ROUTE_CONTRACTS } from '../src/http.js'
import { IntakeEngine } from '../src/intake.js'
import type { StudioApproval, StudioAppSpecRecord, StudioDesignSpecRecord, StudioEvidence, StudioIntakeTurn, StudioPlan, StudioProject, StudioRun } from '../src/model.js'
import type { PromptToAppJobService } from '../src/jobs.js'
import type { CodeGeneratorPort } from '../src/pipeline.js'
import { PlannerEngine } from '../src/planner.js'
import type { PromptModelPort } from '../src/ports.js'
import { PromptToAppService, type PromptToAppActor, type PromptToAppRepository } from '../src/service.js'

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

const validSpec: AppSpecV1 = {
  schema_version: 1, problem: 'Apresentar serviços para novos clientes.', audience: 'Clientes locais',
  journeys: ['Conhecer os serviços'], pages: [{ name: 'Início', sections: ['Serviços', 'Contato'] }],
  entities: [], sensitive_data: { detected: [], confirmed_by_user: false },
  accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true }, language: 'pt-BR',
  acceptance_criteria: ['A página apresenta os serviços com clareza.'],
}
const session = { session_id: 'session', user_id: 'owner', org_id: 'org-a', tenant_id: 'tenant-a' } as SessionRecord
const servers: ReturnType<typeof createServer>[] = []
const roots: string[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(options: {
  readonly emergencyStop?: { assertRunning(scope: { readonly orgId: string; readonly tenantId: string }): void }
  readonly codeContext?: PromptToAppHttpConfig['codeContext']
} = {}) {
  const repository = new MemoryRepository(); let id = 0
  const service = new PromptToAppService({ repository, now: () => new Date('2026-09-03T12:00:00.000Z'), createId: () => `id-${++id}` })
  const identity = { authenticate: vi.fn(() => Promise.resolve(session)), validateCsrf: vi.fn(), validateCsrfToken: vi.fn(),
    assertRequestTrust: vi.fn(),
  }
  const tenancy = { authorizationFor: vi.fn((userId: string, orgId: string, tenantId: string) => ({ userId, orgId, tenantId, role: 'owner' as const })) }
  const model: PromptModelPort = {
    complete: vi.fn((_scope, purpose, _privacy, prompt) => Promise.resolve(purpose === 'plan'
      ? { value: { slices: [{ slice_id: 'slice', title: 'Página', description: 'Criar a página', acceptance_criteria: ['Compila'], planned_files: ['content/app.json', 'src/GeneratedApp.tsx'] }] }, route: 'ollama', model: 'qwen' }
      : { value: prompt.startsWith('Recomende') ? 'Clientes atendidos pela empresa.' : validSpec, route: 'ollama', model: 'qwen' })),
  }
  const jobs = {
    start: vi.fn(async (actor: PromptToAppActor, _projectId: string, _generator: CodeGeneratorPort) => {
      service.assertAuthorized(actor, 'project.write')
      return { runId: 'run-1', jobId: 'studio-prompt-to-app-1' }
    }),
    cancel: vi.fn((actor: PromptToAppActor, _projectId: string) => {
      service.assertAuthorized(actor, 'project.write')
      return 'requested' as const
    }),
  }
  const allowedHosts: string[] = []; const allowedOrigins: string[] = []
  const planner = new PlannerEngine(model)
  const server = createServer(createPromptToAppHttpHandler({
    service, identity: identity as unknown as StudioIdentityService,
    tenancy: tenancy as unknown as StudioTenancyService,
    intake: new IntakeEngine(model), planner,
    ...(options.codeContext === undefined ? {} : { codeContext: options.codeContext }),
    jobs: jobs as unknown as PromptToAppJobService,
    logos: { process: vi.fn(async () => ({
      sha256: 'a'.repeat(64), relative_path: `logos/${'b'.repeat(64)}/${'a'.repeat(64)}.png`, mime: 'image/png' as const,
      size_bytes: 100, width: 10, height: 10, extracted_primary: { h: 217, s: 91, l: 50 },
    })) },
    generatorFor: () => ({ generate: vi.fn() }),
    health: vi.fn(() => Promise.resolve({ state: 'OK', route: 'ollama', route_reason: 'Modelo local saudável preferido para leitura segura.', route_reason_code: 'SAFE_READ_LOCAL', builder: 'OK', disk: 'OK' } as const)),
    allowedHosts, allowedOrigins,
    ...(options.emergencyStop === undefined ? {} : { emergencyStop: options.emergencyStop }),
  }))
  servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port; const host = `127.0.0.1:${port}`; const origin = `http://${host}`
  allowedHosts.push(host); allowedOrigins.push(origin)
  const headers = {
    host, origin, 'content-type': 'application/json',
    cookie: `${SESSION_COOKIE}=session; ${CSRF_COOKIE}=csrf`, 'x-dz23-csrf': 'csrf',
  }
  const request = (path: string, init: RequestInit = {}) => fetch(`${origin}/api/studio/apps${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } })
  return { request, service, repository, identity, tenancy, jobs, planner, allowedHosts, host }
}

describe('prompt-to-app HTTP boundary', () => {
  it('declares every route with authorization and no client-owned scope', () => {
    // A contagem sobe DE PROPÓSITO quando uma rota nasce: ela é o que impede
    // uma rota nova de aparecer sem alguém olhar a autorização dela.
    // 18 desde `POST /projects/:projectId/plan/slice` (E-03).
    expect(PROMPT_TO_APP_ROUTE_CONTRACTS).toHaveLength(18)
    expect(PROMPT_TO_APP_ROUTE_CONTRACTS.every(route => route.access === 'authorized' && route.permission !== null)).toBe(true)
  })

  it('serves real health and creates a scoped project without accepting scope fields', async () => {
    const f = await fixture()
    // O motivo viaja junto: sem ele a pessoa via o NOME da rota e nunca o porquê.
    expect(await (await f.request('/health')).json()).toEqual({
      state: 'OK', route: 'ollama', route_reason: 'Modelo local saudável preferido para leitura segura.', route_reason_code: 'SAFE_READ_LOCAL', builder: 'OK', disk: 'OK',
    })
    const created = await f.request('/projects', { method: 'POST', body: JSON.stringify({
      name: 'Meu site', original_brief: 'Quero apresentar meu trabalho.', category: 'landing-page', privacy: 'local-only',
    }) })
    expect(created.status).toBe(201)
    expect(f.repository.projectRows[0]).toMatchObject({ org_id: 'org-a', tenant_id: 'tenant-a', created_by: 'owner' })
    expect((await f.request('/projects', { method: 'POST', body: JSON.stringify({
      name: 'Ataque', original_brief: 'Tentar trocar a organização.', category: 'landing-page', privacy: 'any', org_id: 'other',
    }) })).status).toBe(400)
    expect((await f.request(`/projects/${f.repository.projectRows[0]!.project_id}/design`, { method: 'POST', body: JSON.stringify({ preset: 'professional' }) })).status).toBe(200)
    expect(f.repository.designRows[0]).toMatchObject({ org_id: 'org-a', tenant_id: 'tenant-a', design_spec: { preset: 'professional' } })
    expect((await f.request(`/projects/${f.repository.projectRows[0]!.project_id}/design`, { method: 'POST', body: JSON.stringify({ preset: 'brand' }) })).status).toBe(400)
    expect((await f.request(`/projects/${f.repository.projectRows[0]!.project_id}/design/logo`, { method: 'POST', body: new Uint8Array([137, 80, 78, 71]), headers: { 'content-type': 'image/png' } })).status).toBe(200)
    const details = await (await f.request(`/projects/${f.repository.projectRows[0]!.project_id}`)).json() as { design: { version: number }; runs: unknown[] }
    expect(details).toMatchObject({ design: { version: 2 }, runs: [] })
    expect((await f.request('/projects')).status).toBe(200)
    const form = await f.request('/projects', { method: 'POST', body: JSON.stringify({
      name: 'Cadastro', original_brief: 'Quero cadastrar contatos e consultar uma lista.', category: 'form-database', privacy: 'local-only',
    }) })
    expect(form.status).toBe(201)
    expect(f.repository.projectRows.at(-1)).toMatchObject({ category: 'form-database', org_id: 'org-a', tenant_id: 'tenant-a' })
  })

  it('runs idea through questions, plan approval and generation without skipping approval', async () => {
    const f = await fixture()
    const created = await (await f.request('/projects', { method: 'POST', body: JSON.stringify({
      name: 'Site', original_brief: 'Quero apresentar meus serviços.', category: 'landing-page', privacy: 'local-only',
    }) })).json() as { project: { project_id: string } }
    const projectId = created.project.project_id
    for (const answer of ['Clientes locais', 'Conhecer os serviços', 'Serviços e contato']) {
      expect((await f.request(`/projects/${projectId}/intake/answer`, { method: 'POST', body: JSON.stringify({ answer, recommend: false }) })).status).toBeLessThan(300)
    }
    expect(f.service.project({ userId: 'owner', orgId: 'org-a', tenantId: 'tenant-a', role: 'owner' }, projectId).state).toBe('SPEC_READY')
    expect((await f.request(`/projects/${projectId}/generate`, { method: 'POST', body: '{}' })).status).toBe(404)
    expect((await f.request(`/projects/${projectId}/plan`, { method: 'POST', body: '{}' })).status).toBe(201)
    expect((await f.request(`/projects/${projectId}/plan/change`, { method: 'POST', body: JSON.stringify({ reason: 'Mostrar o contato antes dos serviços.' }) })).status).toBe(200)
    expect(f.repository.planRows.some(value => value.status === 'CHANGE_REQUESTED')).toBe(true)
    const second = await f.request(`/projects/${projectId}/plan`, { method: 'POST', body: '{}' })
    expect(second.status).toBe(201)
    expect(f.repository.planRows).toHaveLength(2)
    const proposed = await second.json() as { plan: { revision?: number, slices: { slice_id: string, planned_files: string[] }[] } }
    // E-03: a pessoa edita o plano ANTES de aprovar, pela rota do produto.
    const first = proposed.plan.slices[0]!
    const edited = await f.request(`/projects/${projectId}/plan/edit`, { method: 'POST', body: JSON.stringify({
      base_revision: proposed.plan.revision ?? 1,
      slices: [{ slice_id: first.slice_id, title: 'Meus servicos', acceptance_criteria: ['a pessoa ve os servicos', 'a pessoa acha o telefone'] }],
    }) })
    expect(edited.status).toBe(200)
    const afterEdit = await edited.json() as { plan: { revision: number, edited_by_person: boolean, slices: { slice_id: string, title: string, planned_files: string[] }[] } }
    expect(afterEdit.plan.slices[0]).toMatchObject({ title: 'Meus servicos', planned_files: first.planned_files })
    expect(afterEdit.plan.edited_by_person).toBe(true)
    // Reenviar a mesma revisao e recusado com 409, e nao aceito por ser o ultimo a chegar.
    expect((await f.request(`/projects/${projectId}/plan/edit`, { method: 'POST', body: JSON.stringify({ base_revision: proposed.plan.revision ?? 1, removed: [first.slice_id] }) })).status).toBe(409)
    expect((await f.request(`/projects/${projectId}/plan/approve`, { method: 'POST', body: '{}' })).status).toBe(200)
    const accepted = await f.request(`/projects/${projectId}/generate`, { method: 'POST', body: '{}' })
    expect(accepted.status).toBe(202)
    expect(await accepted.json()).toEqual({ run_id: 'run-1' })
    expect(f.jobs.start).toHaveBeenCalledOnce()
    expect(f.jobs.start.mock.calls[0]![0]).toMatchObject({ sessionId: 'session', orgId: 'org-a', tenantId: 'tenant-a' })
    expect((await f.request(`/projects/${projectId}/generate/cancel`, { method: 'POST', body: '{}' })).status).toBe(202)
    expect(f.jobs.cancel).toHaveBeenCalledOnce()
  })

  it('returns captured development codes only after a verified run and only in project details', async () => {
    const f = await fixture()
    const actor = { userId: 'owner', orgId: 'org-a', tenantId: 'tenant-a', role: 'owner' as const }
    const project = await f.service.createProject(actor, {
      name: 'Painel', original_brief: 'Quero gerenciar clientes com acesso protegido.', category: 'crud-panel', privacy: 'local-only',
    })
    const runDirectory = await mkdtemp(join(tmpdir(), 'dz23-http-capture-')); roots.push(runDirectory)
    await mkdir(resolve(runDirectory, 'data'))
    await writeFile(resolve(runDirectory, 'data', 'studio-capture.json'), JSON.stringify([
      { kind: 'code', email: 'owner@example.test', code: '123456', expiresAt: '2026-09-03T12:10:00.000Z' },
      { kind: 'invitation', email: 'member@example.test', expiresAt: '2026-09-04T12:00:00.000Z' },
    ]))
    f.repository.runRows.push({
      run_id: 'verified-run', operation_id: 'verified-run', owner_session_id: 'session', plan_id: 'plan', project_id: project.project_id,
      org_id: 'org-a', tenant_id: 'tenant-a', stage: 'verify', attempt: 1, state: 'PASSED', started_at: '2026-09-03T12:00:00.000Z',
      finished_at: '2026-09-03T12:01:00.000Z', sandbox: 'full', route: 'ollama', model: 'fixture', input_tokens: 1, output_tokens: 1,
      estimated_cost_usd: 0, run_directory: runDirectory, failure_code: null, acceptance_checks: [],
    })
    const hidden = await (await f.request(`/projects/${project.project_id}`)).json() as { current_run: { verification_codes: unknown[] }; runs: unknown[] }
    expect(hidden.current_run.verification_codes).toEqual([])
    f.repository.projectRows[0] = { ...f.repository.projectRows[0]!, state: 'VERIFIED_PROTOTYPE' }
    const visible = await (await f.request(`/projects/${project.project_id}`)).json() as { current_run: { verification_codes: unknown[] }; runs: unknown[] }
    expect(visible.current_run.verification_codes).toEqual([{ email: 'owner@example.test', code: '123456', expires_at: '2026-09-03T12:10:00.000Z' }])
    expect(JSON.stringify(visible.runs)).not.toContain('123456')
  })

  it('requires membership, session, CSRF, trusted host and a known route', async () => {
    const f = await fixture()
    f.tenancy.authorizationFor.mockImplementationOnce(() => undefined as never)
    expect((await f.request('/projects')).status).toBe(403)
    f.identity.authenticate.mockRejectedValueOnce(new IdentityError('invalid', 'Entre'))
    expect((await f.request('/projects')).status).toBe(401)
    f.identity.validateCsrfToken.mockImplementationOnce(() => { throw new IdentityError('csrf', 'csrf') })
    expect((await f.request('/projects', { method: 'POST', body: '{}' })).status).toBe(401)
    f.allowedHosts.splice(0)
    expect((await f.request('/projects')).status).toBe(401)
    f.allowedHosts.push(f.host)
    expect((await f.request('/missing')).status).toBe(404)
  })

  it('returns 403 when a viewer tries to start or cancel generation', async () => {
    const f = await fixture()
    const owner = { userId: 'owner', orgId: 'org-a', tenantId: 'tenant-a', role: 'owner' as const }
    const project = await f.service.createProject(owner, {
      name: 'Projeto protegido', original_brief: 'Quero um projeto protegido por permissões.', category: 'landing-page', privacy: 'local-only',
    })
    await f.service.saveSpec(owner, project.project_id, validSpec, 'intake')
    await f.service.proposePlan(owner, project.project_id, [{
      slice_id: 'slice-protected', title: 'Página', description: 'Criar a página protegida.',
      acceptance_criteria: ['Compila'], planned_files: ['content/app.json', 'src/GeneratedApp.tsx'],
    }])
    await f.service.approvePlan(owner, project.project_id)
    f.tenancy.authorizationFor.mockReturnValue({ userId: 'owner', orgId: 'org-a', tenantId: 'tenant-a', role: 'viewer' } as never)

    expect((await f.request(`/projects/${project.project_id}/generate`, { method: 'POST', body: '{}' })).status).toBe(403)
    expect((await f.request(`/projects/${project.project_id}/generate/cancel`, { method: 'POST', body: '{}' })).status).toBe(403)
    expect((await f.request(`/projects/${project.project_id}/design`, { method: 'POST', body: JSON.stringify({ preset: 'modern' }) })).status).toBe(403)
    expect(f.jobs.start).toHaveBeenCalledOnce()
    expect(f.jobs.cancel).toHaveBeenCalledOnce()
  })

  it('keeps a project invisible across organizations even with adversarial route and body input', async () => {
    const f = await fixture()
    const created = await (await f.request('/projects', { method: 'POST', body: JSON.stringify({
      name: 'Projeto da organização A', original_brief: 'Quero uma página para a organização A.', category: 'landing-page', privacy: 'local-only',
    }) })).json() as { project: { project_id: string } }
    const projectId = created.project.project_id
    const attacker = { session_id: 'attacker-session', user_id: 'attacker', org_id: 'org-b', tenant_id: 'tenant-b' } as SessionRecord
    const asAttacker = (path: string, init: RequestInit = {}) => {
      f.identity.authenticate.mockResolvedValueOnce(attacker)
      return f.request(path, init)
    }

    expect((await asAttacker(`/projects/${projectId}?org_id=org-a&tenant_id=tenant-a`)).status).toBe(404)
    expect((await asAttacker(`/projects/${projectId}/intake/answer`, {
      method: 'POST', body: JSON.stringify({ answer: 'Roubar escopo', recommend: false, org_id: 'org-a', tenant_id: 'tenant-a' }),
    })).status).toBe(400)
    expect((await asAttacker(`/projects/${projectId}/plan`, { method: 'POST', body: JSON.stringify({ org_id: 'org-a' }) })).status).toBe(404)
    expect((await asAttacker(`/projects/${projectId}/design`, { method: 'POST', body: JSON.stringify({ preset: 'modern' }) })).status).toBe(404)
    expect((await asAttacker(`/projects/${projectId}/plan/change`, { method: 'POST', body: JSON.stringify({ reason: 'Tentar alterar o plano alheio.' }) })).status).toBe(404)
    expect((await asAttacker(`/projects/${projectId}/plan/edit`, { method: 'POST', body: JSON.stringify({ base_revision: 1, removed: ['s1'] }) })).status).toBe(404)
    expect((await asAttacker(`/projects/${projectId}`, { method: 'DELETE', body: JSON.stringify({ org_id: 'org-a' }) })).status).toBe(404)
    expect(f.repository.projectRows).toHaveLength(1)
    expect(f.repository.projectRows[0]).toMatchObject({ org_id: 'org-a', tenant_id: 'tenant-a', archived_at: null })
  })

  it('covers recommendation, completed-intake replay, and both sensitive-data decisions', async () => {
    const f = await fixture()
    const normal = await (await f.request('/projects', { method: 'POST', body: JSON.stringify({
      name: 'Normal', original_brief: 'Quero apresentar serviços.', category: 'landing-page', privacy: 'local-only',
    }) })).json() as { project: { project_id: string } }
    expect((await f.request(`/projects/${normal.project.project_id}/intake/answer`, {
      method: 'POST', body: JSON.stringify({ answer: '', recommend: true }),
    })).status).toBe(200)
    expect(f.repository.turnRows.at(-1)).toMatchObject({ answer: 'Clientes atendidos pela empresa.', recommended: true, route: 'ollama' })
    expect((await f.request(`/projects/${normal.project.project_id}/intake/answer`, {
      method: 'POST', body: JSON.stringify({ answer: 'Objetivo', recommend: false }),
    })).status).toBe(200)
    expect((await f.request(`/projects/${normal.project.project_id}/intake/answer`, {
      method: 'POST', body: JSON.stringify({ answer: 'Conteúdo', recommend: false }),
    })).status).toBe(201)
    expect((await f.request(`/projects/${normal.project.project_id}/intake/answer`, {
      method: 'POST', body: JSON.stringify({ answer: 'replay', recommend: false }),
    })).status).toBe(409)

    const refused = await (await f.request('/projects', { method: 'POST', body: JSON.stringify({
      name: 'Sensível recusado', original_brief: 'Cadastro com CPF de clientes.', category: 'form-database', privacy: 'local-only',
    }) })).json() as { project: { project_id: string } }
    expect((await f.request(`/projects/${refused.project.project_id}/intake/answer`, {
      method: 'POST', body: JSON.stringify({ answer: '' }),
    })).status).toBe(400)
    expect(await (await f.request(`/projects/${refused.project.project_id}/intake/answer`, {
      method: 'POST', body: JSON.stringify({ answer: '', confirm_sensitive: false }),
    })).json()).toMatchObject({ blocked: true })

    const confirmed = await (await f.request('/projects', { method: 'POST', body: JSON.stringify({
      name: 'Sensível confirmado', original_brief: 'Cadastro com CPF de clientes.', category: 'form-database', privacy: 'local-only',
    }) })).json() as { project: { project_id: string } }
    expect(await (await f.request(`/projects/${confirmed.project.project_id}/intake/answer`, {
      method: 'POST', body: JSON.stringify({ answer: '', confirm_sensitive: true }),
    })).json()).toMatchObject({ next: { id: 'audience' } })
  })

  it('sorts current runs, hides unavailable captures, locks out sessions, and archives as owner', async () => {
    const f = await fixture()
    const actor = { userId: 'owner', orgId: 'org-a', tenantId: 'tenant-a', role: 'owner' as const }
    const project = await f.service.createProject(actor, {
      name: 'Lifecycle', original_brief: 'Projeto para conferir ciclo.', category: 'landing-page', privacy: 'local-only',
    })
    f.repository.projectRows[0] = { ...f.repository.projectRows[0]!, state: 'VERIFIED_PROTOTYPE' }
    for (const attempt of [1, 2]) f.repository.runRows.push({
      run_id: `run-${attempt}`, operation_id: `run-${attempt}`, owner_session_id: 'session', plan_id: 'plan', project_id: project.project_id,
      org_id: 'org-a', tenant_id: 'tenant-a', stage: 'verify', attempt, state: 'PASSED', started_at: '2026-09-03T12:00:00.000Z',
      finished_at: '2026-09-03T12:01:00.000Z', sandbox: 'full', route: 'ollama', model: 'fixture', input_tokens: 1, output_tokens: 1,
      estimated_cost_usd: 0, run_directory: 'not-created', failure_code: null, acceptance_checks: [],
    })
    const details = await (await f.request(`/projects/${project.project_id}`)).json() as { current_run: { run_id: string; verification_codes: unknown[] } }
    expect(details.current_run).toMatchObject({ run_id: 'run-2', verification_codes: [] })

    f.identity.authenticate.mockRejectedValueOnce(new IdentityError('locked', 'Aguarde'))
    expect((await f.request('/projects')).status).toBe(429)
    expect((await f.request('/projects', { method: 'POST', body: '{invalid' })).status).toBe(400)
    expect((await f.request(`/projects/${project.project_id}`, { method: 'DELETE', body: '{}' })).status).toBe(200)
    expect(f.repository.projectRows[0]?.archived_at).not.toBeNull()
  })
})

describe('E-11: a parada de emergência na porta de /api/studio/apps', () => {
  function stopped() {
    const error = new Error('O Studio está parado por uma parada de emergência.') as Error & { code?: string }
    error.code = 'STOPPED'
    return error
  }

  it('POST /generate responde 409 com a frase da parada, e o trabalho não é iniciado', async () => {
    const f = await fixture({ emergencyStop: { assertRunning: () => { throw stopped() } } })
    const created = await (await f.request('/projects', { method: 'POST', body: JSON.stringify({
      name: 'Meu site', original_brief: 'Quero apresentar meu trabalho.', category: 'landing-page', privacy: 'local-only',
    }) })).json() as { project: { project_id: string } }
    const projectId = created.project.project_id
    await f.service.saveSpec({ userId: 'owner', orgId: 'org-a', tenantId: 'tenant-a', role: 'owner' }, projectId, validSpec, 'intake')
    await f.request(`/projects/${projectId}/plan`, { method: 'POST', body: '{}' })
    await f.request(`/projects/${projectId}/plan/approve`, { method: 'POST', body: '{}' })
    const refused = await f.request(`/projects/${projectId}/generate`, { method: 'POST', body: '{}' })
    // 409, e não 500: a tela precisa distinguir "o Studio está parado de
    // propósito" de "algo quebrou".
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({ error: expect.stringContaining('parada de emergência') })
    expect(f.jobs.start).not.toHaveBeenCalled()
  })

  it('uma rota de espaço de trabalho não reivindicada continua sendo 404', async () => {
    const f = await fixture()
    expect((await f.request('/emergency-stop')).status).toBe(404)
  })

  it('uma fatia de espaço de trabalho recebe o pedido JÁ autenticado, com papel e escopo resolvidos', async () => {
    // É assim que o botão de emergência entra sem abrir uma segunda autoridade
    // sobre `/api/studio/apps`: quem diz quem é a pessoa continua sendo o
    // núcleo, e a fatia só decide o que fazer.
    const seen: unknown[] = []
    const unregister = registerPromptToAppWorkspaceHttpExtension(async input => {
      if (input.suffix !== '/emergency-stop') return false
      seen.push(input.actor)
      input.response.writeHead(200, { 'content-type': 'application/json' })
      input.response.end('{"ok":true}')
      return true
    })
    try {
      const f = await fixture()
      const response = await f.request('/emergency-stop')
      expect(response.status).toBe(200)
      expect(seen).toEqual([{ userId: 'owner', orgId: 'org-a', tenantId: 'tenant-a', role: 'owner', sessionId: 'session' }])
      // E a mutação da fatia passa pelo MESMO CSRF das outras: o núcleo o valida
      // antes de a fatia ver o pedido.
      f.identity.validateCsrfToken.mockImplementationOnce(() => { throw new IdentityError('csrf', 'csrf') })
      expect((await f.request('/emergency-stop', { method: 'POST', body: '{}' })).status).toBe(401)
      expect(seen).toHaveLength(1)
    } finally {
      unregister()
    }
  })
})

describe('E-08: pontos de retorno e desfazer na porta HTTP', () => {
  /** Um projeto com uma execução gravada, do jeito que o pipeline a grava. */
  async function projectWithRun(f: Awaited<ReturnType<typeof fixture>>, run: Partial<StudioRun>) {
    const created = await (await f.request('/projects', { method: 'POST', body: JSON.stringify({
      name: 'Meu site', original_brief: 'Quero apresentar meu trabalho.', category: 'landing-page', privacy: 'privado-local',
    }) })).json() as { project: { project_id: string } }
    const projectId = created.project.project_id
    f.repository.runRows = [{
      run_id: 'attempt-1', operation_id: 'attempt-1', owner_session_id: 'session', plan_id: 'plan', project_id: projectId,
      org_id: 'org-a', tenant_id: 'tenant-a', stage: 'verify', attempt: 1, state: 'BLOCKED_EXTERNAL',
      started_at: '2026-09-03T12:00:00.000Z', finished_at: '2026-09-03T12:01:00.000Z', sandbox: 'full',
      route: 'ollama', model: 'qwen', input_tokens: null, output_tokens: null, estimated_cost_usd: null,
      run_directory: '/runs/attempt-1', artifact_sha256: null, failure_code: 'ACCEPTANCE_ATTESTATION_UNAVAILABLE',
      acceptance_checks: [], ...run,
    } as StudioRun]
    return projectId
  }

  it('lista os pontos e diz POR QUE não há ponto seguro, sem inventar um', async () => {
    const f = await fixture()
    const projectId = await projectWithRun(f, {})
    const response = await f.request(`/projects/${projectId}/checkpoints`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      green_run_id: null, reason: 'ACCEPTANCE_ATTESTATION_UNAVAILABLE', current_run_id: null,
      checkpoints: [{ run_id: 'attempt-1', green: false, blocker: 'ACCEPTANCE_ATTESTATION_UNAVAILABLE' }],
    })
    // E desfazer para essa tentativa é recusado: ela não é um ponto seguro.
    const refused = await f.request(`/projects/${projectId}/undo`, { method: 'POST', body: JSON.stringify({ run_id: 'attempt-1' }) })
    expect(refused.status).toBe(400)
  })

  it('desfazer para um ponto seguro muda o estado e a tentativa corrente, sem apagar tentativa nenhuma', async () => {
    const f = await fixture()
    const projectId = await projectWithRun(f, {
      state: 'PASSED', failure_code: null, template_integrity: 'VERIFIED', artifact_sha256: 'a'.repeat(64),
    })
    f.repository.projectRows = f.repository.projectRows.map(project => ({ ...project, state: 'BUILD_FAILED' as const }))
    const response = await f.request(`/projects/${projectId}/undo`, { method: 'POST', body: JSON.stringify({ run_id: 'attempt-1' }) })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      project: { state: 'VERIFIED_PROTOTYPE', current_run_id: 'attempt-1' },
      checkpoint: { run_id: 'attempt-1', green: true },
    })
    // O histórico continua inteiro, e a leitura do projeto passa a mostrar a
    // tentativa escolhida como a corrente.
    expect(f.repository.runRows).toHaveLength(1)
    const details = await (await f.request(`/projects/${projectId}`)).json() as { current_run: { run_id: string } }
    expect(details.current_run.run_id).toBe('attempt-1')
  })

  it('a rota de leitura não aceita mutação, e a de desfazer não aceita leitura', async () => {
    const f = await fixture()
    const projectId = await projectWithRun(f, {})
    expect((await f.request(`/projects/${projectId}/checkpoints`, { method: 'POST', body: '{}' })).status).toBe(404)
    expect((await f.request(`/projects/${projectId}/undo`)).status).toBe(404)
  })
})

describe('o inventario do codigo no planejamento de mudanca', () => {
  async function ate(f: Awaited<ReturnType<typeof fixture>>) {
    const created = await (await f.request('/projects', { method: 'POST', body: JSON.stringify({
      name: 'Site', original_brief: 'Quero apresentar meus serviços.', category: 'landing-page', privacy: 'local-only',
    }) })).json() as { project: { project_id: string } }
    const projectId = created.project.project_id
    for (const answer of ['Clientes locais', 'Conhecer os serviços', 'Serviços e contato']) {
      await f.request(`/projects/${projectId}/intake/answer`, { method: 'POST', body: JSON.stringify({ answer, recommend: false }) })
    }
    return projectId
  }

  const INVENTARIO = {
    index: buildCodeIndex([{ path: 'src/lib/validacao.ts', text: 'export function validar() { return true }\n' }]),
  }

  it('o primeiro plano NAO le o inventario: nao ha codigo ainda', async () => {
    // Ler o disco para um plano novo e trabalho por nada, e o resultado seria
    // descartado pelo proprio planejador.
    const codeContext = vi.fn(async () => INVENTARIO)
    const f = await fixture({ codeContext })
    const projectId = await ate(f)
    expect((await f.request(`/projects/${projectId}/plan`, { method: 'POST', body: '{}' })).status).toBe(201)
    expect(codeContext).not.toHaveBeenCalled()
  })

  it('depois de um pedido de MUDANCA, o inventario e lido e chega ao planejamento', async () => {
    const codeContext = vi.fn(async () => INVENTARIO)
    const f = await fixture({ codeContext })
    const projectId = await ate(f)
    await f.request(`/projects/${projectId}/plan`, { method: 'POST', body: '{}' })
    await f.request(`/projects/${projectId}/plan/change`, { method: 'POST', body: JSON.stringify({ reason: 'Mostrar o contato antes.' }) })
    expect((await f.request(`/projects/${projectId}/plan`, { method: 'POST', body: '{}' })).status).toBe(201)
    expect(codeContext).toHaveBeenCalledTimes(1)
    expect(f.planner.lastCode?.join('\n')).toContain('src/lib/validacao.ts exporta: validar')
  })

  it('sem leitor montado, o planejamento de mudanca continua acontecendo', async () => {
    // Um perfil que nao monta isto planeja mudanca sem inventario, como antes.
    // O que ele NAO faz e planejar com inventario vazio, que seria afirmar que
    // o aplicativo nao tem nada.
    const f = await fixture()
    const projectId = await ate(f)
    await f.request(`/projects/${projectId}/plan`, { method: 'POST', body: '{}' })
    await f.request(`/projects/${projectId}/plan/change`, { method: 'POST', body: JSON.stringify({ reason: 'Mostrar o contato antes.' }) })
    expect((await f.request(`/projects/${projectId}/plan`, { method: 'POST', body: '{}' })).status).toBe(201)
    expect(f.planner.lastCode).toBeUndefined()
  })

  it('leitor que devolve `undefined` NAO vira inventario vazio', async () => {
    // Vazio diria ao planejador que o aplicativo nao tem codigo, e ele mandaria
    // criar tudo de novo por cima do que esta la.
    const f = await fixture({ codeContext: async () => undefined })
    const projectId = await ate(f)
    await f.request(`/projects/${projectId}/plan`, { method: 'POST', body: '{}' })
    await f.request(`/projects/${projectId}/plan/change`, { method: 'POST', body: JSON.stringify({ reason: 'Mostrar o contato antes.' }) })
    expect((await f.request(`/projects/${projectId}/plan`, { method: 'POST', body: '{}' })).status).toBe(201)
    expect(f.planner.lastCode).toBeUndefined()
  })
})
