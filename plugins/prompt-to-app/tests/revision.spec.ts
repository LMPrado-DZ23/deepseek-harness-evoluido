import { describe, expect, it } from 'vitest'
import type { AppSpecV1 } from '../src/appspec.js'
import { MAX_CRITERIOS, RevisionError, chaveDoPedido, especificacaoRevisada, pedidoNormalizado, pedidosDeRevisao } from '../src/revision.js'
import { REVISION_TRANSITIONS, RevisionNotAvailableError, assertRevisionTransition, canReviseFrom } from '../src/state.js'
import type { ProjectState } from '../src/model.js'

const SPEC: AppSpecV1 = {
  schema_version: 1,
  problem: 'a clínica precisa receber contatos de quem quer marcar consulta',
  audience: 'pacientes da clínica',
  journeys: ['abrir a página e mandar o contato'],
  pages: [{ name: 'Início', sections: ['apresentação', 'formulário'] }],
  entities: [],
  sensitive_data: { detected: [], confirmed_by_user: false },
  accessibility: { wcag_level: 'AA', keyboard_required: true, reduced_motion: true },
  language: 'pt-BR',
  acceptance_criteria: ['o formulário envia o contato'],
}

describe('o pedido de mudança entra na especificação da MESMA tarefa', () => {
  it('vira um critério de aceite a mais, preservando os que já existiam', () => {
    const revisada = especificacaoRevisada(SPEC, 'o botão de enviar precisa ficar verde')
    expect(revisada.acceptance_criteria).toEqual([
      'o formulário envia o contato',
      'o botão de enviar precisa ficar verde',
    ])
  })

  it('nada mais da especificação é tocado', () => {
    const revisada = especificacaoRevisada(SPEC, 'o botão de enviar precisa ficar verde')
    expect({ ...revisada, acceptance_criteria: [] }).toEqual({ ...SPEC, acceptance_criteria: [] })
  })

  it('o mesmo pedido duas vezes é REPLAY, não um critério repetido', () => {
    // Quem apertou duas vezes não errou nada; gravar a segunda cópia faria a
    // tentativa seguinte conferir o mesmo critério duas vezes.
    const uma = especificacaoRevisada(SPEC, 'o botão de enviar precisa ficar verde')
    expect(() => especificacaoRevisada(uma, '  o botão de enviar   precisa ficar VERDE '))
      .toThrowError(RevisionError)
    try { especificacaoRevisada(uma, 'o botão de enviar precisa ficar verde') }
    catch (erro) { expect((erro as RevisionError).code).toBe('DUPLICATE') }
  })

  it('o texto GRAVADO é o da pessoa: só o espaço é arrumado', () => {
    expect(pedidoNormalizado('  o  botão \n VERDE ')).toBe('o botão VERDE')
  })

  it('o texto COMPARADO ignora maiúsculas, para o repetido ser reconhecido', () => {
    expect(chaveDoPedido('  o  botão \n VERDE ')).toBe(chaveDoPedido('O BOTÃO verde'))
  })

  it('pedido curto demais é recusado ANTES de gravar qualquer coisa', () => {
    expect(() => especificacaoRevisada(SPEC, 'oi')).toThrowError(RevisionError)
  })

  it('pedido longo demais é recusado — o esquema não aceitaria o critério', () => {
    expect(() => especificacaoRevisada(SPEC, 'x'.repeat(301))).toThrowError(RevisionError)
  })

  it('quando os critérios estão no teto, a revisão para em vez de gerar spec inválida', () => {
    const cheia: AppSpecV1 = {
      ...SPEC,
      acceptance_criteria: Array.from({ length: MAX_CRITERIOS }, (_, indice) => `criterio numero ${indice}`),
    }
    try { especificacaoRevisada(cheia, 'mais uma mudança'); expect.unreachable() }
    catch (erro) { expect((erro as RevisionError).code).toBe('TOO_MANY') }
  })
})

