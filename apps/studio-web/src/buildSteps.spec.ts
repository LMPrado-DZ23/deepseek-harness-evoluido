import { describe, expect, it } from 'vitest'
import { BUILD_STEP_ORDER, buildStepLabel, buildStepRows, buildStepStateLabel, hasBuildSteps, type RunStepRecord } from './buildSteps'
import t from './i18n/pt-BR.json'

const step = (over: Partial<RunStepRecord> & Pick<RunStepRecord, 'step'>): RunStepRecord =>
  ({ state: 'PASSED', started_at: '2026-09-09T12:00:00.000Z', finished_at: '2026-09-09T12:00:10.000Z', ...over })

describe('a linha do tempo da construção', () => {
  it('mostra os quatro passos mesmo quando só o primeiro começou', () => {
    const rows = buildStepRows([step({ step: 'install', state: 'RUNNING', finished_at: null })], false)
    expect(rows.map(row => row.step)).toEqual([...BUILD_STEP_ORDER])
    expect(rows.map(row => row.state)).toEqual(['running', 'waiting', 'waiting', 'waiting'])
  })

  it('separa "ainda vai" de "não chegou a ser" pelo fim da execução', () => {
    const steps = [step({ step: 'install' }), step({ step: 'build', state: 'FAILED' })]
    expect(buildStepRows(steps, false).map(row => row.state)).toEqual(['passed', 'failed', 'waiting', 'waiting'])
    // A MESMA ausência, depois que a execução acabou, deixa de ser promessa.
    // Dizer "ainda vai acontecer" sobre um passo que nunca vai acontecer é o
    // defeito que esta distinção existe para impedir.
    expect(buildStepRows(steps, true).map(row => row.state)).toEqual(['passed', 'failed', 'never', 'never'])
  })

  it('conta os segundos só do passo que terminou', () => {
    const rows = buildStepRows([
      step({ step: 'install', started_at: '2026-09-09T12:00:00.000Z', finished_at: '2026-09-09T12:00:42.000Z' }),
      step({ step: 'build', state: 'RUNNING', finished_at: null }),
    ], false)
    expect(rows[0]!.seconds).toBe(42)
    // Um cronômetro correndo congelaria no primeiro engasgo de rede, e número
    // parado mente com mais convicção do que número nenhum.
    expect(rows[1]!.seconds).toBeNull()
  })

  it('descarta um passo que este cliente não conhece em vez de quebrar a lista', () => {
    // Um servidor mais novo que a interface não pode apagar a tela de quem está
    // esperando a criação terminar.
    const rows = buildStepRows([step({ step: 'install' }), step({ step: 'lint-do-futuro' })], false)
    expect(rows).toHaveLength(4)
    expect(rows[0]!.state).toBe('passed')
  })

  it('trata execução antiga, sem o campo, como execução sem passos', () => {
    expect(hasBuildSteps(undefined)).toBe(false)
    expect(buildStepRows(undefined, true).map(row => row.state)).toEqual(['never', 'never', 'never', 'never'])
  })

  it('tem frase em português para todo passo e todo estado', () => {
    for (const name of BUILD_STEP_ORDER) expect(buildStepLabel(name).length).toBeGreaterThan(3)
    for (const state of ['running', 'passed', 'failed', 'waiting', 'never'] as const) {
      expect(buildStepStateLabel(state).length).toBeGreaterThan(2)
    }
    // A tabela é EXAUSTIVA sobre a união: um passo novo no construtor não
    // compila até alguém escrever a frase dele. Este teste guarda o outro lado
    // — que as frases não sumiram do catálogo.
    expect(Object.keys(t.creation.steps.labels).sort()).toEqual([...BUILD_STEP_ORDER].sort())
  })

  it('nenhuma frase de passo repete outra', () => {
    // Duas etapas com a mesma frase é exatamente o defeito de origem: a pessoa
    // via o mesmo texto imóvel enquanto quatro coisas diferentes aconteciam.
    const labels = BUILD_STEP_ORDER.map(buildStepLabel)
    expect(new Set(labels).size).toBe(labels.length)
  })
})
