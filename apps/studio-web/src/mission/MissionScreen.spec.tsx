import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import copy from '../i18n/mission.pt-BR.json'
import {
  availableActions, buildDraft, buildPatch, completionLabel, CriterionEditor, fieldFor,
  MissionCard, MissionForm, MissionScreen, runCountLabel, spendLabel,
} from './MissionScreen'
import type { MissionView } from './missionApi'

/** Os codigos de maquina que nunca podem ser LIDOS pela pessoa. */
const CODIGOS = ['UNPROVEN', 'REFUTED', 'BLOCKED_EXTERNAL', 'CANDIDATE_COMPLETED', 'NO_LIMIT']

/**
 * So o texto que a pessoa LE, sem marcacao e sem atributo.
 * @param markup - o HTML desenhado.
 * @returns o texto visivel.
 */
function visibleText(markup: string): string {
  return markup.replace(/<[^>]*>/gu, ' ')
}

function mission(over: Partial<MissionView> = {}): MissionView {
  return {
    mission_id: 'm1', objective: 'Terminar com prova', status: 'RUNNING', max_total_tokens: 1_000,
    run_count: 0, criteria: [{ criterion_id: 'suite', statement: 'A suite passa', state: 'UNPROVEN', evidence: null, blocked_reason: null }],
    created_at: 'x', updated_at: 'x',
    spend: { kind: 'NO_LIMIT' }, completion: { kind: 'UNPROVEN', criteria: ['suite'] },
    ...over,
  }
}

describe('as frases da tela dizem o que a pessoa precisa para agir', () => {
  it('o gasto sem medida NOMEIA o trabalho que nao foi medido', () => {
    // Dizer so "nao da para medir" descreve um impedimento sem dizer o que
    // olhar, e o que a pessoa faz com essa frase e nada.
    const frase = spendLabel({ kind: 'UNMEASURED', runId: 'run-7', limit: 800 })
    expect(frase).toContain('run-7')
  })

  it('dentro e fora do limite sao frases DIFERENTES, com os dois numeros', () => {
    const dentro = spendLabel({ kind: 'WITHIN', spent: 300, limit: 800 })
    const fora = spendLabel({ kind: 'EXCEEDED', spent: 900, limit: 800 })
    expect(dentro).not.toBe(fora)
    for (const frase of [dentro, fora]) expect(frase).toContain('800')
    expect(fora).toContain('900')
  })

  it('sem limite combinado nao vira "cabe"', () => {
    expect(spendLabel({ kind: 'NO_LIMIT' })).toBe(copy.spend.NO_LIMIT)
  })

  it('a contagem de trabalhos tem singular, plural e nenhum', () => {
    expect(runCountLabel(0)).toBe(copy.runCount.zero)
    expect(runCountLabel(1)).toBe(copy.runCount.one)
    expect(runCountLabel(4)).toContain('4')
  })

  it('cada veredito tem a sua frase, e nenhuma repete a outra', () => {
    const frases = [
      completionLabel({ kind: 'PROVEN' }),
      completionLabel({ kind: 'REFUTED', criteria: ['a'] }),
      completionLabel({ kind: 'UNPROVEN', criteria: ['a'] }),
      completionLabel({ kind: 'BLOCKED_EXTERNAL', criteria: ['a'], reasons: ['b'] }),
    ]
    expect(new Set(frases).size).toBe(4)
  })
})

describe('os dois gestos aparecem separados, e um de cada vez', () => {
  it('em andamento cabe marcar como terminado, e nao encerrar', () => {
    expect(availableActions(mission())).toEqual({ candidate: true, complete: false })
  })

  it('marcado como terminado cabe encerrar, e nao marcar de novo', () => {
    expect(availableActions(mission({ status: 'CANDIDATE_COMPLETED' }))).toEqual({ candidate: false, complete: true })
  })

  it('encerrado nao cabe nenhum dos dois', () => {
    expect(availableActions(mission({ status: 'COMPLETED' }))).toEqual({ candidate: false, complete: false })
  })

  it('encerrar aparece mesmo com item sem prova: a recusa e explicada, o botao sumido nao', () => {
    // Esconder o botao trocaria uma recusa que diz QUAL item falta por um botao
    // que sumiu sem motivo visivel.
    const semProva = mission({ status: 'CANDIDATE_COMPLETED', completion: { kind: 'UNPROVEN', criteria: ['suite'] } })
    expect(availableActions(semProva).complete).toBe(true)
  })
})

