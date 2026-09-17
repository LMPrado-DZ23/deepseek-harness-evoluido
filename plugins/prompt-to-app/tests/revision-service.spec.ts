import { describe, expect, it } from 'vitest'
import type { AppSpecV1 } from '../src/appspec.js'
import type {
  StudioApproval, StudioAppSpecRecord, StudioCreationKey, StudioDesignSpecRecord,
  StudioEvidence, StudioIntakeTurn, StudioPlan, StudioProject, StudioRun,
} from '../src/model.js'
import { PromptToAppError, PromptToAppService, type PromptToAppActor, type PromptToAppRepository } from '../src/service.js'

/**
 * Continuar a MESMA tarefa depois de um resultado, do lado do serviço.
 *
 * O módulo puro já prova o que entra na especificação. O que se prova aqui é o
 * que só existe quando as gravações acontecem juntas: a tarefa continua sendo
 * a mesma, o histórico não é tocado, e nada é aprovado no caminho.
 */
class MemoryRepository implements PromptToAppRepository {
  projectRows: StudioProject[] = []
  specRows: StudioAppSpecRecord[] = []
  approvalRows: StudioApproval[] = []
  runRows: StudioRun[] = []
  projects = () => this.projectRows
  specs = () => this.specRows
  designs = () => [] as StudioDesignSpecRecord[]
  turns = () => [] as StudioIntakeTurn[]
  plans = () => [] as StudioPlan[]
  runs = () => this.runRows
  evidence = () => [] as StudioEvidence[]
  approvals = () => this.approvalRows
  creationKeys = () => [] as StudioCreationKey[]
  putProject = async (value: StudioProject) => {
    this.projectRows = [...this.projectRows.filter(row => row.project_id !== value.project_id), value]
  }
  putSpec = async (value: StudioAppSpecRecord) => { this.specRows = [...this.specRows, value] }
  putApproval = async (value: StudioApproval) => { this.approvalRows = [...this.approvalRows, value] }
  putDesign = async () => {}
  putTurn = async () => {}
  putPlan = async () => {}
  putRun = async () => {}
  putEvidence = async () => {}
  putCreationKey = async () => {}
}

const ana: PromptToAppActor = { userId: 'user-a', orgId: 'org-a', tenantId: 'tenant-a', role: 'owner' }

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

function fixture(estado: StudioProject['state'] = 'VERIFIED_PROTOTYPE') {
  const repository = new MemoryRepository()
  let id = 0
  const agora = '2026-09-17T12:00:00.000Z'
  const service = new PromptToAppService({
    repository, now: () => new Date(agora), createId: () => `novo-${++id}`,
  })
  repository.projectRows = [{
    project_id: 'proj-1', org_id: ana.orgId, tenant_id: ana.tenantId, name: 'Clínica',
    state: estado, original_brief: 'quero uma página para a clínica receber contatos',
    category: 'landing-page', created_by: ana.userId, privacy: 'privado-local',
    created_at: agora, updated_at: agora, archived_at: null,
  }]
  repository.specRows = [{
    spec_id: 'spec-1', project_id: 'proj-1', org_id: ana.orgId, tenant_id: ana.tenantId,
    version: 1, app_spec: SPEC, sha256: 'a'.repeat(64), origin: 'intake', created_at: agora,
  }]
  return { repository, service }
}

describe('reviseProject continua a MESMA tarefa', () => {
  it('a tarefa não muda de identidade e volta a poder planejar', async () => {
    const { service, repository } = fixture()
    const revisada = await service.reviseProject(ana, 'proj-1', 'o botão de enviar precisa ficar verde')
    expect(revisada.project.project_id).toBe('proj-1')
    expect(revisada.project.state).toBe('SPEC_READY')
    expect(repository.projectRows).toHaveLength(1)
  })

  it('a especificação nova é gravada com origem "edit" e NÃO substitui a anterior', async () => {
    const { service, repository } = fixture()
    await service.reviseProject(ana, 'proj-1', 'o botão de enviar precisa ficar verde')
    expect(repository.specRows).toHaveLength(2)
    expect(repository.specRows[1]).toMatchObject({ origin: 'edit', version: 2 })
    expect(repository.specRows[0]!.app_spec.acceptance_criteria).toEqual(['o formulário envia o contato'])
  })

  it('a revisão NÃO aprova nada: só o registro da transição é gravado', async () => {
    // Uma revisão que aprovasse o plano seguinte gastaria uma tentativa sem
    // ninguém olhar, que é o que a decisão de produto proíbe.
    const { service, repository } = fixture()
    await service.reviseProject(ana, 'proj-1', 'o botão de enviar precisa ficar verde')
    expect(repository.approvalRows.map(linha => linha.subject)).toEqual(['transition'])
    expect(repository.approvalRows[0]).toMatchObject({ from_state: 'VERIFIED_PROTOTYPE', to_state: 'SPEC_READY' })
  })

  it('durante uma tentativa, a revisão é recusada como REPLAY', async () => {
    const { service } = fixture('GENERATING')
    await expect(service.reviseProject(ana, 'proj-1', 'muda o botão de lugar'))
      .rejects.toMatchObject({ code: 'REPLAY' })
  })

  it('o pedido repetido é REPLAY e não grava a segunda especificação', async () => {
    const { service, repository } = fixture()
    await service.reviseProject(ana, 'proj-1', 'o botão de enviar precisa ficar verde')
    // A tarefa voltou para SPEC_READY; o repetido tem de ser barrado pelo
    // conteúdo, e não pelo estado.
    repository.projectRows = [{ ...repository.projectRows[0]!, state: 'VERIFIED_PROTOTYPE' }]
    await expect(service.reviseProject(ana, 'proj-1', 'O BOTÃO de enviar precisa ficar VERDE'))
      .rejects.toMatchObject({ code: 'REPLAY' })
    expect(repository.specRows).toHaveLength(2)
  })

  it('o pedido curto demais é INVALID e não grava nada', async () => {
    const { service, repository } = fixture()
    await expect(service.reviseProject(ana, 'proj-1', 'oi')).rejects.toBeInstanceOf(PromptToAppError)
    expect(repository.specRows).toHaveLength(1)
    expect(repository.projectRows[0]!.state).toBe('VERIFIED_PROTOTYPE')
  })

  it('a tarefa de outro inquilino não é alcançada', async () => {
    const { service } = fixture()
    const estranho: PromptToAppActor = { userId: 'user-z', orgId: 'org-b', tenantId: 'tenant-b', role: 'owner' }
    await expect(service.reviseProject(estranho, 'proj-1', 'o botão de enviar precisa ficar verde'))
      .rejects.toBeInstanceOf(PromptToAppError)
  })
})
