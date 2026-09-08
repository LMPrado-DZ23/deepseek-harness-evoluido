import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { Conversation, CompactionBand, ConversationItem, conversationReducer } from './Conversation'
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

  it('12. a faixa de compactação é anunciável, indeterminada e sem porcentagem', () => {
    const running = renderToStaticMarkup(createElement(CompactionBand, {
      view: { compactionId: 'c1', phase: 'summarizing' },
    }))
    expect(running).toContain('role="status"')
    expect(running).toContain('aria-live="polite"')
    expect(running).toContain('role="progressbar"')
    expect(running).toContain('aria-label=')
    // Barra indeterminada NÃO pode declarar valor: não há unidade real por trás.
    expect(running).not.toContain('aria-valuenow')
    expect(running).not.toMatch(/\d+%/u)
    expect(running).toContain('Organizando nossa conversa')
    expect(running).toContain('Resumindo mensagens antigas')

    const reconciling = renderToStaticMarkup(createElement(CompactionBand, {
      view: { compactionId: 'c1', phase: 'reconciling' },
    }))
    expect(reconciling).toContain('Nada foi perdido')
    expect(reconciling).not.toContain('Conversa organizada')

    const failed = renderToStaticMarkup(createElement(CompactionBand, {
      view: { compactionId: 'c1', phase: 'failed' },
    }))
    expect(failed).toContain('Não foi possível organizar a conversa. Nada foi perdido.')
    expect(failed).not.toContain('progressbar')

    // Concluída: marcador com as contagens verdadeiras, sem barra e sem porcentagem.
    const done = renderToStaticMarkup(createElement(CompactionBand, {
      view: { compactionId: 'c1', phase: 'completed', items: 6, tokens: 12345 },
    }))
    expect(done).toContain('Conversa organizada')
    expect(done).toContain('6 itens')
    expect(done).toContain('12345 tokens aproximados')
    expect(done).not.toContain('progressbar')
    expect(done).not.toMatch(/\d+%/u)

    // Sem contagem informada, o marcador não inventa número nenhum.
    const silent = renderToStaticMarkup(createElement(CompactionBand, {
      view: { compactionId: 'c1', phase: 'completed' },
    }))
    expect(silent).toContain('Conversa organizada')
    expect(silent).not.toContain('itens')

    // Movimento reduzido é respeitado pela folha de estilo real do produto.
    const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
    expect(styles).toContain('prefers-reduced-motion')
    expect(styles).toContain('.compaction-bar::after{animation:none')
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

describe('M91: o resumo que substituiu o histórico', () => {
  const checkpoint = {
    type: 'compaction.checkpoint' as const, seq: 9, at: 9,
    id: 'chk-1', text: 'Resumo do que foi conversado até aqui.', truncated: false,
  }

  it('aparece no registro, identificado como resumo e não como fala da pessoa', () => {
    // Antes ele nem chegava ao navegador: a projeção do servidor descartava a
    // mensagem do plugin, e a pessoa via o histórico encolher sem ver o que
    // ficou no lugar.
    const html = renderToStaticMarkup(createElement(ConversationItem, { event: checkpoint }))
    expect(html).toContain('Resumo do histórico organizado')
    expect(html).toContain('Resumo do que foi conversado até aqui.')
    expect(html).toContain('Nada foi apagado do registro da sessão')
    // Não pode ser atribuído a quem não escreveu.
    expect(html).not.toContain('Você')
  })

  it('vem fechado, para não roubar a leitura da conversa', () => {
    const html = renderToStaticMarkup(createElement(ConversationItem, { event: checkpoint }))
    expect(html).toContain('<details')
    expect(html).not.toContain('<details open')
  })

  it('isola a direção do texto do resumo', () => {
    expect(renderToStaticMarkup(createElement(ConversationItem, { event: checkpoint }))).toContain('dir="auto"')
  })
})
