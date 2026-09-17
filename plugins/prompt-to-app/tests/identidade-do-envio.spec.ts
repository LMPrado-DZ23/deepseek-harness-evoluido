import { describe, expect, it } from 'vitest'
import type { AppSpecV1 } from '../src/appspec.js'
import type {
  StudioApproval, StudioAppSpecRecord, StudioCreationKey, StudioDesignSpecRecord,
  StudioEvidence, StudioIntakeTurn, StudioPlan, StudioProject, StudioRun,
} from '../src/model.js'
import { PromptToAppError, PromptToAppService, type PromptToAppActor, type PromptToAppRepository } from '../src/service.js'
import { desfechoDoEnvio, impressaoDoEnvio } from '../src/creation-key.js'

/**
 * A IDENTIDADE DO ENVIO dentro de uma tarefa já aberta.
 *
 * A criação de tarefa já tinha isto desde `UX-02`. Os envios seguintes não
 * tinham: quem perguntava, perdia a resposta por tempo esgotado e apertava de
 * novo ganhava DUAS mensagens; quem pedia alteração ganhava DUAS revisões,
 * cada uma com um plano para aprovar.
 *
 * O que se prova aqui é o que só existe quando as gravações acontecem juntas —
 * a reserva durável, a releitura reautorizada e a queda entre as duas escritas.
 */
class MemoryRepository implements PromptToAppRepository {
  projectRows: StudioProject[] = []
  specRows: StudioAppSpecRecord[] = []
  turnRows: StudioIntakeTurn[] = []
  approvalRows: StudioApproval[] = []
  keyRows: StudioCreationKey[] = []
  projects = () => this.projectRows
  specs = () => this.specRows
  designs = () => [] as StudioDesignSpecRecord[]
  turns = () => this.turnRows
  plans = () => [] as StudioPlan[]
  runs = () => [] as StudioRun[]
  evidence = () => [] as StudioEvidence[]
  approvals = () => this.approvalRows
  creationKeys = () => this.keyRows
  putProject = async (value: StudioProject) => {
    this.projectRows = [...this.projectRows.filter(row => row.project_id !== value.project_id), value]
  }
  putSpec = async (value: StudioAppSpecRecord) => { this.specRows = [...this.specRows, value] }
  putTurn = async (value: StudioIntakeTurn) => { this.turnRows = [...this.turnRows, value] }
  putApproval = async (value: StudioApproval) => { this.approvalRows = [...this.approvalRows, value] }
  putCreationKey = async (value: StudioCreationKey) => { this.keyRows = [...this.keyRows, value] }
  putDesign = async () => {}
  putPlan = async () => {}
  putRun = async () => {}
  putEvidence = async () => {}
}

const ana: PromptToAppActor = { userId: 'user-a', orgId: 'org-a', tenantId: 'tenant-a', role: 'owner' }
const bruno: PromptToAppActor = { userId: 'user-b', orgId: 'org-a', tenantId: 'tenant-a', role: 'owner' }
const CHAVE = 'chave-de-envio-0001'
const AGORA = '2026-09-17T12:00:00.000Z'

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
  const service = new PromptToAppService({ repository, now: () => new Date(AGORA), createId: () => `novo-${++id}` })
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

describe('a impressão de um envio', () => {
  it('o TIPO entra na impressão: a mesma frase como pergunta e como alteração não colide', () => {
    // Sem isto, quem perguntasse "trocar o cabeçalho" e depois PEDISSE trocar o
    // cabeçalho receberia a resposta da pergunta em vez da revisão.
    const pergunta = impressaoDoEnvio({ tipo: 'pergunta', projectId: 'p1', texto: 'trocar o cabeçalho' })
    const revisao = impressaoDoEnvio({ tipo: 'revisao', projectId: 'p1', texto: 'trocar o cabeçalho' })
    expect(pergunta).not.toBe(revisao)
  })

  it('a TAREFA entra na impressão: a mesma frase em duas tarefas não colide', () => {
    expect(impressaoDoEnvio({ tipo: 'pergunta', projectId: 'p1', texto: 'por quê?' }))
      .not.toBe(impressaoDoEnvio({ tipo: 'pergunta', projectId: 'p2', texto: 'por quê?' }))
  })

  it('sem reserva, envia; com a mesma, reusa; com outra impressão, conflito', () => {
    const reserva = {
      request_key: CHAVE, org_id: 'o', tenant_id: 't', user_id: 'u',
      fingerprint: 'f1', project_id: 'p1', created_at: AGORA, kind: 'pergunta' as const, result_id: 'turno-1',
    }
    expect(desfechoDoEnvio(undefined, 'f1')).toEqual({ kind: 'ENVIAR' })
    expect(desfechoDoEnvio(reserva, 'f1')).toEqual({ kind: 'REUSAR', resultId: 'turno-1' })
    expect(desfechoDoEnvio(reserva, 'f2')).toEqual({ kind: 'CONFLITO' })
  })

  it('reserva SEM efeito gravado devolve REUSAR sem identificador — o processo caiu no meio', () => {
    const reserva = {
      request_key: CHAVE, org_id: 'o', tenant_id: 't', user_id: 'u',
      fingerprint: 'f1', project_id: 'p1', created_at: AGORA,
    }
    expect(desfechoDoEnvio(reserva, 'f1')).toEqual({ kind: 'REUSAR', resultId: undefined })
  })
})

