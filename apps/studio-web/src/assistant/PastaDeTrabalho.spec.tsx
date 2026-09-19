import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PastaDeTrabalho, enderecoParaBaixar, tamanhoLegivel } from './PastaDeTrabalho'

describe('pasta de trabalho', () => {
  it('o download vai pela rota do FRIGG, com o caminho codificado', () => {
    expect(enderecoParaBaixar('enviados/nota fiscal & cia.pdf')).toBe('/studio/assistant/files/baixar?caminho=enviados%2Fnota%20fiscal%20%26%20cia.pdf')
  })

  it('tamanhos para quem lê', () => {
    expect(tamanhoLegivel(512)).toBe('512 B')
    expect(tamanhoLegivel(2048)).toBe('2 KB')
    expect(tamanhoLegivel(5 * 1024 * 1024 + 300_000)).toBe('5,3 MB')
  })

  it('mostra o envio de qualquer arquivo e explica a pasta', () => {
    const html = renderToStaticMarkup(createElement(PastaDeTrabalho, { buscar: (() => new Promise(() => {})) as never }))
    expect(html).toContain('Pasta de trabalho')
    expect(html).toContain('Enviar arquivo')
    expect(html).toContain('até 50 MB')
    expect(html).not.toContain('accept=')
  })
})
