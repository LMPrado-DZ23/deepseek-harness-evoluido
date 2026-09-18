import { describe, expect, it } from 'vitest'
import {
  OFERTA_VAZIA, chaveDaMargem, chaveDoEstadoDaOferta, condicoesDoTexto, dinheiroEmTexto,
  chaveDoRotuloDaMargem, margemDaOferta, numeroDoTexto, ofertaDoRascunho, percentualEmTexto, rascunhoDaOferta,
  recusaDaOferta, recusaDeAprovacaoNaTela, sugestaoDePreco,
  type OfertaEnviada, type RascunhoDaOferta,
} from './oferta'

function rascunho(extra: Partial<RascunhoDaOferta> = {}): RascunhoDaOferta {
  return {
    ...OFERTA_VAZIA,
    nome: 'Bolo de aniversário',
    entrega: 'Um bolo de dois quilos, decorado, entregue no endereço.',
    publico: 'Famílias do bairro',
    preco: '200',
    quantidade: '4',
    condicoes: 'Encomenda com três dias de antecedência',
    custos: [{ nome: 'Ingredientes', valor: '60' }],
    ...extra,
  }
}

function oferta(extra: Partial<OfertaEnviada> = {}): OfertaEnviada {
  return { ...ofertaDoRascunho(rascunho()), ...extra }
}

describe('um número escrito por gente', () => {
  it('aceita a vírgula decimal, porque é assim que se escreve em português', () => {
    expect(numeroDoTexto('12,50')).toBe(12.5)
  })

  it('aceita o ponto de milhar junto da vírgula decimal', () => {
    expect(numeroDoTexto('1.200,90')).toBe(1200.9)
  })

  it('campo vazio é `null`, e NÃO zero', () => {
    // A distinção é o coração desta fatia: "não sei o valor" e "custa zero" são
    // fatos diferentes, e colapsá-los faz a margem mentir para cima.
    expect(numeroDoTexto('')).toBeNull()
    expect(numeroDoTexto('   ')).toBeNull()
  })

  it('texto que não é número também é `null`, e não vira zero', () => {
    expect(numeroDoTexto('uns cem reais')).toBeNull()
  })

  it('zero escrito é ZERO — quem digitou zero decidiu', () => {
    expect(numeroDoTexto('0')).toBe(0)
  })
})

describe('as condições escritas', () => {
  it('uma por linha, sem as vazias e sem as repetidas', () => {
    expect(condicoesDoTexto('Três dias antes\n\n  Três   dias antes  \nSem glúten sob pedido'))
      .toEqual(['Três dias antes', 'Sem glúten sob pedido'])
  })

  it('campo vazio não vira uma condição em branco', () => {
    expect(condicoesDoTexto('')).toEqual([])
    expect(condicoesDoTexto('\n  \n')).toEqual([])
  })
})

describe('o rascunho virado pedido', () => {
  it('custo SEM valor vai como `null`, e nunca como zero', () => {
    const enviada = ofertaDoRascunho(rascunho({ custos: [{ nome: 'Frete', valor: '' }] }))
    expect(enviada.custos).toEqual([{ nome: 'Frete', valor: null }])
  })

  it('custo sem NOME não é enviado: uma linha em branco do formulário não é um custo', () => {
    const enviada = ofertaDoRascunho(rascunho({ custos: [{ nome: '  ', valor: '10' }] }))
    expect(enviada.custos).toEqual([])
  })

  it('a moeda sobe em maiúsculas', () => {
    expect(ofertaDoRascunho(rascunho({ moeda: 'brl' })).moeda).toBe('BRL')
  })

  it('preço vazio vai como `null` — o rascunho sem preço é um estado legítimo', () => {
    expect(ofertaDoRascunho(rascunho({ preco: '' })).preco).toBeNull()
  })

  it('a capacidade é inteira: meia entrega por semana não é uma quantidade', () => {
    expect(ofertaDoRascunho(rascunho({ quantidade: '4,7' })).capacidade.quantidade).toBe(4)
  })

  it('capacidade vazia vira zero, e é o zero que impede a aprovação', () => {
    expect(ofertaDoRascunho(rascunho({ quantidade: '' })).capacidade.quantidade).toBe(0)
  })
})

