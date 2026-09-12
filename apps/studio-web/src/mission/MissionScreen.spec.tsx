import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import copy from '../i18n/mission.pt-BR.json'
import { availableActions, completionLabel, runCountLabel, spendLabel, MissionScreen } from './MissionScreen'
import type { MissionView } from './missionApi'

function mission(over: Partial<MissionView> = {}): MissionView {
  return {
    mission_id: 'm1', objective: 'Terminar com prova', status: 'RUNNING', max_total_tokens: 1_000,
    run_ids: [], criteria: [{ criterion_id: 'suite', statement: 'A suite passa', state: 'UNPROVEN', evidence: null, blocked_reason: null }],
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
