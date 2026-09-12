import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import copy from '../i18n/team.pt-BR.json'
import { ConversationRequestError } from '../assistant/conversationApi'
import {
  TaskRow, TeamCards, TeamCostBlock, TeamTraceBlock, TeamTraceSection, TeamView,
  formatMoment, label, orderedTasks, shouldLoadTrace,
} from './TeamPanel'
import type { TeamPanel as TeamPanelData, TeamTask, TeamTrace as TeamTraceData, ToolCall } from './teamApi'

const TEAM = '11111111-2222-4333-8444-555555555555'

function task(overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    task_id: 'implementar', title: 'Implementar o formulário', role: 'implementer', status: 'RUNNING',
    depends_on: [], intended_paths: ['src/form.tsx'], blocked: false, dependency_block: null, diagnostic: null,
    evidence: { state: 'NOT_EXECUTED' }, cost: { state: 'NOT_MEASURED' },
    updated_at: '2026-09-08T00:00:00.000Z', ...overrides,
  }
}

function panel(overrides: Partial<TeamPanelData> = {}): TeamPanelData {
  return {
    team_id: TEAM, name: 'Arrumar o cadastro', status: 'RUNNING', updated_at: '2026-09-08T00:00:00.000Z',
    workspace_id: 'meu-projeto', required_tier: 'T2', sensitive_operation: null,
    approved_by: 'ana@exemplo.com', approved_at: '2026-09-08T00:00:00.000Z', diagnostic: null,
    created_at: '2026-09-08T00:00:00.000Z', tasks: [task()],
    cost: { state: 'NOT_MEASURED', reason: 'O Studio ainda não mede o custo de cada etapa.' },
    ...overrides,
  }
}

function view(overrides: Partial<Parameters<typeof TeamView>[0]> = {}) {
  return renderToStaticMarkup(createElement(TeamView, {
    cards: [], panel: null, loaded: true, readError: null, stopError: null,
    stopping: false, reason: '', onReason: () => {}, onStop: () => {}, ...overrides,
  }))
}

describe('ordem das etapas', () => {
  it('quem não depende de ninguém vem antes, e o recuo mostra a árvore', () => {
    const ordered = orderedTasks([
      task({ task_id: 'juntar', depends_on: ['revisar'] }),
      task({ task_id: 'revisar', depends_on: ['implementar'] }),
      task({ task_id: 'implementar' }),
    ])
    expect(ordered.map(entry => [entry.task.task_id, entry.depth]))
      .toEqual([['implementar', 0], ['revisar', 1], ['juntar', 2]])
  })

  it('duas etapas paralelas ficam no mesmo nível', () => {
    const ordered = orderedTasks([
      task({ task_id: 'a' }), task({ task_id: 'b' }), task({ task_id: 'c', depends_on: ['a', 'b'] }),
    ])
    expect(ordered.map(entry => entry.depth)).toEqual([0, 0, 1])
  })

  it('um ciclo NÃO faz etapa sumir da tela', () => {
    // Esconder a etapa seria o pior desfecho: o trabalho continua existindo e
    // a pessoa deixaria de vê-lo por causa de um erro de plano.
    const ordered = orderedTasks([
      task({ task_id: 'a', depends_on: ['b'] }), task({ task_id: 'b', depends_on: ['a'] }),
    ])
    expect(ordered.map(entry => entry.task.task_id).sort()).toEqual(['a', 'b'])
  })

  it('dependência que aponta para etapa inexistente não trava a lista', () => {
    const ordered = orderedTasks([task({ task_id: 'a', depends_on: ['fantasma'] })])
    expect(ordered).toEqual([{ task: task({ task_id: 'a', depends_on: ['fantasma'] }), depth: 0 }])
  })
})

describe('nomes na tela', () => {
  it('o código cru vira frase, e um estado novo aparece em vez de sumir', () => {
    expect(label(copy.taskStatus, 'BUDGET_EXCEEDED')).toBe(copy.taskStatus.BUDGET_EXCEEDED)
    expect(label(copy.taskStatus, 'ESTADO_NOVO')).toBe('ESTADO_NOVO')
  })

  it('data ilegível continua sendo mostrada, e não vira "agora"', () => {
    expect(formatMoment('não é data')).toBe('não é data')
    expect(formatMoment('2026-09-08T00:00:00.000Z')).not.toBe('2026-09-08T00:00:00.000Z')
  })
})

