import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ConversationItem } from './Conversation'
import { isConversationEvent } from './conversationApi'
import { applySnapshot, conversationStatus, emptyConversation, openedConversation } from './conversationState'

const falhou = { type: 'turn.failed', seq: 3, at: 3, reason: 'O FRIGG não conseguiu responder (AUTH): sem chave' } as const

describe('o turno que termina em erro (19/09/2026)', () => {
  it('é um evento válido e aparece na conversa como alerta', () => {
    expect(isConversationEvent(falhou)).toBe(true)
    expect(isConversationEvent({ ...falhou, reason: 1 })).toBe(false)
    const html = renderToStaticMarkup(createElement(ConversationItem, { event: falhou }))
    expect(html).toContain('role="alert"')
    expect(html).toContain('sem chave')
  })

  it('devolve a tela ao estado parado, para a pessoa poder escrever de novo', () => {
    const estado = applySnapshot(openedConversation(emptyConversation(), 'c1'), {
      conversation_id: 'c1', cursor: 3, truncated: false,
      events: [{ type: 'turn.state', seq: 1, at: 1, state: 'working' }, falhou],
    })
    expect(conversationStatus(estado)).toBe('idle')
  })
})
