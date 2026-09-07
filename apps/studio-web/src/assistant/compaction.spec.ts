import { describe, expect, it } from 'vitest'
import type { ConversationEvent, ConversationSnapshot } from './conversationApi'
import { isConversationEvent } from './conversationApi'
import {
  applySnapshot,
  compactionView,
  emptyConversation,
  isCompacting,
  openedConversation,
  queueMessage,
  setDraft,
} from './conversationState'

function withEvents(events: readonly ConversationEvent[]) {
  const snapshot: ConversationSnapshot = {
    conversation_id: 'conversa-1',
    cursor: events.at(-1)?.seq ?? 0,
    truncated: false,
    events,
  }
  return applySnapshot(openedConversation(emptyConversation(), 'conversa-1'), snapshot)
}

const start = (seq: number, id = 'comp-1'): ConversationEvent => ({ type: 'compaction.state', seq, at: seq, compaction_id: id, state: 'summarizing' })
const summary = (seq: number, id = 'comp-1'): ConversationEvent => ({ type: 'compaction.state', seq, at: seq, compaction_id: id, state: 'committing', items: 6, tokens: 12_345 })
const end = (seq: number, id = 'comp-1'): ConversationEvent => ({ type: 'compaction.state', seq, at: seq, compaction_id: id, state: 'completed' })
const failed = (seq: number, id = 'comp-1'): ConversationEvent => ({ type: 'compaction.state', seq, at: seq, compaction_id: id, state: 'failed' })
const message = (seq: number, text = 'oi'): ConversationEvent => ({ type: 'message.user', seq, at: seq, id: `u${String(seq)}`, text, truncated: false })