describe('a tela', () => {
  it('antes da primeira leitura não afirma que não há trabalho', () => {
    const html = view({ loaded: false })
    expect(html).toContain(copy.loading)
    expect(html).not.toContain(copy.empty)
  })

  it('falha de leitura não vira "nenhum trabalho"', () => {
    const html = view({ readError: new ConversationRequestError(500, 'caiu', true) })
    expect(html).toContain('role="alert"')
    expect(html).toContain('caiu')
    expect(html).not.toContain(copy.empty)
  })

  it('lista vazia só é dita depois de uma leitura que deu certo', () => {
    expect(view()).toContain(copy.empty)
  })

  it('a tela sem equipe deixou de ser um beco: ela diz COMO começar e leva lá', () => {
    // O painel mostrava tudo sobre uma equipe — árvore, custo, evidência, o
    // botão de parar — e nenhum caminho para começar uma. Quem chegava aqui
    // lia "nenhum trabalho foi iniciado" e ficava com essa informação na mão.
    const html = view()
    expect(html).toContain(copy.emptyHow)
    expect(html).toContain(copy.emptyAction)
    // O destino é a CONVERSA, com o pedido escrito: é lá que existe o agente
    // vivo do Harness que ancora uma equipe.
    expect(html).toContain('/studio/assistente?pedido=')
  })

  it('o caminho de começar NÃO é um botão que finge iniciar', () => {
    // Uma equipe é ancorada num agente vivo, que só existe dentro de uma
    // chamada de ferramenta. Uma rota HTTP teria de inventar esse dono — e
    // inventar dono é pior do que não ter botão nenhum.
    const html = view()
    expect(html).not.toMatch(/<button[^>]*>[^<]*Pedir um trabalho em equipe/u)
    expect(html).toMatch(/<a[^>]+href="\/studio\/assistente\?pedido=/u)
  })

  it('o painel mostra custo NÃO MEDIDO, quem autorizou e as etapas', () => {
    const html = view({ panel: panel() })
    expect(html).toContain(copy.costTitle)
    expect(html).toContain('O Studio ainda não mede o custo de cada etapa.')
    expect(html).toContain('ana@exemplo.com')
    expect(html).toContain('Implementar o formulário')
    expect(html).toContain(copy.stop)
  })

  it('nenhum caminho absoluto do computador aparece na tela', () => {
    const html = view({ panel: panel({ tasks: [task({ intended_paths: ['src/form.tsx'] })] }), cards: [] })
    expect(html).not.toMatch(/[A-Za-z]:\\|\/home\/|\/var\/lib\/|\/tmp\//u)
  })

  it('trabalho já encerrado não oferece um botão de parar que não para nada', () => {
    for (const status of ['COMPLETED', 'CANCELLED']) {
      const html = view({ panel: panel({ status }) })
      expect(html, status).toContain('disabled=""')
    }
    expect(view({ panel: panel() })).not.toContain('disabled=""')
  })

  it('o erro da parada não é apagado pela leitura seguinte', () => {
    const html = view({ panel: panel(), stopError: new ConversationRequestError(403, copy.stopForbidden, false), readError: null })
    expect(html).toContain(copy.stopForbidden)
  })

  it('a lista liga cada trabalho ao seu painel', () => {
    const html = renderToStaticMarkup(createElement(TeamCards, {
      cards: [{ team_id: TEAM, name: 'Equipe', status: 'RUNNING', updated_at: '2026-09-08T00:00:00.000Z' }],
    }))
    expect(html).toContain(`href="/studio/progresso/${TEAM}"`)
    expect(html).toContain(copy.status.RUNNING)
  })
})

describe('o consumo na tela', () => {
  const block = (cost: Parameters<typeof TeamCostBlock>[0]['cost']) =>
    renderToStaticMarkup(createElement(TeamCostBlock, { cost }))

  it('sem medida, a tela mostra o MOTIVO e nenhum número', () => {
    const html = block({ state: 'NOT_MEASURED', reason: 'Nenhuma etapa trouxe medida de consumo.' })
    expect(html).toContain('Nenhuma etapa trouxe medida')
    expect(html).not.toMatch(/\b0\b/u)
  })

  it('medida completa mostra o número e quantas etapas entraram', () => {
    const html = block({ state: 'MEASURED', tokens: 12345, measured: 3 })
    expect(html).toContain('12.345')
    expect(html).toContain('3 etapa')
  })

  it('medida PARCIAL avisa que o número é MENOR que o real', () => {
    // Sem este aviso, a pessoa lê uma soma pela metade como se fosse o total,
    // e uma equipe com agente externo parece mais barata do que foi.
    const html = block({ state: 'PARTIAL', tokens: 100, measured: 1, total: 3, reason: 'motivo' })
    expect(html).toContain('role="alert"')
    expect(html).toContain('MENOR')
    expect(html).toContain('1 de 3')
  })

  it('a etapa diz o consumo dela, ou diz que não foi medido', () => {
    expect(renderToStaticMarkup(createElement(TaskRow, {
      task: task({ cost: { state: 'MEASURED', tokens: 4200 } }), depth: 0,
    }))).toContain('4.200 unidades de uso')
    expect(renderToStaticMarkup(createElement(TaskRow, { task: task(), depth: 0 })))
      .toContain(copy.costTaskNotMeasured)
  })
})

describe('uma etapa', () => {
  it('etapa em fila diz que não rodou, e não mostra zero arquivo', () => {
    const html = renderToStaticMarkup(createElement(TaskRow, { task: task({ status: 'QUEUED' }), depth: 0 }))
    expect(html).toContain(copy.evidenceNotExecuted)
    expect(html).not.toContain('0 arquivo')
  })

  it('etapa que rodou mostra arquivos, tamanho e a base', () => {
    const html = renderToStaticMarkup(createElement(TaskRow, {
      task: task({
        status: 'PROPOSED',
        evidence: {
          state: 'MEASURED', changed_files: ['src/form.tsx', 'src/form.css'], diff_bytes: 1234,
          diff_sha256: 'a'.repeat(64), base_commit: 'abcdef1', main_changed_during_run: true,
        },
      }),
      depth: 1,
    }))
    expect(html).toContain('2 arquivo(s) mudado(s), 1234 caracteres')
    expect(html).toContain('abcdef1')
    expect(html).toContain('src/form.css')
    // O aviso de que o projeto mudou embaixo da etapa é o que evita aplicar
    // uma proposta feita sobre outra versão.
    expect(html).toContain(copy.evidenceMainChanged)
  })

  it('etapa bloqueada é anunciada, e não só pintada de vermelho', () => {
    const html = renderToStaticMarkup(createElement(TaskRow, {
      task: task({ status: 'FAILED', blocked: true, diagnostic: 'faltou permissão' }), depth: 0,
    }))
    expect(html).toContain('role="alert"')
    expect(html).toContain(copy.blockedTitle)
    expect(html).toContain('faltou permissão')
  })

  it('de quem a etapa depende está escrito, e não só desenhado no recuo', () => {
    // O recuo não existe para quem usa leitor de tela.
    const semDependencia = renderToStaticMarkup(createElement(TaskRow, { task: task(), depth: 0 }))
    expect(semDependencia).toContain(copy.dependsOnNone)
    const comDependencia = renderToStaticMarkup(createElement(TaskRow, {
      task: task({ task_id: 'revisar', depends_on: ['implementar'] }), depth: 1,
    }))
    expect(comDependencia).toContain('Depende de: implementar')
  })
})

describe('T-24: o plano travado aparece na tela, e diz o que fazer', () => {
  it('dependencia que NAO EXISTE: diz que a etapa nao vai andar e por que', () => {
    const html = renderToStaticMarkup(createElement(TaskRow, {
      task: task({ status: 'QUEUED', depends_on: ['fantasma'], dependency_block: { reason: 'MISSING_DEPENDENCY', dependencies: ['fantasma'] } }),
      depth: 0,
    }))
    expect(html).toContain('não existe no plano')
    expect(html).toContain('fantasma')
    expect(html).toContain('role="alert"')
  })

  it('dependencia que FALHOU: diz que ela espera alguem agir, e nao a vez', () => {
    const html = renderToStaticMarkup(createElement(TaskRow, {
      task: task({ status: 'QUEUED', depends_on: ['anterior'], dependency_block: { reason: 'DEPENDENCY_FAILED', dependencies: ['anterior'] } }),
      depth: 0,
    }))
    expect(html).toContain('não terminou bem')
    expect(html).toContain('esperando alguém agir')
  })

  it('as duas frases sao DIFERENTES: sao dois gestos diferentes', () => {
    // Corrigir um plano e refazer um trabalho nao sao a mesma acao. Uma frase
    // so para os dois casos deixaria metade das pessoas sem saber o que fazer.
    const falta = renderToStaticMarkup(createElement(TaskRow, { task: task({ dependency_block: { reason: 'MISSING_DEPENDENCY', dependencies: ['x'] } }), depth: 0 }))
    const falhou = renderToStaticMarkup(createElement(TaskRow, { task: task({ dependency_block: { reason: 'DEPENDENCY_FAILED', dependencies: ['x'] } }), depth: 0 }))
    expect(falta).not.toBe(falhou)
  })

  it('etapa com plano inteiro nao ganha aviso nenhum', () => {
    const html = renderToStaticMarkup(createElement(TaskRow, { task: task({ status: 'QUEUED' }), depth: 0 }))
    expect(html).not.toContain('não vai andar')
  })
})

describe('a cadeia: que ferramentas cada etapa usou', () => {
  function chamada(over: Partial<ToolCall> = {}): ToolCall {
    return {
      call_id: 'c1', tool_name: 'shell', decision: 'allow', effective_tier: 'T2',
      reason: 'previsto no catalogo', at: '2026-09-08T00:03:00.000Z', sealed: true, ...over,
    }
  }

  function cadeia(over: Partial<TeamTraceData> = {}): TeamTraceData {
    return {
      team_id: 'eq-1', unlinked_count: 0,
      tasks: [{
        task_id: 't1', title: 'Escrever o formulario', role: 'implementer', status: 'APPLIED',
        trace: { link: 'LINKED', run_id: 'r1', session_id: 's1', calls: [chamada()] },
      }],
      ...over,
    }
  }

  it('a decisao aparece EM PORTUGUES, e as tres sao frases diferentes', () => {
    // Colapsar `ask` em `deny` faria a tela dizer que algo foi recusado quando
    // na verdade estava esperando alguem responder.
    const desenhado = renderToStaticMarkup(createElement(TeamTraceBlock, { trace: cadeia({
      tasks: [{
        task_id: 't1', title: 'Uma etapa', role: 'implementer', status: 'APPLIED',
        trace: { link: 'LINKED', run_id: 'r1', session_id: 's1', calls: [
          chamada({ call_id: 'a', decision: 'allow' }),
          chamada({ call_id: 'b', decision: 'ask' }),
          chamada({ call_id: 'c', decision: 'deny' }),
        ] },
      }],
    }) }))
    for (const frase of Object.values(copy.traceDecision)) expect(desenhado).toContain(frase)
    for (const codigo of ['allow', 'ask', 'deny']) {
      expect(desenhado.replace(/class="[^"]*"/gu, ''), codigo).not.toContain(codigo)
    }
  })

  it('etapa SEM ELO grita, e nao e desenhada como "nao usou ferramenta"', () => {
    // Descrever como limpo o caso em que a vigilancia falhou e a mentira mais
    // cara que esta tela poderia contar.
    const desenhado = renderToStaticMarkup(createElement(TeamTraceBlock, { trace: cadeia({
      unlinked_count: 1,
      tasks: [{
        task_id: 't1', title: 'Uma etapa', role: 'implementer', status: 'APPLIED',
        trace: { link: 'UNLINKED', run_id: 'r1', calls: [] },
      }],
    }) }))
    expect(desenhado).toContain(copy.traceUnlinked)
    expect(desenhado).not.toContain(copy.traceEmpty)
    expect(desenhado).not.toContain(copy.traceNotExecuted)
    expect(desenhado).toContain('role="alert"')
  })

  it('etapa que NAO rodou tem frase propria, diferente da de sem elo', () => {
    const desenhado = renderToStaticMarkup(createElement(TeamTraceBlock, { trace: cadeia({
      tasks: [{
        task_id: 't1', title: 'Uma etapa', role: 'implementer', status: 'QUEUED',
        trace: { link: 'NOT_EXECUTED', calls: [] },
      }],
    }) }))
    expect(desenhado).toContain(copy.traceNotExecuted)
    expect(desenhado).not.toContain(copy.traceUnlinked)
  })

  it('elo com zero chamadas diz que rodou e nao pediu nada — que e outra coisa', () => {
    const desenhado = renderToStaticMarkup(createElement(TeamTraceBlock, { trace: cadeia({
      tasks: [{
        task_id: 't1', title: 'Uma etapa', role: 'implementer', status: 'APPLIED',
        trace: { link: 'LINKED', run_id: 'r1', session_id: 's1', calls: [] },
      }],
    }) }))
    expect(desenhado).toContain(copy.traceEmpty)
    expect(desenhado).not.toContain(copy.traceUnlinked)
  })

  it('o resumo de cima conta quantas etapas RODARAM, e nao quantas existem', () => {
    // Uma etapa em fila nao tinha como deixar ligacao, e conta-la no total
    // faria o relato parecer permanentemente furado.
    const desenhado = renderToStaticMarkup(createElement(TeamTraceBlock, { trace: cadeia({
      unlinked_count: 1,
      tasks: [
        { task_id: 'a', title: 'Rodou', role: 'implementer', status: 'APPLIED', trace: { link: 'UNLINKED', run_id: 'r1', calls: [] } },
        { task_id: 'b', title: 'Rodou tambem', role: 'implementer', status: 'APPLIED', trace: { link: 'LINKED', run_id: 'r2', session_id: 's2', calls: [] } },
        { task_id: 'c', title: 'Em fila', role: 'implementer', status: 'QUEUED', trace: { link: 'NOT_EXECUTED', calls: [] } },
      ],
    }) }))
    expect(desenhado).toContain(copy.traceUnlinkedSummary.replace('{count}', '1').replace('{total}', '2'))
  })

  it('sem nenhuma etapa sem elo, diz que o relato E completo', () => {
    const desenhado = renderToStaticMarkup(createElement(TeamTraceBlock, { trace: cadeia() }))
    expect(desenhado).toContain(copy.traceComplete)
    expect(desenhado).not.toContain('role="alert"')
  })

  it('chamada sem selo e DITA como sem selo', () => {
    // Omitir a distincao faria uma linha inauditavel parecer auditada.
    const com = renderToStaticMarkup(createElement(TeamTraceBlock, { trace: cadeia() }))
    const sem = renderToStaticMarkup(createElement(TeamTraceBlock, { trace: cadeia({
      tasks: [{
        task_id: 't1', title: 'Uma etapa', role: 'implementer', status: 'APPLIED',
        trace: { link: 'LINKED', run_id: 'r1', session_id: 's1', calls: [chamada({ sealed: false })] },
      }],
    }) }))
    expect(com).not.toContain(copy.traceUnsealed)
    expect(sem).toContain(copy.traceUnsealed)
  })

  it('abrir de novo NAO le de novo, e fechar tambem nao', () => {
    // `<details>` dispara ao abrir E ao fechar. Sem a conferencia, cada clique
    // era uma ida a trilha inteira — o custo que a leitura sob demanda existe
    // para evitar.
    expect(shouldLoadTrace(false, false)).toBe(true)
    expect(shouldLoadTrace(true, false)).toBe(false)
    expect(shouldLoadTrace(false, true)).toBe(false)
    expect(shouldLoadTrace(true, true)).toBe(false)
  })

  it('a secao NAO le nada antes de alguem abrir', () => {
    // A trilha cresce com o uso: le-la em toda volta do laco deixaria o painel
    // mais lento justamente onde ha mais o que mostrar.
    const load = vi.fn(async () => cadeia())
    renderToStaticMarkup(createElement(TeamTraceSection, { teamId: 'eq-1', load }))
    expect(load).not.toHaveBeenCalled()
  })
})
