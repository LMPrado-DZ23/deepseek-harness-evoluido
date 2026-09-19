import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { conferido } from './registro-conferido.js'
import { CSRF_COOKIE, SESSION_COOKIE, type SessionRecord, type StudioIdentityService } from '@dz23-studio/identity'
import type { StudioTenancyService } from '@dz23-studio/tenancy'
import type { AppSpecV1 } from '../src/appspec.js'
import { createPromptToAppHttpHandler } from '../src/http.js'
import { IntakeEngine } from '../src/intake.js'
import { esquemaDoPedido } from '../src/index.js'
import { respostasLidas } from '../src/leitura.js'
import type { StudioCreationKey, StudioApproval, StudioAppSpecRecord, StudioDesignSpecRecord, StudioEvidence, StudioIntakeTurn, StudioPlan, StudioProject, StudioRun } from '../src/model.js'
import type { PromptToAppJobService } from '../src/jobs.js'
import { PlannerEngine } from '../src/planner.js'
import { ModelRouteUnavailableError, type PromptModelPort, type PropositoDoModelo } from '../src/ports.js'
import { PromptToAppService, type PromptToAppRepository } from '../src/service.js'

/*
  PLAN-01 — perguntar só o que falta, aproveitar várias respostas de uma vez,
  "Não sei, recomende", e corrigir uma resposta sem recomeçar.
*/

class MemoryRepository implements PromptToAppRepository {
  projectRows: StudioProject[] = []; specRows: StudioAppSpecRecord[] = []; designRows: StudioDesignSpecRecord[] = []; turnRows: StudioIntakeTurn[] = []
  planRows: StudioPlan[] = []; runRows: StudioRun[] = []; evidenceRows: StudioEvidence[] = []; approvalRows: StudioApproval[] = []
  keyRows: StudioCreationKey[] = []
  projects = () => this.projectRows; specs = () => this.specRows; designs = () => this.designRows; turns = () => this.turnRows; plans = () => this.planRows
  runs = () => this.runRows; evidence = () => this.evidenceRows; approvals = () => this.approvalRows; creationKeys = () => this.keyRows
  putProject = async (v: StudioProject) => { this.projectRows = up(this.projectRows, conferido(v, 'project_id'), 'project_id') }
  putSpec = async (v: StudioAppSpecRecord) => { this.specRows = up(this.specRows, conferido(v, 'spec_id'), 'spec_id') }
  putDesign = async (v: StudioDesignSpecRecord) => { this.designRows = up(this.designRows, conferido(v, 'design_id'), 'design_id') }
  putTurn = async (v: StudioIntakeTurn) => { this.turnRows = up(this.turnRows, conferido(v, 'turn_id'), 'turn_id') }
  putPlan = async (v: StudioPlan) => { this.planRows = up(this.planRows, conferido(v, 'plan_id'), 'plan_id') }
  putRun = async (v: StudioRun) => { this.runRows = up(this.runRows, conferido(v, 'run_id'), 'run_id') }
  putEvidence = async (v: StudioEvidence) => { this.evidenceRows = up(this.evidenceRows, conferido(v, 'evidence_id'), 'evidence_id') }
  putApproval = async (v: StudioApproval) => { this.approvalRows = up(this.approvalRows, conferido(v, 'approval_id'), 'approval_id') }
  putCreationKey = async (v: StudioCreationKey) => { this.keyRows = [...this.keyRows.filter(r => r.request_key !== v.request_key), v] }
}
function up<T, K extends keyof T>(rows: T[], value: T, key: K): T[] { return [...rows.filter(row => row[key] !== value[key]), value] }

function spec(audience: string): AppSpecV1 {
  return {
    schema_version: 1, problem: 'Controlar notas da turma.', audience,
    journeys: ['Lançar notas'], pages: [{ name: 'Início', sections: ['Notas'] }],
    entities: [], sensitive_data: { detected: [], confirmed_by_user: false },
    accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true }, language: 'pt-BR',
    acceptance_criteria: ['A lista mostra as notas.'],
  }
}

