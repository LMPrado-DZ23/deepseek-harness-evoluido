import { describe, expect, it } from 'vitest'
import {
  catalogoVigente, custosConhecidos, margemEstimada, ofertaAprovada, ofertasIguais,
  precoSugerido, proximaVersaoDaOferta, recusaDeAprovacao, recusaDeOferta,
} from '../src/oferta.js'
import type { Custo, Oferta, RegistroDeOferta } from '../src/model.js'

function oferta(extra: Partial<Oferta> = {}): Oferta {
  return {
    nome: 'Bolo de aniversário',
    entrega: 'Um bolo de dois quilos, decorado, entregue no endereço da pessoa.',
    publico: 'Famílias do bairro',
    preco: 200,
    moeda: 'BRL',
    capacidade: { quantidade: 4, periodo: 'semana' },
    condicoes: ['Encomenda com três dias de antecedência'],
    custos: [{ nome: 'Ingredientes', valor: 60 }],
    ...extra,
  }
}

function registro(extra: Partial<RegistroDeOferta> = {}): RegistroDeOferta {
  return {
    offer_version_id: 'ov-1', offer_key: 'of-1', business_id: 'emp-1',
    org_id: 'org-a', tenant_id: 'tenant-a', version: 1, oferta: oferta(),
    created_by: 'user-a', created_at: '2026-09-18T12:00:00.000Z',
    approved_at: null, approved_by: null,
    ...extra,
  }
}

const ATIVA = { archived_at: null }

describe('os custos declarados', () => {
  it('soma o que TEM valor e nomeia o que não tem', () => {
    const custos: Custo[] = [{ nome: 'Ingredientes', valor: 60 }, { nome: 'Frete', valor: null }]
    expect(custosConhecidos(custos)).toEqual({ total: 60, semValor: ['Frete'] })
  })

  it('sem custo nenhum, o total é zero e não falta nada — são fatos diferentes', () => {
    expect(custosConhecidos([])).toEqual({ total: 0, semValor: [] })
  })
})

describe('a margem estimada', () => {
  it('sem custo declarado é DESCONHECIDA, e nunca 100%', () => {
    // Este é o caso central do aceite. Dizer "margem de 100%" a quem não
    // declarou custo nenhum é afirmar que a oferta é lucro puro — e ninguém
    // olhou para os custos ainda.
    const margem = margemEstimada(200, [])
    expect(margem.estado).toBe('DESCONHECIDA')
    expect(margem.porUnidade).toBeNull()
    expect(margem.percentual).toBeNull()
  })

  it('com custo SEM valor, é TETO — a margem real só pode ser menor', () => {
    // Chamar isto de estimativa esconderia exatamente a parte que falta.
    const margem = margemEstimada(200, [{ nome: 'Ingredientes', valor: 60 }, { nome: 'Frete', valor: null }])
    expect(margem.estado).toBe('TETO')
    expect(margem.porUnidade).toBe(140)
    expect(margem.custosSemValor).toEqual(['Frete'])
  })

  it('com todo custo valorado, é ESTIMADA — e continua estimativa', () => {
    const margem = margemEstimada(200, [{ nome: 'Ingredientes', valor: 60 }, { nome: 'Gás', valor: 20 }])
    expect(margem.estado).toBe('ESTIMADA')
    expect(margem.porUnidade).toBe(120)
    expect(margem.percentual).toBe(60)
    expect(margem.custosSemValor).toEqual([])
  })

  it('sem PREÇO não há margem: a pergunta não existe antes de alguém decidir o preço', () => {
    expect(margemEstimada(null, [{ nome: 'Ingredientes', valor: 60 }]).estado).toBe('DESCONHECIDA')
  })

  it('a margem pode ser NEGATIVA, e isso é dito e não escondido', () => {
    // Uma oferta que custa mais do que cobra é um fato que a pessoa precisa
    // ver. Aparar em zero faria o prejuízo virar empate na tela.
    const margem = margemEstimada(50, [{ nome: 'Ingredientes', valor: 60 }])
    expect(margem.porUnidade).toBe(-10)
    expect(margem.percentual).toBe(-20)
  })

  it('conta quantos custos foram declarados, mesmo quando não sabe o valor de nenhum', () => {
    const margem = margemEstimada(200, [{ nome: 'Frete', valor: null }])
    expect(margem.custosDeclarados).toBe(1)
    expect(margem.estado).toBe('TETO')
  })
})

