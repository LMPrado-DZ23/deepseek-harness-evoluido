import { describe, expect, it } from 'vitest'
import { execucaoTerminou, transcricaoDaTarefa, type DetalhesDaTarefa } from './transcricao'

const PROJETO = {
  project_id: 'proj-1', name: 'Clínica', state: 'VERIFIED_PROTOTYPE',
  original_brief: 'quero uma página para a clínica receber contatos',
  created_at: '2026-09-17T10:00:00.000Z',
}

function detalhes(extra: Partial<DetalhesDaTarefa> = {}): DetalhesDaTarefa {
  return { project: PROJETO, ...extra }
}

const RUN = {
  run_id: 'run-1', attempt: 1, stage: 'verify', state: 'PASSED',
  started_at: '2026-09-17T10:05:00.000Z', finished_at: '2026-09-17T10:09:00.000Z',
}

describe('a conversa da tarefa sai dos registros que já existem', () => {
  it('o pedido da pessoa abre a conversa', () => {
    const [primeiro] = transcricaoDaTarefa(detalhes())
    expect(primeiro).toMatchObject({ tipo: 'pedido', autor: 'pessoa', texto: PROJETO.original_brief })
  })

  it('o pedido abre a conversa mesmo quando o projeto chega SEM instante', () => {
    // A resposta de `POST /projects` devolve o projeto parcial. Antes de haver
    // âncora, "sem instante" empurrava o pedido para o fim da própria conversa.
    const { created_at: _omitido, ...parcial } = PROJETO
    const lances = transcricaoDaTarefa({ project: parcial, turns: [turno('audience', 'quem vai usar?', 'clientes')] })
    expect(lances[0]?.tipo).toBe('pedido')
  })

  it('pergunta e resposta viram dois lances, na ordem, mesmo gravados no mesmo instante', () => {
    const lances = transcricaoDaTarefa(detalhes({ turns: [turno('audience', 'quem vai usar?', 'clientes da clínica')] }))
    expect(lances.map(lance => lance.tipo)).toEqual(['pedido', 'pergunta', 'resposta'])
    expect(lances[1]).toMatchObject({ autor: 'estudio', respondida: true })
    expect(lances[2]).toMatchObject({ autor: 'pessoa', texto: 'clientes da clínica' })
  })

  it('turno sem resposta NÃO inventa uma mensagem em branco da pessoa', () => {
    const lances = transcricaoDaTarefa(detalhes({ turns: [turno('goal', 'qual o objetivo?', '   ')] }))
    expect(lances.map(lance => lance.tipo)).toEqual(['pedido', 'pergunta'])
  })

  it('a pergunta ainda aberta fecha a conversa e se declara não respondida', () => {
    const lances = transcricaoDaTarefa(detalhes({
      turns: [turno('audience', 'quem vai usar?', 'clientes')],
      next: { id: 'goal', text: 'o que a pessoa precisa conseguir fazer?' },
    }))
    expect(lances.at(-1)).toMatchObject({ tipo: 'pergunta', perguntaId: 'goal', respondida: false })
  })

  it('a tentativa terminada rende execução E artefato, e o artefato vem depois', () => {
    const lances = transcricaoDaTarefa(detalhes({ runs: [RUN] }))
    expect(lances.map(lance => lance.tipo)).toEqual(['pedido', 'execucao', 'artefato'])
    expect(lances[2]).toMatchObject({ tipo: 'artefato', estado: 'PASSED', tentativa: 1 })
  })

  it('a tentativa em curso NÃO produz artefato: não há resultado para olhar', () => {
    const correndo = { ...RUN, state: 'RUNNING', finished_at: null }
    const lances = transcricaoDaTarefa(detalhes({ runs: [correndo] }))
    expect(lances.map(lance => lance.tipo)).toEqual(['pedido', 'execucao'])
    expect(lances[1]).toMatchObject({ emCurso: true })
  })

  it('o artefato é datado pelo FIM da tentativa, não pelo início', () => {
    // Datado pelo início, ele apareceria antes de tudo o que aconteceu durante
    // a tentativa — inclusive antes de um plano revisado no meio dela.
    const lances = transcricaoDaTarefa(detalhes({
      runs: [RUN],
      plan: { plan_id: 'plan-1', status: 'APPROVED', slices: [fatia()], updated_at: '2026-09-17T10:07:00.000Z' },
    }))
    expect(lances.map(lance => lance.tipo)).toEqual(['pedido', 'execucao', 'plano', 'artefato'])
  })

  it('a tentativa corrente NÃO é duplicada quando também está no histórico', () => {
    const corrente = { ...RUN, acceptance_checks: [{ id: 'c1', label: 'AC-1', status: 'PASSED' }] }
    const lances = transcricaoDaTarefa(detalhes({ runs: [RUN], current_run: corrente }))
    expect(lances.filter(lance => lance.tipo === 'execucao')).toHaveLength(1)
    // E é a corrente que vence: ela traz os critérios que o histórico não traz.
    expect(lances.find(lance => lance.tipo === 'artefato')).toMatchObject({ criterios: [{ id: 'c1', label: 'AC-1', status: 'PASSED' }] })
  })

  it('a tentativa corrente aparece mesmo quando o histórico ainda não foi lido', () => {
    const lances = transcricaoDaTarefa(detalhes({ current_run: RUN }))
    expect(lances.filter(lance => lance.tipo === 'execucao')).toHaveLength(1)
  })

  it('cada evidência fica na tentativa que a produziu', () => {
    const segunda = { ...RUN, run_id: 'run-2', attempt: 2, started_at: '2026-09-17T11:00:00.000Z', finished_at: '2026-09-17T11:04:00.000Z' }
    const lances = transcricaoDaTarefa(detalhes({
      runs: [RUN, segunda],
      evidence: [
        { evidence_id: 'e1', run_id: 'run-1', kind: 'build-log', relative_path: 'build.log', size_bytes: 10 },
        { evidence_id: 'e2', run_id: 'run-2', kind: 'test-report', relative_path: 'tests.json', size_bytes: 20 },
      ],
    }))
    const artefatos = lances.filter(lance => lance.tipo === 'artefato')
    expect(artefatos[0]).toMatchObject({ runId: 'run-1', evidencias: [{ evidence_id: 'e1' }] })
    expect(artefatos[1]).toMatchObject({ runId: 'run-2', evidencias: [{ evidence_id: 'e2' }] })
  })

  it('a tentativa REPROVADA continua sendo um artefato, com o estado que teve', () => {
    // O aceite VIS-12 é explícito: nenhum selo genérico certifica o que não foi
    // verificado. O lance carrega `FAILED` e quem desenha não pode dizer outra coisa.
    const lances = transcricaoDaTarefa(detalhes({ runs: [{ ...RUN, state: 'FAILED' }] }))
    expect(lances.at(-1)).toMatchObject({ tipo: 'artefato', estado: 'FAILED' })
  })

  it('as tentativas vêm da mais antiga para a mais recente', () => {
    const segunda = { ...RUN, run_id: 'run-2', attempt: 2, started_at: '2026-09-17T11:00:00.000Z', finished_at: '2026-09-17T11:04:00.000Z' }
    const lances = transcricaoDaTarefa(detalhes({ runs: [segunda, RUN] }))
    expect(lances.filter(lance => lance.tipo === 'execucao').map(lance => lance.id))
      .toEqual(['execucao:run-1', 'execucao:run-2'])
  })

  it('o plano entra como um lance recolhível, com a revisão e a autoria', () => {
    const lances = transcricaoDaTarefa(detalhes({
      plan: { plan_id: 'plan-1', revision: 2, status: 'PROPOSED', slices: [fatia()], edited_by_person: true, updated_at: '2026-09-17T10:02:00.000Z' },
    }))
    expect(lances.at(-1)).toMatchObject({ tipo: 'plano', revisao: 2, status: 'PROPOSED', escritoPelaPessoa: true })
  })

  it('a conversa inteira fica em ordem cronológica, misturando as origens', () => {
    const lances = transcricaoDaTarefa(detalhes({
      turns: [turno('audience', 'quem vai usar?', 'clientes', '2026-09-17T10:01:00.000Z')],
      plan: { plan_id: 'plan-1', status: 'APPROVED', slices: [fatia()], updated_at: '2026-09-17T10:03:00.000Z' },
      runs: [RUN],
    }))
    expect(lances.map(lance => lance.tipo)).toEqual(['pedido', 'pergunta', 'resposta', 'plano', 'execucao', 'artefato'])
  })

  it('o pedido de mudança da pessoa vira uma MENSAGEM DELA na conversa', () => {
    // Sem este lance, pedir uma alteração sumia da tarefa e reaparecia só como
    // um critério dentro do plano seguinte.
    const lances = transcricaoDaTarefa(detalhes({
      runs: [RUN],
      revisions: [{ spec_id: 'spec-2', request: 'deixe o botão de contato em verde', created_at: '2026-09-17T10:20:00.000Z' }],
    }))
    expect(lances.at(-1)).toMatchObject({ tipo: 'pedido', autor: 'pessoa', texto: 'deixe o botão de contato em verde' })
  })

  it('vários pedidos de mudança ficam na ordem em que foram escritos', () => {
    const lances = transcricaoDaTarefa(detalhes({
      revisions: [
        { spec_id: 'spec-3', request: 'segundo pedido', created_at: '2026-09-17T11:00:00.000Z' },
        { spec_id: 'spec-2', request: 'primeiro pedido', created_at: '2026-09-17T10:20:00.000Z' },
      ],
    }))
    expect(lances.map(lance => lance.tipo === 'pedido' ? lance.texto : null).filter(texto => texto !== null))
      .toEqual([PROJETO.original_brief, 'primeiro pedido', 'segundo pedido'])
  })

  it('a tarefa recém-criada, sem nada ainda, é só o pedido', () => {
    expect(transcricaoDaTarefa(detalhes())).toHaveLength(1)
  })
})

describe('execucaoTerminou', () => {
  it('reconhece os cinco desfechos que não continuam', () => {
    for (const estado of ['PASSED', 'FAILED', 'BLOCKED_EXTERNAL', 'BUDGET_EXCEEDED', 'CANCELLED']) {
      expect(execucaoTerminou(estado)).toBe(true)
    }
  })
  it('PENDING e RUNNING continuam', () => {
    expect(execucaoTerminou('PENDING')).toBe(false)
    expect(execucaoTerminou('RUNNING')).toBe(false)
  })
})

function turno(id: string, pergunta: string, resposta: string, quando = '2026-09-17T10:01:00.000Z') {
  return { turn_id: `turn-${id}`, question_id: id, question: pergunta, answer: resposta, recommended: false, created_at: quando }
}
function fatia() {
  return { slice_id: 's1', title: 'Página', description: 'a página inicial', acceptance_criteria: ['abre'] }
}
