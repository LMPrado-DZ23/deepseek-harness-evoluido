import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import t from '../i18n/pt-BR.json'
import { ConsultedPanel, PlanEditor, type ConsultedView } from './PlanEditor'
import type { PlanView } from './planEdit'

const PLAN: PlanView = {
  revision: 1,
  slices: [
    { slice_id: 's1', title: 'Agenda', description: 'Marcar horário', acceptance_criteria: ['dá para marcar'] },
    { slice_id: 's2', title: 'Contato', description: 'Falar com a loja', acceptance_criteria: ['tem telefone'] },
  ],
}

function render(plan: PlanView, extra: Partial<Parameters<typeof PlanEditor>[0]> = {}) {
  return renderToStaticMarkup(createElement(PlanEditor, {
    plan, submit: async () => {}, approve: async () => {}, reason: '', setReason: () => {}, requestChange: async () => {}, ...extra,
  }))
}

describe('E-03 tela do plano editável', () => {
  it('mostra cada parte com os botões de editar, tirar e mover', () => {
    const html = render(PLAN)
    expect(html).toContain('Editar esta parte')
    expect(html).toContain('Tirar esta parte')
    expect(html).toContain('Subir')
    expect(html).toContain('Descer')
    // O nome da parte entra no rótulo do botão de mover: "Subir" sozinho, repetido
    // em cada linha, não diz a quem lê por leitor de tela o que vai subir.
    expect(html).toContain('aria-label="Subir: Contato"')
  })

  it('diz que os arquivos criados NÃO são editáveis, em vez de deixar a ausência parecer esquecimento', () => {
    expect(render(PLAN)).toContain('definidos pelo Studio')
  })

  it('a primeira parte não sobe e a última não desce', () => {
    const html = render(PLAN)
    // Dois botões desabilitados: subir na primeira, descer na última.
    expect(html.match(/disabled=""/gu)?.length).toBeGreaterThanOrEqual(2)
  })

  it('com uma parte só, tirar fica desabilitado', () => {
    const html = render({ revision: 1, slices: [PLAN.slices[0]!] })
    const remove = html.slice(html.indexOf('Tirar esta parte') - 200, html.indexOf('Tirar esta parte'))
    expect(remove).toContain('disabled')
  })

  it('avisa quando o plano tem alterações da pessoa, e não avisa quando não tem', () => {
    expect(render({ ...PLAN, edited_by_person: true })).toContain('alterações suas')
    expect(render(PLAN)).not.toContain('alterações suas')
  })

  it('aprovar e pedir mudança continuam existindo: editar não substitui nenhum dos dois', () => {
    const html = render(PLAN)
    expect(html).toContain('Aprovar este plano')
    expect(html).toContain('Pedir uma mudança')
  })
})

describe('acrescentar uma etapa pela tela', () => {
  it('oferece descrever o que falta, e DIZ que os arquivos não são escolha da pessoa', () => {
    // O editor sabia mudar, tirar e reordenar — e não sabia ACRESCENTAR. Quem
    // queria algo fora do plano pedia mudança em texto livre e recebia um
    // plano inteiro novo, perdendo os títulos e critérios já ajustados à mão.
    const html = render(PLAN, { addSlice: async () => {} })
    expect(html).toContain('Falta alguma etapa?')
    expect(html).toContain('Acrescentar esta etapa')
    // A frase existe porque `planned_files` é a autorização de escrita do
    // gerador: um campo de formulário que a alimentasse viraria escrita
    // arbitrária no espaço de trabalho.
    expect(html).toContain('quais arquivos a etapa nova pode criar')
    expect(html).not.toContain('planned_files')
  })

  it('sem a rota no servidor, o bloco não aparece', () => {
    // Melhor não oferecer do que oferecer um botão que responde 404 na cara de
    // quem não programa.
    expect(render(PLAN)).not.toContain('Falta alguma etapa?')
  })

  it('o botão nasce desabilitado: pedido vazio não vira etapa', () => {
    const html = render(PLAN, { addSlice: async () => {} })
    expect(html).toMatch(/Acrescentar esta etapa[\s\S]{0,80}/u)
    expect(html).toContain('disabled')
  })
})

