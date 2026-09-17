import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CamposDoPlano, PlanoLido } from './Empresa'
import type { RegistroDePlano } from './empresaApi'

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
