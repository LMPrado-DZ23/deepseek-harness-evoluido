import { describe, expect, it } from 'vitest'
import type { AppSpecV1 } from '../src/appspec.js'
import type {
  StudioApproval, StudioAppSpecRecord, StudioCreationKey, StudioDesignSpecRecord,
  StudioEvidence, StudioIntakeTurn, StudioPlan, StudioProject, StudioRun,
} from '../src/model.js'
import { PromptToAppError, PromptToAppService, type PromptToAppActor, type PromptToAppRepository } from '../src/service.js'
import { MAX_PERGUNTA } from '../src/pergunta.js'

/**
 * PERGUNTAR sobre a tarefa não é pedir alteração dela.
 *
 * O defeito que estes testes travam foi apontado pelo dono do produto: depois
 * de um resultado, toda mensagem virava critério de aceite permanente e custava
 * uma tentativa. O que se prova aqui é o NÃO — o que a pergunta não pode
 * mexer —, porque é o não que o defeito violava.
 */
class MemoryRepository implements PromptToAppRepository {
  projectRows: StudioProject[] = []
  specRows: StudioAppSpecRecord[] = []
  turnRows: StudioIntakeTurn[] = []
  planRows: StudioPlan[] = []
  runRows: StudioRun[] = []
  approvalRows: StudioApproval[] = []
  projects = () => this.projectRows
  specs = () => this.specRows
  designs = () => [] as StudioDesignSpecRecord[]
  turns = () => this.turnRows
  plans = () => this.planRows
  runs = () => this.runRows
  evidence = () => [] as StudioEvidence[]
  approvals = () => this.approvalRows
  creationKeys = () => [] as StudioCreationKey[]
  putProject = async (value: StudioProject) => {
    this.projectRows = [...this.projectRows.filter(row => row.project_id !== value.project_id), value]
  }
  putSpec = async (value: StudioAppSpecRecord) => { this.specRows = [...this.specRows, value] }
  putApproval = async (value: StudioApproval) => { this.approvalRows = [...this.approvalRows, value] }
  putTurn = async (value: StudioIntakeTurn) => { this.turnRows = [...this.turnRows, value] }
  putDesign = async () => {}
  putPlan = async () => {}
  putRun = async () => {}
  putEvidence = async () => {}
  putCreationKey = async () => {}
}

const ana: PromptToAppActor = { userId: 'user-a', orgId: 'org-a', tenantId: 'tenant-a', role: 'owner' }
const leitor: PromptToAppActor = { userId: 'user-b', orgId: 'org-a', tenantId: 'tenant-a', role: 'viewer' }

const SPEC: AppSpecV1 = {
  schema_version: 1,
  problem: 'a clínica precisa receber contatos de quem quer marcar consulta',
  audience: 'pacientes da clínica',
  journeys: ['abrir a página e mandar o contato'],
  pages: [{ name: 'Início', sections: ['apresentação', 'formulário'] }],
  entities: [],
  sensitive_data: { detected: [], confirmed_by_user: false },
  accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true },
  language: 'pt-BR',
  acceptance_criteria: ['o formulário envia o contato'],
}

const AGORA = '2026-09-17T12:00:00.000Z'

function fixture(estado: StudioProject['state'] = 'VERIFIED_PROTOTYPE') {
  const repository = new MemoryRepository()
  let id = 0
  const service = new PromptToAppService({
    repository, now: () => new Date(AGORA), createId: () => `novo-${++id}`,
  })
  repository.projectRows = [{
    project_id: 'proj-1', org_id: ana.orgId, tenant_id: ana.tenantId, name: 'Clínica',
    state: estado, original_brief: 'quero uma página para a clínica receber contatos',
    category: 'landing-page', created_by: ana.userId, privacy: 'privado-local',
    created_at: AGORA, updated_at: AGORA, archived_at: null,
  }]
  repository.specRows = [{
    spec_id: 'spec-1', project_id: 'proj-1', org_id: ana.orgId, tenant_id: ana.tenantId,
    version: 1, app_spec: SPEC, sha256: 'a'.repeat(64), origin: 'intake', created_at: AGORA,
  }]
  return { repository, service }
}

