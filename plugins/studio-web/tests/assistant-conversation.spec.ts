import { describe, expect, it, vi } from 'vitest'
import type { SessionRecord } from '@dz23-studio/identity'
import {
  AssistantConversationError,
  AssistantConversationService,
  sanitizeAssistantEvent,
  sanitizeAssistantSnapshot,
  type AssistantConversationControllerPort,
} from '../src/assistant-conversation.js'

const identitySession = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  session_id: 'identity-1', user_id: 'user-1', org_id: 'org-1', tenant_id: 'tenant-1',
  token_hash: 'a'.repeat(64), csrf_hash: 'b'.repeat(64), device_label: 'Notebook', user_agent: '', ip_truncated: '',
  created_at: '2026-09-06T00:00:00.000Z', last_seen_at: '2026-09-06T00:00:00.000Z',
  expires_sliding_at: '2026-09-07T00:00:00.000Z', expires_absolute_at: '2026-10-06T00:00:00.000Z',
  last_strong_auth_at: null, last_strong_auth_method: null, revoked_at: null, revoked_reason: null,
  harness_session_ids: ['conversation-1'], ...overrides,
})

function fixture(input: { readonly allowed?: boolean; readonly owned?: boolean } = {}) {
  const inspect = vi.fn<AssistantConversationControllerPort['inspect']>(async () => ({ events: [] }))
  const prompt = vi.fn<AssistantConversationControllerPort['prompt']>(async () => ({ accepted: true }))
  const cancel = vi.fn<AssistantConversationControllerPort['cancel']>(() => ({ accepted: true }))
  const launchTenantConversation = vi.fn(async () => ({
    session_id: 'conversation-1', reused: false as const, preset: 'dz23-assistant' as const,
  }))
  const service = new AssistantConversationService({
    identity: { ownsHarnessSession: () => input.owned !== false },
    tenancy: { authorizationFor: () => input.allowed === false ? undefined : ({
      userId: 'user-1', orgId: 'org-1', tenantId: 'tenant-1', role: 'viewer',
    }) },
    launcher: { launchTenantConversation },
    sessions: { inspect, prompt, cancel },
    createRequestId: () => 'request-1',
  })
  return { service, inspect, prompt, cancel, launchTenantConversation }
}

const event = (type: string, seq: number, data: Record<string, unknown>, time = 100 + seq) => ({ type, seq, time, data })

