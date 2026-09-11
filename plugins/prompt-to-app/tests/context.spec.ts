import { describe, expect, it } from 'vitest'
import {
  ContextBudgetExceededError,
  DEFAULT_CONTEXT_BUDGET_CHARS,
  assembleContext,
  type ContextSection,
} from '../src/context.js'

const instruction = (id: string, text: string): ContextSection =>
  ({ id, kind: 'instruction', priority: 0, text, source: 'instrução' })
const schema = (id: string, text: string): ContextSection =>
  ({ id, kind: 'schema', priority: 0, text, source: 'schema' })
const evidence = (id: string, text: string, priority: number, source = 'evidência'): ContextSection =>
  ({ id, kind: 'evidence', priority, text, source })

describe('T-07: o contexto tem teto, e o que não coube fica registrado', () => {
  it('sem aperto, tudo entra na ordem de entrada', () => {
    const { prompt, ledger } = assembleContext([
      instruction('a', 'faça assim'),
      evidence('b', 'este é o material', 10),
      schema('c', 'responda neste formato'),
    ])
    expect(prompt).toBe('faça assim\neste é o material\nresponda neste formato')
    expect(ledger.dropped).toEqual([])
    expect(ledger.included.map(item => item.id)).toEqual(['a', 'b', 'c'])
    expect(ledger.budget).toBe(DEFAULT_CONTEXT_BUDGET_CHARS)
  })

  it('quando falta espaço, corta EVIDÊNCIA — e a de menor prioridade primeiro', () => {
    const { prompt, ledger } = assembleContext([
      instruction('inst', 'X'.repeat(10)),
      evidence('importante', 'A'.repeat(10), 100),
      evidence('dispensavel', 'B'.repeat(10), 1),
      schema('sch', 'Y'.repeat(10)),
    ], { budgetChars: 33 })
    expect(prompt).toContain('A'.repeat(10))
    expect(prompt).not.toContain('B'.repeat(10))
    expect(ledger.dropped).toEqual([{ id: 'dispensavel', source: 'evidência', chars: 10, reason: 'BUDGET' }])
  })

  it('instrução e schema NUNCA são cortados: eles estourando, isto FALHA', () => {
    // Cortar o schema produziria uma resposta que o `parse` recusa, e a pessoa
    // leria "formato inválido" sobre um problema que era de TAMANHO. O erro
    // próprio é o que deixa dizer a verdade.
    expect(() => assembleContext([
      instruction('inst', 'X'.repeat(100)),
      schema('sch', 'Y'.repeat(100)),
    ], { budgetChars: 50 })).toThrow(ContextBudgetExceededError)
  })

  it('o erro carrega os números, para a mensagem poder ser honesta', () => {
    try {
      assembleContext([instruction('inst', 'X'.repeat(100))], { budgetChars: 40 })
      expect.unreachable('deveria ter falhado')
    } catch (error) {
      expect(error).toBeInstanceOf(ContextBudgetExceededError)
      expect((error as ContextBudgetExceededError).requiredChars).toBe(100)
      expect((error as ContextBudgetExceededError).budget).toBe(40)
      expect((error as ContextBudgetExceededError).code).toBe('CONTEXT_BUDGET_EXCEEDED')
    }
  })

  it('parte repetida entra UMA vez, e a repetição fica registrada', () => {
    const { prompt, ledger } = assembleContext([
      evidence('primeira', 'o mesmo texto', 10),
      evidence('segunda', 'o mesmo texto', 10),
    ])
    expect(prompt).toBe('o mesmo texto')
    expect(ledger.dropped).toEqual([{ id: 'segunda', source: 'evidência', chars: 13, reason: 'DUPLICATE' }])
  })

  it('mesmo texto em TIPOS diferentes não é duplicata', () => {
    // Uma instrução e uma evidência com o mesmo texto cumprem papéis
    // diferentes; unificá-las cortaria uma das duas por engano.
    const { ledger } = assembleContext([instruction('i', 'igual'), evidence('e', 'igual', 5)])
    expect(ledger.dropped).toEqual([])
    expect(ledger.included).toHaveLength(2)
  })

  it('é DETERMINÍSTICO: mesma entrada, mesma saída', () => {
    // Um prompt que muda sozinho entre execuções torna impossível reproduzir o
    // que o modelo viu — e aí nenhuma investigação de resposta ruim conclui.
    const sections = [
      instruction('inst', 'X'.repeat(10)),
      evidence('a', 'A'.repeat(10), 5),
      evidence('b', 'B'.repeat(10), 5),
      evidence('c', 'C'.repeat(10), 5),
    ]
    const first = assembleContext(sections, { budgetChars: 32 })
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(assembleContext(sections, { budgetChars: 32 }).prompt).toBe(first.prompt)
    }
  })

  it('empate de prioridade se resolve pela ORDEM DE ENTRADA', () => {
    const { prompt } = assembleContext([
      evidence('primeiro', 'P'.repeat(10), 5),
      evidence('segundo', 'S'.repeat(10), 5),
    ], { budgetChars: 10 })
    expect(prompt).toBe('P'.repeat(10))
  })

  it('a ordem final é a de ENTRADA, não a de prioridade', () => {
    // Prioridade decide quem fica, não onde aparece. Reordenar o prompt
    // mudaria a resposta do modelo por um motivo que ninguém pediu.
    const { prompt } = assembleContext([
      evidence('baixa', 'primeiro no prompt', 1),
      evidence('alta', 'segundo no prompt', 100),
    ])
    expect(prompt).toBe('primeiro no prompt\nsegundo no prompt')
  })

  it('o registro contabiliza o que entrou, com procedência', () => {
    const { ledger } = assembleContext([
      instruction('inst', 'faça'),
      evidence('spec', 'o material', 10, 'AppSpec'),
    ])
    expect(ledger.included).toEqual([
      { id: 'inst', kind: 'instruction', source: 'instrução', chars: 4 },
      { id: 'spec', kind: 'evidence', source: 'AppSpec', chars: 10 },
    ])
    expect(ledger.chars).toBe(15)
  })

  it('lista vazia produz prompt vazio, e não erro', () => {
    const { prompt, ledger } = assembleContext([])
    expect(prompt).toBe('')
    expect(ledger.chars).toBe(0)
  })
})
