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
  planRowsInternos: StudioPlan[] = []
  plans = () => this.planRowsInternos
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
  putPlan = async (value: StudioPlan) => {
    this.planRowsInternos = [...this.planRowsInternos.filter(row => row.plan_id !== value.plan_id), value]
  }
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


describe('responder o intake com identidade de envio', () => {
  /** Um contador de chamadas ao modelo: o custo é o que esta parte protege. */
  function comModelo() {
    const f = fixture('DRAFT')
    let chamadas = 0
    const produzir = async () => {
      chamadas += 1
      return { answer: 'pacientes da clínica', route: 'ollama-local', model: 'q4' }
    }
    return { ...f, produzir, chamadas: () => chamadas }
  }

  const pergunta = { questionId: 'audience' as const, question: 'Para quem é?', recommended: false, digitada: 'pacientes da clínica' }

  it('o mesmo envio duas vezes grava UM turno, e devolve o mesmo', async () => {
    const { service, repository, produzir } = comModelo()
    const primeira = await service.answerIntakeTurn(ana, 'proj-1', pergunta, produzir, CHAVE)
    const segunda = await service.answerIntakeTurn(ana, 'proj-1', pergunta, produzir, CHAVE)
    expect(repository.turnRows).toHaveLength(1)
    expect(segunda.turn_id).toBe(primeira.turn_id)
  })

  it('reenviar com RECOMENDAR não chama o modelo de novo — e não cobra de novo', async () => {
    // Este é o defeito que esta fatia fecha, e ele era de CUSTO, não de tela:
    // a próxima pergunta já teria mudado, então ninguém veria dois turnos; a
    // conta do provedor via duas chamadas.
    const { service, produzir, chamadas } = comModelo()
    const recomendada = { ...pergunta, recommended: true, digitada: '' }
    await service.answerIntakeTurn(ana, 'proj-1', recomendada, produzir, CHAVE)
    await service.answerIntakeTurn(ana, 'proj-1', recomendada, produzir, CHAVE)
    expect(chamadas()).toBe(1)
  })

  it('SEM chave, cada envio é um envio: a rota antiga continua funcionando', async () => {
    // Um cliente antigo não pode deixar de responder de um dia para o outro.
    const { service, repository, produzir } = comModelo()
    await service.answerIntakeTurn(ana, 'proj-1', pergunta, produzir)
    await service.answerIntakeTurn(ana, 'proj-1', pergunta, produzir)
    expect(repository.turnRows).toHaveLength(2)
  })

  it('a resposta DIGITADA entra na impressão: outra resposta na mesma chave é conflito', async () => {
    const { service, produzir } = comModelo()
    await service.answerIntakeTurn(ana, 'proj-1', pergunta, produzir, CHAVE)
    await expect(service.answerIntakeTurn(
      ana, 'proj-1', { ...pergunta, digitada: 'outra coisa' }, produzir, CHAVE,
    )).rejects.toThrow(PromptToAppError)
  })

  it('digitar e RECOMENDAR não têm a mesma impressão — nem com o MESMO texto no campo', async () => {
    /*
      O texto do campo é o mesmo nos dois envios de propósito.

      Com `digitada` diferente, a impressão já diferia pelo texto, e a marca de
      recomendação não estava sendo exercitada por teste nenhum: a sabotagem
      que a removia SOBREVIVIA. O caso real é este — a pessoa escreve algo,
      manda, e depois pede recomendação sem limpar o campo. Sem a marca, ela
      receberia de volta o que digitou, apresentado como recomendação do modelo.
    */
    const { service, produzir } = comModelo()
    await service.answerIntakeTurn(ana, 'proj-1', pergunta, produzir, CHAVE)
    await expect(service.answerIntakeTurn(
      ana, 'proj-1', { ...pergunta, recommended: true }, produzir, CHAVE,
    )).rejects.toThrow(PromptToAppError)
  })

  it('a PERGUNTA NÃO entra na impressão — e isto é uma decisão, não um esquecimento', async () => {
    /*
      A primeira versão desta função incluía a pergunta, e o e2e mostrou que
      estava errado: a pergunta corrente é calculada pelo SERVIDOR a partir do
      que já foi respondido, então o primeiro envio a muda. Quando o reenvio
      chega, a pergunta já é outra, a impressão dá diferente, e a reserva vira
      conflito — quebrando exatamente o caso para o qual a chave existe.

      O que se perde é estreito: duas perguntas respondidas com o mesmo texto e
      a MESMA chave são a mesma intenção. A chave nasce por envio no cliente, e
      reusá-la entre duas perguntas é defeito de cliente; o reenvio depois de
      perder a resposta é o caminho normal de quem tem rede ruim.
    */
    const { service, repository, produzir } = comModelo()
    await service.answerIntakeTurn(ana, 'proj-1', pergunta, produzir, CHAVE)
    const segunda = await service.answerIntakeTurn(
      ana, 'proj-1', { ...pergunta, questionId: 'goal', question: 'Qual o objetivo?' }, produzir, CHAVE,
    )
    expect(repository.turnRows).toHaveLength(1)
    expect(segunda.question_id).toBe('audience')
  })

  it('o MODELO só é chamado quando o envio é novo — a chamada mora dentro da chave', async () => {
    // Chamar antes de conferir a chave cobraria a chamada mesmo no reenvio, e
    // o valor devolvido seria jogado fora. O contador é a prova.
    const { service, produzir, chamadas } = comModelo()
    const recomendada = { ...pergunta, recommended: true }
    await service.answerIntakeTurn(ana, 'proj-1', recomendada, produzir, CHAVE)
    expect(chamadas()).toBe(1)
    await service.answerIntakeTurn(ana, 'proj-1', recomendada, produzir, CHAVE)
    await service.answerIntakeTurn(ana, 'proj-1', recomendada, produzir, CHAVE)
    expect(chamadas()).toBe(1)
  })

  it('a chave de OUTRA pessoa não devolve o turno desta', async () => {
    // A chave não é credencial: o escopo de quem pede entra no armazenamento.
    const { service, repository, produzir } = comModelo()
    await service.answerIntakeTurn(ana, 'proj-1', pergunta, produzir, CHAVE)
    await service.answerIntakeTurn(bruno, 'proj-1', pergunta, produzir, CHAVE)
    expect(repository.turnRows).toHaveLength(2)
  })

  it('a queda entre a reserva e o turno termina o efeito com o MESMO identificador', async () => {
    const { service, repository, produzir } = comModelo()
    // A reserva ficou; o turno, não — é o que uma queda no meio deixa.
    repository.keyRows = [{
      request_key: CHAVE, org_id: ana.orgId, tenant_id: ana.tenantId, user_id: ana.userId,
      fingerprint: impressaoDoEnvio({ tipo: 'resposta', projectId: 'proj-1', texto: 'pacientes da clínica' }),
      project_id: 'proj-1', kind: 'resposta', result_id: 'turno-reservado', created_at: AGORA,
    }]
    const turno = await service.answerIntakeTurn(ana, 'proj-1', pergunta, produzir, CHAVE)
    expect(turno.turn_id).toBe('turno-reservado')
    expect(repository.turnRows).toHaveLength(1)
  })
})


