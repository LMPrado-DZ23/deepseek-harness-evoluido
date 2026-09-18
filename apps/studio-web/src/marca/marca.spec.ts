import { describe, expect, it } from 'vitest'
import { EMBLEMA, MARCA, nomeAcessivelDaMarca, podeAnunciarDominio, tituloDaPagina } from './marca'

describe('a marca de apresentação', () => {
  it('é FRIGG, e o DZ23 continua como ORIGEM — não como concorrente', () => {
    // BR-F01: nenhuma superfície exibe duas marcas disputando o mesmo papel. A
    // origem tem nome próprio e função própria, e por isso pode coexistir.
    expect(MARCA.nome).toBe('FRIGG')
    expect(MARCA.origem).toBe('DZ23')
    expect(MARCA.nome).not.toBe(MARCA.origem)
  })

  it('preserva o núcleo técnico que a decisão de marca manda preservar', () => {
    expect(MARCA.nucleo).toBe('DeepSeek')
  })
})

describe('o domínio escolhido', () => {
  it('é frigg.ia.br, e NÃO está publicado', () => {
    // BR-F07: escolher não é registrar, apontar, certificar nem servir. O kit
    // diz isso com todas as letras, e a constante repete para que nenhuma tela
    // possa afirmar implantação sem que alguém mude esta linha.
    expect(MARCA.dominioEscolhido).toBe('frigg.ia.br')
    expect(MARCA.dominioPublicado).toBe(false)
  })

  it('não pode ser anunciado como endereço de acesso enquanto não houver prova', () => {
    expect(podeAnunciarDominio()).toBe(false)
  })
})

describe('o título da aba', () => {
  it('sem seção, é só a marca', () => {
    expect(tituloDaPagina()).toBe('FRIGG')
  })

  it('com seção, a marca vem DEPOIS', () => {
    // Seis abas começando com "FRIGG" são seis abas iguais para quem lê os
    // primeiros caracteres de cada uma.
    expect(tituloDaPagina('Preferências')).toBe('Preferências · FRIGG')
  })

  it('seção vazia, em branco ou ausente cai no mesmo lugar', () => {
    // Um título "  · FRIGG" seria pior que nenhum: parece defeito.
    expect(tituloDaPagina('')).toBe('FRIGG')
    expect(tituloDaPagina('   ')).toBe('FRIGG')
    expect(tituloDaPagina(null)).toBe('FRIGG')
  })

  it('apara o espaço em volta da seção, em vez de escrevê-lo', () => {
    expect(tituloDaPagina('  Ajuda  ')).toBe('Ajuda · FRIGG')
  })
})

describe('o nome acessível do logotipo', () => {
  it('diz a AÇÃO, e não o nome do arquivo', () => {
    // O logotipo é um link. "frigg-mark-48.png" não diz a ninguém para onde se
    // vai ao ativá-lo.
    expect(nomeAcessivelDaMarca()).toBe('FRIGG: ir para a tela inicial')
    expect(nomeAcessivelDaMarca()).toContain('inicial')
  })
})

describe('o emblema', () => {
  it('serve 1x e 2x, porque num monitor denso 48 px desenhado a 48 px borra', () => {
    expect(EMBLEMA.srcSet).toContain('frigg-mark-48.png 1x')
    expect(EMBLEMA.srcSet).toContain('frigg-mark-96.png 2x')
  })

  it('o 1x do srcSet é o MESMO arquivo do src — e não um segundo desenho', () => {
    expect(EMBLEMA.srcSet.startsWith(`${EMBLEMA.src} 1x`)).toBe(true)
  })

  it('é desenhado de 36 px para cima, faixa em que o emblema sobrevive', () => {
    // Abaixo disso o emblema vira mancha: a medição está em
    // `audit/FRIGG_MARCA_R1/comparacao-marca.png`, e quem cobre o pequeno é o
    // micro-F do favicon.
    expect(EMBLEMA.lado).toBeGreaterThanOrEqual(36)
  })
})
