import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { IdiomaProvider } from './IdiomaProvider'
import { catalogosDe, ESPACOS_TRADUZIDOS, TELAS_TRADUZIDAS, type EspacoDeNomes } from './catalogos'
import { IDIOMAS, type Idioma } from './idioma'
import { marcadoresPendentes } from './texto'
import { Rail } from '../shell/Rail'
import { Preferencias } from '../preferencias/Preferencias'

/*
  AS TELAS DECLARADAS TRADUZIDAS, DESENHADAS NOS TRÊS IDIOMAS.

  ## Por que este arquivo existe, e por que ele não é mais um teste de catálogo

  Em 18/09/2026 uma revisão externa achou, lendo o código, que o rótulo acessível
  do logotipo saía em português mesmo com o inglês escolhido. Os catálogos do
  `rail` estavam completos nos três idiomas; `gate:idiomas` passava; e a frase
  errada estava lá — porque não vinha de catálogo nenhum. Vinha de uma FUNÇÃO,
  `nomeAcessivelDaMarca()`, que devolvia português fixo.

  Nada que olhe catálogos acha isso. Nada que procure literais na tela acha
  também: a frase estava em outro arquivo. O que acha é DESENHAR a tela no
  idioma escolhido e olhar o que saiu — que é o que este arquivo faz.

  ## O que ele afirma

  1. Nenhum marcador `{assim}` sobra na tela, em idioma nenhum.
  2. Nenhuma frase do catálogo PORTUGUÊS aparece na tela em inglês ou espanhol,
     quando aquela frase TEM tradução diferente. Esta é a afirmação que pega a
     família inteira do defeito, e não o caso achado: qualquer texto que escape
     da tradução cai aqui, venha de onde vier.
  3. A lista de telas percorrida é a DECLARADA em `TELAS_TRADUZIDAS`, e o
     conjunto tem de cobrir todo espaço de nomes declarado traduzido. Migrar um
     espaço sem declarar a tela dele não passa por aqui despercebido.
*/

/** O que cada tela declarada precisa para ser desenhada. */
const TELAS: Readonly<Record<string, () => ReactElement>> = {
  'shell/Rail.tsx': () => createElement(Rail, {
    ativo: 'nova', aberto: true, aoFechar: () => {}, conta: 'Leandro Prado', tarefas: [],
  }),
  'preferencias/Preferencias.tsx': () => createElement(Preferencias, {
    contexto: { autenticado: true, notificacoesSuportadas: false },
    aoFechar: () => {}, conta: 'Leandro Prado',
  }),
}

/**
 * O HTML de uma tela, desenhada num idioma.
 *
 * O ambiente é INJETADO com a escolha já guardada, e não simulado com um clique:
 * o que se quer medir aqui é o desenho no idioma, e não o caminho da troca —
 * esse é exercitado pelo teste de navegador.
 * @param tela - o construtor da tela.
 * @param idioma - o idioma.
 * @returns o HTML.
 */
function desenhar(tela: () => ReactElement, idioma: Idioma): string {
  return renderToStaticMarkup(createElement(IdiomaProvider, {
    ambiente: {
      armazem: { getItem: () => JSON.stringify({ idioma, em: 1 }), setItem: () => {} },
      tagsDoNavegador: [],
    },
    children: tela(),
  }))
}

/**
 * Todas as frases de um catálogo, incluindo as aninhadas.
 * @param valor - o catálogo ou um pedaço dele.
 * @returns as frases.
 */
function frases(valor: unknown): readonly string[] {
  if (typeof valor === 'string') return [valor]
  if (typeof valor === 'object' && valor !== null) return Object.values(valor).flatMap(frases)
  return []
}

/**
 * Os pedaços FIXOS de uma frase — o que sobra quando se tiram os marcadores.
 *
 * Comparar a frase crua com o HTML não funciona, e a primeira versão deste
 * arquivo caiu nessa armadilha: o catálogo guarda `{marca}: ir para a tela
 * inicial` e a tela mostra `FRIGG: ir para a tela inicial`, então a frase crua
 * NUNCA aparece no HTML e o teste passava com o defeito na tela. A sabotagem
 * que recolocou o defeito original sobreviveu, e foi ela que mostrou isto.
 *
 * O que aparece no HTML são os pedaços entre os marcadores. São eles que se
 * procura.
 * @param frase - a frase do catálogo.
 * @returns os pedaços com texto suficiente para serem procurados.
 */
function pedacosFixos(frase: string): readonly string[] {
  return frase.split(/\{[A-Za-z][A-Za-z0-9]*\}/u).map(pedaco => pedaco.trim()).filter(pedaco => pedaco.length > 3)
}

describe('as telas declaradas traduzidas', () => {
  it('declaram uma tela para CADA espaço de nomes traduzido', () => {
    for (const espaco of ESPACOS_TRADUZIDOS) {
      const telas = TELAS_TRADUZIDAS[espaco as EspacoDeNomes] ?? []
      expect(telas.length, `o espaço ${espaco} não declara tela`).toBeGreaterThan(0)
      for (const tela of telas) expect(TELAS[tela], `a tela ${tela} não é desenhada por este teste`).toBeTypeOf('function')
    }
  })

  for (const [caminho, construir] of Object.entries(TELAS)) {
    for (const idioma of IDIOMAS) {
      it(`${caminho} não deixa marcador na tela em ${idioma}`, () => {
        expect(marcadoresPendentes(desenhar(construir, idioma))).toEqual([])
      })
    }

    for (const idioma of IDIOMAS.filter(candidato => candidato !== 'pt-BR')) {
      it(`${caminho} não escreve português na tela em ${idioma}`, () => {
        const html = desenhar(construir, idioma)
        /*
          Só entram na conferência as frases que MUDAM de idioma. Uma frase igual
          nos dois catálogos — "Plugins", "FRIGG" — aparecer no HTML não é
          defeito; é a mesma palavra nas duas línguas, e cobrá-la ensinaria a
          traduzir palavra que não se traduz só para calar um teste.
        */
        const noIdioma = new Set(frases(catalogosDe(idioma)))
        const vazaram = frases(catalogosDe('pt-BR'))
          .filter(frase => !noIdioma.has(frase))
          .filter(frase => {
            const pedacos = pedacosFixos(frase)
            return pedacos.length > 0 && pedacos.every(pedaco => html.includes(pedaco))
          })
        expect(vazaram, `estas frases em português apareceram na tela em ${idioma}`).toEqual([])
      })
    }
  }
})
