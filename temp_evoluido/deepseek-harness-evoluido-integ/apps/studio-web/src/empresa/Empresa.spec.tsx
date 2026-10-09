import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CamposDaOferta, CamposDoPlano, EvidenciaDaTarefaLida, MargemDaOfertaLida, OfertaLida, PlanoLido, SugestaoDePreco, periodoEmTexto } from './Empresa'
import { rascunhoDaOferta } from './oferta'
import copy from '../i18n/empresa.pt-BR.json'
import type { RegistroDeOferta, RegistroDePlano } from './empresaApi'

/**
 * O que a tela DESENHA.
 *
 * Esta suíte não tem navegador: ela desenha o componente com
 * `renderToStaticMarkup` e confere o que sai. A jornada com cliques — cadastrar,
 * revisar, arquivar — é provada no e2e, que é o único passo que roda o produto
 * montado.
 */
function registro(plano: Partial<RegistroDePlano['plano']> = {}): RegistroDePlano {
  return {
    plan_id: 'plan-1', business_id: 'emp-1', version: 1,
    created_by: 'user-a', created_at: '2026-09-17T12:00:00.000Z',
    plano: {
      objetivo: 'vender bolos caseiros por encomenda no bairro',
      publico: 'moradores do bairro',
      oferta: 'bolo de 1kg com 2 dias de antecedência',
      limites: ['não entrega fora do bairro'],
      ...plano,
    },
  }
}

describe('o plano lido', () => {
  it('mostra objetivo, público, oferta e cada limite', () => {
    const html = renderToStaticMarkup(createElement(PlanoLido, { registro: registro() }))
    expect(html).toContain('vender bolos caseiros por encomenda no bairro')
    expect(html).toContain('moradores do bairro')
    expect(html).toContain('bolo de 1kg com 2 dias de antecedência')
    expect(html).toContain('<li>não entrega fora do bairro</li>')
  })

  it('cada limite é um ITEM, e não um parágrafo com todos dentro', () => {
    // Cada limite é conferido sozinho depois; um parágrafo com cinco limites
    // dentro não é conferível.
    const html = renderToStaticMarkup(createElement(PlanoLido, {
      registro: registro({ limites: ['só à vista', 'não entrega fora do bairro'] }),
    }))
    expect(html.match(/<li>/gu)).toHaveLength(2)
  })

  it('sem limite nenhum, DIZ que não há — em vez de uma lista vazia', () => {
    const html = renderToStaticMarkup(createElement(PlanoLido, { registro: registro({ limites: [] }) }))
    expect(html).toContain('Nenhum limite declarado.')
    expect(html).not.toContain('<li>')
  })

  it('oferta vazia não vira um rótulo com nada embaixo', () => {
    // "Ainda não decidi" é um estado honesto; um rótulo vazio parece defeito.
    const html = renderToStaticMarkup(createElement(PlanoLido, { registro: registro({ oferta: '' }) }))
    expect(html).not.toContain('O que ela entrega')
  })
})

describe('os campos do plano', () => {
  it('todo campo tem RÓTULO ligado a ele pelo `id`', () => {
    // Sem o `for`/`id`, quem usa leitor de tela ouve "caixa de texto" e nada
    // mais; e um `id` repetido entre o cadastro e a revisão ligaria o rótulo de
    // um ao campo do outro — por isso o prefixo entra por parâmetro.
    const html = renderToStaticMarkup(createElement(CamposDoPlano, {
      rascunho: { objetivo: '', publico: '', oferta: '', limites: '' },
      aoMudar: () => undefined,
      prefixo: 'teste',
    }))
    for (const campo of ['objetivo', 'publico', 'oferta', 'limites']) {
      expect(html).toContain(`for="teste-${campo}"`)
      expect(html).toContain(`id="teste-${campo}"`)
    }
  })

  it('o que já foi escrito aparece no campo', () => {
    const html = renderToStaticMarkup(createElement(CamposDoPlano, {
      rascunho: { objetivo: 'vender bolos', publico: 'o bairro', oferta: '', limites: 'só à vista' },
      aoMudar: () => undefined,
      prefixo: 'teste',
    }))
    expect(html).toContain('vender bolos')
    expect(html).toContain('só à vista')
  })
})

