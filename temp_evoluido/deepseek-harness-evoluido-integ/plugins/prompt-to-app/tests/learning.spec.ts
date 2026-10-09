import { describe, expect, it } from 'vitest'

import {
  MAX_ERROR_RATE,
  MIN_OCCASIONS,
  type Observation,
  type ObservedRun,
  observationsFrom,
  VALIDATION_WINDOW_DAYS,
  applicableRules,
  deriveRules,
  recoveryNoteFor,
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

describe('observationsFrom — o que o registro sabe responder sozinho', () => {
  function run(overrides: Partial<ObservedRun> = {}): ObservedRun {
    return {
      project_id: 'p', run_id: 'r', operation_id: 'op', attempt: 1,
      state: 'FAILED', failure_code: 'build: exit 1',
      finished_at: recently.toISOString(), started_at: recently.toISOString(),
      ...overrides,
    }
  }

  function ler(runs: readonly ObservedRun[]) {
    return observationsFrom(runs, { now: NOW })
  }

  it('falhou e depois PASSOU na mesma operacao: a recuperacao valeu', () => {
    const { observations } = ler([run(), run({ run_id: 'r2', attempt: 2, state: 'PASSED', failure_code: null })])
    expect(observations).toEqual([{ pattern: 'recuperou:build: exit 1', occasion: 'p/op', held: true, at: recently }])
  })

  it('falhou e NUNCA passou: a recuperacao nao valeu', () => {
    const { observations } = ler([run(), run({ run_id: 'r2', attempt: 2 })])
    expect(observations).toEqual([{ pattern: 'recuperou:build: exit 1', occasion: 'p/op', held: false, at: recently }])
  })

  it('tres tentativas da MESMA criacao sao UMA ocasiao', () => {
    // Tres tentativas de um laco nao sao tres evidencias independentes.
    const { observations } = ler([run(), run({ run_id: 'r2', attempt: 2 }), run({ run_id: 'r3', attempt: 3 })])
    expect(observations).toHaveLength(1)
  })

  it('a tentativa que falhou NAO conta contra a criacao que a seguinte salvou', () => {
    // O desfecho e por OPERACAO. Marcar cada tentativa separadamente faria a
    // tentativa 2 contar contra uma criacao que a 3 salvou.
    const { observations } = ler([
      run({ attempt: 1 }), run({ run_id: 'r2', attempt: 2 }),
      run({ run_id: 'r3', attempt: 3, state: 'PASSED', failure_code: null }),
    ])
    expect(observations[0]!.held).toBe(true)
  })

  it('operacoes DIFERENTES sao ocasioes diferentes', () => {
    const { observations } = ler([run(), run({ operation_id: 'op2', run_id: 'r2' })])
    expect(observations).toHaveLength(2)
    expect(new Set(observations.map(item => item.occasion)).size).toBe(2)
  })

  it('a ocasiao carrega o PROJETO: um projeto nao aprende com o vizinho', () => {
    const { observations } = ler([run({ project_id: 'outro' })])
    expect(observations[0]!.occasion).toBe('outro/op')
  })

  it('execucao que nao TERMINOU nao observa nada', () => {
    expect(ler([run({ state: 'RUNNING' })]).observations).toEqual([])
    expect(ler([run({ state: 'CANCELLED' })]).observations).toEqual([])
  })

  it('falha SEM assinatura nao vira padrao', () => {
    // Um padrao chamado `recuperou:` nao diz nada e juntaria falhas distintas.
    expect(ler([run({ failure_code: null })]).observations).toEqual([])
    expect(ler([run({ failure_code: '' })]).observations).toEqual([])
  })

  it('fora da janela nao entra, e do FUTURO tambem nao', () => {
    const velha = new Date(NOW.getTime() - (VALIDATION_WINDOW_DAYS + 1) * 86_400_000).toISOString()
    const futura = new Date(NOW.getTime() + 60_000).toISOString()
    expect(ler([run({ finished_at: velha, started_at: velha })]).observations).toEqual([])
    expect(ler([run({ finished_at: futura, started_at: futura })]).observations).toEqual([])
  })

  it('data ilegivel e DESCARTADA, e nao tratada como agora', () => {
    expect(ler([run({ finished_at: 'ontem', started_at: 'ontem' })]).observations).toEqual([])
  })

  it('sem `finished_at`, vale quando ela COMECOU', () => {
    expect(ler([run({ finished_at: null })]).observations).toHaveLength(1)
  })

  it('a leitura DECLARA a contraprova porque percorreu a janela inteira', () => {
    // Ela nao filtra por desfecho: toda ocasiao em que a condicao apareceu
    // entrou, tenha dado certo ou errado. E isso que `challengedPatterns`
    // significa — e um leitor que consultasse so os sucessos nao poderia
    // declarar nada.
    const { challenged } = ler([run(), run({ operation_id: 'op2', run_id: 'r2', failure_code: 'test: exit 1' })])
    expect([...challenged].sort()).toEqual(['recuperou:build: exit 1', 'recuperou:test: exit 1'])
  })

  it('de ponta a ponta: tres ocasioes contestadas viram REGRA', () => {
    const runs = [0, 1, 2].flatMap(index => [
      run({ operation_id: `op${String(index)}`, run_id: `a${String(index)}` }),
      run({ operation_id: `op${String(index)}`, run_id: `b${String(index)}`, state: 'PASSED', failure_code: null }),
    ])
    const { observations, challenged } = ler(runs)
    const rules = deriveRules(observations, { now: NOW, challengedPatterns: challenged })
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({ status: 'VALIDATED', supporting: 3, contradicting: 0 })
  })

  it('de ponta a ponta: sem ocasioes bastantes ela fica CANDIDATA', () => {
    const { observations, challenged } = ler([run(), run({ run_id: 'r2', state: 'PASSED', failure_code: null })])
    const rules = deriveRules(observations, { now: NOW, challengedPatterns: challenged })
    expect(rules[0]).toMatchObject({ status: 'CANDIDATE', reason: 'TOO_FEW_OCCASIONS' })
  })
})

describe('recoveryNoteFor — o aprendizado finalmente FALA com alguem (T-20)', () => {
  const agora = new Date('2026-09-12T12:00:00.000Z')
  /** Uma operacao: uma tentativa que falhou com `falha`, e o desfecho dela. */
  const operacao = (id: string, falha: string, passou: boolean, dia = 1): ObservedRun[] => [
    { project_id: 'p', run_id: `${id}-1`, operation_id: id, attempt: 1, state: 'FAILED', failure_code: falha,
      finished_at: `2026-09-0${String(dia)}T10:00:00.000Z`, started_at: `2026-09-0${String(dia)}T09:00:00.000Z` },
    ...(passou ? [{ project_id: 'p', run_id: `${id}-2`, operation_id: id, attempt: 2, state: 'PASSED', failure_code: null,
      finished_at: `2026-09-0${String(dia)}T11:00:00.000Z`, started_at: `2026-09-0${String(dia)}T10:30:00.000Z` }] : []),
  ]

  it('tres ocasioes superadas viram uma frase, COM os dois numeros', () => {
    // O numero vai junto sempre: uma regra sem evidencia pede obediencia, com
    // evidencia pede julgamento — e quem le pode discordar dela.
    const runs = [...operacao('o1', 'build: exit 1', true, 1), ...operacao('o2', 'build: exit 1', true, 2), ...operacao('o3', 'build: exit 1', true, 3)]
    const nota = recoveryNoteFor('build: exit 1', runs, { now: agora })
    expect(nota).toBeDefined()
    expect(nota).toContain('3 de 3')
    // E NAO manda a pessoa obedecer.
    expect(nota).toContain('a decisão é sua')
    expect(nota).toContain('não é garantia')
  })

  it('DUAS ocasioes nao dizem nada: candidata nao e regra', () => {
    // Uma candidata dita em voz de regra e supersticao com aparencia de
    // conhecimento.
    const runs = [...operacao('o1', 'build: exit 1', true, 1), ...operacao('o2', 'build: exit 1', true, 2)]
    expect(recoveryNoteFor('build: exit 1', runs, { now: agora })).toBeUndefined()
  })

  it('a falha que acabou de acontecer CONTA no total, e ela e uma contradicao', () => {
    // Mostrar so os acertos contaria a noticia boa e esconderia a que a pessoa
    // acabou de viver, na propria tela em que ela a viveu.
    const runs = [
      ...operacao('o1', 'build: exit 1', true, 1), ...operacao('o2', 'build: exit 1', true, 2),
      ...operacao('o3', 'build: exit 1', true, 3), ...operacao('o4', 'build: exit 1', true, 4),
      ...operacao('agora', 'build: exit 1', false, 5),
    ]
    const nota = recoveryNoteFor('build: exit 1', runs, { now: agora })
    expect(nota).toContain('4 de 5')
  })

  it('a falha que quase nunca e superada NAO vira conselho', () => {
    // Taxa de erro acima do teto: a regra nao passa na validacao, e o silencio
    // e a resposta certa. Dizer "ja foi superada em 1 de 4" com voz de regra
    // mandaria alguem gastar tentativa atras de uma coisa que nao costuma dar.
    const runs = [
      ...operacao('o1', 'oom', true, 1), ...operacao('o2', 'oom', false, 2),
      ...operacao('o3', 'oom', false, 3), ...operacao('o4', 'oom', false, 4),
    ]
    expect(recoveryNoteFor('oom', runs, { now: agora })).toBeUndefined()
  })

  it('a nota e da FALHA desta execucao, e nao de outra qualquer', () => {
    const runs = [...operacao('o1', 'build: exit 1', true, 1), ...operacao('o2', 'build: exit 1', true, 2), ...operacao('o3', 'build: exit 1', true, 3)]
    expect(recoveryNoteFor('tests: 3 failed', runs, { now: agora })).toBeUndefined()
  })

  it('sem falha nomeada nao ha o que procurar', () => {
    const runs = [...operacao('o1', 'build: exit 1', true, 1), ...operacao('o2', 'build: exit 1', true, 2), ...operacao('o3', 'build: exit 1', true, 3)]
    expect(recoveryNoteFor(undefined, runs, { now: agora })).toBeUndefined()
    expect(recoveryNoteFor('', runs, { now: agora })).toBeUndefined()
  })

  it('registro VAZIO nao inventa conselho', () => {
    expect(recoveryNoteFor('build: exit 1', [], { now: agora })).toBeUndefined()
  })

  it('o que envelheceu fora da janela para de aconselhar', () => {
    // Uma falha de meses atras ja pode ter sido corrigida, e um conselho velho
    // e pior do que nenhum: ele parece atual.
    const runs = [...operacao('o1', 'build: exit 1', true, 1), ...operacao('o2', 'build: exit 1', true, 2), ...operacao('o3', 'build: exit 1', true, 3)]
    expect(recoveryNoteFor('build: exit 1', runs, { now: agora, windowDays: 1 })).toBeUndefined()
  })
})