describe('perguntar com identidade de envio', () => {
  it('o mesmo envio duas vezes deixa UMA mensagem, e devolve a mesma', async () => {
    const { service, repository } = fixture()
    const primeira = await service.askAboutProject(ana, 'proj-1', 'por que falhou?', CHAVE)
    const segunda = await service.askAboutProject(ana, 'proj-1', 'por que falhou?', CHAVE)
    expect(repository.turnRows).toHaveLength(1)
    expect(segunda.turn_id).toBe(primeira.turn_id)
  })

  it('SEM chave, dois envios continuam sendo dois — a ordem do histórico é preservada', async () => {
    // O reenvio sem chave é o comportamento antigo, e ele continua: duas
    // perguntas iguais feitas de propósito são duas perguntas.
    const { service, repository } = fixture()
    await service.askAboutProject(ana, 'proj-1', 'por que falhou?')
    await service.askAboutProject(ana, 'proj-1', 'por que falhou?')
    expect(repository.turnRows).toHaveLength(2)
  })

  it('mesma chave com texto DIFERENTE é conflito, e não a resposta antiga', async () => {
    const { service, repository } = fixture()
    await service.askAboutProject(ana, 'proj-1', 'por que falhou?', CHAVE)
    await expect(service.askAboutProject(ana, 'proj-1', 'quanto custou?', CHAVE)).rejects.toThrow(PromptToAppError)
    expect(repository.turnRows).toHaveLength(1)
  })

  it('a chave NÃO é credencial: a reserva de outra pessoa não alcança esta', async () => {
    const { service, repository } = fixture()
    await service.askAboutProject(ana, 'proj-1', 'por que falhou?', CHAVE)
    // Bruno manda a MESMA chave e o MESMO texto: ele ganha a mensagem dele.
    const dele = await service.askAboutProject(bruno, 'proj-1', 'por que falhou?', CHAVE)
    expect(repository.turnRows).toHaveLength(2)
    expect(repository.keyRows).toHaveLength(2)
    expect(dele.turn_id).not.toBe(repository.turnRows[0]!.turn_id)
  })

  it('a reserva fica e o turno some: o reenvio TERMINA o efeito com o mesmo identificador', async () => {
    // É a queda entre as duas escritas. Sem isto, a reserva apontaria para um
    // turno que nunca existiu e a pessoa nunca mais veria a resposta.
    const { service, repository } = fixture()
    const primeira = await service.askAboutProject(ana, 'proj-1', 'por que falhou?', CHAVE)
    repository.turnRows = []
    const segunda = await service.askAboutProject(ana, 'proj-1', 'por que falhou?', CHAVE)
    expect(segunda.turn_id).toBe(primeira.turn_id)
    expect(repository.turnRows).toHaveLength(1)
  })

  it('dois envios CONCORRENTES com a mesma chave produzem UM efeito', async () => {
    const { service, repository } = fixture()
    const [esquerda, direita] = await Promise.all([
      service.askAboutProject(ana, 'proj-1', 'por que falhou?', CHAVE),
      service.askAboutProject(ana, 'proj-1', 'por que falhou?', CHAVE),
    ])
    expect(repository.turnRows).toHaveLength(1)
    expect(esquerda.turn_id).toBe(direita.turn_id)
  })

  it('chave curta demais é recusada, e nada é gravado', async () => {
    const { service, repository } = fixture()
    await expect(service.askAboutProject(ana, 'proj-1', 'por que falhou?', 'curta')).rejects.toThrow(PromptToAppError)
    expect(repository.turnRows).toHaveLength(0)
    expect(repository.keyRows).toHaveLength(0)
  })
})

describe('pedir alteração com identidade de envio', () => {
  it('o mesmo pedido duas vezes deixa UMA revisão, e devolve a mesma', async () => {
    const { service, repository } = fixture()
    const primeira = await service.reviseProject(ana, 'proj-1', 'o botão precisa ficar verde', CHAVE)
    const segunda = await service.reviseProject(ana, 'proj-1', 'o botão precisa ficar verde', CHAVE)
    // Uma especificação nova, e não duas: a inicial mais a revisão.
    expect(repository.specRows).toHaveLength(2)
    expect(segunda.spec.spec_id).toBe(primeira.spec.spec_id)
    expect(segunda.project.state).toBe('SPEC_READY')
  })

  it('dois pedidos CONCORRENTES com a mesma chave produzem UMA revisão', async () => {
    const { service, repository } = fixture()
    const [esquerda, direita] = await Promise.all([
      service.reviseProject(ana, 'proj-1', 'o botão precisa ficar verde', CHAVE),
      service.reviseProject(ana, 'proj-1', 'o botão precisa ficar verde', CHAVE),
    ])
    expect(repository.specRows).toHaveLength(2)
    expect(esquerda.spec.spec_id).toBe(direita.spec.spec_id)
  })

  it('o reenvio NÃO grava uma segunda aprovação de transição', async () => {
    // Uma aprovação a mais por reenvio faria a auditoria contar duas decisões
    // onde a pessoa tomou uma.
    const { service, repository } = fixture()
    await service.reviseProject(ana, 'proj-1', 'o botão precisa ficar verde', CHAVE)
    const antes = repository.approvalRows.length
    await service.reviseProject(ana, 'proj-1', 'o botão precisa ficar verde', CHAVE)
    expect(repository.approvalRows).toHaveLength(antes)
  })
})