describe('o mapa de revisão é separado do mapa normal', () => {
  it('só desfecho aceita pedido de mudança', () => {
    const aceitam: ProjectState[] = ['VERIFIED_PROTOTYPE', 'BUILD_FAILED', 'TESTS_FAILED', 'CANCELLED', 'INTERRUPTED']
    for (const estado of aceitam) expect(canReviseFrom(estado)).toBe(true)
  })

  it('NENHUM estado com tentativa em andamento aceita: o pipeline ainda escreve nele', () => {
    for (const estado of ['GENERATING', 'BUILD_OK', 'TESTS_OK'] as ProjectState[]) {
      expect(canReviseFrom(estado)).toBe(false)
      expect(() => assertRevisionTransition(estado)).toThrowError(RevisionNotAvailableError)
    }
  })

  it('estado antes do primeiro resultado também não aceita: não há o que mudar ainda', () => {
    for (const estado of ['DRAFT', 'SPEC_READY', 'PLAN_PROPOSED', 'PLAN_APPROVED'] as ProjectState[]) {
      expect(canReviseFrom(estado)).toBe(false)
    }
  })

  it('o destino é SEMPRE SPEC_READY — a revisão reabre, ela não aprova', () => {
    // Um destino mais adiantado pularia a aprovação do plano novo, que é
    // exatamente o que a decisão de produto proíbe enfraquecer.
    for (const destinos of Object.values(REVISION_TRANSITIONS)) {
      for (const destino of destinos) expect(destino).toBe('SPEC_READY')
    }
  })
})

describe('os pedidos de mudança são derivados das especificações', () => {
  const spec = (criterios: readonly string[]) => ({ ...SPEC, acceptance_criteria: [...criterios] })
  const registro = (version: number, origin: string, criterios: readonly string[], created_at: string) =>
    ({ spec_id: `spec-${version}`, version, origin, created_at, app_spec: spec(criterios) })

  it('o critério que a revisão acrescentou é o texto que a pessoa escreveu', () => {
    const pedidos = pedidosDeRevisao([
      registro(1, 'intake', ['o formulário envia o contato'], '2026-09-17T10:00:00.000Z'),
      registro(2, 'edit', ['o formulário envia o contato', 'o botão fica verde'], '2026-09-17T10:20:00.000Z'),
    ])
    expect(pedidos).toEqual([{ spec_id: 'spec-2', request: 'o botão fica verde', created_at: '2026-09-17T10:20:00.000Z' }])
  })

  it('a especificação de admissão NUNCA vira pedido de mudança', () => {
    // Ela é o ponto de partida, e não algo que a pessoa pediu depois.
    expect(pedidosDeRevisao([registro(1, 'intake', ['o formulário envia o contato'], '2026-09-17T10:00:00.000Z')])).toEqual([])
  })

  it('uma especificação de ADMISSÃO com critério novo também não vira pedido', () => {
    /*
      A primeira versão deste arquivo afirmava a regra com uma lista de UM
      registro — e o laço começa no segundo, então ela nunca chegava a ser
      exercitada: a sabotagem que removia a conferência de origem sobreviveu.
      Com duas admissões, a conferência passa a ter peso.
    */
    const pedidos = pedidosDeRevisao([
      registro(1, 'intake', ['a'], '2026-09-17T10:00:00.000Z'),
      registro(2, 'intake', ['a', 'b'], '2026-09-17T10:10:00.000Z'),
    ])
    expect(pedidos).toEqual([])
  })

  it('uma edição SEM critério novo não vira pedido: ninguém escreveu nada', () => {
    // Inventar um texto para ela seria pôr palavras na boca de quem não falou.
    const pedidos = pedidosDeRevisao([
      registro(1, 'intake', ['a'], '2026-09-17T10:00:00.000Z'),
      registro(2, 'edit', ['a'], '2026-09-17T10:20:00.000Z'),
    ])
    expect(pedidos).toEqual([])
  })

  it('a ordem é a das versões, e não a da lista recebida', () => {
    const pedidos = pedidosDeRevisao([
      registro(3, 'edit', ['a', 'b', 'c'], '2026-09-17T11:00:00.000Z'),
      registro(1, 'intake', ['a'], '2026-09-17T10:00:00.000Z'),
      registro(2, 'edit', ['a', 'b'], '2026-09-17T10:20:00.000Z'),
    ])
    expect(pedidos.map(pedido => pedido.request)).toEqual(['b', 'c'])
  })
})