describe('o que uma tarefa produziu', () => {
  const pacote = {
    export_id: 'exp-1', project_id: 'p-1', file_name: 'prototipo.zip',
    size_bytes: 2048, created_at: '2026-09-17T12:00:00.000Z',
  }

  it('ainda LENDO é um estado próprio, e não "não produziu nada"', () => {
    // Colapsar os dois seria afirmar sem ter olhado.
    const html = renderToStaticMarkup(createElement(EvidenciaDaTarefaLida, { pacotes: null }))
    expect(html).toContain('Lendo o que as tarefas produziram')
    expect(html).not.toContain('Nada ainda')
  })

  it('leu e não há nada DIZ isso', () => {
    const html = renderToStaticMarkup(createElement(EvidenciaDaTarefaLida, { pacotes: [] }))
    expect(html).toContain('Nada ainda.')
  })

  it('cada pacote vira um link de download com o NOME do arquivo', () => {
    const html = renderToStaticMarkup(createElement(EvidenciaDaTarefaLida, { pacotes: [pacote] }))
    expect(html).toContain('Baixar prototipo.zip')
    expect(html).toContain('/api/studio/hub/projects/p-1/exports/exp-1/download')
  })

  it('o marcador `{file}` NUNCA chega à tela', () => {
    // Já aconteceu na Biblioteca: a frase estava certa no catálogo, o marcador
    // não era preenchido, e nenhum teste olhava o texto do link.
    const html = renderToStaticMarkup(createElement(EvidenciaDaTarefaLida, { pacotes: [pacote] }))
    expect(html).not.toContain('{file}')
  })

  it('mostra o tamanho e a data, para a pessoa saber o que vai baixar', () => {
    const html = renderToStaticMarkup(createElement(EvidenciaDaTarefaLida, { pacotes: [pacote] }))
    expect(html).toContain('2')
    expect(html).toContain('KB')
  })
})

function ofertaRegistro(extra: Partial<RegistroDeOferta> = {}): RegistroDeOferta {
  return {
    offer_version_id: 'ov-1', offer_key: 'of-1', business_id: 'emp-1', version: 1,
    created_by: 'user-a', created_at: '2026-09-18T12:00:00.000Z',
    approved_at: null, approved_by: null,
    oferta: {
      nome: 'Bolo de aniversário',
      entrega: 'Um bolo de dois quilos, decorado, entregue no endereço.',
      publico: 'Famílias do bairro',
      preco: 200, moeda: 'BRL',
      capacidade: { quantidade: 4, periodo: 'semana' },
      condicoes: ['Encomenda com três dias de antecedência'],
      custos: [{ nome: 'Ingredientes', valor: 60 }],
    },
    ...extra,
  }
}

describe('a oferta lida', () => {
  it('mostra entrega, público, preço com moeda, capacidade e cada condição', () => {
    const html = renderToStaticMarkup(createElement(OfertaLida, { registro: ofertaRegistro() }))
    expect(html).toContain('Um bolo de dois quilos')
    expect(html).toContain('Famílias do bairro')
    expect(html).toContain('200,00')
    expect(html).toContain('<li>Encomenda com três dias de antecedência</li>')
  })

  it('preço ausente é DITO, e não desenhado como zero nem deixado em branco', () => {
    const html = renderToStaticMarkup(createElement(OfertaLida, { registro: ofertaRegistro({
      oferta: { ...ofertaRegistro().oferta, preco: null },
    }) }))
    expect(html).toContain(copy.ofertaSemPreco)
    expect(html).not.toContain('R$&nbsp;0,00')
  })

  it('rascunho e aprovada são distinguidos por TEXTO, e não só por cor', () => {
    // Uma distinção só por cor não existe para quem não a enxerga.
    expect(renderToStaticMarkup(createElement(OfertaLida, { registro: ofertaRegistro() }))).toContain(copy.ofertaRascunho)
    expect(renderToStaticMarkup(createElement(OfertaLida, { registro: ofertaRegistro({
      approved_at: '2026-09-18T13:00:00.000Z', approved_by: 'user-a',
    }) }))).toContain(copy.ofertaAprovada)
  })
})

