import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TabelaDeUso } from './Preferencias'
import { contagemEmTexto, custoEmTexto, linhasDeUso, type RotaDeUso } from './uso'

/** O que a seção de uso DESENHA. */
function rota(extra: Partial<RotaDeUso> = {}): RotaDeUso {
  return {
    route: 'omniroute', requests: 10, input_tokens: 700, output_tokens: 300,
    estimated_cost_usd: 0.0025, unpriced_requests: 0, ...extra,
  }
}

function desenhar(rotas: readonly RotaDeUso[], veredito?: string) {
  return renderToStaticMarkup(createElement(TabelaDeUso, { linhas: linhasDeUso(rotas), veredito }))
}

describe('a tabela de uso do espaço de trabalho', () => {
  it('custo DESCONHECIDO sai em palavras, e NUNCA como US$ 0,0000', () => {
    // É a regra central do adendo, na camada onde a pessoa lê.
    const html = desenhar([rota({ requests: 4, unpriced_requests: 4, estimated_cost_usd: 0 })], 'WITHIN')
    expect(html).toContain('não medido')
    expect(html).not.toContain('US$ 0,0000</td>')
  })

  it('ZERO MEDIDO continua saindo como zero', () => {
    // O erro simétrico também é erro: uma rota local de graça custou zero.
    const html = desenhar([rota({ route: 'ollama', estimated_cost_usd: 0, unpriced_requests: 0 })], 'WITHIN')
    expect(html).toContain('US$ 0,0000')
    expect(html).not.toContain('não medido')
  })

  it('o total DIZ quantas chamadas ficaram fora dele', () => {
    // Sem esta linha, o total pareceria a conta inteira.
    const html = desenhar([
      rota({ route: 'a', requests: 10, estimated_cost_usd: 0.5 }),
      rota({ route: 'b', requests: 4, estimated_cost_usd: 0, unpriced_requests: 4 }),
    ], 'WITHIN')
    expect(html).toContain('US$ 0,5000')
    expect(html).toContain('4 chamada(s) sem preço configurado')
  })

  it('SEM consumo nenhum não afirma "dentro do teto"', () => {
    const html = desenhar([], 'WITHIN')
    expect(html).toContain('Nenhuma chamada registrada')
    expect(html).not.toContain('Dentro do teto')
  })

  it('teto de CUSTO excedido e SEM PREÇO excedido são frases diferentes', () => {
    // Elas pedem ações diferentes: gastar menos, ou configurar preço.
    expect(desenhar([rota()], 'COST_EXCEEDED')).toContain('teto de custo foi atingido')
    expect(desenhar([rota()], 'UNPRICED_EXCEEDED')).toContain('sem preço configurado')
  })

  it('a LIMITAÇÃO do produto está escrita na tela', () => {
    // Sem ela, alguém lê "Uso e custos" e supõe que está vendo a fatura.
    expect(desenhar([rota()], 'WITHIN')).toContain('Cota de assinatura e custo informado pelo provedor não existem')
  })

  it('nenhum marcador do catálogo chega à tela', () => {
    const html = desenhar([rota({ requests: 4, unpriced_requests: 2 })], 'WITHIN')
    for (const marcador of ['{n}', '{custo}', '{chamadas}']) expect(html).not.toContain(marcador)
  })

  it('a tabela tem CABEÇALHO de coluna e de linha, para quem usa leitor de tela', () => {
    const html = desenhar([rota()], 'WITHIN')
    expect(html).toContain('scope="col"')
    expect(html).toContain('scope="row"')
  })
})

describe('os números na língua de quem lê', () => {
  it('o custo usa VÍRGULA decimal, e não ponto', () => {
    /*
      `toFixed` devolve "0.0042", e este produto é inteiro em português do
      Brasil. A divergência apareceu na conferência da captura de entrega, e
      nenhum teste a pegava: a tela estava certa em tudo, menos na língua em
      que escrevia número.
    */
    expect(custoEmTexto(0.0042)).toBe('US$ 0,0042')
  })

  it('quatro casas, porque o custo de uma chamada é da ordem de milésimos', () => {
    // Com duas casas, quase todo consumo real apareceria como "US$ 0,00".
    expect(custoEmTexto(0.0001)).toBe('US$ 0,0001')
  })

  it('a contagem grande usa o separador de milhar de quem lê', () => {
    expect(contagemEmTexto(1_200)).toBe('1.200')
  })
})
