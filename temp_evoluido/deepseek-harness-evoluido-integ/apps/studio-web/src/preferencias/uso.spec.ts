import { describe, expect, it } from 'vitest'
import { chaveDoVeredito, estadoDoCusto, linhasDeUso, totalDeUso, type RotaDeUso } from './uso'

function rota(extra: Partial<RotaDeUso> = {}): RotaDeUso {
  return {
    route: 'omniroute', requests: 10, input_tokens: 1_000, output_tokens: 500,
    estimated_cost_usd: 0.002, unpriced_requests: 0, ...extra,
  }
}

describe('o estado do custo de uma rota', () => {
  it('sem chamada NÃO PRECIFICADA, é MEDIDO', () => {
    expect(estadoDoCusto({ requests: 10, unpriced_requests: 0 })).toBe('MEDIDO')
  })

  it('TODAS sem preço é DESCONHECIDO, e não "custou zero"', () => {
    expect(estadoDoCusto({ requests: 10, unpriced_requests: 10 })).toBe('DESCONHECIDO')
  })

  it('algumas sem preço é PARCIAL — nem uma coisa nem outra', () => {
    // Colapsar parcial em medido esconde metade do custo; colapsar em
    // desconhecido joga fora a metade que se sabe.
    expect(estadoDoCusto({ requests: 10, unpriced_requests: 3 })).toBe('PARCIAL')
  })

  it('rota que nunca foi chamada é MEDIDA, e não desconhecida', () => {
    // Zero chamadas não é ignorância: é ausência de consumo.
    expect(estadoDoCusto({ requests: 0, unpriced_requests: 0 })).toBe('MEDIDO')
  })
})

describe('as linhas da tabela de uso', () => {
  it('custo DESCONHECIDO vira `null`, e nunca 0', () => {
    // É a regra central do adendo: ausência de prova não vira prova.
    const [linha] = linhasDeUso([rota({ requests: 5, unpriced_requests: 5, estimated_cost_usd: 0 })])
    expect(linha!.custoUsd).toBeNull()
    expect(linha!.estado).toBe('DESCONHECIDO')
  })

  it('ZERO MEDIDO continua zero — o erro simétrico também é erro', () => {
    // Uma rota local, de graça e medida, custou zero de verdade.
    const [linha] = linhasDeUso([rota({ route: 'ollama', estimated_cost_usd: 0, unpriced_requests: 0 })])
    expect(linha!.custoUsd).toBe(0)
    expect(linha!.estado).toBe('MEDIDO')
  })

  it('rota com ZERO chamadas fica de fora da tabela', () => {
    // Ela existe no registro porque o Studio a conhece, e não porque alguém a
    // usou; uma linha de zeros faria a tabela parecer cheia de consumo.
    expect(linhasDeUso([rota({ requests: 0 })])).toEqual([])
  })

  it('a ordem é da rota MAIS usada para a menos', () => {
    const linhas = linhasDeUso([
      rota({ route: 'pouco', requests: 2 }),
      rota({ route: 'muito', requests: 40 }),
    ])
    expect(linhas.map(linha => linha.rota)).toEqual(['muito', 'pouco'])
  })

  it('os tokens somados são entrada MAIS saída', () => {
    expect(linhasDeUso([rota({ input_tokens: 700, output_tokens: 300 })])[0]!.tokens).toBe(1_000)
  })
})

describe('o total do espaço', () => {
  it('soma SÓ o que foi medido, e conta as não precificadas ao lado', () => {
    // Sem a segunda conta, um espaço inteiro sem preço configurado mostraria
    // "US$ 0,00" e pareceria de graça.
    const linhas = linhasDeUso([
      rota({ route: 'a', requests: 10, estimated_cost_usd: 0.5, unpriced_requests: 0 }),
      rota({ route: 'b', requests: 4, estimated_cost_usd: 0, unpriced_requests: 4 }),
    ])
    expect(totalDeUso(linhas)).toEqual({ custoMedidoUsd: 0.5, naoPrecificadas: 4, chamadas: 14 })
  })

  it('sem linha nenhuma, tudo é zero — e isso é um fato, não uma ausência', () => {
    expect(totalDeUso([])).toEqual({ custoMedidoUsd: 0, naoPrecificadas: 0, chamadas: 0 })
  })
})

describe('o veredito do teto, em palavras', () => {
  it('SEM medição, a tela diz que não sabe', () => {
    // Um Studio sem `route-health` montado não tem o que responder.
    expect(chaveDoVeredito(undefined, false)).toBe('naoSei')
  })

  it('DENTRO sem consumo nenhum NÃO vira "dentro do teto"', () => {
    // "Dentro do teto" quando nada foi gasto é uma afirmação sobre um limite
    // que ninguém definiu e sobre um consumo que não houve.
    expect(chaveDoVeredito('WITHIN', false)).toBe('semConsumo')
  })

  it('DENTRO com consumo é dentro', () => {
    expect(chaveDoVeredito('WITHIN', true)).toBe('dentro')
  })

  it('custo excedido e não precificadas excedidas são frases DIFERENTES', () => {
    // Elas pedem ações diferentes: uma é gastar menos, a outra é configurar
    // preço. Uma frase só mandaria metade das pessoas ao lugar errado.
    expect(chaveDoVeredito('COST_EXCEEDED', true)).toBe('custoExcedido')
    expect(chaveDoVeredito('UNPRICED_EXCEEDED', true)).toBe('semPrecoExcedido')
  })

  it('um veredito que a tela não conhece NÃO vira excedido', () => {
    // Inventar bloqueio a partir de um valor novo do servidor seria pior que
    // mostrar o estado calmo: a pessoa pararia de trabalhar sem motivo.
    expect(chaveDoVeredito('ALGO_NOVO', true)).toBe('dentro')
  })
})