describe('a margem desenhada', () => {
  it('sem custo declarado, NÃO escreve número nenhum — escreve que não sabe', () => {
    // É o caso central do aceite: "não sei" não pode virar "100% de margem".
    const html = renderToStaticMarkup(createElement(MargemDaOfertaLida, {
      oferta: { ...ofertaRegistro().oferta, custos: [] },
    }))
    expect(html).toContain(copy.margemDesconhecida)
    expect(html).not.toContain('100,0%')
  })

  it('o RÓTULO em negrito acompanha o estado, e não diz "estimada" sobre um teto', () => {
    // Achado da conferência da captura. O número em negrito com um rótulo que
    // contradiz a explicação embaixo dá ao número a autoridade que a
    // explicação estava tentando tirar.
    const teto = renderToStaticMarkup(createElement(MargemDaOfertaLida, {
      oferta: { ...ofertaRegistro().oferta, custos: [{ nome: 'Ingredientes', valor: 60 }, { nome: 'Frete', valor: null }] },
    }))
    expect(teto).toContain(copy.margemRotuloTeto)
    expect(teto).not.toContain(`<strong>${copy.margemRotuloEstimada}</strong>`)
    expect(renderToStaticMarkup(createElement(MargemDaOfertaLida, { oferta: ofertaRegistro().oferta })))
      .toContain(`<strong>${copy.margemRotuloEstimada}</strong>`)
  })

  it('com custo SEM valor, diz que é TETO e nomeia o custo que falta', () => {
    const html = renderToStaticMarkup(createElement(MargemDaOfertaLida, {
      oferta: { ...ofertaRegistro().oferta, custos: [{ nome: 'Ingredientes', valor: 60 }, { nome: 'Frete', valor: null }] },
    }))
    expect(html).toContain(copy.margemTeto)
    expect(html).toContain('Frete')
  })

  it('com tudo valorado, mostra o número E a frase de que não é lucro', () => {
    const html = renderToStaticMarkup(createElement(MargemDaOfertaLida, { oferta: ofertaRegistro().oferta }))
    expect(html).toContain('70,0%')
    expect(html).toContain(copy.margemEstimada)
  })
})

describe('a sugestão de preço desenhada', () => {
  it('vem SEMPRE com a frase de que não foi aplicada', () => {
    // Um número sozinho ao lado de um campo de preço é lido como preenchimento.
    const html = renderToStaticMarkup(createElement(SugestaoDePreco, {
      rascunho: rascunhoDaOferta(ofertaRegistro().oferta), margemDesejada: '50', aoMudarMargem: () => {},
    }))
    expect(html).toContain(copy.sugestaoAjuda)
    expect(html).toContain('120,00')
  })

  it('sem custo com valor, diz que não há de onde sugerir', () => {
    const html = renderToStaticMarkup(createElement(SugestaoDePreco, {
      rascunho: { ...rascunhoDaOferta(ofertaRegistro().oferta), custos: [] },
      margemDesejada: '50', aoMudarMargem: () => {},
    }))
    expect(html).toContain(copy.sugestaoSemCusto)
  })
})

describe('os campos da oferta', () => {
  it('o campo de custo tem RÓTULO de verdade, e não só `placeholder`', () => {
    // `placeholder` some quando a pessoa digita e nem todo leitor de tela o
    // anuncia como rótulo.
    const html = renderToStaticMarkup(createElement(CamposDaOferta, {
      rascunho: { ...rascunhoDaOferta(ofertaRegistro().oferta) },
      aoMudar: () => {},
    }))
    expect(html).toContain('for="dz-oferta-custo-nome-0"')
    expect(html).toContain('for="dz-oferta-custo-valor-0"')
  })

  it('a ajuda dos custos diz que vazio NÃO é zero', () => {
    const html = renderToStaticMarkup(createElement(CamposDaOferta, {
      rascunho: rascunhoDaOferta(ofertaRegistro().oferta), aoMudar: () => {},
    }))
    expect(html).toContain('NÃO é zero')
  })
})

describe('o período em texto', () => {
  it('cada período tem sua chave, e nenhuma delas é indefinida', () => {
    expect(copy[periodoEmTexto('dia')]).toBe('dia')
    expect(copy[periodoEmTexto('semana')]).toBe('semana')
    expect(copy[periodoEmTexto('mes')]).toBe('mês')
  })
})
