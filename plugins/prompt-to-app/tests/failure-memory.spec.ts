import { describe, expect, it } from 'vitest'
import { crossRunWarning, FailureMemory, failureHistory, type PastFailure } from '../src/failure-memory.js'

describe('T-08: memória de falha — a mesma correção não é pedida três vezes igual', () => {
  it('na primeira vez, a correção é o próprio diagnóstico', () => {
    const memory = new FailureMemory()
    memory.record('build: exit 1')
    expect(memory.correctionFor('build: exit 1')).toBe('build: exit 1')
  })

  it('a partir da SEGUNDA repetição, o pedido muda de estratégia', () => {
    // Este é o defeito: o laço tenta três vezes e passa ao gerador o mesmo
    // diagnóstico da vez anterior. Falhando duas vezes pelo mesmo motivo, a
    // terceira pedia exatamente a mesma correção — mesma falha, mesma
    // estratégia, e a única coisa garantida era o gasto.
    const memory = new FailureMemory()
    memory.record('build: exit 1')
    memory.record('build: exit 1')
    const correction = memory.correctionFor('build: exit 1')
    expect(correction).toContain('já foi pedida 2 vezes')
    expect(correction).toContain('Mude de estratégia')
    // O diagnóstico original CONTINUA lá: mudar de abordagem não é esquecer
    // qual era o problema.
    expect(correction).toContain('build: exit 1')
  })

  it('não inventa correção quando não houve falha', () => {
    expect(new FailureMemory().correctionFor(undefined)).toBeUndefined()
  })

  it('espaço e quebra de linha não fazem duas ocorrências parecerem falhas diferentes', () => {
    const memory = new FailureMemory()
    memory.record('build: exit 1')
    memory.record('build:   exit 1\n')
    expect(memory.timesSeen('build: exit 1')).toBe(2)
    expect(memory.correctionFor('build: exit 1')).toContain('Mude de estratégia')
  })

  it('erros que diferem no ARQUIVO continuam sendo erros diferentes', () => {
    // A normalização não pode juntar falhas parecidas: uma repetição falsa
    // faria o Studio mudar de estratégia sem motivo, e piorar o pedido.
    const memory = new FailureMemory()
    memory.record('src/a.ts: tipo inválido')
    memory.record('src/b.ts: tipo inválido')
    expect(memory.timesSeen('src/a.ts: tipo inválido')).toBe(1)
    expect(memory.correctionFor('src/a.ts: tipo inválido')).toBe('src/a.ts: tipo inválido')
  })

  it('falhas ALTERNADAS não escalam antes da hora', () => {
    const memory = new FailureMemory()
    memory.record('erro A')
    memory.record('erro B')
    expect(memory.correctionFor('erro A')).toBe('erro A')
    memory.record('erro A')
    expect(memory.correctionFor('erro A')).toContain('Mude de estratégia')
  })

  it('diagnóstico vazio não vira falha registrada', () => {
    const memory = new FailureMemory()
    expect(memory.record('   ')).toBe(0)
    expect(memory.timesSeen('')).toBe(0)
  })

  it('o relato lista as falhas da mais repetida para a menos', () => {
    const memory = new FailureMemory()
    memory.record('raro')
    memory.record('comum'); memory.record('comum'); memory.record('comum')
    expect(memory.entries()).toEqual([
      { diagnostic: 'comum', times: 3 },
      { diagnostic: 'raro', times: 1 },
    ])
  })
})

