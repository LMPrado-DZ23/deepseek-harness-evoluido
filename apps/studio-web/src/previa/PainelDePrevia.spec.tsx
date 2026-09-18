import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { IdiomaProvider } from '../i18n/IdiomaProvider'
import { IDIOMAS, type Idioma } from '../i18n/idioma'
import { catalogosDe } from '../i18n/catalogos'
import { PainelDePrevia } from './PainelDePrevia'
import type { LeituraDoPainel } from './estado'
import type { Modo, Viewport } from './layout'

/*
  O PAINEL DESENHADO, e não o painel descrito.

  A decisão de o que mostrar mora em `situacaoDoPainel` e tem teste próprio;
  a conferência de rota mora em `rotaDaPrevia` e tem o dela. O que ESTE arquivo
  prova é a LIGAÇÃO: que o painel consome aquelas decisões, e que o que sai na
  tela é o que elas disseram.

  O desenho é estático (`renderToStaticMarkup`), que é a convenção deste
  projeto — a suíte roda em `node`, sem DOM. Clique, digitação e foco são
  exercitados no navegador de verdade, pelo e2e.
*/

const BASE = 'http://p-0123456789abcdef01234567.dz23.localhost:7711'

function desenhar(leitura: LeituraDoPainel, extra: { viewport?: Viewport; modo?: Modo; base?: string | null; comEncerrar?: boolean } = {}): string {
  return renderToStaticMarkup(createElement(IdiomaProvider, {
    // Português INJETADO: sem ambiente, o provedor cai no padrão do navegador,
    // que num teste sem navegador não é o idioma que estes casos conferem.
    ambiente: { armazem: { getItem: () => JSON.stringify({ idioma: 'pt-BR', em: 1 }), setItem: () => undefined }, tagsDoNavegador: [] },
    children: createElement(PainelDePrevia, {
      leitura,
      base: extra.base === undefined ? BASE : extra.base,
      modo: extra.modo ?? 'dividido',
      viewport: extra.viewport ?? 'desktop',
      aoExpandir: () => undefined,
      aoRestaurar: () => undefined,
      aoTrocarViewport: () => undefined,
      ...(extra.comEncerrar === true ? { aoEncerrar: () => undefined } : {}),
    }),
  }))
}

const temQuadro = (html: string) => html.includes('<iframe')

describe('o painel NÃO simula um aplicativo funcionando', () => {
  it('enquanto o modelo escreve, não há quadro nenhum', () => {
    const html = desenhar({ previa: null, execucao: { state: 'RUNNING', stage: 'generate' } })
    expect(html).toContain('Preparando o aplicativo')
    expect(temQuadro(html)).toBe(false)
  })

  it('enquanto o build roda, o texto é OUTRO — e continua sem quadro', () => {
    const html = desenhar({ previa: null, execucao: { state: 'RUNNING', stage: 'build' } })
    expect(html).toContain('Construindo')
    expect(temQuadro(html)).toBe(false)
  })

  it('e não há porcentagem inventada em nenhuma espera', () => {
    // Uma barra que anda sozinha sem medir nada é a forma mais convincente de
    // mentir sobre progresso.
    for (const etapa of ['generate', 'build']) {
      expect(desenhar({ previa: null, execucao: { state: 'RUNNING', stage: etapa } })).not.toMatch(/\d+\s*%/u)
    }
  })

  it('com a prévia pronta, o quadro aponta para a prévia', () => {
    const html = desenhar({ previa: { state: 'READY', health: 'OK' }, execucao: null })
    expect(html).toContain(`src="${BASE}/"`)
  })
})

describe('a versão anterior é identificada como anterior', () => {
  it('com execução nova em curso, o painel AVISA que o que está ali é a de antes', () => {
    const html = desenhar({ previa: { state: 'READY', health: 'OK' }, execucao: { state: 'RUNNING', stage: 'build' } })
    expect(html).toContain('Versão anterior')
    expect(html).toContain('Esta não é a alteração que você acabou de pedir.')
    // E o quadro continua servindo, porque a versão de antes ainda funciona.
    expect(temQuadro(html)).toBe(true)
  })

  it('sem execução nova, não há aviso nenhum', () => {
    expect(desenhar({ previa: { state: 'READY', health: 'OK' }, execucao: null })).not.toContain('Versão anterior')
  })
})

describe('a barra de rota anuncia o que ela não faz', () => {
  it('a ajuda diz, na própria tela, que ali não se abre outro endereço', () => {
    const html = desenhar({ previa: { state: 'READY', health: 'OK' }, execucao: null })
    expect(html).toContain('Só páginas do seu aplicativo. Este campo não abre outros endereços.')
  })
})

describe('desktop e celular mudam a largura de verdade', () => {
  it('o celular aplica largura máxima, e a tela diz o que ele NÃO é', () => {
    const html = desenhar({ previa: { state: 'READY', health: 'OK' }, execucao: null }, { viewport: 'celular' })
    expect(html).toContain('max-width:390px')
    // Selecionar celular não valida um aplicativo Android ou iOS nativo.
    expect(html).toContain('Não é um aplicativo Android ou iPhone')
  })

  it('o desktop não inventa largura', () => {
    expect(desenhar({ previa: { state: 'READY', health: 'OK' }, execucao: null })).not.toContain('max-width')
  })
})