describe('AssistantConversationService', () => {
  it('opens only a server-authorized tenant conversation', async () => {
    const allowed = fixture()
    await expect(allowed.service.open(identitySession())).resolves.toMatchObject({ session_id: 'conversation-1' })
    expect(allowed.launchTenantConversation).toHaveBeenCalledWith(identitySession())

    const forbidden = fixture({ allowed: false })
    await expect(forbidden.service.open(identitySession())).rejects.toEqual(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(forbidden.launchTenantConversation).not.toHaveBeenCalled()
  })

  it('checks exact ownership before every read, send and cancel without revealing a foreign id', async () => {
    const foreign = fixture({ owned: false })
    await expect(foreign.service.snapshot(identitySession(), 'stolen')).rejects.toEqual(expect.objectContaining({
      code: 'NOT_FOUND', message: 'Conversa não encontrada.',
    }))
    await expect(foreign.service.send(identitySession(), 'stolen', 'oi', new AbortController().signal))
      .rejects.toEqual(expect.objectContaining({ code: 'NOT_FOUND' }))
    expect(() => foreign.service.cancel(identitySession(), 'stolen')).toThrowError(AssistantConversationError)
    expect(foreign.inspect).not.toHaveBeenCalled()
    expect(foreign.prompt).not.toHaveBeenCalled()
    expect(foreign.cancel).not.toHaveBeenCalled()
  })

  it('submits only bounded text with a server request id and maps runtime failures', async () => {
    const f = fixture()
    await expect(f.service.send(identitySession(), 'conversation-1', 'Olá', new AbortController().signal)).resolves.toEqual({
      accepted: true, request_id: 'request-1',
    })
    expect(f.prompt).toHaveBeenCalledWith({
      requestId: 'request-1', sessionId: 'conversation-1', mode: 'queue', content: [{ type: 'text', text: 'Olá' }],
    }, expect.any(AbortSignal))
    for (const invalid of ['', '   ', 'a\0b', 'x'.repeat(32 * 1024 + 1)]) {
      await expect(f.service.send(identitySession(), 'conversation-1', invalid, new AbortController().signal))
        .rejects.toEqual(expect.objectContaining({ code: 'INVALID_MESSAGE' }))
    }
    f.prompt.mockRejectedValueOnce(new Error('provider details must stay private'))
    await expect(f.service.send(identitySession(), 'conversation-1', 'tente', new AbortController().signal))
      .rejects.toEqual(expect.objectContaining({ code: 'SESSION_UNAVAILABLE', message: expect.not.stringContaining('provider') }))
  })

  it('returns a sanitized snapshot and contains inspection and cancellation failures', async () => {
    const f = fixture()
    f.inspect.mockResolvedValueOnce({ events: [
      event('user/message', 0, { id: 'u1', source: { kind: 'user', rpcId: 'private' }, content: [{ type: 'text', text: 'Oi' }] }),
      event('request/header', 1, { header: { cwd: '/segredo', token: 'secret' } }),
      event('assistant/message', 2, { message: { id: 'a1', source: { kind: 'model', replayState: 'secret' }, content: [{ type: 'reasoning', text: 'private' }, { type: 'text', text: 'Olá!' }] } }),
    ] as never })
    const snapshot = await f.service.snapshot(identitySession(), 'conversation-1')
    expect(snapshot).toMatchObject({ conversation_id: 'conversation-1', cursor: 2, truncated: false })
    expect(snapshot.events).toHaveLength(2)
    expect(JSON.stringify(snapshot)).not.toMatch(/segredo|secret|private|reasoning|replayState|cwd/u)

    f.inspect.mockRejectedValueOnce(new Error('storage path /private'))
    await expect(f.service.snapshot(identitySession(), 'conversation-1')).rejects.toEqual(expect.objectContaining({
      code: 'NOT_FOUND', message: expect.not.stringContaining('/private'),
    }))
    expect(f.service.cancel(identitySession(), 'conversation-1')).toEqual({ accepted: true })
    f.cancel.mockImplementationOnce(() => { throw new Error('internal') })
    expect(() => f.service.cancel(identitySession(), 'conversation-1')).toThrowError(expect.objectContaining({ code: 'SESSION_UNAVAILABLE' }))
  })
})

describe('assistant transcript sanitization', () => {
  it('projects only the closed public allowlist and drops secrets and internal context', () => {
    const values = [
      event('turn/start', 0, { turn: 1 }),
      event('turn/end', 1, { turn: 1, reason: 'success' }),
      event('user/message', 2, { id: 'u1', source: { kind: 'plugin', plugin: 'secrets' }, content: [{ type: 'text', text: 'hidden' }] }),
      event('user/message', 3, { id: 'u2', source: { kind: 'user' }, content: [{ type: 'image', name: 'secret.png' }, { type: 'text', text: 'visível' }] }),
      event('assistant/message', 4, { interrupted: true, message: { id: 'a1', content: [{ type: 'reasoning', text: 'não mostrar' }, { type: 'text', text: 'resposta' }] } }),
      event('tool/call', 5, { callId: 'call-1', name: 'studio_agent_start', arguments: '{"password":"secret"}' }),
      event('tool/result', 6, { message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', content: ['secret'] }] } }),
      event('tool/result', 7, { message: { source: { kind: 'tool', callId: 'call-2' } }, error: { message: 'secret' } }),
      event('approval/asked', 8, { id: 'approval-1', toolName: 'unknown-tool', reason: 'senha secret' }),
      event('approval/decided', 9, { id: 'approval-1', outcome: 'rejected' }),
      event('unknown/private', 10, { cwd: '/secret' }),
    ]
    const snapshot = sanitizeAssistantSnapshot('conversation-1', values)
    expect(snapshot.events.map(item => item.type)).toEqual([
      'turn.state', 'turn.state', 'message.user', 'message.assistant',
      'tool.state', 'tool.state', 'tool.state', 'approval.requested', 'approval.resolved',
    ])
    expect(snapshot.events[4]).toMatchObject({ label: 'Iniciar um assistente especializado', state: 'running' })
    expect(snapshot.events[7]).toMatchObject({ tool_label: 'Ação do assistente' })
    expect(JSON.stringify(snapshot)).not.toMatch(/password|senha|secret|reasoning|arguments|unknown-tool/u)
  })

  it('drops malformed events, invalid decisions and empty messages', () => {
    const malformed = [
      null, [], {}, { type: 'turn/start', seq: -1, time: 1, data: {} },
      { type: 'turn/start', seq: 0.5, time: 1, data: {} },
      { type: 'turn/start', seq: 0, time: Number.NaN, data: {} },
      { type: 'turn/start', seq: 0, time: 1, data: null },
      event('user/message', 1, { id: '', source: { kind: 'user' }, content: [] }),
      event('assistant/message', 2, { message: null }),
      event('tool/call', 3, { callId: '', name: 'studio_agent_start' }),
      event('tool/result', 4, { message: {} }),
      event('approval/asked', 5, { id: '', toolName: 'x' }),
      event('approval/decided', 6, { id: 'x', outcome: 'invented' }),
    ]
    expect(malformed.map(sanitizeAssistantEvent)).toEqual(malformed.map(() => undefined))
  })

  it('bounds public text and transcript size while retaining the durable cursor', () => {
    const values = Array.from({ length: 505 }, (_, seq) => event('user/message', seq, {
      id: `m-${seq}`, source: { kind: 'user' }, content: [{ type: 'text', text: seq === 504 ? 'x'.repeat(64 * 1024 + 1) : 'x' }],
    }))
    const snapshot = sanitizeAssistantSnapshot('conversation-1', values)
    expect(snapshot).toMatchObject({ cursor: 504, truncated: true })
    expect(snapshot.events).toHaveLength(500)
    expect(snapshot.events[0]).toMatchObject({ id: 'm-5' })
    expect(snapshot.events.at(-1)).toMatchObject({ id: 'm-504', truncated: true })
    expect((snapshot.events.at(-1) as { text: string }).text).toHaveLength(64 * 1024)
  })
})
