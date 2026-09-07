import type { ConversationEvent, ConversationSnapshot } from './conversationApi'

/**
 * A message the person sent that has not come back in the journal yet. It is
 * kept so the screen can say "guardada e será enviada em seguida" instead of
 * making the text disappear while the turn is busy.
 */
export interface QueuedMessage {
  readonly request_id: string
  readonly text: string
}

export interface ConversationState {
  readonly conversationId: string | null
  /** Journal events, deduplicated by seq and always ascending. */
  readonly events: readonly ConversationEvent[]
  /** Highest seq accepted. Never regresses. */
  readonly cursor: number
  readonly truncated: boolean
  readonly turn: 'idle' | 'working'
  readonly queued: readonly QueuedMessage[]
  /** Text typed but not sent. Survives rerender, reconnection and snapshots. */
  readonly draft: string
}

export function emptyConversation(): ConversationState {
  return { conversationId: null, events: [], cursor: 0, truncated: false, turn: 'idle', queued: [], draft: '' }
}

export function openedConversation(state: ConversationState, conversationId: string): ConversationState {
  if (state.conversationId === conversationId) return state
  return { ...emptyConversation(), conversationId, draft: state.draft }
}

/**
 * Merges a snapshot into the state. Idempotent and monotonic: the same snapshot
 * twice changes nothing, an older or reordered one cannot remove an event or
 * move the cursor backwards, and a duplicated seq never appears twice.
 */
export function applySnapshot(state: ConversationState, snapshot: ConversationSnapshot): ConversationState {
  if (state.conversationId !== null && snapshot.conversation_id !== state.conversationId) return state
  const bySeq = new Map(state.events.map(event => [event.seq, event]))
  for (const event of snapshot.events) {
    if (!bySeq.has(event.seq)) bySeq.set(event.seq, event)
  }
  const events = [...bySeq.values()].sort((left, right) => left.seq - right.seq)
  const cursor = Math.max(state.cursor, snapshot.cursor, events.at(-1)?.seq ?? 0)
  const delivered = new Set(events.filter(isUserMessage).map(event => event.text))
  return {
    ...state,
    conversationId: state.conversationId ?? snapshot.conversation_id,
    events,
    cursor,
    truncated: state.truncated || snapshot.truncated,
    turn: latestTurn(events, state.turn),
    queued: state.queued.filter(message => !delivered.has(message.text)),
  }
}

export function setDraft(state: ConversationState, draft: string): ConversationState {
  return state.draft === draft ? state : { ...state, draft }
}

/**
 * Accepts one send. The draft is cleared only here - after the server accepted
 * it - and the text moves to the queue, so nothing the person typed is lost
 * between the click and the journal.
 */
export function queueMessage(state: ConversationState, requestId: string, text: string): ConversationState {
  if (state.queued.some(message => message.request_id === requestId)) return state
  return { ...state, draft: '', queued: [...state.queued, { request_id: requestId, text }] }
}

/** Drops a send the server refused, so it is not shown as waiting forever. */
export function dropQueuedMessage(state: ConversationState, requestId: string): ConversationState {
  const queued = state.queued.filter(message => message.request_id !== requestId)
  return queued.length === state.queued.length ? state : { ...state, queued }
}

export function isUserMessage(event: ConversationEvent): event is Extract<ConversationEvent, { type: 'message.user' }> {
  return event.type === 'message.user'
}

function latestTurn(events: readonly ConversationEvent[], fallback: 'idle' | 'working'): 'idle' | 'working' {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type === 'turn.state') return event.state
  }
  return fallback
}

/**
 * What the screen announces. Derived, never stored, so it cannot drift from the
 * journal: the person is told the turn is busy only while the journal says so.
 */
export function conversationStatus(state: ConversationState): 'idle' | 'working' | 'queued' {
  if (state.queued.length > 0) return 'queued'
  return state.turn
}
