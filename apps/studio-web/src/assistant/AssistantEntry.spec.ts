import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AssistantEntry } from './AssistantEntry'

describe('AssistantEntry', () => {
  it('offers the governed Harness chat without claiming that work is already complete', () => {
    const html = renderToStaticMarkup(createElement(AssistantEntry))
    expect(html).toContain('<button')
    expect(html).toContain('Abrir conversa segura')
    expect(html).toContain('cria ou retoma uma conversa separada neste dispositivo')
    expect(html).not.toContain('aplicação pronta')
  })
})
