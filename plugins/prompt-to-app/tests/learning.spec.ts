import { describe, expect, it } from 'vitest'

import {
  MAX_ERROR_RATE,
  MIN_OCCASIONS,
  type Observation,
  VALIDATION_WINDOW_DAYS,
  applicableRules,
  deriveRules,
  ruleEvidence,
} from '../src/learning.js'

const NOW = new Date('2026-09-12T12:00:00.000Z')
const recently = new Date(NOW.getTime() - 86_400_000)

function observe(pattern: string, occasion: string, held: boolean, at = recently): Observation {
  return { pattern, occasion, held, at }
}

/** Ocasioes distintas, todas a favor. */
function supporting(pattern: string, count: number, at = recently): Observation[] {
  return Array.from({ length: count }, (_value, index) => observe(pattern, `ocasiao-${index}`, true, at))
}

function derive(observations: readonly Observation[], challenged: readonly string[] = [], now = NOW) {
  return deriveRules(observations, { now, challengedPatterns: challenged })
}

describe('o caminho ate VALIDATED', () => {
  it('repeticao independente, contraprova procurada e taxa baixa viram REGRA', () => {
    const [rule] = derive(supporting('usar-zod', MIN_OCCASIONS), ['usar-zod'])
    expect(rule).toMatchObject({ pattern: 'usar-zod', status: 'VALIDATED', supporting: MIN_OCCASIONS, contradicting: 0 })
  })

  it('uma contradicao dentro do teto ainda valida', () => {
    const observations = [...supporting('x', 9), observe('x', 'ruim', false)]
    expect(derive(observations, ['x'])[0]).toMatchObject({ status: 'VALIDATED', supporting: 9, contradicting: 1 })
  })
})

describe('o portao da REPETICAO INDEPENDENTE', () => {
  it('menos ocasioes que o minimo fica CANDIDATA', () => {
    const [rule] = derive(supporting('x', MIN_OCCASIONS - 1), ['x'])
    expect(rule).toMatchObject({ status: 'CANDIDATE', reason: 'TOO_FEW_OCCASIONS' })
  })

  it('tres repeticoes na MESMA ocasiao sao UMA observacao', () => {
    // Tres falhas na mesma execucao sao um laco de repeticao; conta-las como
    // tres diria que a evidencia e mais forte do que e.
    const observations = [
      observe('x', 'mesma', true), observe('x', 'mesma', true), observe('x', 'mesma', true),
    ]
    const [rule] = derive(observations, ['x'])
    expect(rule).toMatchObject({ status: 'CANDIDATE', reason: 'TOO_FEW_OCCASIONS', supporting: 1 })
  })

  it('o minimo e TRES, e a razao e que com dois a regra nasce incontestavel', () => {
    // Com duas ocasioes, a segunda coincidencia JA e a regra e nao existe
    // observacao capaz de contradize-la antes de ela nascer.
    expect(MIN_OCCASIONS).toBeGreaterThanOrEqual(3)
  })
})

describe('o portao da CONTRAPROVA', () => {
  it('padrao nunca contestado fica CANDIDATA, por mais evidencia a favor que tenha', () => {
    // Esta e a linha que separa aprender de confirmar: nenhuma quantidade de
    // evidencia a favor a satisfaz.
    const [rule] = derive(supporting('x', 50), [])
    expect(rule).toMatchObject({ status: 'CANDIDATE', reason: 'NEVER_CHALLENGED', supporting: 50 })
  })

  it('ter procurado contraprova e nao ter achado JA basta', () => {
    // O que se exige e a BUSCA, e nao o achado: um padrao verdadeiro nao tem
    // contraprova, e exigi-la excluiria exatamente as regras boas.
    const [rule] = derive(supporting('x', MIN_OCCASIONS), ['x'])
    expect(rule!.status).toBe('VALIDATED')
  })

  it('contestar OUTRO padrao nao valida este', () => {
    const [rule] = derive(supporting('x', MIN_OCCASIONS), ['y'])
    expect(rule).toMatchObject({ reason: 'NEVER_CHALLENGED' })
  })
})

describe('o portao da TAXA DE ERRO', () => {
  it('errar acima do teto mantem em CANDIDATA, mesmo contestada', () => {
    // Uma correlacao chamada de regra e o passo que vira supersticao: quem le
    // depois nao ve a taxa, ve a regra.
    const observations = [...supporting('x', 7), observe('x', 'a', false), observe('x', 'b', false), observe('x', 'c', false)]
    const [rule] = derive(observations, ['x'])
    expect(rule).toMatchObject({ status: 'CANDIDATE', reason: 'ERROR_RATE', supporting: 7, contradicting: 3 })
  })

  it('exatamente no teto ainda valida', () => {
    const total = 10
    const errors = Math.round(total * MAX_ERROR_RATE)
    const observations = [
      ...supporting('x', total - errors),
      ...Array.from({ length: errors }, (_value, index) => observe('x', `erro-${index}`, false)),
    ]
    expect(derive(observations, ['x'])[0]!.status).toBe('VALIDATED')
  })

  it('errar MAIS do que acertar e REFUTADA, e nao candidata', () => {
    // Mante-la como candidata faria a lista de candidatos crescer com coisas
    // que ja se sabe que nao valem.
    const observations = [
      observe('x', 'a', true),
      observe('x', 'b', false), observe('x', 'c', false),
    ]
    const [rule] = derive(observations, ['x'])
    expect(rule).toMatchObject({ status: 'REFUTED', supporting: 1, contradicting: 2 })
  })

  it('a refutacao NAO espera a amostra minima', () => {
    const [rule] = derive([observe('x', 'a', false)], [])
    expect(rule!.status).toBe('REFUTED')
  })

  it('a refutacao nao depende de ter sido contestada', () => {
    const observations = [observe('x', 'a', true), observe('x', 'b', false), observe('x', 'c', false)]
    expect(derive(observations, [])[0]!.status).toBe('REFUTED')
  })
})

