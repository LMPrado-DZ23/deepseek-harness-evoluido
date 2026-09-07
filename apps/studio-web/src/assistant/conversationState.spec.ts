import { describe, expect, it } from 'vitest'
import type { ConversationEvent, ConversationSnapshot } from './conversationApi'
import {
  applySnapshot,
  conversationStatus,
  dropQueuedMessage,
  emptyConversation,
  openedConversation,
  queueMessage,
  setDraft,
} from './conversationState'

function snapshot(events: readonly ConversationEvent[], overrides: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  return {
    conversation_id: 'conversa-1',
    cursor: events.at(-1)?.seq ?? 0,
    truncated: false,
    events,
    ...overrides,
  }
}

const user = (seq: number, text: string): ConversationEvent => ({ type: 'message.user', seq, at: seq, id: `u${String(seq)}`, text, truncated: false })
const assistant = (seq: number, text: string): ConversationEvent => ({ type: 'message.assistant', seq, at: seq, id: `a${String(seq)}`, text, interrupted: false, truncated: false })
const turn = (seq: number, state: 'working' | 'idle'): ConversationEvent => ({ type: 'turn.state', seq, at: seq, state })

describe('estado da conversa', () => {
  it('funde o snapshot sem duplicar, sem reordenar e sem andar para trás', () => {
    const opened = openedConversation(emptyConversation(), 'conversa-1')
    const first = applySnapshot(opened, snapshot([user(1, 'oi'), assistant(2, 'olá')]))
    expect(first.events.map(event => event.seq)).toEqual([1, 2])
    expect(first.cursor).toBe(2)

    // O mesmo snapshot de novo não muda nada.
    expect(applySnapshot(first, snapshot([user(1, 'oi'), assistant(2, 'olá')])).events).toEqual(first.events)

    // Fora de ordem e com repetido: a ordem final continua por seq, sem duplicar.
    const merged = applySnapshot(first, snapshot([assistant(4, 'pronto'), user(3, 'e agora'), user(1, 'oi')]))
    expect(merged.events.map(event => event.seq)).toEqual([1, 2, 3, 4])

    // Snapshot atrasado não remove evento nem regride o cursor.
    const stale = applySnapshot(merged, snapshot([user(1, 'oi')], { cursor: 1 }))
    expect(stale.events.map(event => event.seq)).toEqual([1, 2, 3, 4])
    expect(stale.cursor).toBe(4)
  })

  it('ignora snapshot de outra conversa', () => {
    const opened = openedConversation(emptyConversation(), 'conversa-1')
    const other = applySnapshot(opened, snapshot([user(1, 'de outra pessoa')], { conversation_id: 'conversa-2' }))
    expect(other.events).toEqual([])
  })

  it('mantém "cortado" depois de visto uma vez', () => {
    const opened = openedConversation(emptyConversation(), 'conversa-1')
    const cut = applySnapshot(opened, snapshot([user(9, 'oi')], { truncated: true }))
    expect(cut.truncated).toBe(true)
    expect(applySnapshot(cut, snapshot([user(9, 'oi')], { truncated: false })).truncated).toBe(true)
  })

  it('guarda a mensagem enviada durante o turno e a solta quando ela aparece no journal', () => {
    const opened = openedConversation(emptyConversation(), 'conversa-1')
    const working = applySnapshot(opened, snapshot([turn(1, 'working')]))
    expect(conversationStatus(working)).toBe('working')

    const typed = setDraft(working, 'faça isso')
    const sent = queueMessage(typed, 'req-1', 'faça isso')
    expect(sent.draft).toBe('')
    expect(sent.queued).toEqual([{ request_id: 'req-1', text: 'faça isso' }])
    expect(conversationStatus(sent)).toBe('queued')

    // Enviar o mesmo request_id duas vezes não cria duas cópias.
    expect(queueMessage(sent, 'req-1', 'faça isso').queued).toHaveLength(1)

    const delivered = applySnapshot(sent, snapshot([turn(1, 'working'), user(2, 'faça isso'), turn(3, 'idle')]))
    expect(delivered.queued).toEqual([])
    expect(conversationStatus(delivered)).toBe('idle')
  })

  it('o rascunho sobrevive a snapshot, a rerender e à troca de conversa', () => {
    const typed = setDraft(openedConversation(emptyConversation(), 'conversa-1'), 'texto não enviado')
    expect(applySnapshot(typed, snapshot([user(1, 'oi')])).draft).toBe('texto não enviado')
    expect(setDraft(typed, 'texto não enviado')).toBe(typed)
    expect(openedConversation(typed, 'conversa-2').draft).toBe('texto não enviado')
    expect(openedConversation(typed, 'conversa-2').events).toEqual([])
    expect(openedConversation(typed, 'conversa-1')).toBe(typed)
  })

  it('solta o envio recusado em vez de deixá-lo esperando para sempre', () => {
    const sent = queueMessage(openedConversation(emptyConversation(), 'conversa-1'), 'req-1', 'oi')
    expect(dropQueuedMessage(sent, 'req-1').queued).toEqual([])
    const untouched = dropQueuedMessage(sent, 'req-desconhecido')
    expect(untouched).toBe(sent)
  })

  it('o turno vem do journal, não de um palpite da tela', () => {
    const opened = openedConversation(emptyConversation(), 'conversa-1')
    expect(conversationStatus(opened)).toBe('idle')
    const busy = applySnapshot(opened, snapshot([turn(1, 'working')]))
    const stillBusy = applySnapshot(busy, snapshot([turn(1, 'working'), assistant(2, 'pensando')]))
    expect(conversationStatus(stillBusy)).toBe('working')
    expect(conversationStatus(applySnapshot(stillBusy, snapshot([turn(3, 'idle')])))).toBe('idle')
  })
})