describe('a recusa de gravar', () => {
  it('sem nome, recusa', () => {
    expect(recusaDaOferta(rascunho({ nome: 'B' }))).toBe('erroOfertaNome')
  })

  it('sem dizer o que entrega, recusa', () => {
    expect(recusaDaOferta(rascunho({ entrega: 'um bolo' }))).toBe('erroOfertaEntrega')
  })

  it('sem dizer para quem, recusa', () => {
    expect(recusaDaOferta(rascunho({ publico: 'a' }))).toBe('erroOfertaPublico')
  })

  it('moeda fora de ISO 4217 recusa ANTES do envio', () => {
    expect(recusaDaOferta(rascunho({ moeda: 'reais' }))).toBe('erroOfertaMoeda')
  })

  it('SEM PREÇO grava: rascunho incompleto é um estado do trabalho', () => {
    // O que não se pode é aprovar sem preço, e quem diz isso é a outra recusa.
    expect(recusaDaOferta(rascunho({ preco: '' }))).toBeNull()
  })

  it('completo o bastante, não recusa', () => {
    expect(recusaDaOferta(rascunho())).toBeNull()
  })
})

describe('a recusa de aprovar', () => {
  it('sem preço, recusa', () => {
    expect(recusaDeAprovacaoNaTela(oferta({ preco: null }))).toBe('erroAprovarPreco')
  })

  it('preço zero também recusa: de graça é uma decisão, mas não é um preço', () => {
    expect(recusaDeAprovacaoNaTela(oferta({ preco: 0 }))).toBe('erroAprovarPreco')
  })

  it('sem capacidade, recusa', () => {
    expect(recusaDeAprovacaoNaTela(oferta({ capacidade: { quantidade: 0, periodo: 'mes' } }))).toBe('erroAprovarCapacidade')
  })

  it('sem condição escrita, recusa', () => {
    expect(recusaDeAprovacaoNaTela(oferta({ condicoes: [] }))).toBe('erroAprovarCondicoes')
  })

  it('completa, não recusa', () => {
    expect(recusaDeAprovacaoNaTela(oferta())).toBeNull()
  })
})

describe('a margem na tela', () => {
  it('sem custo declarado é DESCONHECIDA, e nunca 100%', () => {
    const margem = margemDaOferta(oferta({ custos: [] }))
    expect(margem.estado).toBe('DESCONHECIDA')
    expect(margem.porUnidade).toBeNull()
    expect(margem.percentual).toBeNull()
    expect(chaveDaMargem(margem)).toBe('margemDesconhecida')
  })

  it('com custo SEM valor é TETO, e nomeia o que falta saber', () => {
    const margem = margemDaOferta(oferta({ custos: [{ nome: 'Ingredientes', valor: 60 }, { nome: 'Frete', valor: null }] }))
    expect(margem.estado).toBe('TETO')
    expect(margem.porUnidade).toBe(140)
    expect(margem.custosSemValor).toEqual(['Frete'])
    expect(chaveDaMargem(margem)).toBe('margemTeto')
  })

  it('com tudo valorado é ESTIMADA', () => {
    const margem = margemDaOferta(oferta())
    expect(margem.estado).toBe('ESTIMADA')
    expect(margem.percentual).toBe(70)
    expect(chaveDaMargem(margem)).toBe('margemEstimada')
  })

  it('sem preço, DESCONHECIDA mesmo com custo valorado', () => {
    expect(margemDaOferta(oferta({ preco: null })).estado).toBe('DESCONHECIDA')
  })

  it('margem NEGATIVA é mostrada, e não aparada em zero', () => {
    const margem = margemDaOferta(oferta({ preco: 50, custos: [{ nome: 'Ingredientes', valor: 60 }] }))
    expect(margem.porUnidade).toBe(-10)
  })
})

