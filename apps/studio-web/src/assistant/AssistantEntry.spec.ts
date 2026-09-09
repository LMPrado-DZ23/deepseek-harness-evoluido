import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AssistantEntry, type AssistantEntryProps } from './AssistantEntry'

describe('AssistantEntry', () => {
  it('offers the governed Harness chat without claiming that work is already complete', () => {
    const html = renderToStaticMarkup(createElement(AssistantEntry))
    expect(html).toContain('<button')
    expect(html).toContain('Abrir conversa segura')
    expect(html).toContain('cria ou retoma uma conversa separada neste dispositivo')
    expect(html).not.toContain('aplicação pronta')
  })

  it('quando veio um pedido de outra tela, a tela AVISA antes de abrir a conversa', () => {
    // Um campo que aparece já preenchido sem explicação parece coisa que
    // alguém escreveu no lugar da pessoa.
    const html = renderToStaticMarkup(createElement<AssistantEntryProps>(AssistantEntry, { search: '?pedido=quero%20uma%20equipe' }))
    expect(html).toContain('Trouxemos um pedido já escrito')
  })

  it('sem pedido no endereço, nada de aviso', () => {
    expect(renderToStaticMarkup(createElement<AssistantEntryProps>(AssistantEntry, { search: '' }))).not.toContain('Trouxemos um pedido')
  })
})
