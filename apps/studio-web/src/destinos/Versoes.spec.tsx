import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ContagemDeConteudos, textoDaMudanca } from './destinos'
import type { VersaoDoPacote } from './versoes'

/** O que as versões DESENHAM na Biblioteca. */
function versao(sha: string): VersaoDoPacote {
  return {
    item: {
      projeto: { project_id: 'p-1', name: 'Clínica', state: 'VERIFIED_PROTOTYPE' },
      registro: {
        export_id: sha.slice(0, 5), project_id: 'p-1', run_id: 'run-1', file_name: 'prototipo.zip',
        sha256: sha, size_bytes: 1_000, entries: 3, created_at: '2026-09-17T12:00:00.000Z',
      },
    },
    numero: 1, vigente: true, mudanca: null,
  }
}

describe('a frase da mudança', () => {
  it('a primeira versão DIZ que é a primeira', () => {
    expect(textoDaMudanca(null)).toContain('primeira versão')
  })

  it('conteúdo idêntico é dito em palavras, e não como "0 bytes"', () => {
    expect(textoDaMudanca({ bytes: 0, arquivos: 0, identico: true })).toContain('idêntico')
  })

  it('encolher DIZ QUANTO, e o valor absoluto é o que faz isso acontecer', () => {
    /*
      A primeira versão deste caso olhava só o sinal, e a sabotagem que removia
      o `Math.abs` SOBREVIVEU — porque `formatBytes` devolve "0 B" para qualquer
      número negativo. Sem o valor absoluto a frase virava "encolheu 0 B": sem
      menos nenhum, e sem informação nenhuma. O que o teste precisa olhar é o
      TAMANHO, e não o sinal.
    */
    const frase = textoDaMudanca({ bytes: -2_048, arquivos: 0, identico: false })
    expect(frase).toContain('encolheu')
    expect(frase).toContain('2.0 KB')
    expect(frase).not.toContain('0 B')
  })

  it('crescer diz quanto', () => {
    expect(textoDaMudanca({ bytes: 2_048, arquivos: 0, identico: false })).toContain('cresceu')
  })

  it('o marcador `{bytes}` NUNCA chega à tela', () => {
    for (const mudanca of [
      { bytes: 10, arquivos: 0, identico: false },
      { bytes: -10, arquivos: 0, identico: false },
    ]) expect(textoDaMudanca(mudanca)).not.toContain('{bytes}')
  })
})

describe('a contagem de conteúdos', () => {
  it('com UM pacote não diz nada: "1 conteúdo em 1 pacote" é ruído', () => {
    expect(renderToStaticMarkup(createElement(ContagemDeConteudos, { versoes: [versao('a'.repeat(64))] }))).toBe('')
  })

  it('com todos IGUAIS diz isso em palavras, que é o fato menos esperado', () => {
    const mesmo = 'f'.repeat(64)
    const html = renderToStaticMarkup(createElement(ContagemDeConteudos, { versoes: [versao(mesmo), versao(mesmo)] }))
    expect(html).toContain('mesmo conteúdo')
  })

  it('com conteúdos diferentes diz QUANTOS, e em quantos pacotes', () => {
    const html = renderToStaticMarkup(createElement(ContagemDeConteudos, {
      versoes: [versao('a'.repeat(64)), versao('b'.repeat(64)), versao('a'.repeat(64))],
    }))
    expect(html).toContain('2')
    expect(html).toContain('3')
    expect(html).not.toContain('{n}')
    expect(html).not.toContain('{total}')
  })
})