describe('a tela desenhada', () => {
  it('comeca anunciando que esta carregando, com papel de status', () => {
    // Sem `role="status"` quem usa leitor de tela fica sem saber que a tela
    // esta buscando alguma coisa, e conclui que ela esta vazia.
    const html = renderToStaticMarkup(createElement(MissionScreen))
    expect(html).toContain('role="status"')
    expect(html).toContain(copy.loading)
    expect(html).toContain(copy.title)
  })
})

describe('o cartao desenhado — o corpo que nenhum teste alcancava', () => {
  const html = (over: Partial<MissionView> = {}) => renderToStaticMarkup(createElement(MissionCard, {
    mission: mission(over), busy: false, onCandidate: () => undefined, onComplete: () => undefined, onRecord: async () => undefined,
  }))

  it('o item comprovado mostra ONDE esta a prova', () => {
    // Um item que se diz comprovado sem mostrar a prova e a mesma coisa que nao
    // estar comprovado.
    const desenhado = html({
      criteria: [{ criterion_id: 'x', statement: 'A suite passa', state: 'PROVEN', evidence: 'saida de 12/09', blocked_reason: null }],
      completion: { kind: 'PROVEN' },
    })
    expect(desenhado).toContain('saida de 12/09')
    expect(desenhado).toContain(copy.evidenceLabel)
    expect(desenhado).toContain(copy.criterion.PROVEN)
  })

  it('o item parado mostra DE QUEM depende, e nao so que esta parado', () => {
    const desenhado = html({
      criteria: [{ criterion_id: 'x', statement: 'O endereco aponta', state: 'BLOCKED_EXTERNAL', evidence: null, blocked_reason: 'a empresa que registra' }],
      completion: { kind: 'BLOCKED_EXTERNAL', criteria: ['x'], reasons: ['a empresa que registra'] },
    })
    expect(desenhado).toContain('a empresa que registra')
    expect(desenhado).toContain(copy.criterion.BLOCKED_EXTERNAL)
  })

  it('nenhum codigo de maquina vaza para a tela', () => {
    const desenhado = html({
      criteria: [
        { criterion_id: 'a', statement: 'um', state: 'UNPROVEN', evidence: null, blocked_reason: null },
        { criterion_id: 'b', statement: 'dois', state: 'REFUTED', evidence: null, blocked_reason: null },
      ],
      completion: { kind: 'REFUTED', criteria: ['b'] },
    })
    // A afirmacao e sobre o que a pessoa LE, e nao sobre o HTML cru: o seletor
    // de estado carrega os codigos em `value`, que e como um `<select>`
    // funciona e nunca aparece na tela. Comparar o HTML inteiro reprovaria o
    // seletor por existir — e afrouxar para o HTML inteiro deixaria passar um
    // codigo escrito como texto, que e o defeito de verdade.
    for (const codigo of CODIGOS) {
      expect(visibleText(desenhado), codigo).not.toContain(codigo)
    }
  })

  it('o codigo so aparece em `value`, e em lugar NENHUM alem disso', () => {
    // A afirmacao acima olha o texto visivel. Esta olha o resto do HTML: se um
    // codigo aparecer num `title`, num `aria-label` ou num `placeholder`, ele
    // chega a pessoa sem ser texto — e o teste de cima nao veria.
    const desenhado = html({
      criteria: [{ criterion_id: 'a', statement: 'um', state: 'UNPROVEN', evidence: null, blocked_reason: null }],
    })
    const semValues = desenhado.replace(/value="[A-Z_]+"/gu, 'value=""')
    for (const codigo of CODIGOS) expect(semValues, codigo).not.toContain(codigo)
  })

  it('em andamento aparece marcar como terminado — e a explicacao do que isso NAO faz', () => {
    const desenhado = html()
    expect(desenhado).toContain(copy.declareCandidate)
    expect(desenhado).toContain(copy.candidateHelp)
    expect(desenhado).not.toContain(copy.complete)
  })

  it('marcado como terminado aparece encerrar, e some o de marcar', () => {
    const desenhado = html({ status: 'CANDIDATE_COMPLETED' })
    expect(desenhado).toContain(copy.complete)
    expect(desenhado).not.toContain(copy.declareCandidate)
  })

  it('encerrado nao oferece gesto nenhum', () => {
    const desenhado = html({ status: 'COMPLETED', completion: { kind: 'PROVEN' } })
    expect(desenhado).not.toContain('<button')
    expect(desenhado).toContain(copy.status.COMPLETED)
  })

  it('ocupado desabilita o botao, para o gesto nao sair duas vezes', () => {
    const ocupado = renderToStaticMarkup(createElement(MissionCard, {
      mission: mission(), busy: true, onCandidate: () => undefined, onComplete: () => undefined, onRecord: async () => undefined,
    }))
    expect(ocupado).toContain('disabled')
  })
})