describe('compactação — projeção honesta no cliente', () => {
  it('1. start → summary → end termina no marcador com contagens verdadeiras', () => {
    expect(compactionView(withEvents([start(1)]))?.phase).toBe('summarizing')
    const committing = compactionView(withEvents([start(1), summary(2)]))
    expect(committing).toMatchObject({ phase: 'committing', items: 6, tokens: 12_345 })
    const done = compactionView(withEvents([start(1), summary(2), end(3)]))
    expect(done).toEqual({ compactionId: 'comp-1', phase: 'completed', items: 6, tokens: 12_345 })
    expect(isCompacting(done)).toBe(false)
  })

  it('2. start → end(error) mostra falha e não afirma conclusão', () => {
    const view = compactionView(withEvents([start(1), failed(2)]))
    expect(view?.phase).toBe('failed')
    expect(isCompacting(view)).toBe(false)
  })

  it('3. reconexão no meio restaura a faixa em andamento', () => {
    const reconnected = withEvents([start(1)])
    expect(isCompacting(compactionView(reconnected))).toBe(true)
    expect(compactionView(reconnected)?.phase).toBe('summarizing')
  })

  it('4. queda depois do summary e antes do end vira RECONCILING, nunca "concluído"', () => {
    const view = compactionView(withEvents([start(1), summary(2), message(3)]))
    expect(view?.phase).toBe('reconciling')
    expect(isCompacting(view)).toBe(true)
    expect(view?.phase).not.toBe('completed')
  })

  it('5. evento duplicado, atrasado e fora de ordem é idempotente e monotônico', () => {
    const ordered = withEvents([start(1), summary(2), end(3)])
    const noisy = withEvents([end(3), summary(2), start(1), start(1), summary(2), end(3)])
    expect(compactionView(noisy)).toEqual(compactionView(ordered))
    const late = applySnapshot(ordered, {
      conversation_id: 'conversa-1', cursor: 3, truncated: false, events: [start(1)],
    })
    expect(compactionView(late)?.phase).toBe('completed')
  })

  it('6. mensagem enviada durante a compactação é preservada e aplicada uma única vez', () => {
    const organizing = withEvents([start(1)])
    const sent = queueMessage(setDraft(organizing, 'não me perca'), 'req-1', 'não me perca')
    expect(sent.draft).toBe('')
    expect(sent.queued).toEqual([{ request_id: 'req-1', text: 'não me perca' }])
    expect(queueMessage(sent, 'req-1', 'não me perca').queued).toHaveLength(1)
    const delivered = applySnapshot(sent, {
      conversation_id: 'conversa-1', cursor: 4, truncated: false,
      events: [start(1), summary(2), end(3), message(4, 'não me perca')],
    })
    expect(delivered.queued).toEqual([])
    expect(delivered.events.filter(event => event.type === 'message.user')).toHaveLength(1)
  })

  it('7. texto digitado e não enviado sobrevive à compactação inteira', () => {
    const typing = setDraft(withEvents([start(1)]), 'rascunho vivo')
    const after = applySnapshot(typing, {
      conversation_id: 'conversa-1', cursor: 3, truncated: false, events: [start(1), summary(2), end(3)],
    })
    expect(after.draft).toBe('rascunho vivo')
  })

  it('8. evento de outra conversa não aparece nem altera a faixa', () => {
    const mine = withEvents([start(1)])
    const foreign = applySnapshot(mine, {
      conversation_id: 'conversa-de-outro-tenant', cursor: 9, truncated: false, events: [end(9, 'comp-alheia')],
    })
    expect(compactionView(foreign)?.phase).toBe('summarizing')
    expect(foreign.events).toEqual(mine.events)
  })

  it('9. o contrato público não aceita campo interno nem contagem impossível', () => {
    expect(isConversationEvent({ type: 'compaction.state', seq: 1, at: 1, compaction_id: 'c', state: 'summarizing' })).toBe(true)
    expect(isConversationEvent({ type: 'compaction.state', seq: 1, at: 1, compaction_id: '', state: 'summarizing' })).toBe(false)
    expect(isConversationEvent({ type: 'compaction.state', seq: 1, at: 1, compaction_id: 'c', state: 'pensando' })).toBe(false)
    expect(isConversationEvent({ type: 'compaction.state', seq: 1, at: 1, compaction_id: 'c', state: 'committing', items: -1 })).toBe(false)
    expect(isConversationEvent({ type: 'compaction.state', seq: 1, at: 1, compaction_id: 'c', state: 'committing', tokens: 1.5 })).toBe(false)
    expect(isConversationEvent({ type: 'compaction.state', seq: 1, at: 1, compaction_id: 'c', state: 'committing', items: 0, tokens: 0 })).toBe(true)
  })

  it('10. não existe porcentagem: nenhum estado projetado carrega fração de progresso', () => {
    for (const state of [withEvents([start(1)]), withEvents([start(1), summary(2)]), withEvents([start(1), summary(2), end(3)])]) {
      const view = compactionView(state)
      expect(Object.keys(view ?? {})).not.toContain('percent')
      expect(JSON.stringify(view)).not.toMatch(/percent|progress|ratio|completed_units|total_units/u)
    }
    expect(compactionView(withEvents([start(1), summary(2)]))).toMatchObject({ items: 6, tokens: 12_345 })
  })

  it('11. compactação automática e manual usam a mesma máquina e o mesmo journal', () => {
    const automatic = compactionView(withEvents([start(1, 'auto-1'), summary(2, 'auto-1'), end(3, 'auto-1')]))
    const manual = compactionView(withEvents([start(1, 'manual-1'), summary(2, 'manual-1'), end(3, 'manual-1')]))
    expect({ ...automatic, compactionId: 'x' }).toEqual({ ...manual, compactionId: 'x' })
  })

  it('mostra apenas a compactação mais recente quando houve mais de uma', () => {
    const twice = withEvents([start(1, 'c1'), summary(2, 'c1'), end(3, 'c1'), start(4, 'c2')])
    expect(compactionView(twice)).toMatchObject({ compactionId: 'c2', phase: 'summarizing' })
    expect(compactionView(twice)?.items).toBeUndefined()
  })

  it('sem compactação nenhuma, não há faixa', () => {
    expect(compactionView(withEvents([message(1)]))).toBeNull()
    expect(isCompacting(null)).toBe(false)
  })
})
