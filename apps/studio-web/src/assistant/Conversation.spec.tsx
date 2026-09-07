import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Conversation, conversationReducer } from './Conversation'
import { emptyConversation } from './conversationState'

const port = { fetch: async () => Response.json({ conversation_id: 'c1', cursor: 0, events: [], truncated: false }) }

describe('tela da conversa', () => {
  it('abre acessível, com registro anunciável, rótulo de campo e estado vazio explicado', () => {
    const html = renderToStaticMarkup(createElement(Conversation, { conversationId: 'c1', port }))
    expect(html).toContain('role="log"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('role="status"')
    expect(html).toContain('for="conversation-draft"')
    expect(html).toContain('id="conversation-draft"')
    expect(html).toContain('Ainda não há mensagens')
    expect(html).toContain('Escreva abaixo o que você precisa')
    // Sem mensagem, enviar fica desabilitado - nada de botão que não faz nada.
    expect(html).toContain('disabled=""')
    // Sem turno ativo não existe botão Parar mentindo que há algo para parar.
    expect(html).not.toContain('Parar')
    // Nada de porcentagem inventada em lugar nenhum desta tela.
    expect(html).not.toMatch(/\d+%/u)
  })

  it('o reducer é a única porta de entrada do estado e respeita cada ação', () => {
    const opened = conversationReducer(emptyConversation(), { kind: 'opened', conversationId: 'c1' })
    expect(opened.conversationId).toBe('c1')
    const typed = conversationReducer(opened, { kind: 'draft', draft: 'oi' })
    expect(typed.draft).toBe('oi')
    const queued = conversationReducer(typed, { kind: 'queued', requestId: 'r1', text: 'oi' })
    expect(queued.queued).toHaveLength(1)
    expect(queued.draft).toBe('')
    const dropped = conversationReducer(queued, { kind: 'dropped', requestId: 'r1' })
    expect(dropped.queued).toEqual([])
    const merged = conversationReducer(dropped, {
      kind: 'snapshot',
      snapshot: {
        conversation_id: 'c1', cursor: 1, truncated: false,
        events: [{ type: 'message.user', seq: 1, at: 1, id: 'u1', text: 'oi', truncated: false }],
      },
    })
    expect(merged.events).toHaveLength(1)
  })
})