describe('pedir ALTERAÇÃO NO PLANO com identidade de envio', () => {
  /**
   * Um plano PROPOSTO, que é o único estado em que o pedido de alteração vale.
   *
   * O repositório de memória deste arquivo não guardava plano nenhum — ele não
   * precisava. Agora precisa, e guarda.
   */
  function comPlano() {
    const f = fixture()
    f.repository.planRowsInternos = [{
      plan_id: 'plan-1', project_id: 'proj-1', org_id: ana.orgId, tenant_id: ana.tenantId,
      spec_id: 'spec-1', revision: 1, status: 'PROPOSED', change_request: null,
      steps: [{ id: 'passo-1', title: 'a página', detail: 'montar a página', planned_files: ['index.html'] }],
      created_at: AGORA, updated_at: AGORA,
    } as unknown as StudioPlan]
    return f
  }

  const PEDIDO = 'o botão precisa ficar verde'

  it('o mesmo pedido duas vezes devolve o MESMO plano, em vez de um erro de repetição', async () => {
    // Antes disto, o reenvio depois de a resposta se perder recebia "não dá
    // mais" para um pedido que tinha dado certo. Não era duplicação de efeito —
    // era uma mentira sobre o que aconteceu.
    const { service } = comPlano()
    const primeiro = await service.requestPlanChange(ana, 'proj-1', PEDIDO, CHAVE)
    const segundo = await service.requestPlanChange(ana, 'proj-1', PEDIDO, CHAVE)
    expect(segundo.status).toBe('CHANGE_REQUESTED')
    expect(segundo.change_request).toBe(primeiro.change_request)
    expect(segundo.revision).toBe(primeiro.revision)
  })

  it('SEM chave, o segundo pedido continua recusado pela guarda de estado', async () => {
    // A guarda não foi enfraquecida: ela continua sendo a verdade sobre o
    // estado. A chave só evita que quem reenviou a MESMA intenção a encontre.
    const { service } = comPlano()
    await service.requestPlanChange(ana, 'proj-1', PEDIDO)
    await expect(service.requestPlanChange(ana, 'proj-1', PEDIDO)).rejects.toThrow(PromptToAppError)
  })

  it('a mesma chave com OUTRO pedido é conflito', async () => {
    const { service } = comPlano()
    await service.requestPlanChange(ana, 'proj-1', PEDIDO, CHAVE)
    await expect(service.requestPlanChange(ana, 'proj-1', 'outra coisa', CHAVE)).rejects.toThrow(PromptToAppError)
  })

  it('dois pedidos CONCORRENTES com a mesma chave produzem UM pedido', async () => {
    const { service } = comPlano()
    const [esquerda, direita] = await Promise.all([
      service.requestPlanChange(ana, 'proj-1', PEDIDO, CHAVE),
      service.requestPlanChange(ana, 'proj-1', PEDIDO, CHAVE),
    ])
    expect(esquerda.change_request).toBe(direita.change_request)
    expect(esquerda.status).toBe('CHANGE_REQUESTED')
  })

  it('pedido curto demais é recusado ANTES de qualquer reserva', async () => {
    const { service, repository } = comPlano()
    await expect(service.requestPlanChange(ana, 'proj-1', 'x', CHAVE)).rejects.toThrow(PromptToAppError)
    expect(repository.keyRows).toHaveLength(0)
  })
})
