import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import copy from '../i18n/mission.pt-BR.json'
import { availableActions, completionLabel, MissionCard, MissionScreen, runCountLabel, spendLabel } from './MissionScreen'
import type { MissionView } from './missionApi'

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
    mission: mission(over), busy: false, onCandidate: () => undefined, onComplete: () => undefined,
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
    for (const codigo of ['UNPROVEN', 'REFUTED', 'BLOCKED_EXTERNAL', 'CANDIDATE_COMPLETED', 'NO_LIMIT']) {
      expect(desenhado, codigo).not.toContain(codigo)
    }
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
      mission: mission(), busy: true, onCandidate: () => undefined, onComplete: () => undefined,
    }))
    expect(ocupado).toContain('disabled')
  })
})