describe('perguntar sobre a tarefa', () => {
  it('NÃO grava especificação nova — que é o defeito inteiro', async () => {
    // "por que falhou?" virava um critério de aceite chamado "por que falhou?".
    const { service, repository } = fixture()
    await service.askAboutProject(ana, 'proj-1', 'por que falhou?')
    expect(repository.specRows).toHaveLength(1)
    expect(repository.specRows[0]!.app_spec.acceptance_criteria).toEqual(['o formulário envia o contato'])
  })

  it('NÃO muda o estado da tarefa, então não custa tentativa', async () => {
    const { service, repository } = fixture()
    await service.askAboutProject(ana, 'proj-1', 'quanto custou isso?')
    expect(repository.projectRows[0]!.state).toBe('VERIFIED_PROTOTYPE')
    expect(repository.runRows).toHaveLength(0)
  })

  it('NÃO aprova nada no caminho', async () => {
    const { service, repository } = fixture()
    await service.askAboutProject(ana, 'proj-1', 'e as provas?')
    expect(repository.approvalRows).toHaveLength(0)
  })

  it('grava a pergunta na MESMA conversa, com o texto como a pessoa escreveu', async () => {
    const { service, repository } = fixture()
    await service.askAboutProject(ana, 'proj-1', '  Por que   o Botão ficou AZUL?  ')
    expect(repository.turnRows).toHaveLength(1)
    // Espaço repetido some; maiúscula, acento e pontuação ficam.
    expect(repository.turnRows[0]!.question).toBe('Por que o Botão ficou AZUL?')
    expect(repository.turnRows[0]!.question_id).toBe('pergunta-da-pessoa')
  })

  it('a ORDEM do histórico é a de chegada, e duas perguntas iguais continuam duas', async () => {
    // "Preserve o texto e a ordem do histórico" — do dono, por escrito.
    const { service, repository } = fixture()
    await service.askAboutProject(ana, 'proj-1', 'primeira')
    await service.askAboutProject(ana, 'proj-1', 'segunda')
    await service.askAboutProject(ana, 'proj-1', 'primeira')
    expect(repository.turnRows.map(turn => turn.question)).toEqual(['primeira', 'segunda', 'primeira'])
  })

  it('não diz que chamou modelo nenhum, porque não chamou', async () => {
    const { service, repository } = fixture()
    await service.askAboutProject(ana, 'proj-1', 'quem escreveu isso?')
    expect(repository.turnRows[0]!.route).toBeNull()
    expect(repository.turnRows[0]!.model).toBeNull()
  })

  it('responde com o que está registrado, e custo ausente NÃO vira zero', async () => {
    const { service, repository } = fixture()
    repository.runRows = [{
      run_id: 'run-1', operation_id: 'op-1', owner_session_id: 'ses-1', plan_id: 'plan-1',
      project_id: 'proj-1', org_id: ana.orgId, tenant_id: ana.tenantId,
      stage: 'test', attempt: 2, state: 'FAILED', started_at: AGORA, finished_at: AGORA,
      sandbox: 'full', route: null, model: null, input_tokens: null, output_tokens: null,
      estimated_cost_usd: null, run_directory: '/tmp/run-1',
      failure_code: null, acceptance_checks: [],
    }]
    const turn = await service.askAboutProject(ana, 'proj-1', 'e agora?')
    expect(turn.answer).toContain('tentativa 2')
    expect(turn.answer).toContain('não registrado')
    expect(turn.answer).not.toContain('US$ 0')
  })

  it('tarefa sem plano também aceita pergunta', async () => {
    const { service } = fixture('DRAFT')
    const turn = await service.askAboutProject(ana, 'proj-1', 'o que falta aqui?')
    expect(turn.answer).toContain('Critérios de aceite combinados: 0')
  })

  it('recusa texto curto demais e longo demais, sem gravar nada', async () => {
    const { service, repository } = fixture()
    await expect(service.askAboutProject(ana, 'proj-1', ' a ')).rejects.toThrow(PromptToAppError)
    await expect(service.askAboutProject(ana, 'proj-1', 'a'.repeat(MAX_PERGUNTA + 1))).rejects.toThrow(PromptToAppError)
    expect(repository.turnRows).toHaveLength(0)
  })

  it('quem só pode ler NÃO escreve na conversa', async () => {
    const { service, repository } = fixture()
    await expect(service.askAboutProject(leitor, 'proj-1', 'posso perguntar?')).rejects.toThrow(PromptToAppError)
    expect(repository.turnRows).toHaveLength(0)
  })
})