describe('o painel do que o Studio consultou', () => {
  function consultado(over: Partial<ConsultedView> = {}): ConsultedView {
    return { used: [{ label: 'O que você descreveu', source: 'app-spec' }], dropped: [], refusedSkills: [], incompleteCode: false, ...over }
  }

  it('lista o que entrou, em portugues', () => {
    const html = renderToStaticMarkup(createElement(ConsultedPanel, { consulted: consultado() }))
    expect(html).toContain('O que você descreveu')
    expect(html).toContain(t.plan.consultedTitle)
  })

  it('coube tudo: NAO aparece aviso nenhum', () => {
    // Um aviso repetido em toda tela ensina a pessoa a nao olhar para ele.
    const html = renderToStaticMarkup(createElement(ConsultedPanel, { consulted: consultado() }))
    expect(html).not.toContain('role="alert"')
    expect(html).not.toContain(t.plan.consultedSkillsTitle)
  })

  it('o que NAO COUBE vira aviso, e ele vem ANTES da lista', () => {
    // Quem le precisa saber que a lista tem consequencia antes de ler os itens.
    const html = renderToStaticMarkup(createElement(ConsultedPanel, {
      consulted: consultado({ dropped: [{ label: 'O que você descreveu', source: 'app-spec', reason: 'BUDGET' }] }),
    }))
    expect(html).toContain(t.plan.consultedIncomplete)
    expect(html.indexOf(t.plan.consultedIncomplete)).toBeLessThan(html.indexOf('plan-consulted-dropped'))
  })

  it('o painel ABRE sozinho quando faltou alguma coisa, e o titulo diz isso', () => {
    // Fechado e com o mesmo titulo, nao existia motivo nenhum para alguem
    // clicar — e a informacao que mais importa e a que so aparece depois.
    const comFalta = renderToStaticMarkup(createElement(ConsultedPanel, {
      consulted: consultado({ dropped: [{ label: 'O que você descreveu', source: 'app-spec', reason: 'BUDGET' }] }),
    }))
    expect(comFalta).toContain('open=""')
    expect(comFalta).toContain(t.plan.consultedTitleGap)
    const semFalta = renderToStaticMarkup(createElement(ConsultedPanel, { consulted: consultado() }))
    expect(semFalta).not.toContain('open=""')
    expect(semFalta).toContain(t.plan.consultedTitle)
  })

  it('o aviso NAO depende de cor: a palavra Atencao faz o trabalho sozinha', () => {
    const html = renderToStaticMarkup(createElement(ConsultedPanel, { consulted: consultado({ incompleteCode: true }) }))
    expect(html).toContain(t.plan.consultedAttention)
  })

  it('DUPLICADA nao levanta aviso: nada se perdeu', () => {
    // Alarme falso sobre duplicata desgasta a linha que precisa ser levada a
    // serio, que e a do que NAO COUBE.
    const html = renderToStaticMarkup(createElement(ConsultedPanel, {
      consulted: consultado({ dropped: [{ label: 'Uma regra do Studio', source: 'x', reason: 'DUPLICATE' }] }),
    }))
    expect(html).not.toContain(t.plan.consultedIncomplete)
    // Mas ela ainda aparece na lista, DITA como duplicada.
    expect(html).toContain(t.plan.consultedDuplicate)
  })

  it('inventario que nao pode ser lido tem frase PROPRIA, e nao a de nao caber', () => {
    // "Nao coube" manda encurtar o texto; nao ter conseguido ler o aplicativo
    // nao tem nada a ver com o tamanho do que a pessoa escreveu.
    const html = renderToStaticMarkup(createElement(ConsultedPanel, { consulted: consultado({ incompleteCode: true }) }))
    expect(html).toContain(t.plan.consultedUnreadCode)
    expect(html).not.toContain(t.plan.consultedIncomplete)
  })

  it('lista vazia do que foi consultado DIZ que esta vazia', () => {
    // Um `ul` vazio e indistinguivel de painel quebrado.
    const html = renderToStaticMarkup(createElement(ConsultedPanel, { consulted: consultado({ used: [] }) }))
    expect(html).toContain(t.plan.consultedNothing)
  })

  it('habilidade recusada aparece com titulo proprio', () => {
    const html = renderToStaticMarkup(createElement(ConsultedPanel, {
      consulted: consultado({ refusedSkills: [{ label: 'Uma habilidade não foi usada porque está desligada', source: 'hub-1' }] }),
    }))
    expect(html).toContain(t.plan.consultedSkillsTitle)
    expect(html).toContain('está desligada')
  })

  it('o identificador da habilidade NAO e desenhado: ele e chave, nao explicacao', () => {
    const html = renderToStaticMarkup(createElement(ConsultedPanel, {
      consulted: consultado({ refusedSkills: [{ label: 'Uma habilidade não foi usada', source: 'hub-1' }] }),
    }))
    expect(html).not.toContain('hub-1')
  })

  it('sem o bloco, o painel NAO aparece — em vez de aparecer vazio', () => {
    // Vazio sugeriria que o Studio nao consultou nada.
    const html = renderToStaticMarkup(createElement(PlanEditor, {
      plan: PLAN, submit: async () => undefined, approve: async () => undefined,
      reason: '', setReason: () => undefined, requestChange: async () => undefined,
    }))
    expect(html).not.toContain(t.plan.consultedTitle)
  })
})
