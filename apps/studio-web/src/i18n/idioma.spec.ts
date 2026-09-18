import { describe, expect, it } from 'vitest'
import {
  CHAVE_DO_IDIOMA, IDIOMAS, IDIOMA_PADRAO, NOME_DO_IDIOMA, ehIdioma, escolhaGuardada,
  guardarEscolha, idiomaDaTag, idiomaEfetivo, idiomaNegociado, tagDoDocumento,
} from './idioma'
import { catalogosDe, ESPACOS_TRADUZIDOS, quantosIdiomas } from './catalogos'

describe('os idiomas que o produto tem', () => {
  it('são três, e o padrão é o de quem já usa o produto hoje', () => {
    expect([...IDIOMAS]).toEqual(['pt-BR', 'en', 'es'])
    expect(IDIOMA_PADRAO).toBe('pt-BR')
    expect(quantosIdiomas()).toBe(3)
  })

  it('cada um tem NOME PRÓPRIO, na própria língua', () => {
    // Bandeira é país: a do Brasil não representa quem fala português em
    // Portugal, nem a da Espanha quem fala espanhol no México. E o nome próprio
    // é o que a pessoa reconhece numa interface que ela não lê.
    expect(NOME_DO_IDIOMA.en).toBe('English')
    expect(NOME_DO_IDIOMA.es).toBe('Español')
    expect(NOME_DO_IDIOMA['pt-BR']).toContain('Português')
  })

  it('reconhece um idioma vindo de fora e recusa o que não é', () => {
    expect(ehIdioma('es')).toBe(true)
    expect(ehIdioma('de')).toBe(false)
    expect(ehIdioma(null)).toBe(false)
    expect(ehIdioma(42)).toBe(false)
  })
})

describe('a negociação BCP 47', () => {
  it('mapeia a subtag primária, com região ou sem', () => {
    expect(idiomaDaTag('en')).toBe('en')
    expect(idiomaDaTag('en-GB')).toBe('en')
    expect(idiomaDaTag('es-419')).toBe('es')
    expect(idiomaDaTag('pt-BR')).toBe('pt-BR')
  })

  it('`pt-PT` cai em pt-BR — e isso é uma decisão declarada, não um acidente', () => {
    // Não há catálogo europeu. Entregar português do Brasil a quem pediu
    // português é melhor que entregar inglês.
    expect(idiomaDaTag('pt-PT')).toBe('pt-BR')
  })

  it('ignora a caixa e o espaço em volta', () => {
    expect(idiomaDaTag('  ES-mx ')).toBe('es')
  })

  it('um idioma que o produto não tem devolve `null`, e não o padrão', () => {
    // `null` é "não negociei"; o padrão é a decisão de quem chama. Colapsar os
    // dois faria a precedência perder um degrau.
    expect(idiomaDaTag('de-DE')).toBeNull()
    expect(idiomaDaTag('')).toBeNull()
  })

  it('a ORDEM do navegador é respeitada: a primeira suportada vence', () => {
    // `navigator.languages` vem da mais desejada para a menos. Ficar com a
    // última inverteria a preferência da pessoa.
    expect(idiomaNegociado(['de-DE', 'es-ES', 'en-US'])).toBe('es')
    expect(idiomaNegociado(['en-US', 'es-ES'])).toBe('en')
  })

  it('sem nenhuma suportada, não negocia', () => {
    expect(idiomaNegociado(['de', 'fr'])).toBeNull()
    expect(idiomaNegociado([])).toBeNull()
  })
})

describe('a precedência do idioma efetivo', () => {
  it('sem nada, é pt-BR', () => {
    expect(idiomaEfetivo({})).toBe('pt-BR')
  })

  it('o navegador vence o padrão', () => {
    expect(idiomaEfetivo({ doNavegador: 'es' })).toBe('es')
  })

  it('a escolha local vence o navegador', () => {
    expect(idiomaEfetivo({ local: { idioma: 'en', em: 1 }, doNavegador: 'es' })).toBe('en')
  })

  it('a escolha MAIS RECENTE vence — e é assim que a conta não apaga a da pessoa', () => {
    // É o defeito que o adendo manda tratar por escrito: a preferência da conta
    // viaja por rede e chega DEPOIS de a pessoa já ter escolhido na tela.
    // Deixá-la vencer por ter chegado por último faria a escolha piscar e voltar.
    expect(idiomaEfetivo({ local: { idioma: 'en', em: 200 }, daConta: { idioma: 'es', em: 100 } })).toBe('en')
    expect(idiomaEfetivo({ local: { idioma: 'en', em: 100 }, daConta: { idioma: 'es', em: 200 } })).toBe('es')
  })

  it('empate no instante fica com a escolha LOCAL', () => {
    // Quem está na frente da tela é quem acabou de decidir.
    expect(idiomaEfetivo({ local: { idioma: 'en', em: 100 }, daConta: { idioma: 'es', em: 100 } })).toBe('en')
  })

  it('só a da conta, sem local, vale', () => {
    expect(idiomaEfetivo({ daConta: { idioma: 'es', em: 1 }, doNavegador: 'en' })).toBe('es')
  })
})