interface Chamada { readonly purpose: PropositoDoModelo; readonly prompt: string }

const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r())))) })

async function fixture(leitura: () => unknown) {
  const repository = new MemoryRepository(); let id = 0; let relogio = Date.parse('2026-09-19T12:00:00.000Z')
  // O relógio ANDA: a especificação desatualizada é decidida por data.
  const service = new PromptToAppService({ repository, now: () => new Date(relogio += 1_000), createId: () => `id-${++id}` })
  const chamadas: Chamada[] = []
  const falhas = { intake: false, leitura: false }
  const model: PromptModelPort = {
    complete: vi.fn(async (_scope, purpose: PropositoDoModelo, _privacy, prompt: string) => {
      chamadas.push({ purpose, prompt })
      if (purpose === 'leitura') {
        if (falhas.leitura) throw new ModelRouteUnavailableError('sem rota')
        return { value: leitura(), route: 'ollama', model: 'qwen' }
      }
      if (purpose === 'plan') {
        return { value: { slices: [{ slice_id: 's', title: 'Página', description: 'Criar', acceptance_criteria: ['Compila'], planned_files: ['content/app.json', 'src/GeneratedApp.tsx'] }] }, route: 'ollama', model: 'qwen' }
      }
      if (prompt.startsWith('Recomende')) return { value: 'Professores da escola.', route: 'ollama', model: 'qwen' }
      if (falhas.intake) throw new ModelRouteUnavailableError('sem rota')
      return { value: spec('Professores'), route: 'ollama', model: 'qwen' }
    }),
  }
  const session = { session_id: 's', user_id: 'owner', org_id: 'org-a', tenant_id: 'tenant-a' } as SessionRecord
  const identity = {
    authenticate: vi.fn((token: string) => Promise.resolve(token.startsWith('session:') ? { ...session, org_id: token.slice(8), tenant_id: token.slice(8) } : session)),
    validateCsrf: vi.fn(), validateCsrfToken: vi.fn(), assertRequestTrust: vi.fn(),
  }
  const tenancy = { authorizationFor: vi.fn((userId: string, orgId: string, tenantId: string) => ({ userId, orgId, tenantId, role: 'owner' as const })) }
  const allowedHosts: string[] = []; const allowedOrigins: string[] = []
  const server = createServer(createPromptToAppHttpHandler({
    service, identity: identity as unknown as StudioIdentityService, tenancy: tenancy as unknown as StudioTenancyService,
    intake: new IntakeEngine(model), planner: new PlannerEngine(model),
    jobs: { start: vi.fn(), cancel: vi.fn() } as unknown as PromptToAppJobService,
    logos: { process: vi.fn() }, generatorFor: () => ({ generate: vi.fn() }),
    health: vi.fn(() => Promise.resolve({ state: 'OK', route: 'ollama', route_reason: 'ok', route_reason_code: 'SAFE_READ_LOCAL', builder: 'OK', disk: 'OK' } as const)),
    allowedHosts, allowedOrigins,
  }))
  servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`; const origin = `http://${host}`
  allowedHosts.push(host); allowedOrigins.push(origin)
  const headers = { host, origin, 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=session; ${CSRF_COOKIE}=csrf`, 'x-dz23-csrf': 'csrf' }
  const request = (path: string, init: RequestInit = {}) => fetch(`${origin}/api/studio/apps${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } })
  const post = (path: string, body: unknown, extra: RequestInit = {}) => request(path, { method: 'POST', body: JSON.stringify(body), ...extra })
  const criar = async (brief: string) => {
    const r = await (await post('/projects', { name: 'Notas', original_brief: brief, category: 'landing-page', privacy: 'local-only' })).json() as { project: { project_id: string } }
    return r.project.project_id
  }
  const respostas = (projectId: string) => repository.turnRows.filter(t => t.project_id === projectId)
  return { request, post, criar, respostas, repository, chamadas, falhas, model }
}

