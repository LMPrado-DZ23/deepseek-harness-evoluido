/**
 * T-19 — o teto em DINHEIRO.
 *
 * O teto por tokens já existia. O de dinheiro estava parado porque depende de
 * uma tabela de preço, e preço é decisão de fora. O que estava parado era o
 * NÚMERO; o mecanismo é este, e ele é construído para o estado de hoje: tabela
 * VAZIA.
 */
import { describe, expect, it } from 'vitest'
import {
  chaveDoModelo,
  custoDaExecucao,
  gastoEmDinheiro,
  precosVencendo,
  precoDeModeloSchema,
  tabelaDePrecoSchema,
  type ConsumoDeExecucao,
  type TabelaDePreco,
} from '../src/price-table.js'

const AGORA = '2026-09-16T12:00:00.000Z'

function preco(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provedor: 'fornecedor', modelo: 'modelo-a',
    entrada_centavos_por_milhao: 300, saida_centavos_por_milhao: 1_500,
    moeda: 'BRL', fonte: 'pagina de precos do fornecedor, lida em 16/09',
    anotado_em: AGORA, vale_ate: '2026-12-31T00:00:00.000Z',
    ...overrides,
  }
}

function tabela(...precos: Record<string, unknown>[]): TabelaDePreco {
  return tabelaDePrecoSchema.parse({ moeda: 'BRL', precos })
}

const consumo = (overrides: Partial<ConsumoDeExecucao> = {}): ConsumoDeExecucao => ({
  run_id: 'run-1', provedor: 'fornecedor', modelo: 'modelo-a',
  tokens_entrada: 1_000_000, tokens_saida: 1_000_000, ...overrides,
})

describe('a tabela de preço', () => {
  it('exige validade e origem: preço sem elas não é conferível nem revisitável', () => {
    const { vale_ate: _validade, ...semValidade } = preco()
    const { fonte: _fonte, ...semFonte } = preco()
    expect(precoDeModeloSchema.safeParse(semValidade).success).toBe(false)
    expect(precoDeModeloSchema.safeParse(semFonte).success).toBe(false)
    expect(precoDeModeloSchema.safeParse(preco()).success).toBe(true)
  })

  it('o preço é INTEIRO em centavos: ponto flutuante soma errado, e um teto que erra centavos mil vezes erra o teto', () => {
    expect(precoDeModeloSchema.safeParse(preco({ entrada_centavos_por_milhao: 3.5 })).success).toBe(false)
    expect(precoDeModeloSchema.safeParse(preco({ entrada_centavos_por_milhao: -1 })).success).toBe(false)
  })

  it('a chave leva PROVEDOR e modelo: o mesmo nome de modelo em dois provedores não tem o mesmo preço', () => {
    expect(chaveDoModelo('A', 'm')).toBe(chaveDoModelo('a', 'M'))
    expect(chaveDoModelo('revendedor', 'gpt-4o')).not.toBe(chaveDoModelo('fornecedor', 'gpt-4o'))
  })
})

describe('o custo de uma execução', () => {
  it('soma entrada e saída pelos preços próprios, e arredonda para CIMA', () => {
    // 1M de entrada a 300 + 1M de saída a 1500 = 1800 centavos.
    expect(custoDaExecucao(consumo(), tabela(preco()), AGORA)).toEqual({ kind: 'CALCULADO', centavos: 1_800 })
    // Arredondar para baixo deixaria passar um pouco mais a cada execução, e
    // "um pouco mais" mil vezes é o teto não existindo.
    expect(custoDaExecucao(consumo({ tokens_entrada: 1, tokens_saida: 0 }), tabela(preco()), AGORA))
      .toEqual({ kind: 'CALCULADO', centavos: 1 })
  })

  it('modelo que a tabela não conhece NUNCA vale zero', () => {
    const verdict = custoDaExecucao(consumo({ modelo: 'modelo-novo' }), tabela(preco()), AGORA)
    // Somar zero produziria um total que PARECE medido, e o teto autorizaria
    // gasto justamente onde o registro está incompleto.
    expect(verdict).toEqual({ kind: 'SEM_PRECO', provedor: 'fornecedor', modelo: 'modelo-novo' })
  })

  it('preço VENCIDO é diferente de ausente e de válido, e diz até quando valia', () => {
    const verdict = custoDaExecucao(consumo(), tabela(preco({ vale_ate: '2026-09-01T00:00:00.000Z' })), AGORA)
    expect(verdict).toMatchObject({ kind: 'PRECO_VENCIDO', vale_ate: '2026-09-01T00:00:00.000Z' })
  })

  it('preço em OUTRA moeda é tão incalculável quanto ausente: converter exigiria um câmbio que ninguém declarou', () => {
    expect(custoDaExecucao(consumo(), tabela(preco({ moeda: 'USD' })), AGORA).kind).toBe('SEM_PRECO')
  })

  it('execução que não relatou consumo é SEM_CONSUMO, e não consumo zero', () => {
    expect(custoDaExecucao(consumo({ tokens_saida: null }), tabela(preco()), AGORA))
      .toEqual({ kind: 'SEM_CONSUMO', runId: 'run-1' })
    expect(custoDaExecucao(consumo({ tokens_entrada: undefined }), tabela(preco()), AGORA).kind).toBe('SEM_CONSUMO')
  })
})