describe('o portao da VALIDADE', () => {
  it('regra validada sobre dado velho VENCE, e volta a precisar de evidencia', () => {
    const old = new Date(NOW.getTime() - (VALIDATION_WINDOW_DAYS + 1) * 86_400_000)
    const [rule] = derive(supporting('x', MIN_OCCASIONS, old), ['x'])
    expect(rule).toMatchObject({ status: 'EXPIRED', reason: 'STALE' })
  })

  it('exatamente na borda da janela ainda vale', () => {
    const borda = new Date(NOW.getTime() - VALIDATION_WINDOW_DAYS * 86_400_000)
    expect(derive(supporting('x', MIN_OCCASIONS, borda), ['x'])[0]!.status).toBe('VALIDATED')
  })

  it('observacao do FUTURO nao sustenta a regra', () => {
    // Um relogio adiantado manteria a regra validada para sempre.
    const futuro = new Date(NOW.getTime() + 10_000)
    expect(derive(supporting('x', MIN_OCCASIONS, futuro), ['x'])[0]!.status).toBe('EXPIRED')
  })

  it('vale a observacao MAIS RECENTE do padrao', () => {
    const old = new Date(NOW.getTime() - (VALIDATION_WINDOW_DAYS + 10) * 86_400_000)
    const observations = [...supporting('x', MIN_OCCASIONS - 1, old), observe('x', 'nova', true, recently)]
    expect(derive(observations, ['x'])[0]!.status).toBe('VALIDATED')
  })
})

describe('dentro de uma ocasiao, a contradicao pesa mais', () => {
  it('uma falha na mesma ocasiao derruba a confirmacao dela', () => {
    // Deixar a confirmacao sobrescrever seria escolher a noticia boa dentro do
    // proprio dado.
    const observations = [observe('x', 'mista', true), observe('x', 'mista', false)]
    const [rule] = derive(observations, ['x'])
    expect(rule).toMatchObject({ supporting: 0, contradicting: 1 })
  })

  it('a ordem em que as observacoes chegam nao muda o resultado', () => {
    const primeiro = derive([observe('x', 'm', true), observe('x', 'm', false)], ['x'])[0]
    const segundo = derive([observe('x', 'm', false), observe('x', 'm', true)], ['x'])[0]
    expect(primeiro).toEqual(segundo)
  })
})

describe('applicableRules — o que pode virar instrucao', () => {
  it('SO as validadas saem', () => {
    // O que sai daqui vira instrucao que um agente segue, e uma instrucao nao
    // carrega consigo o aviso de que era so uma hipotese.
    const rules = derive([
      ...supporting('valida', MIN_OCCASIONS),
      ...supporting('candidata', MIN_OCCASIONS),
      observe('refutada', 'a', false),
    ], ['valida'])
    expect(applicableRules(rules).map(rule => rule.pattern)).toEqual(['valida'])
  })

  it('nenhuma regra validada devolve lista vazia, e nao a melhor candidata', () => {
    expect(applicableRules(derive(supporting('x', MIN_OCCASIONS), []))).toEqual([])
  })
})

describe('ruleEvidence', () => {
  it('a evidencia vai GRUDADA na regra', () => {
    // Regra sem numeros pede obediencia; com numeros, pede julgamento.
    const observations = [...supporting('x', 9), observe('x', 'ruim', false)]
    const [rule] = derive(observations, ['x'])
    expect(ruleEvidence(rule!)).toBe('x (9/10)')
  })
})

describe('varios padroes juntos', () => {
  it('cada padrao e julgado sozinho', () => {
    const rules = derive([
      ...supporting('a', MIN_OCCASIONS),
      ...supporting('b', 1),
      observe('c', 'x', false), observe('c', 'y', false),
    ], ['a', 'b', 'c'])
    const byPattern = Object.fromEntries(rules.map(rule => [rule.pattern, rule.status]))
    expect(byPattern).toEqual({ a: 'VALIDATED', b: 'CANDIDATE', c: 'REFUTED' })
  })

  it('lista vazia nao inventa regra nenhuma', () => {
    expect(derive([], ['x'])).toEqual([])
  })
})