describe('PLAN-01 — a leitura do que a pessoa já disse', () => {
  it('lê o JSON do modelo, cercado ou não, e devolve só o que falta e não é vazio', () => {
    expect(respostasLidas('```json\n{"audience":"x","goal":"Lançar notas","content":null}\n```', ['goal', 'content'])).toEqual({ goal: 'Lançar notas' })
    expect(respostasLidas({ goal: '  ', content: 'Notas e alunos', extra: 1 }, ['goal', 'content'])).toEqual({ content: 'Notas e alunos' })
    expect(respostasLidas({ goal: 'Lançar' }, ['content'])).toEqual({})
    // Resposta ilegível vira "não li nada", e não erro: a conversa continua perguntando.
    expect(respostasLidas('não sei responder', ['goal'])).toEqual({})
    expect(respostasLidas({ goal: 42 }, ['goal'])).toEqual({})
  })

  it('tem gramática própria no servidor local, e o intake continua sem', () => {
    const esquema = esquemaDoPedido('leitura') as { properties: Record<string, unknown> }
    expect(Object.keys(esquema.properties).sort()).toEqual(['audience', 'content', 'goal'])
    expect(esquemaDoPedido('intake')).toBeUndefined()
  })

  it('um pedido completo pula as perguntas que ele já responde, e grava a leitura como RECOMENDADA', async () => {
    const f = await fixture(() => ({ audience: null, goal: 'Lançar e consultar notas', content: 'Alunos, disciplinas e notas' }))
    const projectId = await f.criar('Quero um app para professores lançarem e consultarem notas de alunos por disciplina.')
    const r = await f.post(`/projects/${projectId}/intake/answer`, { answer: 'Professores', recommend: false })
    expect(r.status).toBe(201)
    const corpo = await r.json() as { spec: unknown; inferred: StudioIntakeTurn[] }
    expect(corpo.spec).toBeDefined()
    expect(corpo.inferred.map(t => [t.question_id, t.answer, t.recommended, t.route])).toEqual([
      ['goal', 'Lançar e consultar notas', true, 'ollama'], ['content', 'Alunos, disciplinas e notas', true, 'ollama'],
    ])
    const leituras = f.chamadas.filter(c => c.purpose === 'leitura')
    expect(leituras).toHaveLength(1)
    // Só o que falta entra no prompt: a pergunta já respondida não é paga de novo.
    expect(leituras[0]!.prompt).not.toContain('Para quem você quer criar')
    expect(leituras[0]!.prompt).toContain('O que a pessoa deve conseguir fazer')
    expect(leituras[0]!.prompt).toContain('Professores')
    // A resposta da pessoa é dela; a da leitura é recomendada.
    expect(f.respostas(projectId).map(t => [t.question_id, t.recommended])).toEqual([['audience', false], ['goal', true], ['content', true]])
  })

  it('várias respostas de uma vez: a leitura aproveita o que a pessoa escreveu na RESPOSTA, e não só no pedido', async () => {
    const f = await fixture(() => ({ goal: null, content: 'Alunos e notas' }))
    const projectId = await f.criar('Um app de notas.')
    const r = await (await f.post(`/projects/${projectId}/intake/answer`, { answer: 'Professores; precisa mostrar alunos e notas', recommend: false })).json() as { next: { id: string }; inferred: StudioIntakeTurn[] }
    expect(r.next.id).toBe('goal')
    expect(r.inferred.map(t => t.question_id)).toEqual(['content'])
    expect(f.chamadas.find(c => c.purpose === 'leitura')!.prompt).toContain('precisa mostrar alunos e notas')
  })

  it('não inventa: sem nada no texto, pergunta a próxima e não grava nada', async () => {
    const f = await fixture(() => ({ audience: null, goal: null, content: null }))
    const projectId = await f.criar('Um aplicativo qualquer.')
    const r = await (await f.post(`/projects/${projectId}/intake/answer`, { answer: 'Professores', recommend: false })).json() as Record<string, unknown>
    expect(r).toEqual({ next: expect.objectContaining({ id: 'goal' }) })
    expect(f.respostas(projectId)).toHaveLength(1)
  })

  it('sem rota de modelo a leitura some e o questionário segue — ela é atalho, não porta', async () => {
    const f = await fixture(() => ({ goal: 'x' }))
    f.falhas.leitura = true
    const projectId = await f.criar('Um app de notas.')
    const r = await f.post(`/projects/${projectId}/intake/answer`, { answer: 'Professores', recommend: false })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ next: expect.objectContaining({ id: 'goal' }) })
    expect(f.respostas(projectId).map(t => t.question_id)).toEqual(['audience'])
  })

  it('o reenvio da mesma resposta NÃO paga a leitura de novo', async () => {
    const f = await fixture(() => ({ goal: null, content: null }))
    const projectId = await f.criar('Um app de notas.')
    const corpo = { answer: 'Professores', recommend: false, request_key: 'k'.repeat(24) }
    await f.post(`/projects/${projectId}/intake/answer`, corpo)
    await f.post(`/projects/${projectId}/intake/answer`, corpo)
    expect(f.chamadas.filter(c => c.purpose === 'leitura')).toHaveLength(1)
  })

  it('"Não sei, recomende" continua como era: recomenda e não dispara leitura', async () => {
    const f = await fixture(() => ({ goal: 'x', content: 'y' }))
    const projectId = await f.criar('Um app de notas.')
    const r = await (await f.post(`/projects/${projectId}/intake/answer`, { answer: '', recommend: true })).json() as { next: { id: string } }
    expect(r.next.id).toBe('goal')
    expect(f.chamadas.map(c => c.purpose)).toEqual(['intake'])
    expect(f.respostas(projectId)[0]).toMatchObject({ answer: 'Professores da escola.', recommended: true })
  })
})