describe('a sugestão de preço', () => {
  it('não vira o preço: ela é um número devolvido, e o campo continua sendo da pessoa', () => {
    // A prova de que a sugestão não é aplicada está do outro lado: mesmo com
    // custos declarados, o rascunho sem preço vai para o servidor com `null`.
    expect(ofertaDoRascunho(rascunho({ preco: '' })).preco).toBeNull()
    expect(sugestaoDePreco(oferta(), 50)).toBe(120)
  })

  it('sem custo conhecido não sugere: sugerir a partir de zero é inventar', () => {
    expect(sugestaoDePreco(oferta({ custos: [] }), 50)).toBeNull()
    expect(sugestaoDePreco(oferta({ custos: [{ nome: 'Frete', valor: null }] }), 50)).toBeNull()
  })

  it('margem de 100% ou mais não devolve número', () => {
    expect(sugestaoDePreco(oferta(), 100)).toBeNull()
    expect(sugestaoDePreco(oferta(), 120)).toBeNull()
  })
})

describe('os textos de dinheiro e porcentagem', () => {
  it('escreve o dinheiro em português do Brasil, com a moeda da oferta', () => {
    // `toFixed` devolveria `200.00`, com ponto decimal, num produto inteiro em
    // português — o mesmo defeito que a conferência de captura já achou uma vez.
    expect(dinheiroEmTexto(1234.5, 'BRL')).toContain('1.234,50')
    expect(dinheiroEmTexto(1234.5, 'BRL')).toContain('R$')
  })

  it('uma moeda que o navegador não conhece NÃO derruba a tela', () => {
    // Feio e honesto é melhor que uma exceção no meio da lista do catálogo.
    expect(dinheiroEmTexto(10, 'XXY')).toContain('XXY')
  })

  it('a porcentagem tem uma casa e vírgula decimal', () => {
    expect(percentualEmTexto(70)).toBe('70,0%')
    expect(percentualEmTexto(66.666)).toBe('66,7%')
  })
})

describe('o estado de uma versão', () => {
  it('sem aprovação é RASCUNHO, com aprovação é APROVADA', () => {
    expect(chaveDoEstadoDaOferta({ approved_at: null })).toBe('ofertaRascunho')
    expect(chaveDoEstadoDaOferta({ approved_at: '2026-09-18T12:00:00.000Z' })).toBe('ofertaAprovada')
  })
})

describe('a volta para o formulário', () => {
  it('a oferta vigente volta editável, e o que era `null` volta VAZIO — não zero', () => {
    const editavel = rascunhoDaOferta(oferta({ preco: null, custos: [{ nome: 'Frete', valor: null }] }))
    expect(editavel.preco).toBe('')
    expect(editavel.custos).toEqual([{ nome: 'Frete', valor: '' }])
  })

  it('ida e volta preserva a oferta', () => {
    const original = oferta()
    expect(ofertaDoRascunho(rascunhoDaOferta(original))).toEqual(original)
  })

  it('o número volta com VÍRGULA, para a pessoa reconhecer o que escreveu', () => {
    expect(rascunhoDaOferta(oferta({ preco: 12.5 })).preco).toBe('12,5')
  })
})

describe('o rótulo da margem', () => {
  it('muda com o estado, em vez de dizer "estimada" sempre', () => {
    // Achado da conferência da captura: o rótulo em negrito dizia "Margem
    // estimada" ao lado do número, e a frase logo abaixo dizia "é um teto, e
    // não uma estimativa". Quem lê depressa lê só a primeira.
    expect(chaveDoRotuloDaMargem(margemDaOferta(oferta()))).toBe('margemRotuloEstimada')
    expect(chaveDoRotuloDaMargem(margemDaOferta(oferta({
      custos: [{ nome: 'Ingredientes', valor: 60 }, { nome: 'Frete', valor: null }],
    })))).toBe('margemRotuloTeto')
    expect(chaveDoRotuloDaMargem(margemDaOferta(oferta({ custos: [] })))).toBe('margemRotuloDesconhecida')
  })

  it('o rótulo e a frase NUNCA se contradizem: os dois saem do mesmo estado', () => {
    for (const custos of [[], [{ nome: 'Ingredientes', valor: 60 }], [{ nome: 'Frete', valor: null }]]) {
      const margem = margemDaOferta(oferta({ custos }))
      expect(chaveDoRotuloDaMargem(margem).replace('margemRotulo', '')).toBe(chaveDaMargem(margem).replace('margem', ''))
    }
  })
})
