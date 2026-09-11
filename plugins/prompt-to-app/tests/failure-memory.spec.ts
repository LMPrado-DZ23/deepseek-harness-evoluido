import { describe, expect, it } from 'vitest'
import { FailureMemory } from '../src/failure-memory.js'

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