describe('PLAN-01 — corrigir uma resposta sem recomeçar', () => {
  async function respondida(leitura: () => unknown = () => ({})) {
    const f = await fixture(leitura)
    const projectId = await f.criar('Um app de notas.')
    for (const answer of ['Professores', 'Lançar notas', 'Alunos e notas']) {
      await f.post(`/projects/${projectId}/intake/answer`, { answer, recommend: false })
    }
    return { f, projectId }
  }

  it('antes da especificação, a correção troca só aquela resposta e a conversa segue', async () => {
    const f = await fixture(() => ({}))
    const projectId = await f.criar('Um app de notas.')
    await f.post(`/projects/${projectId}/intake/answer`, { answer: 'Alunos', recommend: false })
    const r = await f.post(`/projects/${projectId}/intake/correct`, { question_id: 'audience', answer: 'Professores' })
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ turn: { question_id: 'audience', answer: 'Professores', recommended: false }, next: { id: 'goal' } })
    // O histórico fica: a resposta anterior não some.
    expect(f.respostas(projectId).map(t => t.answer)).toEqual(['Alunos', 'Professores'])
  })

  it('com a especificação pronta, a correção gera uma VERSÃO nova a partir das respostas atuais', async () => {
    const { f, projectId } = await respondida()
    expect(f.repository.specRows).toHaveLength(1)
    f.chamadas.length = 0
    const r = await f.post(`/projects/${projectId}/intake/correct`, { question_id: 'goal', answer: 'Consultar a média da turma' })
    expect(r.status).toBe(201)
    expect(f.repository.specRows.map(s => s.version).sort()).toEqual([1, 2])
    const sintese = f.chamadas.find(c => c.purpose === 'intake')!.prompt
    expect(sintese).toContain('Consultar a média da turma')
    expect(sintese).not.toContain('Lançar notas')
    // As outras decisões continuam as mesmas.
    expect(sintese).toContain('Professores')
    expect(sintese).toContain('Alunos e notas')
  })

  it('uma correção que traz dado sensível pede a confirmação ANTES de refazer a especificação', async () => {
    const { f, projectId } = await respondida()
    const r = await (await f.post(`/projects/${projectId}/intake/correct`, { question_id: 'content', answer: 'Notas de cada aluno menor de idade' })).json() as { next: { id: string } }
    expect(r.next.id).toBe('sensitive-confirmation')
    expect(f.repository.specRows).toHaveLength(1)
    const confirmada = await f.post(`/projects/${projectId}/intake/answer`, { answer: '', confirm_sensitive: true })
    expect(confirmada.status).toBe(201)
    expect(f.repository.specRows).toHaveLength(2)
  })

  it('uma síntese que falhou depois da correção é refeita, e não recusada como "já respondido"', async () => {
    const { f, projectId } = await respondida()
    f.falhas.intake = true
    expect((await f.post(`/projects/${projectId}/intake/correct`, { question_id: 'goal', answer: 'Ver médias' })).status).toBeGreaterThanOrEqual(500)
    expect(f.repository.specRows).toHaveLength(1)
    f.falhas.intake = false
    const r = await f.post(`/projects/${projectId}/intake/answer`, { answer: '', recommend: false })
    expect(r.status).toBe(201)
    expect(f.repository.specRows).toHaveLength(2)
    // Aplicada, a correção deixa de ser pendência: responder de novo volta a ser recusado.
    expect((await f.post(`/projects/${projectId}/intake/answer`, { answer: 'x', recommend: false })).status).toBe(409)
  })

  it('depois do plano, corrigir é recusado: o caminho ali é o pedido de mudança', async () => {
    const { f, projectId } = await respondida()
    expect((await f.post(`/projects/${projectId}/plan`, {})).status).toBe(201)
    const r = await f.post(`/projects/${projectId}/intake/correct`, { question_id: 'goal', answer: 'Outra coisa' })
    expect(r.status).toBe(400)
    expect(f.repository.specRows).toHaveLength(1)
  })

  it('de volta a SPEC_READY por uma revisão, com plano já existente, corrigir continua recusado', async () => {
    // A revisão devolve a tarefa a SPEC_READY; o plano antigo e os pedidos de
    // mudança continuam valendo, e refazer pelo questionário os apagaria.
    const { f, projectId } = await respondida()
    expect((await f.post(`/projects/${projectId}/plan`, {})).status).toBe(201)
    const projeto = f.repository.projectRows.find(p => p.project_id === projectId)!
    await f.repository.putProject({ ...projeto, state: 'SPEC_READY' })
    expect((await f.post(`/projects/${projectId}/intake/correct`, { question_id: 'goal', answer: 'Outra coisa' })).status).toBe(400)
    expect(f.repository.specRows).toHaveLength(1)
  })

  it('recusa corrigir o que não foi respondido, a confirmação de dado sensível e o que é de outro inquilino', async () => {
    const f = await fixture(() => ({}))
    const projectId = await f.criar('Um app de notas.')
    expect((await f.post(`/projects/${projectId}/intake/correct`, { question_id: 'goal', answer: 'x' })).status).toBe(400)
    expect((await f.post(`/projects/${projectId}/intake/correct`, { question_id: 'sensitive-confirmation', answer: 'x' })).status).toBe(400)
    await f.post(`/projects/${projectId}/intake/answer`, { answer: 'Professores', recommend: false })
    const alheio = await f.post(`/projects/${projectId}/intake/correct`, { question_id: 'audience', answer: 'x' }, {
      headers: { cookie: `${SESSION_COOKIE}=session:org-b; ${CSRF_COOKIE}=csrf` },
    })
    expect(alheio.status).toBe(404)
    expect(f.respostas(projectId).map(t => t.answer)).toEqual(['Professores'])
  })
})
