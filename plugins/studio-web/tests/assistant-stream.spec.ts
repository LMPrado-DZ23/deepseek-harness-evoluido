import { describe, expect, it, vi } from 'vitest'
import {
  ASSISTANT_STREAM_HEADERS,
  streamAssistantConversation,
  type AssistantStreamSink,
} from '../src/assistant-stream.js'
import type { AssistantConversationSnapshot } from '../src/assistant-conversation.js'

/** Um destino que guarda o que foi escrito, para o teste ler o protocolo. */
function sink() {
  const chunks: string[] = []
  let ended = false
  const target: AssistantStreamSink = { write: chunk => { chunks.push(chunk) }, end: () => { ended = true } }
  return {
    target,
    get text() { return chunks.join('') },
    get ended() { return ended },
    events() {
      return chunks.filter(chunk => chunk.startsWith('event: ')).map(chunk => {
        const name = /^event: (?<name>[^\n]+)/u.exec(chunk)!.groups!.name!
        const data = chunk.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')
        return { name, payload: JSON.parse(data) as Record<string, unknown> }
      })
    },
  }
}

const snapshot = (seqs: readonly number[]): AssistantConversationSnapshot => ({
  conversation_id: 'c1', cursor: seqs.length, truncated: false,
  events: seqs.map(seq => ({ type: 'message.assistant', seq, at: seq, id: `m${String(seq)}`, text: `t${String(seq)}`, interrupted: false, truncated: false })),
})

/** Relógio e sono controlados: o teste não pode depender do relógio de parede. */
function clock() {
  let value = 0
  return {
    now: () => value,
    sleep: async (ms: number) => { value += ms },
    advance: (ms: number) => { value += ms },
  }
}

describe('a conexão que acompanha a conversa', () => {
  it('manda o retrato inteiro primeiro e depois SÓ o que é novo', async () => {
    // O primeiro envio precisa ser tudo: quem acabou de abrir a tela tem de ver
    // o que já existe, e não esperar a próxima mudança para a conversa aparecer.
    // Depois disso, reenviar tudo a cada mudança desfaria o ganho inteiro.
    const time = clock()
    const controller = new AbortController()
    const reads = [snapshot([1, 2]), snapshot([1, 2, 3]), snapshot([1, 2, 3])]
    let call = 0
    const out = sink()
    const read = vi.fn(async () => {
      const value = reads[Math.min(call, reads.length - 1)]!
      call += 1
      if (call >= 3) controller.abort()
      return value
    })
    await streamAssistantConversation({ read, sink: out.target, signal: controller.signal, intervalMs: 10, now: time.now, sleep: time.sleep })

    const events = out.events()
    expect(events.map(item => item.name)).toEqual(['snapshot', 'snapshot'])
    expect((events[0]!.payload.events as { seq: number }[]).map(item => item.seq)).toEqual([1, 2])
    // A segunda leitura trouxe 1, 2 e 3 — e só o 3 viajou.
    expect((events[1]!.payload.events as { seq: number }[]).map(item => item.seq)).toEqual([3])
    expect(out.ended).toBe(true)
  })

  it('uma conversa parada não gasta evento nenhum, só o batimento', async () => {
    // Este era metade do defeito: uma conversa em silêncio custava uma
    // requisição a cada 1,5 s, por aba, para sempre. O preço de não estar
    // acontecendo nada era o mesmo de estar acontecendo tudo.
    const time = clock()
    const controller = new AbortController()
    let call = 0
    const out = sink()
    await streamAssistantConversation({
      read: async () => { call += 1; if (call > 200) controller.abort(); return snapshot([1]) },
      sink: out.target, signal: controller.signal, intervalMs: 250, now: time.now, sleep: time.sleep,
    })
    const events = out.events()
    // Um único `snapshot`: o inicial. Nada mais mudou.
    expect(events).toHaveLength(1)
    // E o batimento existe, senão um intermediário mata a conexão parada.
    expect(out.text).toContain(': .\n\n')
  })

  it('encerra por tempo em vez de viver para sempre', async () => {
    // Uma conexão eterna guarda uma leitura em laço para uma aba esquecida
    // aberta há dias, e seria cortada POR FORA, na hora errada e sem aviso.
    // Cortando por dentro o fim é limpo e o navegador reconecta sozinho.
    const time = clock()
    const out = sink()
    const outcome = await streamAssistantConversation({
      read: async () => snapshot([1]), sink: out.target, signal: new AbortController().signal,
      intervalMs: 100, maxMs: 1_000, now: time.now, sleep: time.sleep,
    })
    expect(outcome).toBe('expired')
    expect(out.ended).toBe(true)
  })

  it('um soluço de leitura não derruba a conexão; falhas seguidas derrubam', async () => {
    // Uma falha isolada virando erro na tela faria a conversa piscar vermelho
    // por causa de um tropeço. Já uma conexão viva que não entrega nada é PIOR
    // que uma fechada — a fechada pelo menos faz o navegador reconectar.
    const time = clock()
    const controller = new AbortController()
    let call = 0
    const out = sink()
    const outcome = await streamAssistantConversation({
      read: async () => {
        call += 1
        if (call === 2) throw new Error('soluço')
        if (call > 4) controller.abort()
        return snapshot([1, call])
      },
      sink: out.target, signal: controller.signal, intervalMs: 10, now: time.now, sleep: time.sleep,
    })
    expect(outcome).toBe('closed')
    expect(out.events().some(item => item.name === 'unavailable')).toBe(false)

    const second = sink()
    const failing = await streamAssistantConversation({
      read: async () => { throw new Error('caiu') },
      sink: second.target, signal: new AbortController().signal, intervalMs: 10, now: time.now, sleep: time.sleep,
    })
    expect(failing).toBe('unavailable')
    expect(second.events().at(-1)?.name).toBe('unavailable')
    expect(second.ended).toBe(true)
  })

  it('quebra de linha dentro do texto não parte o evento ao meio', async () => {
    // Um `\n` cru num campo `data:` encerra o evento, e o navegador leria
    // metade de um objeto. Toda linha do JSON vira sua própria linha `data:`.
    const time = clock()
    const controller = new AbortController()
    const out = sink()
    const withNewline: AssistantConversationSnapshot = {
      conversation_id: 'c1', cursor: 1, truncated: false,
      events: [{ type: 'message.user', seq: 1, at: 1, id: 'm1', text: 'linha um\nlinha dois', truncated: false }],
    }
    await streamAssistantConversation({
      read: async () => { controller.abort(); return withNewline },
      sink: out.target, signal: controller.signal, intervalMs: 10, now: time.now, sleep: time.sleep,
    })
    const payload = out.events()[0]!.payload.events as { text: string }[]
    expect(payload[0]!.text).toBe('linha um\nlinha dois')
  })

  it('os cabeçalhos impedem cache e buffer no caminho', () => {
    // Um proxy que armazena em buffer segura os eventos e devolve exatamente o
    // atraso que esta conexão existe para tirar.
    expect(ASSISTANT_STREAM_HEADERS['content-type']).toContain('text/event-stream')
    expect(ASSISTANT_STREAM_HEADERS['cache-control']).toContain('no-store')
    expect(ASSISTANT_STREAM_HEADERS['cache-control']).toContain('no-transform')
    expect(ASSISTANT_STREAM_HEADERS['x-accel-buffering']).toBe('no')
  })
})