describe('o rascunho de criacao', () => {
  it('a meta vira o identificador, sem acento e sem pontuacao', () => {
    // Pedir a chave tecnica a quem esta escrevendo uma meta e pedir que ela
    // conheca o banco de dados.
    const feito = buildDraft('Colocar o site NO AR, para os clientes!', ['O formulario envia de verdade'], '', [])
    expect(feito.ok).toBe(true)
    if (!feito.ok) return
    expect(feito.draft.missionId).toBe('colocar-o-site-no-ar-para-os-clientes')
    expect(feito.draft.objective).toBe('Colocar o site NO AR, para os clientes!')
  })

  it('meta que nao sobra NADA depois de virar identificador e recusada, e nao inventa um', () => {
    // Inventar um identificador aleatorio aqui esconderia o caso: a pessoa
    // veria um objetivo com um nome que ela nao escreveu.
    const feito = buildDraft('🎯🎯🎯', ['algo a comprovar'], '', [])
    expect(feito).toEqual({ ok: false, problem: copy.slugImpossible })
  })

  it('identificador ja em uso NA TELA ganha sufixo, e nao colide', () => {
    const feito = buildDraft('Lancar o site', ['algo a comprovar'], '', ['lancar-o-site'])
    expect(feito.ok && feito.draft.missionId).toBe('lancar-o-site-2')
  })

  it('itens com a MESMA frase recebem identificadores distintos', () => {
    // O esquema do servidor recusa item repetido, e duas frases iguais
    // produziriam a mesma chave.
    const feito = buildDraft('Uma meta qualquer', ['O mesmo item', 'O mesmo item'], '', [])
    expect(feito.ok).toBe(true)
    if (!feito.ok) return
    expect(feito.draft.criteria.map(item => item.criterion_id)).toEqual(['o-mesmo-item', 'o-mesmo-item-2'])
    expect(feito.draft.criteria.map(item => item.statement)).toEqual(['O mesmo item', 'O mesmo item'])
  })

  it('item que nao sobra identificador nenhum ainda assim ganha um, pela posicao', () => {
    const feito = buildDraft('Uma meta qualquer', ['algo comprovavel', '🎯🎯🎯'], '', [])
    expect(feito.ok && feito.draft.criteria.map(item => item.criterion_id)).toEqual(['algo-comprovavel', 'item-2'])
  })

  it('meta curta, lista vazia e item curto tem frases DIFERENTES', () => {
    // Uma frase unica para tres problemas diferentes manda a pessoa procurar
    // sozinha qual deles e o dela.
    const curta = buildDraft('ab', ['algo a comprovar'], '', [])
    const semItem = buildDraft('Uma meta qualquer', ['  '], '', [])
    const itemCurto = buildDraft('Uma meta qualquer', ['ab'], '', [])
    expect([curta, semItem, itemCurto].every(item => !item.ok)).toBe(true)
    const frases = [curta, semItem, itemCurto].map(item => item.ok ? '' : item.problem)
    expect(new Set(frases).size).toBe(3)
  })

  it('limite em branco e SEM LIMITE, e nao zero', () => {
    // `Number('')` e 0: um limite de zero seria um objetivo que nasce estourado.
    const feito = buildDraft('Uma meta qualquer', ['algo a comprovar'], '   ', [])
    expect(feito.ok && feito.draft.maxTotalTokens).toBe(null)
  })

  it('limite quebrado, negativo ou zero e recusado antes da ida de rede', () => {
    for (const cru of ['0', '-5', '1,5', '1.5', 'mil', '1e3x']) {
      const feito = buildDraft('Uma meta qualquer', ['algo a comprovar'], cru, [])
      expect(feito, `aceitou "${cru}" como limite`).toEqual({ ok: false, problem: copy.limitNotWhole })
    }
    expect(buildDraft('Uma meta qualquer', ['algo a comprovar'], ' 1200 ', []).ok).toBe(true)
  })

  it('itens em branco no meio da lista SOMEM, e nao viram item vazio', () => {
    const feito = buildDraft('Uma meta qualquer', ['primeiro item', '   ', 'segundo item'], '', [])
    expect(feito.ok && feito.draft.criteria.map(item => item.statement)).toEqual(['primeiro item', 'segundo item'])
  })
})