describe('o preço sugerido', () => {
  it('vem SEMPRE com `aplicado: false`', () => {
    // O campo existe para que nenhuma tela consiga exibir a sugestão sem
    // exibir o fato de que ela não é o preço da oferta.
    expect(precoSugerido([{ nome: 'Ingredientes', valor: 60 }], 50).aplicado).toBe(false)
  })

  it('calcula o preço que deixaria a margem desejada', () => {
    expect(precoSugerido([{ nome: 'Ingredientes', valor: 60 }], 50).valor).toBe(120)
    expect(precoSugerido([{ nome: 'Ingredientes', valor: 75 }], 25).valor).toBe(100)
  })

  it('sem custo conhecido não sugere nada — sugerir de zero é inventar', () => {
    expect(precoSugerido([], 50).valor).toBeNull()
    expect(precoSugerido([{ nome: 'Frete', valor: null }], 50).valor).toBeNull()
  })

  it('margem de 100% ou mais não devolve número: seria divisão por zero ou preço negativo', () => {
    expect(precoSugerido([{ nome: 'Ingredientes', valor: 60 }], 100).valor).toBeNull()
    expect(precoSugerido([{ nome: 'Ingredientes', valor: 60 }], 150).valor).toBeNull()
  })

  it('margem negativa ou não numérica também não devolve número', () => {
    expect(precoSugerido([{ nome: 'Ingredientes', valor: 60 }], -10).valor).toBeNull()
    expect(precoSugerido([{ nome: 'Ingredientes', valor: 60 }], Number.NaN).valor).toBeNull()
  })

  it('declara os custos SEM valor junto da sugestão: ela é um piso, e não um preço justo', () => {
    const sugerido = precoSugerido([{ nome: 'Ingredientes', valor: 60 }, { nome: 'Frete', valor: null }], 50)
    expect(sugerido.valor).toBe(120)
    expect(sugerido.custosSemValor).toEqual(['Frete'])
  })
})

describe('a versão da oferta', () => {
  it('conta POR OFERTA, e não por empresa', () => {
    // Numerar por empresa faria a segunda oferta nascer na versão 4 porque a
    // primeira foi revisada três vezes.
    const anteriores = [
      registro({ offer_key: 'of-1', version: 1 }),
      registro({ offer_key: 'of-1', version: 2 }),
      registro({ offer_key: 'of-2', version: 1 }),
    ]
    expect(proximaVersaoDaOferta(anteriores, 'of-1')).toBe(3)
    expect(proximaVersaoDaOferta(anteriores, 'of-2')).toBe(2)
    expect(proximaVersaoDaOferta(anteriores, 'of-novo')).toBe(1)
  })

  it('é a MAIOR mais um, e não a quantidade mais um', () => {
    // Uma versão apagada faria a contagem repetir um número que já existiu, e
    // "a versão 3" ficaria ambígua para sempre.
    expect(proximaVersaoDaOferta([registro({ version: 7 })], 'of-1')).toBe(8)
  })
})

describe('o catálogo vigente', () => {
  it('traz a maior VERSÃO de cada oferta, e não a mais recente por data', () => {
    // Dois registros gravados no mesmo milissegundo empatariam por data, e a
    // ordem de leitura decidiria qual oferta a empresa tem.
    const catalogo = catalogoVigente([
      registro({ offer_key: 'of-1', version: 2, created_at: '2026-01-01T00:00:00.000Z' }),
      registro({ offer_key: 'of-1', version: 1, created_at: '2026-09-01T00:00:00.000Z' }),
    ])
    expect(catalogo).toHaveLength(1)
    expect(catalogo[0]!.version).toBe(2)
  })

  it('traz UMA entrada por oferta, em ordem alfabética do nome', () => {
    const catalogo = catalogoVigente([
      registro({ offer_key: 'of-2', oferta: oferta({ nome: 'Torta' }) }),
      registro({ offer_key: 'of-1', oferta: oferta({ nome: 'Bolo' }) }),
    ])
    expect(catalogo.map(item => item.oferta.nome)).toEqual(['Bolo', 'Torta'])
  })

  it('inclui a oferta ainda em RASCUNHO: ela não some da tela de quem a escreveu', () => {
    expect(catalogoVigente([registro({ approved_at: null })])).toHaveLength(1)
  })

  it('sem registro nenhum, o catálogo é vazio', () => {
    expect(catalogoVigente([])).toEqual([])
  })
})

