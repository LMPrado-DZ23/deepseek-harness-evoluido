import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ConversationItem } from './Conversation'
import { isConversationEvent } from './conversationApi'

describe('lista de tarefas e plano na conversa', () => {
  const lista = { type: 'todo.state', seq: 1, at: 1, items: [{ content: 'Pesquisar', status: 'completed' }, { content: 'Escrever', status: 'in_progress' }] } as const
  const plano = { type: 'plan.proposed', seq: 2, at: 2, text: '# Meu plano\n1. Pesquisar' } as const

  it('são eventos válidos; malformados não', () => {
    expect(isConversationEvent(lista)).toBe(true)
    expect(isConversationEvent(plano)).toBe(true)
    expect(isConversationEvent({ ...lista, items: [{ content: 'x', status: 'talvez' }] })).toBe(false)
  })

  it('a lista mostra o que foi feito e o que está sendo feito', () => {
    const html = renderToStaticMarkup(createElement(ConversationItem, { event: lista }))
    expect(html).toContain('Lista de tarefas')
    expect(html).toContain('todo-completed')
    expect(html).toContain('(fazendo agora)')
  })

  it('o plano aparece como markdown', () => {
    const html = renderToStaticMarkup(createElement(ConversationItem, { event: plano }))
    expect(html).toContain('Plano proposto')
    expect(html).toContain('Meu plano')
  })
})