describe('o formulario de criacao', () => {
  it('nasce com UM campo de item, e nao com zero', () => {
    // Um formulario que abre vazio faz a pessoa descobrir sozinha que precisa
    // acrescentar algo antes de poder enviar.
    const html = renderToStaticMarkup(createElement(MissionForm, { taken: [], onCreate: async () => undefined }))
    expect(html.match(/id="mission-criterion-\d+"/gu)).toHaveLength(1)
  })

  it('todo campo tem rotulo ligado por `for`, inclusive o do item', () => {
    const html = renderToStaticMarkup(createElement(MissionForm, { taken: [], onCreate: async () => undefined }))
    for (const id of ['mission-objective', 'mission-criterion-0', 'mission-limit']) {
      expect(html, `campo ${id} sem rotulo ligado`).toContain(`for="${id}"`)
      expect(html).toContain(`id="${id}"`)
    }
  })

  it('nao mostra o identificador tecnico em lugar nenhum', () => {
    const html = renderToStaticMarkup(createElement(MissionForm, { taken: [], onCreate: async () => undefined }))
    expect(html).not.toContain('mission_id')
    expect(html.toLowerCase()).not.toContain('identificador')
  })

  it('com um item so, NAO oferece tirar: tirar deixaria um estado que o envio recusa', () => {
    const html = renderToStaticMarkup(createElement(MissionForm, { taken: [], onCreate: async () => undefined }))
    expect(html).not.toContain(copy.removeCriterion)
  })
})

