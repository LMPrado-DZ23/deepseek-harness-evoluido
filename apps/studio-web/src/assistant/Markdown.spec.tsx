import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import copy from '../i18n/assistant.pt-BR.json'
import { CodeBlock, Markdown } from './Markdown'

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }))

describe('a resposta desenhada', () => {
  it('negrito, itálico e código viram elementos, e não asteriscos na tela', () => {
    const out = html('**forte** *leve* `x`')
    expect(out).toContain('<strong>forte</strong>')
    expect(out).toContain('<em>leve</em>')
    expect(out).toContain('<code class="md-code">x</code>')
    expect(out).not.toContain('**')
  })

  it('nenhum HTML do modelo chega à página como HTML', () => {
    // O texto vem de um MODELO. Um único ponto que aceitasse HTML transformaria
    // "o assistente respondeu" em "o assistente escreveu a página".
    const out = html('<script>alert(1)</script> <img src=x onerror=alert(1)> <b>b</b>')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('<img')
    expect(out).not.toContain('<b>')
    expect(out).toContain('&lt;script&gt;')
  })

  it('link seguro abre em outra aba sem levar a página junto', () => {
    const out = html('[site](https://exemplo.invalid/a)')
    expect(out).toContain('href="https://exemplo.invalid/a"')
    expect(out).toContain('rel="noopener noreferrer nofollow"')
    expect(out).toContain('target="_blank"')
  })

  it('link que executa não vira link nenhum', () => {
    const out = html('[x](javascript:alert(1))')
    expect(out).not.toContain('<a ')
    expect(out).toContain('javascript:alert(1)')
  })

  it('imagem remota nunca é buscada: vira link', () => {
    const out = html('![gato](https://exemplo.invalid/g.png)')
    expect(out).not.toContain('<img')
    expect(out).toContain('href="https://exemplo.invalid/g.png"')
  })

  it('os títulos da resposta começam em h3', () => {
    // A página já tem h1 e h2; um h2 vindo de uma resposta quebraria a ordem
    // dos títulos para quem navega por eles.
    expect(html('# um')).toContain('<h3')
    expect(html('### três')).toContain('<h5')
    expect(html('# um')).not.toContain('<h1')
  })

  it('listas, citação e linha viram os elementos certos', () => {
    expect(html('- a\n- b')).toContain('<ul class="md-list">')
    expect(html('1. a')).toContain('<ol class="md-list">')
    expect(html('> nota')).toContain('<blockquote')
    expect(html('---')).toContain('<hr/>')
  })

  it('o bloco de código mostra a linguagem e um botão de copiar com nome', () => {
    const out = html('```ts\nconst a = 1\n```')
    expect(out).toContain('<pre>')
    expect(out).toContain('class="language-ts"')
    expect(out).toContain('const a = 1')
    // "Copiar" repetido sem dizer o quê não ajuda quem não vê a tela, mas o
    // botão fica DENTRO do bloco e o rótulo acessível existe.
    expect(out).toContain(`aria-label="${copy.codeBlockCopy}"`)
  })

  it('código sem linguagem não inventa uma', () => {
    const out = renderToStaticMarkup(createElement(CodeBlock, { language: null, text: 'x' }))
    expect(out).toContain(copy.codeBlockUnknownLanguage)
    expect(out).not.toContain('class="language-')
  })

  it('o texto do parágrafo respeita a direção da escrita', () => {
    expect(html('olá')).toContain('dir="auto"')
  })

  it('uma resposta vazia não desenha nada além do invólucro', () => {
    expect(html('')).toBe('<div class="md"></div>')
  })
})
