import { describe, expect, it, vi } from 'vitest'
import { conversationStreamUrl, openConversationStream, parseStreamSnapshot, streamingAvailable, type EventSourceLike } from './conversationStream'

/** Um `EventSource` de mentira, para o teste não precisar de rede nem navegador. */
function fakeSource() {
  const listeners = new Map<string, ((event: { readonly data?: string }) => void)[]>()
  let closed = false
  const source: EventSourceLike = {
    addEventListener: (type, listener) => { listeners.set(type, [...(listeners.get(type) ?? []), listener]) },
    close: () => { closed = true },
  }
  return {
    source,
    get closed() { return closed },
    emit(type: string, data?: string) { for (const listener of listeners.get(type) ?? []) listener({ ...(data === undefined ? {} : { data }) }) },
  }
}

describe('o fluxo da conversa no navegador', () => {
  it('entrega o pedaço novo sem esperar a próxima volta do relógio', () => {
    const fake = fakeSource()
    const onSnapshot = vi.fn()
    openConversationStream('c1', { onSnapshot, onFallback: vi.fn(), create: () => fake.source })
    fake.emit('snapshot', JSON.stringify({ conversation_id: 'c1', cursor: 3, truncated: false, events: [{ type: 'turn.state', seq: 3, at: 3, state: 'idle' }] }))
    expect(onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ conversation_id: 'c1', cursor: 3 }))
  })

  it('um evento estranho é DESCARTADO em vez de derrubar a conversa', () => {
    // Um corpo malformado no meio de mil bons não pode apagar a conversa de
    // quem está lendo.
    const fake = fakeSource()
    const onSnapshot = vi.fn(); const onFallback = vi.fn()
    openConversationStream('c1', { onSnapshot, onFallback, create: () => fake.source })
    fake.emit('snapshot', 'isto não é JSON')
    fake.emit('snapshot', JSON.stringify({ nada: 'a ver' }))
    expect(onSnapshot).not.toHaveBeenCalled()
    expect(onFallback).not.toHaveBeenCalled()
  })

  it('erro de conexão chama a QUEDA, e a queda é a leitura periódica', () => {
    // Cair não pode virar tela parada. A conversa continua, mais devagar.
    const fake = fakeSource()
    const onFallback = vi.fn()
    openConversationStream('c1', { onSnapshot: vi.fn(), onFallback, create: () => fake.source })
    fake.emit('error')
    expect(onFallback).toHaveBeenCalledOnce()
    expect(fake.closed).toBe(true)
  })

  it('o aviso do servidor de que desistiu de ler também chama a queda', () => {
    // Uma conexão viva que não entrega nada é PIOR que uma fechada: a fechada
    // pelo menos faz o navegador tentar de novo.
    const fake = fakeSource()
    const onFallback = vi.fn()
    openConversationStream('c1', { onSnapshot: vi.fn(), onFallback, create: () => fake.source })
    fake.emit('unavailable')
    expect(onFallback).toHaveBeenCalledOnce()
    expect(fake.closed).toBe(true)
  })

  it('quando nem dá para abrir a conexão, cai na hora em vez de ficar mudo', () => {
    const onFallback = vi.fn()
    openConversationStream('c1', { onSnapshot: vi.fn(), onFallback, create: () => { throw new Error('sem EventSource') } })
    expect(onFallback).toHaveBeenCalledOnce()
  })

  it('só descreve o fluxo como disponível quando ele existe de verdade', () => {
    expect(streamingAvailable(() => fakeSource().source)).toBe(true)
    // Em `environment: node` não há `EventSource`: é exatamente o navegador
    // antigo que a queda existe para atender.
    expect(streamingAvailable()).toBe(typeof EventSource !== 'undefined')
  })

  it('o endereço escapa o identificador da conversa', () => {
    expect(conversationStreamUrl('a/b')).toContain('a%2Fb')
    expect(conversationStreamUrl('c1')).toMatch(/\/c1\/events\/stream$/u)
  })

  it('descarta evento que não passa na conferência de forma', () => {
    const parsed = parseStreamSnapshot(JSON.stringify({
      conversation_id: 'c1', cursor: 1, truncated: false,
      events: [{ type: 'message.user', seq: 1, at: 1, id: 'm1', text: 'oi' }, { type: 'inventado', seq: 2, at: 2 }],
    }))
    expect(parsed?.events).toHaveLength(1)
  })
})
