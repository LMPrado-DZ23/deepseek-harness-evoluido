import { describe, expect, it } from 'vitest'
import { ATALHOS, ATALHOS_VISIVEIS, atalhosDaHome, temMaisAtalhos } from './opcoes'
import { STUDIO_CATEGORIES } from '../categories'

/*
  TODA CATEGORIA QUE O PRODUTO ACEITA TEM PORTA NA HOME.

  Este arquivo existe por causa de uma sabotagem que sobreviveu: dava para
  remover o atalho de uma categoria e nada reprovava. O compilador não reclama —
  `ATALHOS` é uma lista, e uma lista com um item a menos continua sendo uma
  lista válida.

  O efeito de uma categoria sem atalho não é um erro: é uma ausência. Ela
  continua existindo no schema, o classificador continua palpitando-a pelo
  texto, e a pessoa que não escrever a palavra certa nunca descobre que ela
  existe. É a forma mais cara de esconder função — a que não deixa rastro.
*/

describe('os atalhos da home', () => {
  it('há um atalho para CADA categoria que o produto aceita', () => {
    const comAtalho = new Set(ATALHOS.map(atalho => atalho.categoria))
    for (const categoria of STUDIO_CATEGORIES) {
      expect(comAtalho.has(categoria), `a categoria ${categoria} não tem atalho na home`).toBe(true)
    }
  })

  it('e nenhum atalho aponta para categoria que não existe', () => {
    // O outro lado da mesma moeda: um atalho órfão leva a pessoa a pedir uma
    // coisa que o produto recusa depois, no meio do caminho.
    const declaradas = new Set<string>(STUDIO_CATEGORIES)
    for (const atalho of ATALHOS) {
      expect(declaradas.has(atalho.categoria), `o atalho "${atalho.texto}" aponta para ${atalho.categoria}`).toBe(true)
    }
  })

  it('cada atalho tem texto próprio — dois iguais são um deles invisível', () => {
    expect(new Set(ATALHOS.map(atalho => atalho.texto)).size).toBe(ATALHOS.length)
  })

  it('o que está escondido atrás do "Mais" é alcançável', () => {
    /*
      A home mostra quatro pílulas e um "Mais". Se o botão sumisse, as
      categorias de trás — incluindo a aberta, que é a última — ficariam sem
      porta nenhuma, e o teste de cobertura acima continuaria passando.
    */
    expect(ATALHOS.length).toBeGreaterThan(ATALHOS_VISIVEIS)
    expect(temMaisAtalhos()).toBe(true)
    expect(atalhosDaHome(true)).toHaveLength(ATALHOS.length)
    expect(atalhosDaHome(false)).toHaveLength(ATALHOS_VISIVEIS)
  })
})
