import { describe, expect, it } from 'vitest'
import { usoDaTarefa } from './uso'

describe('o uso e o custo da tarefa', () => {
  it('uso DESCONHECIDO não vira zero', () => {
    // A proibição está escrita no adendo do proprietário: "uso desconhecido
    // nunca vira zero". Zero e "não registrado" são respostas diferentes.
    const uso = usoDaTarefa([{ run_id: 'r1', attempt: 1 }])
    expect(uso.custoEstimadoUsd).toBeNull()
    expect(uso.tokensEntrada).toBeNull()
    expect(uso.tentativasSemRegistro).toBe(1)
  })

  it('zero REGISTRADO continua sendo zero, e não vira desconhecido', () => {
    const uso = usoDaTarefa([{ run_id: 'r1', attempt: 1, estimated_cost_usd: 0, input_tokens: 0 }])
    expect(uso.custoEstimadoUsd).toBe(0)
    expect(uso.tokensEntrada).toBe(0)
    expect(uso.tentativasSemRegistro).toBe(0)
  })

  it('a mesma tentativa duas vezes NÃO dobra o custo', () => {
    // O corpo da tarefa traz a tentativa corrente em `runs` e em `current_run`.
    const corrente = { run_id: 'r1', attempt: 1, estimated_cost_usd: 0.5, input_tokens: 100 }
    const uso = usoDaTarefa([corrente, corrente])
    expect(uso.tentativas).toBe(1)
    expect(uso.custoEstimadoUsd).toBe(0.5)
    expect(uso.tokensEntrada).toBe(100)
  })

  it('soma só o que foi registrado, e DIZ quantas ficaram de fora', () => {
    const uso = usoDaTarefa([
      { run_id: 'r1', attempt: 1, estimated_cost_usd: 0.25 },
      { run_id: 'r2', attempt: 2 },
      { run_id: 'r3', attempt: 3, estimated_cost_usd: 0.75 },
    ])
    expect(uso.custoEstimadoUsd).toBe(1)
    expect(uso.tentativasSemRegistro).toBe(1)
    expect(uso.tentativas).toBe(3)
  })

  it('as rotas e os modelos saem sem repetição e em ordem estável', () => {
    const uso = usoDaTarefa([
      { run_id: 'r1', attempt: 1, route: 'deepseek', model: 'chat' },
      { run_id: 'r2', attempt: 2, route: 'ollama', model: 'chat' },
      { run_id: 'r3', attempt: 3, route: 'deepseek', model: null },
    ])
    expect(uso.rotas).toEqual(['deepseek', 'ollama'])
    expect(uso.modelos).toEqual(['chat'])
  })

  it('sem tentativa nenhuma, tudo é ausência — e não zero', () => {
    const uso = usoDaTarefa([])
    expect(uso).toMatchObject({ tentativas: 0, custoEstimadoUsd: null, tokensEntrada: null, tentativasSemRegistro: 0 })
  })
})
