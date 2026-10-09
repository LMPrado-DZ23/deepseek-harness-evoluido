import { describe, expect, it } from 'vitest'
import { resultOfRun } from './App'

type Details = Parameters<typeof resultOfRun>[0]

const details = (run: Partial<NonNullable<Details['current_run']>> & { state: NonNullable<Details['current_run']>['state'] }, projectState: Details['project']['state'] = 'VERIFIED_PROTOTYPE'): Details => ({
  project: { state: projectState },
  current_run: { stage: 'verify', attempt: 1, failure_code: null, acceptance_checks: [], ...run },
})

describe('o resultado que a tela mostra', () => {
  it('marca a criação que RETOMOU, para a pessoa saber por que foi tão rápido', () => {
    // Sem este aviso a retomada seria invisível: a criação terminaria em
    // segundos e a pessoa não teria como saber se o Studio pulou etapa. O que
    // ele pulou foi pedir ao modelo de novo — e o aplicativo é o mesmo que ela
    // mandou construir, e não um segundo aplicativo parecido.
    expect(resultOfRun(details({ state: 'PASSED', resumed_from_run_id: 'run-anterior' }))?.resumed).toBe(true)
  })

  it('não marca a criação que gerou do zero', () => {
    // Ausência do campo é ausência de retomada. Um valor padrão aqui faria toda
    // criação normal anunciar que retomou de algum lugar.
    expect(resultOfRun(details({ state: 'PASSED' }))?.resumed).toBeUndefined()
  })

  it('BUDGET_EXCEEDED não vira "a verificação encontrou um problema"', () => {
    // Este estado já existia na máquina e faltava aqui: caía no último ramo, e
    // quem ficou sem orçamento lia que a verificação achou um defeito.
    expect(resultOfRun(details({ state: 'BUDGET_EXCEEDED' }, 'BUILD_FAILED'))?.state).toBe('BUDGET_EXCEEDED')
  })

  it('execução em andamento ainda não é resultado nenhum', () => {
    expect(resultOfRun(details({ state: 'RUNNING' }, 'GENERATING'))).toBeNull()
  })
})
