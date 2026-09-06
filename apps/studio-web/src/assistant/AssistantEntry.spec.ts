import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AssistantEntry, HARNESS_CHAT_PATH } from './AssistantEntry'

describe('AssistantEntry', () => {
  it('opens the supported Harness chat without claiming automatic session creation', () => {
    const html = renderToStaticMarkup(createElement(AssistantEntry))
    expect(HARNESS_CHAT_PATH).toBe('/')
    expect(html).toContain('href="/"')
    expect(html).toContain('Criar automaticamente uma sessão separada por este botão ainda não existe')
    expect(html).not.toContain('aplicação pronta')
  })
})