describe('o `lang` do documento', () => {
  it('é a tag do idioma — é o que diz ao leitor de tela como pronunciar', () => {
    expect(tagDoDocumento('es')).toBe('es')
    expect(tagDoDocumento('pt-BR')).toBe('pt-BR')
  })
})

describe('a escolha guardada neste navegador', () => {
  function armazem(inicial: string | null) {
    let valor = inicial
    return {
      getItem: () => valor,
      setItem: (_chave: string, novo: string) => { valor = novo },
      lido: () => valor,
    }
  }

  it('guarda e lê de volta', () => {
    const a = armazem(null)
    expect(guardarEscolha(a, { idioma: 'es', em: 7 })).toBe(true)
    expect(escolhaGuardada(a)).toEqual({ idioma: 'es', em: 7 })
  })

  it('sem armazenamento — servidor, janela anônima — devolve `null` em vez de explodir', () => {
    // Uma exceção aqui derrubaria a aplicação antes do primeiro render, por
    // causa de uma preferência de apresentação.
    expect(escolhaGuardada(undefined)).toBeNull()
    expect(guardarEscolha(undefined, { idioma: 'en', em: 1 })).toBe(false)
  })

  it('armazenamento que LANÇA ao ler não derruba a tela', () => {
    const explode = { getItem: () => { throw new Error('bloqueado') } }
    expect(escolhaGuardada(explode)).toBeNull()
  })

  it('armazenamento que LANÇA ao escrever devolve `false`, e a escolha continua valendo', () => {
    const explode = { setItem: () => { throw new Error('cheio') } }
    expect(guardarEscolha(explode, { idioma: 'en', em: 1 })).toBe(false)
  })

  it('guardado ilegível é o mesmo que não guardado', () => {
    expect(escolhaGuardada(armazem('isto não é json'))).toBeNull()
    expect(escolhaGuardada(armazem('{"idioma":"de","em":1}'))).toBeNull()
    expect(escolhaGuardada(armazem('{"idioma":"en"}'))).toBeNull()
    expect(escolhaGuardada(armazem('{"idioma":"en","em":"agora"}'))).toBeNull()
  })

  it('a chave é versionada: um formato novo não lê o antigo por engano', () => {
    expect(CHAVE_DO_IDIOMA).toContain('v1')
  })
})

describe('os catálogos', () => {
  it('cada idioma tem os espaços de nomes traduzidos', () => {
    for (const idioma of IDIOMAS) {
      const catalogos = catalogosDe(idioma)
      for (const espaco of ESPACOS_TRADUZIDOS) expect(catalogos[espaco]).toBeTypeOf('object')
    }
  })

  it('as MESMAS chaves nos três — uma que falte viraria "undefined" na tela', () => {
    const caminhos = (valor: unknown, prefixo = ''): string[] =>
      typeof valor === 'object' && valor !== null
        ? Object.entries(valor).flatMap(([chave, dentro]) => caminhos(dentro, `${prefixo}${chave}.`))
        : [prefixo]
    for (const espaco of ESPACOS_TRADUZIDOS) {
      const referencia = caminhos(catalogosDe('pt-BR')[espaco]).sort()
      expect(caminhos(catalogosDe('en')[espaco]).sort()).toEqual(referencia)
      expect(caminhos(catalogosDe('es')[espaco]).sort()).toEqual(referencia)
    }
  })

  it('as traduções são DIFERENTES do português — paridade de chave não é tradução', () => {
    // Copiar o português e trocar o nome do arquivo passaria em qualquer teste
    // de paridade. O que se mede aqui é que alguém traduziu.
    expect(catalogosDe('en').rail.novaTarefa).not.toBe(catalogosDe('pt-BR').rail.novaTarefa)
    expect(catalogosDe('es').rail.novaTarefa).not.toBe(catalogosDe('pt-BR').rail.novaTarefa)
    expect(catalogosDe('en').preferencias.titulo).not.toBe(catalogosDe('pt-BR').preferencias.titulo)
  })

  it('a MARCA não é traduzida: FRIGG é nome próprio em qualquer língua', () => {
    for (const idioma of IDIOMAS) expect(catalogosDe(idioma).rail.marca).toBe('FRIGG')
  })

  it('as INTERPOLAÇÕES sobrevivem à tradução', () => {
    // `{n}` perdido na tradução deixa a frase sem o número, e ninguém percebe
    // até alguém ler a tela em espanhol.
    for (const idioma of IDIOMAS) {
      expect(catalogosDe(idioma).preferencias.usoTotal).toContain('{custo}')
      expect(catalogosDe(idioma).preferencias.usoTotal).toContain('{chamadas}')
      expect(catalogosDe(idioma).preferencias.usoSemPreco).toContain('{n}')
    }
  })

  it('um idioma que não existe cai no padrão, em vez de devolver `undefined`', () => {
    expect(catalogosDe('de' as never)).toBe(catalogosDe('pt-BR'))
  })
})