describe('o gasto da missão', () => {
  it('tabela AUSENTE e tabela VAZIA são o mesmo estado, e nenhum deles é "sem teto"', () => {
    // Uma tabela vazia tratada como cálculo daria "zero gasto", que é a mentira
    // exata que este módulo existe para não contar.
    expect(gastoEmDinheiro(1_000, [consumo()], undefined, AGORA)).toEqual({ kind: 'SEM_TABELA' })
    expect(gastoEmDinheiro(1_000, [consumo()], tabela(), AGORA)).toEqual({ kind: 'SEM_TABELA' })
  })

  it('soma as execuções e compara com o teto', () => {
    const duas = [consumo(), consumo({ run_id: 'run-2' })]
    expect(gastoEmDinheiro(4_000, duas, tabela(preco()), AGORA)).toEqual({ kind: 'DENTRO', centavos: 3_600, teto: 4_000 })
    expect(gastoEmDinheiro(3_600, duas, tabela(preco()), AGORA)).toEqual({ kind: 'ESTOURADO', centavos: 3_600, teto: 3_600 })
  })

  it('UMA execução incalculável derruba o total inteiro, e diz QUAL', () => {
    const verdict = gastoEmDinheiro(10_000, [consumo(), consumo({ run_id: 'run-2', modelo: 'desconhecido' })], tabela(preco()), AGORA)
    // Somar o que dá e ignorar o resto entregaria um número menor que o real
    // com cara de total. E "não medido" sem dizer qual manda procurar na tabela
    // inteira.
    expect(verdict).toEqual({ kind: 'NAO_MEDIDO', motivo: { kind: 'SEM_PRECO', provedor: 'fornecedor', modelo: 'desconhecido' }, teto: 10_000 })
  })

  it('sem teto declarado, o total ainda é calculado — e ainda pode ser NÃO MEDIDO', () => {
    expect(gastoEmDinheiro(null, [consumo()], tabela(preco()), AGORA)).toEqual({ kind: 'SEM_TETO', centavos: 1_800 })
    // Saber que o total é incalculável importa mesmo sem limite: é esse total
    // que aparece no painel.
    expect(gastoEmDinheiro(null, [consumo({ modelo: 'x' })], tabela(preco()), AGORA)).toMatchObject({ kind: 'NAO_MEDIDO', teto: null })
  })

  it('missão sem execução nenhuma custa zero de verdade', () => {
    expect(gastoEmDinheiro(1_000, [], tabela(preco()), AGORA)).toEqual({ kind: 'DENTRO', centavos: 0, teto: 1_000 })
  })
})

describe('avisar ANTES do vencimento', () => {
  it('lista o que vence na janela, os já vencidos primeiro', () => {
    const cheia = tabela(
      preco({ modelo: 'vence-depois', vale_ate: '2027-01-01T00:00:00.000Z' }),
      preco({ modelo: 'vence-perto', vale_ate: '2026-09-20T00:00:00.000Z' }),
      preco({ modelo: 'ja-venceu', vale_ate: '2026-09-01T00:00:00.000Z' }),
    )
    // A alternativa é descobrir o vencimento quando a missão para: quem estava
    // trabalhando descobre pelo bloqueio.
    expect(precosVencendo(cheia, AGORA, 30).map(item => item.modelo)).toEqual(['ja-venceu', 'vence-perto'])
    expect(precosVencendo(cheia, AGORA, 1).map(item => item.modelo)).toEqual(['ja-venceu'])
  })
})