describe('duas ofertas iguais', () => {
  it('a mesma oferta com as condições em outra ORDEM é a mesma oferta', () => {
    // Gravar uma versão por reordenação encheria o catálogo de mudanças que
    // ninguém tomou.
    const a = oferta({ condicoes: ['Três dias antes', 'Sem glúten sob pedido'] })
    const b = oferta({ condicoes: ['Sem glúten sob pedido', 'Três dias antes'] })
    expect(ofertasIguais(a, b)).toBe(true)
  })

  it('espaço a mais não é mudança', () => {
    expect(ofertasIguais(oferta({ nome: 'Bolo  de   festa' }), oferta({ nome: 'Bolo de festa' }))).toBe(true)
  })

  it('preço diferente é oferta diferente', () => {
    expect(ofertasIguais(oferta({ preco: 200 }), oferta({ preco: 220 }))).toBe(false)
  })

  it('MOEDA diferente é oferta diferente, mesmo com o mesmo número', () => {
    // 200 reais e 200 dólares não são o mesmo preço, e colapsá-los faria a
    // troca de moeda passar como "sem mudança".
    expect(ofertasIguais(oferta({ moeda: 'BRL' }), oferta({ moeda: 'USD' }))).toBe(false)
  })

  it('capacidade diferente é oferta diferente', () => {
    expect(ofertasIguais(oferta(), oferta({ capacidade: { quantidade: 4, periodo: 'dia' } }))).toBe(false)
  })

  it('custo com valor diferente é oferta diferente — a margem muda com ele', () => {
    expect(ofertasIguais(oferta(), oferta({ custos: [{ nome: 'Ingredientes', valor: 90 }] }))).toBe(false)
  })

  it('custo que PERDE o valor é oferta diferente, e não a mesma', () => {
    // Passar de "custa 60" para "não sei quanto custa" muda o estado da margem
    // de ESTIMADA para TETO. Tratar isso como "sem mudança" recusaria gravar
    // justamente a versão que declara a ignorância.
    expect(ofertasIguais(oferta(), oferta({ custos: [{ nome: 'Ingredientes', valor: null }] }))).toBe(false)
  })

  it('preço ausente e preço zero não se confundem na comparação', () => {
    expect(ofertasIguais(oferta({ preco: null }), oferta({ preco: 200 }))).toBe(false)
  })
})

describe('a recusa de uma oferta nova', () => {
  it('empresa ARQUIVADA não recebe oferta', () => {
    expect(recusaDeOferta({ archived_at: '2026-09-18T12:00:00.000Z' }, undefined, oferta())).toBe('arquivada')
  })

  it('oferta idêntica à vigente é recusada por SEM MUDANÇA', () => {
    expect(recusaDeOferta(ATIVA, registro(), oferta())).toBe('sem-mudanca')
  })

  it('a PRIMEIRA versão nunca é recusada por falta de mudança', () => {
    expect(recusaDeOferta(ATIVA, undefined, oferta())).toBeNull()
  })

  it('arquivada vence sem-mudança: a razão mais forte é a que a pessoa precisa ler', () => {
    expect(recusaDeOferta({ archived_at: '2026-09-18T12:00:00.000Z' }, registro(), oferta())).toBe('arquivada')
  })

  it('um rascunho SEM preço pode ser gravado — incompleto é um estado do trabalho', () => {
    expect(recusaDeOferta(ATIVA, undefined, oferta({ preco: null }))).toBeNull()
  })
})

describe('a recusa de APROVAÇÃO', () => {
  it('sem preço não aprova', () => {
    expect(recusaDeAprovacao(registro({ oferta: oferta({ preco: null }) }))).toBe('sem-preco')
  })

  it('sem capacidade não aprova: prometer entrega que ninguém pode cumprir', () => {
    expect(recusaDeAprovacao(registro({ oferta: oferta({ capacidade: { quantidade: 0, periodo: 'mes' } }) }))).toBe('sem-capacidade')
  })

  it('sem condição escrita não aprova — "condições aprovadas" ficaria sem conteúdo', () => {
    expect(recusaDeAprovacao(registro({ oferta: oferta({ condicoes: [] }) }))).toBe('sem-condicoes')
  })

  it('já aprovada não aprova de novo: não é uma segunda decisão', () => {
    expect(recusaDeAprovacao(registro({ approved_at: '2026-09-18T13:00:00.000Z', approved_by: 'user-a' }))).toBe('ja-aprovada')
  })

  it('já aprovada vence as outras razões', () => {
    const jaAprovadaEIncompleta = registro({
      oferta: oferta({ preco: null }),
      approved_at: '2026-09-18T13:00:00.000Z', approved_by: 'user-a',
    })
    expect(recusaDeAprovacao(jaAprovadaEIncompleta)).toBe('ja-aprovada')
  })

  it('completa e em rascunho, aprova', () => {
    expect(recusaDeAprovacao(registro())).toBeNull()
  })
})

describe('a oferta aprovada', () => {
  it('é a que tem instante de aprovação', () => {
    expect(ofertaAprovada(registro())).toBe(false)
    expect(ofertaAprovada(registro({ approved_at: '2026-09-18T13:00:00.000Z', approved_by: 'user-a' }))).toBe(true)
  })
})