describe('fechar, encerrar e cancelar são coisas diferentes, e a tela diz isso', () => {
  it('o rodapé explica que fechar o painel não interrompe nada', () => {
    expect(desenhar({ previa: { state: 'READY', health: 'OK' }, execucao: null }))
      .toContain('Fechar o painel não interrompe a construção nem encerra a prévia.')
  })

  it('encerrar a prévia avisa que a tarefa continua', () => {
    expect(desenhar({ previa: { state: 'READY', health: 'OK' }, execucao: null }, { comEncerrar: true }))
      .toContain('Encerrar a prévia não cancela a tarefa.')
  })

  it('não existe cancelar a TAREFA aqui — a única destrutiva não mora neste painel', () => {
    const html = desenhar({ previa: { state: 'READY', health: 'OK' }, execucao: null }, { comEncerrar: true })
    expect(html).not.toMatch(/cancelar a tarefa</iu)
  })
})

describe('o quadro é isolado, e a tela diz que nada foi publicado', () => {
  it('o `sandbox` não deixa o aplicativo tirar a pessoa da tela nem abrir janela', () => {
    const html = desenhar({ previa: { state: 'READY', health: 'OK' }, execucao: null })
    expect(html).toContain('sandbox="allow-scripts allow-forms allow-same-origin"')
    expect(html).not.toContain('allow-top-navigation')
    expect(html).not.toContain('allow-popups')
  })

  it('abrir em outra janela não vaza a origem nem entrega a janela de origem', () => {
    const html = desenhar({ previa: { state: 'READY', health: 'OK' }, execucao: null })
    expect(html).toContain('rel="noreferrer noopener"')
  })

  it('o rodapé diz que isto não é publicação', () => {
    expect(desenhar({ previa: { state: 'READY', health: 'OK' }, execucao: null }))
      .toContain('não foi publicado na internet')
  })
})

describe('a primeira carga entra pela ADMISSÃO', () => {
  it('com endereço de entrada, o quadro carrega ELE, e não a raiz', () => {
    /*
      A prévia entra por `/__dz23/admission`: é lá que o bilhete vira o cookie
      do host dela. Mandar a primeira carga para `/` pularia a troca, e o
      aplicativo abriria sem sessão — o quadro pareceria funcionar e nada dentro
      dele funcionaria.
    */
    const html = renderToStaticMarkup(createElement(IdiomaProvider, {
      ambiente: { armazem: { getItem: () => JSON.stringify({ idioma: 'pt-BR', em: 1 }), setItem: () => undefined }, tagsDoNavegador: [] },
      children: createElement(PainelDePrevia, {
        leitura: { previa: { state: 'READY', health: 'OK' }, execucao: null },
        base: BASE, entrada: `${BASE}/__dz23/admission`, modo: 'dividido', viewport: 'desktop',
        aoExpandir: () => undefined, aoRestaurar: () => undefined, aoTrocarViewport: () => undefined,
      }),
    }))
    expect(html).toContain(`src="${BASE}/__dz23/admission"`)
  })

  it('sem endereço de entrada, o quadro carrega a raiz do aplicativo', () => {
    expect(desenhar({ previa: { state: 'READY', health: 'OK' }, execucao: null })).toContain(`src="${BASE}/"`)
  })
})

describe('o código de acesso do aplicativo gerado aparece', () => {
  it('quando ele existe, com a frase que evita a procura na caixa de e-mail', () => {
    /*
      Um aplicativo com entrada por código manda o código para um endereço que
      ninguém lê numa prévia local. Sem mostrá-lo, a pessoa fica presa na porta
      do próprio aplicativo — e sem saber por quê.
    */
    const html = renderToStaticMarkup(createElement(IdiomaProvider, {
      ambiente: { armazem: { getItem: () => JSON.stringify({ idioma: 'pt-BR', em: 1 }), setItem: () => undefined }, tagsDoNavegador: [] },
      children: createElement(PainelDePrevia, {
        leitura: { previa: { state: 'READY', health: 'OK' }, execucao: null },
        base: BASE, modo: 'dividido', viewport: 'desktop',
        codigos: [{ email: 'cliente@previa.local', code: '482901', expires_at: '2026-09-18T20:00:00.000Z' }],
        aoExpandir: () => undefined, aoRestaurar: () => undefined, aoTrocarViewport: () => undefined,
      }),
    }))
    expect(html).toContain('cliente@previa.local')
    expect(html).toContain('482901')
    expect(html).toContain('Ele não foi enviado por e-mail')
  })

  it('e sem código nenhum, a seção não existe', () => {
    expect(desenhar({ previa: { state: 'READY', health: 'OK' }, execucao: null })).not.toContain('dz-previa-codigos')
  })
})

describe('os três idiomas desenham a mesma tela', () => {
  for (const idioma of IDIOMAS) {
    it(`a situação e os avisos saem em ${idioma}`, () => {
      const catalogo = catalogosDe(idioma as Idioma).previa
      const html = renderToStaticMarkup(createElement(IdiomaProvider, {
        // O ambiente é INJETADO com a escolha já guardada: o que se mede aqui
        // é o desenho no idioma, e não o caminho da troca.
        ambiente: { armazem: { getItem: () => JSON.stringify({ idioma, em: 1 }), setItem: () => undefined }, tagsDoNavegador: [] },
        children: createElement(PainelDePrevia, {
          leitura: { previa: { state: 'READY', health: 'OK' }, execucao: null },
          base: BASE, modo: 'dividido', viewport: 'celular',
          aoExpandir: () => undefined, aoRestaurar: () => undefined, aoTrocarViewport: () => undefined,
        }),
      }))
      /*
        A comparação é contra o que a TELA desenha, e não contra a chave do
        catálogo: foi exatamente por comparar chave que a revisão de 18/09
        passou por um rótulo em português dentro do inglês.
      */
      expect(html).toContain(catalogo.situacao.disponivel)
      expect(html).toContain(catalogo.celularAviso)
      expect(html).toContain(catalogo.naoPublicado)
      expect(html).toContain(catalogo.rota)
      expect(html).toContain(catalogo.abrirSeparado)
    })
  }
})