describe('as falhas que ATRAVESSAM execucoes', () => {
  const AGORA = new Date('2026-09-12T12:00:00.000Z')

  function falha(over: Partial<PastFailure> = {}): PastFailure {
    return {
      project_id: 'p1', run_id: 'run-1', diagnostic: 'O teste de acessibilidade reprovou em src/Form.tsx',
      created_at: '2026-09-10T12:00:00.000Z', ...over,
    }
  }

  const janela = { currentRunId: 'run-atual', now: AGORA, windowDays: 30 }

  it('falha nova nao tem historico, e nao vira aviso', () => {
    // Um aviso que aparece sempre deixa de ser aviso, e gastaria teto de
    // contexto para nao dizer nada.
    const historico = failureHistory([], 'qualquer coisa', janela)
    expect(historico).toEqual({ times: 0, lastSeenAt: null, runs: [] })
    expect(crossRunWarning(historico)).toBeUndefined()
  })

  it('a mesma falha de outra execucao e encontrada, com a data da ultima', () => {
    const historico = failureHistory([
      falha({ run_id: 'run-1', created_at: '2026-09-10T12:00:00.000Z' }),
      falha({ run_id: 'run-2', created_at: '2026-09-11T12:00:00.000Z' }),
    ], 'O teste de acessibilidade reprovou em src/Form.tsx', janela)
    expect(historico.times).toBe(2)
    expect(historico.runs).toEqual(['run-2', 'run-1'])
    expect(historico.lastSeenAt).toBe('2026-09-11T12:00:00.000Z')
    expect(crossRunWarning(historico)).toContain('2 tentativa(s)')
  })

  it('a execucao ATUAL e excluida por IDENTIFICADOR, e nao por data', () => {
    // Relogio de maquina anda para tras, e uma falha da propria execucao
    // contada como historico faria a primeira tentativa parecer repeticao.
    const historico = failureHistory([
      falha({ run_id: 'run-atual', created_at: '2026-09-12T11:00:00.000Z' }),
    ], 'O teste de acessibilidade reprovou em src/Form.tsx', janela)
    expect(historico.times).toBe(0)
  })

  it('falha FORA da janela nao conta: ela pode ja ter sido corrigida por outra coisa', () => {
    // Continuar avisando seria mandar o gerador evitar um caminho que voltou a
    // funcionar.
    const historico = failureHistory([
      falha({ run_id: 'antiga', created_at: '2026-06-01T12:00:00.000Z' }),
    ], 'O teste de acessibilidade reprovou em src/Form.tsx', janela)
    expect(historico.times).toBe(0)
  })

  it('a janela e de quem PERGUNTA, e nao um numero fixo', () => {
    const antiga = [falha({ run_id: 'antiga', created_at: '2026-06-01T12:00:00.000Z' })]
    const texto = 'O teste de acessibilidade reprovou em src/Form.tsx'
    expect(failureHistory(antiga, texto, { ...janela, windowDays: 30 }).times).toBe(0)
    expect(failureHistory(antiga, texto, { ...janela, windowDays: 365 }).times).toBe(1)
  })

  it('espaco e quebra de linha nao fazem duas falhas parecerem diferentes', () => {
    const historico = failureHistory([
      falha({ run_id: 'run-1', diagnostic: 'O  teste   reprovou\n  em src/Form.tsx' }),
    ], 'O teste reprovou em src/Form.tsx', janela)
    expect(historico.times).toBe(1)
  })

  it('nome de arquivo DIFERENTE e falha diferente', () => {
    // Junta-los criaria uma falsa repeticao que levaria a mudar de estrategia
    // sem motivo.
    const historico = failureHistory([
      falha({ run_id: 'run-1', diagnostic: 'O teste reprovou em src/Outro.tsx' }),
    ], 'O teste reprovou em src/Form.tsx', janela)
    expect(historico.times).toBe(0)
  })

  it('data ilegivel e DESCARTADA, e nao tratada como recente', () => {
    // Uma linha corrompida virando "aconteceu agora" faria o aviso aparecer
    // por causa de um defeito de gravacao.
    const historico = failureHistory([
      falha({ run_id: 'run-1', created_at: 'nao e data' }),
    ], 'O teste de acessibilidade reprovou em src/Form.tsx', janela)
    expect(historico.times).toBe(0)
  })

  it('a mesma falha tres vezes na MESMA execucao conta como UMA ocasiao', () => {
    // Tres vezes na mesma tentativa e um laco de repeticao, nao tres ocasioes
    // — e contar como tres faria o aviso dizer que o problema e mais
    // persistente do que e.
    const historico = failureHistory([
      falha({ run_id: 'run-1', created_at: '2026-09-10T12:00:00.000Z' }),
      falha({ run_id: 'run-1', created_at: '2026-09-10T12:05:00.000Z' }),
      falha({ run_id: 'run-1', created_at: '2026-09-10T12:10:00.000Z' }),
    ], 'O teste de acessibilidade reprovou em src/Form.tsx', janela)
    expect(historico.times).toBe(3)
    expect(historico.runs).toEqual(['run-1'])
    expect(crossRunWarning(historico)).toContain('1 tentativa(s)')
  })

  it('diagnostico VAZIO nao casa com nada', () => {
    expect(failureHistory([falha({ diagnostic: '   ' })], '   ', janela).times).toBe(0)
  })

  it('o aviso diz QUANTAS execucoes e QUANDO foi a ultima', () => {
    // Sem a contagem, "ja aconteceu" nao distingue uma vez de dez; sem a data,
    // quem le nao julga se o mundo mudou desde entao.
    const aviso = crossRunWarning({ times: 5, lastSeenAt: '2026-09-11T12:00:00.000Z', runs: ['a', 'b'] })!
    expect(aviso).toContain('2 tentativa(s)')
    expect(aviso).toContain('2026-09-11T12:00:00.000Z')
  })

  it('historico sem EXECUCAO nenhuma nao vira aviso, mesmo com data', () => {
    // A frase conta EXECUCOES. Com a lista vazia ela diria "0 tentativa(s)",
    // que e um aviso sobre nada — e o chamador nao precisa saber que essa
    // combinacao e impossivel vinda de `failureHistory`: a guarda e aqui.
    expect(crossRunWarning({ times: 3, lastSeenAt: '2026-09-11T12:00:00.000Z', runs: [] })).toBeUndefined()
  })

  it('o aviso NAO conclui que a abordagem nao funciona', () => {
    // "Isto falhou tres vezes" virando "isto nao funciona" e uma REGRA, e esta
    // memoria nao conclui: ela conta o que aconteceu e quem le decide.
    const aviso = crossRunWarning({ times: 3, lastSeenAt: '2026-09-11T12:00:00.000Z', runs: ['a'] })!
    expect(aviso).toContain('tende a ser o mesmo')
    expect(aviso).not.toContain('não funciona')
    expect(aviso).not.toContain('impossível')
  })
})
