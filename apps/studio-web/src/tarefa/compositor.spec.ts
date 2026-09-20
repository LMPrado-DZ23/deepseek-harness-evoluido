import { describe, expect, it } from 'vitest'
import { destinoDoEnvio, envioDisponivel, intencaoPadrao } from './compositor'

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
      expect(destinoDoEnvio({ estado, perguntaAberta: null }, 'agir').tipo).not.toBe('abrir-tarefa')
    }
  })

  it('sem tarefa aberta, o envio abre uma — é a home', () => {
    expect(destinoDoEnvio({ estado: null, perguntaAberta: null }, 'agir')).toEqual({ tipo: 'abrir-tarefa' })
  })

  it('a pergunta aberta vence o estado do projeto', () => {
    // Sem esta precedência, o texto da pessoa viraria pedido de mudança num
    // plano que ainda não existe.
    expect(destinoDoEnvio({ estado: 'DRAFT', perguntaAberta: 'goal' }, 'agir'))
      .toEqual({ tipo: 'responder', perguntaId: 'goal' })
  })

  it('a pergunta aberta vence inclusive durante uma execução', () => {
    expect(destinoDoEnvio({ estado: 'GENERATING', perguntaAberta: 'content' }, 'agir').tipo).toBe('responder')
  })

  it('no plano proposto, o texto é um pedido de mudança do plano', () => {
    expect(destinoDoEnvio({ estado: 'PLAN_PROPOSED', perguntaAberta: null }, 'agir')).toEqual({ tipo: 'mudar-plano' })
  })

  it('durante uma tentativa, o envio ESPERA em vez de disparar outra', () => {
    // Enviar aqui concorreria com a execução e gastaria o orçamento duas vezes
    // pela mesma intenção.
    for (const estado of ['GENERATING', 'BUILD_OK', 'TESTS_OK']) {
      expect(destinoDoEnvio({ estado, perguntaAberta: null }, 'agir')).toEqual({ tipo: 'aguardar', motivo: 'execucao' })
    }
  })

  it('com o plano aprovado e a criação ainda não iniciada, o envio espera a aprovação seguir', () => {
    expect(destinoDoEnvio({ estado: 'PLAN_APPROVED', perguntaAberta: null }, 'agir')).toEqual({ tipo: 'aguardar', motivo: 'aprovacao' })
  })

  it('depois de um resultado — aprovado, reprovado ou cancelado — o texto é um ajuste', () => {
    for (const estado of ['VERIFIED_PROTOTYPE', 'BUILD_FAILED', 'TESTS_FAILED', 'CANCELLED', 'INTERRUPTED']) {
      expect(destinoDoEnvio({ estado, perguntaAberta: null }, 'agir')).toEqual({ tipo: 'ajustar' })
    }
  })
})

describe('envioDisponivel', () => {
  it('texto vazio ou só espaços não é um envio', () => {
    const ajuste = destinoDoEnvio({ estado: 'VERIFIED_PROTOTYPE', perguntaAberta: null }, 'agir')
    expect(envioDisponivel(ajuste, '')).toBe(false)
    expect(envioDisponivel(ajuste, '   \n ')).toBe(false)
  })

  it('esperando, o envio não sai — mas o texto continua sendo aceito', () => {
    const espera = destinoDoEnvio({ estado: 'GENERATING', perguntaAberta: null }, 'agir')
    expect(envioDisponivel(espera, 'muda a cor do botão')).toBe(false)
  })

  it('com destino e texto, o envio sai', () => {
    const ajuste = destinoDoEnvio({ estado: 'VERIFIED_PROTOTYPE', perguntaAberta: null }, 'agir')
    expect(envioDisponivel(ajuste, 'muda a cor do botão')).toBe(true)
  })
})

describe('perguntar não é pedir alteração', () => {
  it('em NENHUM estado perguntar vira pedido de alteração', () => {
    /*
      O defeito que o dono do produto apontou, escrito como laço: depois de um
      resultado, todo envio caía em `ajustar`, e `ajustar` grava critério de
      aceite permanente. Uma pergunta virava critério e custava tentativa.
    */
    for (const estado of TODOS_OS_ESTADOS) {
      expect(destinoDoEnvio({ estado, perguntaAberta: null }, 'perguntar')).toEqual({ tipo: 'perguntar' })
    }
  })

  it('perguntar funciona até com pergunta de admissão aberta', () => {
    expect(destinoDoEnvio({ estado: 'DRAFT', perguntaAberta: 'audience' }, 'perguntar')).toEqual({ tipo: 'perguntar' })
  })

  it('perguntar funciona DURANTE a criação, que é quando mais se quer saber', () => {
    expect(destinoDoEnvio({ estado: 'GENERATING', perguntaAberta: null }, 'perguntar')).toEqual({ tipo: 'perguntar' })
    expect(envioDisponivel({ tipo: 'perguntar' }, 'o que está acontecendo?')).toBe(true)
  })

  it('sem tarefa aberta, perguntar não inventa uma conversa sobre nada', () => {
    expect(destinoDoEnvio({ estado: null, perguntaAberta: null }, 'perguntar')).toEqual({ tipo: 'abrir-tarefa' })
  })

  it('onde o defeito morava, o padrão é PERGUNTAR', () => {
    // Quem não reparar na escolha não grava critério nenhum. O contrário —
    // padrão em "alterar" — é exatamente o defeito de volta.
    for (const estado of ['VERIFIED_PROTOTYPE', 'BUILD_FAILED', 'TESTS_FAILED', 'CANCELLED', 'INTERRUPTED', 'GENERATING', 'PLAN_APPROVED', 'SPEC_READY', 'DRAFT']) {
      expect(intencaoPadrao({ estado, perguntaAberta: null })).toBe('perguntar')
    }
  })

  it('onde a tarefa ESPERA um gesto, o padrão é esse gesto', () => {
    expect(intencaoPadrao({ estado: 'DRAFT', perguntaAberta: 'audience' })).toBe('agir')
    expect(intencaoPadrao({ estado: 'PLAN_PROPOSED', perguntaAberta: null })).toBe('agir')

  })

  it('sem tarefa aberta o padrão é agir, porque é a home que cria a tarefa', () => {
    expect(intencaoPadrao({ estado: null, perguntaAberta: null })).toBe('agir')
  })
})

describe('retomada de revisao interrompida', () => {
  it('oferece retomar a revisao mesmo com outra pergunta ou plano na tela', () => {
    const situation = { estado: 'PLAN_PROPOSED', perguntaAberta: 'audience', revisaoPendente: true }
    expect(destinoDoEnvio(situation, 'agir')).toEqual({ tipo: 'ajustar' })
    expect(intencaoPadrao(situation)).toBe('agir')
  })
  it('perguntar permanece uma escolha explicita durante a retomada', () => {
    const situation = { estado: 'SPEC_READY', perguntaAberta: null, revisaoPendente: true }
    expect(destinoDoEnvio(situation, 'perguntar')).toEqual({ tipo: 'perguntar' })
  })
})
