import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import t from '../i18n/pt-BR.json'
import tarefa from '../i18n/tarefa.pt-BR.json'
import { TaskScreen, perguntaAbertaDe, rotuloDoEstado, type TaskScreenProps } from './TaskScreen'
import type { DetalhesDaTarefa } from './transcricao'

/**
 * O que esta tela precisa provar é uma RECUSA do proprietário, e ela tem duas
 * metades: o que apareceu e não devia (o trilho de cinco etapas como estrutura
 * principal) e o que devia aparecer e não apareceu (a conversa com compositor
 * inferior). Os dois lados estão testados abaixo.
 *
 * A montagem é estática — o ambiente destes testes é `node`, sem navegador. A
 * decisão do envio, que é a parte interativa, mora em `compositor.ts` e é
 * provada lá, estado por estado.
 */
const DETALHES: DetalhesDaTarefa = {
  project: {
    project_id: 'proj-1', name: 'Clínica', state: 'VERIFIED_PROTOTYPE',
    original_brief: 'quero uma página para a clínica receber contatos',
    created_at: '2026-09-17T10:00:00.000Z',
  },
  turns: [{
    turn_id: 'turn-1', question_id: 'audience', question: 'Quem vai usar?',
    answer: 'pacientes da clínica', recommended: false, created_at: '2026-09-17T10:01:00.000Z',
  }],
  plan: {
    plan_id: 'plan-1', revision: 1, status: 'APPROVED', updated_at: '2026-09-17T10:02:00.000Z',
    slices: [{ slice_id: 's1', title: 'Página inicial', description: 'a página com o formulário', acceptance_criteria: ['o formulário envia'] }],
  },
  runs: [{
    run_id: 'run-1', attempt: 1, stage: 'verify', state: 'PASSED',
    started_at: '2026-09-17T10:05:00.000Z', finished_at: '2026-09-17T10:09:00.000Z',
  }],
  current_run: null,
  evidence: [{ evidence_id: 'e1', run_id: 'run-1', kind: 'build-log', relative_path: 'build.log', size_bytes: 12 }],
}

function montar(extra: Partial<TaskScreenProps> = {}): string {
  const props: TaskScreenProps = {
    detalhes: DETALHES, rascunho: '', setRascunho: () => {},
    responder: async () => {}, mudarPlano: async () => {}, ajustar: async () => {}, perguntar: async () => {},
    painel: null, abrirPainel: () => {}, fecharPainel: () => {},
    ...extra,
  }
  return renderToStaticMarkup(createElement(TaskScreen, props))
}

describe('VIS-02: a conversa é a estrutura principal', () => {
  it('o trilho NUMERADO de cinco etapas NÃO é o layout desta tela', () => {
    /*
      Esta é a recusa do proprietário, escrita como teste — e ela é sobre a
      ESTRUTURA, não sobre palavras. "Plano" continua aparecendo, porque a
      conversa fala do plano; o que não pode voltar é o painel permanente com
      os cinco passos numerados ao lado do conteúdo.

      Por isso a conferência é sobre o painel (`progress-panel`) e sobre a
      numeração ("1. Ideia", "2. Perguntas", …), que é o que só existe quando
      o trilho está montado.
    */
    const html = montar()
    expect(html).not.toContain('progress-panel')
    const etapas = [t.progress.idea, t.progress.questions, t.progress.plan, t.progress.creation, t.progress.verification]
    etapas.forEach((titulo, indice) => { expect(html).not.toContain(`${indice + 1}. ${titulo}`) })
  })

  it('o pedido, a pergunta, a resposta, o plano e o resultado estão todos na conversa', () => {
    const html = montar()
    expect(html).toContain('quero uma página para a clínica receber contatos')
    expect(html).toContain('Quem vai usar?')
    expect(html).toContain('pacientes da clínica')
    expect(html).toContain('Página inicial')
    expect(html).toContain(tarefa.artefatoTitulo)
  })

  it('a conversa aparece na ordem em que aconteceu', () => {
    const html = montar()
    expect(html.indexOf('quero uma página')).toBeLessThan(html.indexOf('Quem vai usar?'))
    expect(html.indexOf('Quem vai usar?')).toBeLessThan(html.indexOf('Página inicial'))
    expect(html.indexOf('Página inicial')).toBeLessThan(html.indexOf(tarefa.artefatoTitulo))
  })

  it('o plano vem RECOLHIDO: ele é detalhe da conversa, não a tela', () => {
    const html = montar()
    expect(html).toContain('<details')
    // `open` ausente no bloco do plano — recolhido é o estado inicial.
    expect(html).not.toContain('class="dz-bloco dz-bloco-plano" open')
  })

  it('o compositor inferior existe, com rótulo próprio', () => {
    const html = montar()
    expect(html).toContain('dz-compositor-inferior')
    expect(html).toContain(tarefa.compositorRotulo)
    expect(html).toContain(tarefa.compositorPlaceholder)
  })
})