describe('registrar em que pe esta um item', () => {
  it('o campo TROCA com o estado: prova para comprovado, motivo para parado', () => {
    // O servidor recusa nos DOIS sentidos — prova num item nao comprovado e
    // recusada igual. Mostrar os dois campos convidaria a preencher o errado.
    expect(fieldFor('PROVEN')).toBe('evidence')
    expect(fieldFor('BLOCKED_EXTERNAL')).toBe('blocked')
    expect(fieldFor('UNPROVEN')).toBe('none')
    expect(fieldFor('REFUTED')).toBe('none')
  })

  it('comprovado SEM prova e recusado antes da ida de rede, com a frase certa', () => {
    expect(buildPatch('PROVEN', '   ')).toEqual({ ok: false, problem: copy.evidenceRequired })
    expect(buildPatch('BLOCKED_EXTERNAL', '')).toEqual({ ok: false, problem: copy.blockedRequired })
    // E as duas frases sao DIFERENTES: uma so mandaria a pessoa adivinhar qual
    // dos dois campos e o dela.
    expect(copy.evidenceRequired).not.toBe(copy.blockedRequired)
  })

  it('estado que nao exige texto manda os dois campos como `null` EXPLICITO', () => {
    // Omitir deixaria na tela um item "ainda sem prova" com "Onde esta a prova:
    // ..." logo abaixo — o mesmo verde artificial, pela outra metade do par.
    expect(buildPatch('UNPROVEN', 'sobrou daqui')).toEqual({
      ok: true, patch: { state: 'UNPROVEN', evidence: null, blocked_reason: null },
    })
    expect(buildPatch('REFUTED', '')).toEqual({
      ok: true, patch: { state: 'REFUTED', evidence: null, blocked_reason: null },
    })
  })

  it('comprovado limpa o motivo, e parado limpa a prova', () => {
    expect(buildPatch('PROVEN', ' o relatorio de 09/09 ')).toEqual({
      ok: true, patch: { state: 'PROVEN', evidence: 'o relatorio de 09/09', blocked_reason: null },
    })
    expect(buildPatch('BLOCKED_EXTERNAL', 'a empresa do endereco')).toEqual({
      ok: true, patch: { state: 'BLOCKED_EXTERNAL', blocked_reason: 'a empresa do endereco', evidence: null },
    })
  })

  it('o editor nasce no estado ATUAL do item, e nao num padrao', () => {
    // Nascer em "ainda sem prova" faria um clique distraido APAGAR a prova de
    // um item que ja estava comprovado.
    const html = renderToStaticMarkup(createElement(CriterionEditor, {
      missionId: 'm1',
      criterion: { criterion_id: 'c1', statement: 'algo', state: 'PROVEN', evidence: 'a prova de ontem', blocked_reason: null },
      onRecord: async () => undefined,
    }))
    expect(html).toContain('value="a prova de ontem"')
    expect(html).toMatch(/<option[^>]*selected[^>]*value="PROVEN"|value="PROVEN"[^>]*selected/u)
  })

  it('cada campo do editor tem rotulo ligado, e os identificadores nao colidem entre itens', () => {
    const um = renderToStaticMarkup(createElement(CriterionEditor, {
      missionId: 'm1',
      criterion: { criterion_id: 'c1', statement: 'algo', state: 'PROVEN', evidence: 'x', blocked_reason: null },
      onRecord: async () => undefined,
    }))
    const outro = renderToStaticMarkup(createElement(CriterionEditor, {
      missionId: 'm1',
      criterion: { criterion_id: 'c2', statement: 'algo', state: 'PROVEN', evidence: 'x', blocked_reason: null },
      onRecord: async () => undefined,
    }))
    for (const html of [um, outro]) {
      expect(html).toContain('-state"')
      expect(html).toContain('-text"')
    }
    // Dois itens na mesma tela com o mesmo `id` fazem o rotulo de um apontar
    // para o campo do outro, e o leitor de tela le a coisa errada.
    expect(um).toContain('criterion-m1-c1-state')
    expect(outro).toContain('criterion-m1-c2-state')
  })

  it('objetivo ENCERRADO nao oferece registrar: o servidor recusaria', () => {
    const encerrado = renderToStaticMarkup(createElement(MissionCard, {
      mission: mission({ status: 'COMPLETED' }), busy: false,
      onCandidate: () => undefined, onComplete: () => undefined, onRecord: async () => undefined,
    }))
    const andando = renderToStaticMarkup(createElement(MissionCard, {
      mission: mission({ status: 'RUNNING' }), busy: false,
      onCandidate: () => undefined, onComplete: () => undefined, onRecord: async () => undefined,
    }))
    expect(encerrado).not.toContain(copy.recordSubmit)
    expect(andando).toContain(copy.recordSubmit)
  })
})
