import { describe, expect, it, vi } from 'vitest'
import {
  CONVERSATION_ENDPOINT,
  ConversationRequestError,
  cancelConversationTurn,
  isConversationEvent,
  openConversation,
  readConversation,
  sendConversationMessage,
  organizeConversation,
  type ConversationPort,
} from './conversationApi'

function port(...responses: readonly Response[]) {
  const calls: Array<{ path: string; method: string; csrf: string | undefined; body: string | undefined }> = []
  const queue = [...responses]
  const value: ConversationPort = {
    fetch: vi.fn(async (input, init) => {
      calls.push({
        path: input,
        method: String(init.method),
        csrf: (init.headers as Record<string, string> | undefined)?.['x-dz23-csrf'],
        body: typeof init.body === 'string' ? init.body : undefined,
      })
      const next = queue.shift()
      if (next === undefined) throw new Error('sem resposta preparada')
      return next
    }),
  }
  return { calls, value }
}

const csrf = async () => 'csrf-1'

describe('cliente da conversa', () => {
  it('abre a conversa com CSRF e exige que o servidor confirme o perfil seguro', async () => {
    const good = port(Response.json({ session_id: 'conversa-1', reused: true, preset: 'dz23-assistant' }))
    await expect(openConversation(good.value, csrf)).resolves.toEqual({
      session_id: 'conversa-1', reused: true, preset: 'dz23-assistant',
    })
    expect(good.calls).toEqual([{ path: CONVERSATION_ENDPOINT, method: 'POST', csrf: 'csrf-1', body: '{}' }])

    for (const wrong of [{ session_id: 'c', preset: 'outro' }, { preset: 'dz23-assistant' }, { session_id: '', preset: 'dz23-assistant' }, []]) {
      const bad = port(Response.json(wrong))
      await expect(openConversation(bad.value, csrf)).rejects.toThrow('perfil seguro')
    }
  })

  it('lê a conversa e descarta evento desconhecido ou quebrado, sem quebrar a tela', async () => {
    const response = port(Response.json({
      conversation_id: 'conversa-1',
      cursor: 3,
      truncated: true,
      events: [
        { type: 'message.user', seq: 1, at: 1, id: 'u1', text: 'oi', truncated: false },
        { type: 'coisa.do.futuro', seq: 2, at: 2 },
        { type: 'message.assistant', seq: 3, at: 3, id: 'a1' },
        { type: 'turn.state', seq: 4, at: 4, state: 'working' },
      ],
    }))
    const snapshot = await readConversation('conversa-1', response.value)
    expect(snapshot.events.map(event => event.seq)).toEqual([1, 4])
    expect(snapshot.truncated).toBe(true)
    expect(response.calls[0]).toMatchObject({ path: `${CONVERSATION_ENDPOINT}/conversa-1/events`, method: 'GET' })
  })

  it('recusa um corpo de leitura fora do contrato em vez de mostrar meia conversa', async () => {
    for (const wrong of [{ cursor: 1, events: [] }, { conversation_id: 'c', events: [] }, { conversation_id: 'c', cursor: 1 }, 'texto']) {
      const bad = port(Response.json(wrong))
      await expect(readConversation('conversa-1', bad.value)).rejects.toThrow('perfil seguro')
    }
  })

  it('separa a falha que vale tentar de novo da que só repete a recusa', async () => {
    const cases: ReadonlyArray<readonly [number, boolean]> = [[401, false], [403, false], [404, false], [400, false], [429, true], [500, true], [503, true]]
    for (const [status, retryable] of cases) {
      const failing = port(Response.json({ error: 'Mensagem do catálogo.' }, { status }))
      const error = await readConversation('conversa-1', failing.value).catch((reason: unknown) => reason)
      expect(error, String(status)).toBeInstanceOf(ConversationRequestError)
      expect((error as ConversationRequestError).status, String(status)).toBe(status)
      expect((error as ConversationRequestError).retryable, String(status)).toBe(retryable)
      expect((error as ConversationRequestError).message).toBe('Mensagem do catálogo.')
    }
    // Corpo sem mensagem não vira "undefined" na tela.
    const opaque = port(new Response('nada', { status: 502 }))
    await expect(readConversation('conversa-1', opaque.value)).rejects.toThrow('Não foi possível')
  })

  it('envia o texto como {text} e devolve o request_id do servidor', async () => {
    const sending = port(Response.json({ accepted: true, request_id: 'req-9' }, { status: 202 }))
    await expect(sendConversationMessage('conversa-1', 'oi', sending.value, csrf)).resolves.toEqual({ request_id: 'req-9' })
    expect(sending.calls[0]).toMatchObject({
      path: `${CONVERSATION_ENDPOINT}/conversa-1/messages`, method: 'POST', csrf: 'csrf-1', body: '{"text":"oi"}',
    })
    const noId = port(Response.json({ accepted: true }, { status: 202 }))
    await expect(sendConversationMessage('conversa-1', 'oi', noId.value, csrf)).rejects.toThrow('perfil seguro')
  })

  it('organiza a conversa por rota própria, e nunca escrevendo "/compact" na conversa', async () => {
    // O botão mandava a string "/compact" por /messages. O servidor não faz
    // parsing de comando: virava texto estranho na conversa e nada era
    // organizado.
    const organizing = port(Response.json({ accepted: true, organized: true, items: 4, tokens: 900 }, { status: 202 }))
    await expect(organizeConversation('conversa-1', organizing.value, csrf)).resolves.toEqual({ organized: true })
    expect(organizing.calls[0]).toMatchObject({
      path: `${CONVERSATION_ENDPOINT}/conversa-1/compact`, method: 'POST', csrf: 'csrf-1',
    })
    expect(organizing.calls[0]?.body ?? '').not.toContain('/compact"')

    // "Não havia o que organizar" não é erro, e a tela precisa distinguir.
    const empty = port(Response.json({ accepted: true, organized: false }, { status: 202 }))
    await expect(organizeConversation('conversa-1', empty.value, csrf)).resolves.toEqual({ organized: false })

    // Resposta que não confirma nada não vira "organizei".
    const vague = port(Response.json({ accepted: true }, { status: 202 }))
    await expect(organizeConversation('conversa-1', vague.value, csrf)).rejects.toThrow('perfil seguro')
  })

  it('cancela com CSRF e propaga a recusa do servidor', async () => {
    const cancelling = port(Response.json({ accepted: true }, { status: 202 }))
    await expect(cancelConversationTurn('conversa-1', cancelling.value, csrf)).resolves.toBeUndefined()
    expect(cancelling.calls[0]).toMatchObject({ path: `${CONVERSATION_ENDPOINT}/conversa-1/cancel`, csrf: 'csrf-1' })
    const denied = port(Response.json({ error: 'Esta conversa já pertence a outra sessão.' }, { status: 404 }))
    await expect(cancelConversationTurn('conversa-1', denied.value, csrf)).rejects.toThrow('outra sessão')
  })

  it('escapa o identificador em vez de montar caminho com o que veio de fora', async () => {
    const hostile = port(Response.json({ conversation_id: 'x', cursor: 0, events: [], truncated: false }))
    await readConversation('../../etc/passwd', hostile.value)
    expect(hostile.calls[0]?.path).toBe(`${CONVERSATION_ENDPOINT}/..%2F..%2Fetc%2Fpasswd/events`)
  })

  it('valida cada forma de evento pública', () => {
    expect(isConversationEvent({ type: 'turn.state', seq: 1, at: 1, state: 'idle' })).toBe(true)
    expect(isConversationEvent({ type: 'turn.state', seq: 1, at: 1, state: 'pensando' })).toBe(false)
    expect(isConversationEvent({ type: 'tool.state', seq: 1, at: 1, call_id: 'c', label: 'l', state: 'running' })).toBe(true)
    expect(isConversationEvent({ type: 'tool.state', seq: 1, at: 1, call_id: 'c', label: 'l', state: 'x' })).toBe(false)
    expect(isConversationEvent({ type: 'approval.requested', seq: 1, at: 1, request_id: 'r', tool_label: 't', explanation: 'e' })).toBe(true)
    expect(isConversationEvent({ type: 'approval.requested', seq: 1, at: 1, request_id: 'r', tool_label: 't' })).toBe(false)
    expect(isConversationEvent({ type: 'approval.resolved', seq: 1, at: 1, request_id: 'r', outcome: 'rejected' })).toBe(true)
    expect(isConversationEvent({ type: 'approval.resolved', seq: 1, at: 1, request_id: 'r', outcome: 'talvez' })).toBe(false)
    expect(isConversationEvent({ type: 'message.assistant', seq: 1, at: 1, id: 'a', text: 't', interrupted: true, truncated: false })).toBe(true)
    expect(isConversationEvent({ type: 'message.user', seq: '1', at: 1, id: 'u', text: 't' })).toBe(false)
    expect(isConversationEvent(null)).toBe(false)
    expect(isConversationEvent(['message.user'])).toBe(false)
  })
})