describe('VIS-03: continuar a tarefa', () => {
  it('com texto escrito depois de um resultado, o envio está disponível', () => {
    const html = montar({ rascunho: 'deixa o botão verde' })
    expect(html).toContain('deixa o botão verde')
    expect(html).not.toContain('disabled=""')
  })

  it('sem texto, o envio fica indisponível — e o campo continua lá', () => {
    const html = montar()
    expect(html).toContain('disabled=""')
    expect(html).toContain('dz-compositor-inferior')
  })

  it('durante uma tentativa, o compositor AVISA — e deixa PERGUNTAR', () => {
    /*
      A regra mudou de propósito, e o teste conta a mudança.

      Antes, o envio ficava desabilitado enquanto o construtor rodava. Segurar
      um PEDIDO DE ALTERAÇÃO ali continua certo: ele concorreria com a
      execução e gastaria orçamento duas vezes pela mesma intenção. Segurar uma
      PERGUNTA era silêncio na hora em que a pessoa mais quer saber o que está
      acontecendo — e perguntar não escreve nada nem dispara tentativa.

      Por isso, aqui: o aviso do trabalho em curso continua, a opção marcada é
      "Perguntar", e o envio está disponível.
    */
    const correndo: DetalhesDaTarefa = {
      ...DETALHES,
      project: { ...DETALHES.project, state: 'GENERATING' },
      current_run: { run_id: 'run-2', attempt: 1, stage: 'build', state: 'RUNNING', started_at: '2026-09-17T11:00:00.000Z', finished_at: null },
    }
    const html = montar({ detalhes: correndo, rascunho: 'muda o botão' })
    expect(html).toContain(tarefa.aguardandoTrabalho)
    expect(html).toContain(tarefa.avisoPergunta)
    expect(html).toContain('value="perguntar"/>')
    expect(html).not.toContain('disabled=""')
    // O texto NÃO é descartado enquanto espera.
    expect(html).toContain('muda o botão')
  })

  it('depois de um resultado, a opção marcada é PERGUNTAR — o defeito ao contrário', () => {
    // Era aqui que toda mensagem virava critério de aceite permanente. Quem
    // não reparasse na escolha pagava por isso; agora o padrão não cobra nada.
    const html = montar({ rascunho: 'por que ficou assim?' })
    const marcada = html.slice(html.indexOf('dz-intencao-marcada'), html.indexOf('dz-intencao-marcada') + 200)
    expect(marcada).toContain('value="perguntar"')
    expect(html).toContain(tarefa.avisoPergunta)
    expect(html).not.toContain(tarefa.avisoAjuste)
  })

  it('a segunda opção DIZ o que ela faz neste momento, em vez de "Enviar"', () => {
    const perguntando: DetalhesDaTarefa = {
      ...DETALHES,
      project: { ...DETALHES.project, state: 'DRAFT' },
      next: { id: 'audience', text: 'Quem vai usar?' },
    }
    expect(montar({ detalhes: perguntando })).toContain(tarefa.acaoResponder)
    expect(montar()).toContain(tarefa.acaoAjustar)
  })

  it('a pergunta aberta vira o último lance da conversa', () => {
    const perguntando: DetalhesDaTarefa = {
      ...DETALHES,
      project: { ...DETALHES.project, state: 'DRAFT' },
      next: { id: 'goal', text: 'O que a pessoa precisa conseguir fazer?' },
    }
    expect(montar({ detalhes: perguntando })).toContain('O que a pessoa precisa conseguir fazer?')
  })
})

describe('VIS-04: painéis sob demanda', () => {
  it('sem painel aberto, a conversa ocupa a tela sozinha', () => {
    const html = montar()
    expect(html).not.toContain('dz-tarefa-com-painel')
    expect(html).not.toContain(tarefa.painelFechar)
  })

  it('com painel aberto, a conversa ENCOLHE em vez de sumir', () => {
    // A referência mostra as duas coisas ao mesmo tempo; um painel que
    // substituísse a conversa seria outra tela, e voltar seria navegar.
    const html = montar({ painel: { tipo: 'diagnostico' }, conteudoDoPainel: 'detalhe técnico aqui' })
    expect(html).toContain('dz-tarefa-com-painel')
    expect(html).toContain('dz-tarefa-conversa')
    expect(html).toContain('quero uma página para a clínica receber contatos')
    expect(html).toContain('detalhe técnico aqui')
    expect(html).toContain(tarefa.painelFechar)
  })

  it('o resultado oferece ABRIR, que é o que cria o painel', () => {
    expect(montar()).toContain(tarefa.artefatoAbrir)
  })

  it('o rascunho sobrevive ao painel aberto: ele não mora na conversa', () => {
    const html = montar({ painel: { tipo: 'preview' }, rascunho: 'meu texto guardado' })
    expect(html).toContain('meu texto guardado')
  })
})

describe('VIS-12: o resultado é honesto', () => {
  it('a tentativa reprovada NÃO recebe um selo de tudo certo', () => {
    const reprovada: DetalhesDaTarefa = {
      ...DETALHES,
      project: { ...DETALHES.project, state: 'TESTS_FAILED' },
      runs: [{ ...DETALHES.runs![0]!, state: 'FAILED' }],
    }
    const html = montar({ detalhes: reprovada })
    expect(html).toContain(tarefa.estadoFAILED)
    expect(html).not.toContain(tarefa.estadoPASSED)
  })

  it('a tentativa sem prova guardada DIZ que não há prova', () => {
    const semProva: DetalhesDaTarefa = { ...DETALHES, evidence: [] }
    expect(montar({ detalhes: semProva })).toContain(tarefa.artefatoSemEvidencia)
  })

  it('um estado que este produto não conhece sai como ele mesmo', () => {
    // Escolher uma frase amigável no chute é a certificação vazia que o aceite
    // proíbe; devolver o código cru é feio e verdadeiro.
    expect(rotuloDoEstado('ESTADO_DESCONHECIDO')).toBe('ESTADO_DESCONHECIDO')
    expect(rotuloDoEstado('PASSED')).toBe(tarefa.estadoPASSED)
  })
})

describe('perguntaAbertaDe', () => {
  it('devolve a pergunta pendente quando o servidor mandou uma', () => {
    expect(perguntaAbertaDe({ ...DETALHES, next: { id: 'goal', text: 'x' } })).toBe('goal')
  })
  it('devolve null quando não há nenhuma', () => {
    expect(perguntaAbertaDe(DETALHES)).toBeNull()
  })
})
