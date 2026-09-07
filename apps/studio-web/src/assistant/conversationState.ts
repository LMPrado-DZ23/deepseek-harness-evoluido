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

/**
 * What the screen shows about compaction. `reconciling` is not a server state:
 * it is what the client says when the journal moved past the summary without an
 * end marker - the honest answer there is "still organizing", never "done".
 */
export type CompactionPhase = 'summarizing' | 'committing' | 'completed' | 'failed' | 'reconciling'

export interface CompactionView {
  readonly compactionId: string
  readonly phase: CompactionPhase
  /** Real counts, and only after the summary exists. Never estimated. */
  readonly items?: number
  readonly tokens?: number
}

const PHASE_RANK: Readonly<Record<'summarizing' | 'committing' | 'completed' | 'failed', number>> = {
  summarizing: 1, committing: 2, completed: 3, failed: 3,
}

/**
 * Folds the journal into the current compaction. Monotonic by construction: a
 * duplicated or late event cannot move the phase backwards, and only the newest
 * compaction is shown. Counts, once seen, are kept - the end marker does not
 * carry them.
 */
export function compactionView(state: ConversationState): CompactionView | null {
  let current: { compactionId: string; rank: number; state: 'summarizing' | 'committing' | 'completed' | 'failed'; items?: number; tokens?: number; seq: number } | null = null
  let latestOtherSeq = -1
  for (const event of state.events) {
    if (event.type !== 'compaction.state') {
      latestOtherSeq = Math.max(latestOtherSeq, event.seq)
      continue
    }
    if (current === null || current.compactionId !== event.compaction_id) {
      if (current !== null && event.seq < current.seq) continue
      current = {
        compactionId: event.compaction_id, rank: PHASE_RANK[event.state], state: event.state, seq: event.seq,
        ...(event.items === undefined ? {} : { items: event.items }),
        ...(event.tokens === undefined ? {} : { tokens: event.tokens }),
      }
      continue
    }
    if (PHASE_RANK[event.state] < current.rank) continue
    current = {
      ...current,
      rank: PHASE_RANK[event.state],
      state: event.state,
      seq: Math.max(current.seq, event.seq),
      ...(event.items === undefined ? {} : { items: event.items }),
      ...(event.tokens === undefined ? {} : { tokens: event.tokens }),
    }
  }
  if (current === null) return null
  const phase: CompactionPhase = current.state === 'committing' && latestOtherSeq > current.seq
    ? 'reconciling'
    : current.state
  return {
    compactionId: current.compactionId,
    phase,
    ...(current.items === undefined ? {} : { items: current.items }),
    ...(current.tokens === undefined ? {} : { tokens: current.tokens }),
  }
}

/** True while the conversation is being organized and cannot take a new turn. */
export function isCompacting(view: CompactionView | null): boolean {
  return view !== null && (view.phase === 'summarizing' || view.phase === 'committing' || view.phase === 'reconciling')
}
