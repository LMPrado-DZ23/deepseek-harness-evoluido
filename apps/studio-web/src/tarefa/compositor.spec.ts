import { describe, expect, it } from 'vitest'
import { destinoDoEnvio, envioDisponivel } from './compositor'

/** Todos os estados que o projeto pode ter, para a prova de que nenhum escapa. */
const TODOS_OS_ESTADOS = [
  'DRAFT', 'SPEC_READY', 'PLAN_PROPOSED', 'PLAN_APPROVED', 'GENERATING',
  'BUILD_OK', 'BUILD_FAILED', 'TESTS_OK', 'TESTS_FAILED', 'CANCELLED',
  'INTERRUPTED', 'VERIFIED_PROTOTYPE',
]

describe('o compositor inferior continua a MESMA tarefa', () => {
  it('com uma tarefa aberta, NENHUM estado manda abrir outra tarefa', () => {
    // Esta é a regra inteira do requisito VIS-03, escrita como teste: enviar
    // dentro de uma tarefa nunca recomeça o fluxo. O laço cobre os doze estados
    // porque um estado novo acrescentado sem cuidado é justamente como o
    // defeito antigo voltaria.
    for (const estado of TODOS_OS_ESTADOS) {
      expect(destinoDoEnvio({ estado, perguntaAberta: null }).tipo).not.toBe('abrir-tarefa')
    }
  })

  it('sem tarefa aberta, o envio abre uma — é a home', () => {
    expect(destinoDoEnvio({ estado: null, perguntaAberta: null })).toEqual({ tipo: 'abrir-tarefa' })
  })

  it('a pergunta aberta vence o estado do projeto', () => {
    // Sem esta precedência, o texto da pessoa viraria pedido de mudança num
    // plano que ainda não existe.
    expect(destinoDoEnvio({ estado: 'DRAFT', perguntaAberta: 'goal' }))
      .toEqual({ tipo: 'responder', perguntaId: 'goal' })
  })

  it('a pergunta aberta vence inclusive durante uma execução', () => {
    expect(destinoDoEnvio({ estado: 'GENERATING', perguntaAberta: 'content' }).tipo).toBe('responder')
  })

  it('no plano proposto, o texto é um pedido de mudança do plano', () => {
    expect(destinoDoEnvio({ estado: 'PLAN_PROPOSED', perguntaAberta: null })).toEqual({ tipo: 'mudar-plano' })
  })

  it('durante uma tentativa, o envio ESPERA em vez de disparar outra', () => {
    // Enviar aqui concorreria com a execução e gastaria o orçamento duas vezes
    // pela mesma intenção.
    for (const estado of ['GENERATING', 'BUILD_OK', 'TESTS_OK']) {
      expect(destinoDoEnvio({ estado, perguntaAberta: null })).toEqual({ tipo: 'aguardar', motivo: 'execucao' })
    }
  })

  it('com o plano aprovado e a criação ainda não iniciada, o envio espera a aprovação seguir', () => {
    expect(destinoDoEnvio({ estado: 'PLAN_APPROVED', perguntaAberta: null })).toEqual({ tipo: 'aguardar', motivo: 'aprovacao' })
  })

  it('depois de um resultado — aprovado, reprovado ou cancelado — o texto é um ajuste', () => {
    for (const estado of ['VERIFIED_PROTOTYPE', 'BUILD_FAILED', 'TESTS_FAILED', 'CANCELLED', 'INTERRUPTED']) {
      expect(destinoDoEnvio({ estado, perguntaAberta: null })).toEqual({ tipo: 'ajustar' })
    }
  })
})

describe('envioDisponivel', () => {
  it('texto vazio ou só espaços não é um envio', () => {
    const ajuste = destinoDoEnvio({ estado: 'VERIFIED_PROTOTYPE', perguntaAberta: null })
    expect(envioDisponivel(ajuste, '')).toBe(false)
    expect(envioDisponivel(ajuste, '   \n ')).toBe(false)
  })

  it('esperando, o envio não sai — mas o texto continua sendo aceito', () => {
    const espera = destinoDoEnvio({ estado: 'GENERATING', perguntaAberta: null })
    expect(envioDisponivel(espera, 'muda a cor do botão')).toBe(false)
  })

  it('com destino e texto, o envio sai', () => {
    const ajuste = destinoDoEnvio({ estado: 'VERIFIED_PROTOTYPE', perguntaAberta: null })
    expect(envioDisponivel(ajuste, 'muda a cor do botão')).toBe(true)
  })
})
