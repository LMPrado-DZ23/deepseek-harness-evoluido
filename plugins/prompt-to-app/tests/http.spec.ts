import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CSRF_COOKIE, IdentityError, SESSION_COOKIE, type SessionRecord, type StudioIdentityService } from '@dz23-studio/identity'
import type { StudioTenancyService } from '@dz23-studio/tenancy'
import type { AppSpecV1 } from '../src/appspec.js'
import { createPromptToAppHttpHandler, PROMPT_TO_APP_ROUTE_CONTRACTS } from '../src/http.js'
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
afterEach(async () => Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))))

async function fixture() {
  const repository = new MemoryRepository(); let id = 0
  const service = new PromptToAppService({ repository, now: () => new Date('2026-09-03T12:00:00.000Z'), createId: () => `id-${++id}` })
  const identity = { authenticate: vi.fn(() => Promise.resolve(session)), validateCsrf: vi.fn() }
  const tenancy = { authorizationFor: vi.fn((userId: string, orgId: string, tenantId: string) => ({ userId, orgId, tenantId, role: 'owner' as const })) }
  const model: PromptModelPort = {
    complete: vi.fn((_scope, purpose) => Promise.resolve(purpose === 'plan'
      ? { value: { slices: [{ slice_id: 'slice', title: 'Página', description: 'Criar a página', acceptance_criteria: ['Compila'], planned_files: ['content/app.json', 'src/GeneratedApp.tsx'] }] }, route: 'ollama', model: 'qwen' }
      : { value: validSpec, route: 'ollama', model: 'qwen' })),
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
  const server = createServer(createPromptToAppHttpHandler({
    service, identity: identity as unknown as StudioIdentityService,
    tenancy: tenancy as unknown as StudioTenancyService,
    intake: new IntakeEngine(model), planner: new PlannerEngine(model),
    jobs: jobs as unknown as PromptToAppJobService,
    logos: { process: vi.fn(async () => ({
      sha256: 'a'.repeat(64), relative_path: `logos/${'b'.repeat(64)}/${'a'.repeat(64)}.png`, mime: 'image/png' as const,
      size_bytes: 100, width: 10, height: 10, extracted_primary: { h: 217, s: 91, l: 50 },
    })) },
    generatorFor: () => ({ generate: vi.fn() }),
    health: vi.fn(() => Promise.resolve({ state: 'OK', route: 'ollama', builder: 'OK', disk: 'OK' } as const)),
    allowedHosts, allowedOrigins,
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
  return { request, service, repository, identity, tenancy, jobs, allowedHosts, host }
}

describe('prompt-to-app HTTP boundary', () => {
  it('declares every route with authorization and no client-owned scope', () => {
    expect(PROMPT_TO_APP_ROUTE_CONTRACTS).toHaveLength(13)
    expect(PROMPT_TO_APP_ROUTE_CONTRACTS.every(route => route.access === 'authorized' && route.permission !== null)).toBe(true)
  })

  it('serves real health and creates a scoped project without accepting scope fields', async () => {
    const f = await fixture()
    expect(await (await f.request('/health')).json()).toEqual({ state: 'OK', route: 'ollama', builder: 'OK', disk: 'OK' })
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
    expect((await f.request(`/projects/${projectId}/plan`, { method: 'POST', body: '{}' })).status).toBe(201)
    expect(f.repository.planRows).toHaveLength(2)
    expect((await f.request(`/projects/${projectId}/plan/approve`, { method: 'POST', body: '{}' })).status).toBe(200)
    const accepted = await f.request(`/projects/${projectId}/generate`, { method: 'POST', body: '{}' })
    expect(accepted.status).toBe(202)
    expect(await accepted.json()).toEqual({ run_id: 'run-1' })
    expect(f.jobs.start).toHaveBeenCalledOnce()
    expect(f.jobs.start.mock.calls[0]![0]).toMatchObject({ sessionId: 'session', orgId: 'org-a', tenantId: 'tenant-a' })
    expect((await f.request(`/projects/${projectId}/generate/cancel`, { method: 'POST', body: '{}' })).status).toBe(202)
    expect(f.jobs.cancel).toHaveBeenCalledOnce()
  })

  it('requires membership, session, CSRF, trusted host and a known route', async () => {
    const f = await fixture()
    f.tenancy.authorizationFor.mockImplementationOnce(() => undefined as never)
    expect((await f.request('/projects')).status).toBe(403)
    f.identity.authenticate.mockRejectedValueOnce(new IdentityError('invalid', 'Entre'))
    expect((await f.request('/projects')).status).toBe(401)
    f.identity.validateCsrf.mockImplementationOnce(() => { throw new IdentityError('csrf', 'csrf') })
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
    expect((await asAttacker(`/projects/${projectId}`, { method: 'DELETE', body: JSON.stringify({ org_id: 'org-a' }) })).status).toBe(404)
    expect(f.repository.projectRows).toHaveLength(1)
    expect(f.repository.projectRows[0]).toMatchObject({ org_id: 'org-a', tenant_id: 'tenant-a', archived_at: null })
  })
})
