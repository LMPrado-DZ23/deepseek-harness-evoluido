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

function fixture(input: {
  readonly allowed?: boolean
  readonly owned?: boolean
  readonly role?: 'owner' | 'admin' | 'builder' | 'viewer'
  readonly randomRequestId?: boolean
} = {}) {
  const inspect = vi.fn<AssistantConversationControllerPort['inspect']>(async () => ({ events: [] }))
  const prompt = vi.fn<AssistantConversationControllerPort['prompt']>(async () => ({ accepted: true }))
  const cancel = vi.fn<AssistantConversationControllerPort['cancel']>(() => ({ accepted: true }))
  const launchTenantConversation = vi.fn(async () => ({
    session_id: 'conversation-1', reused: false as const, preset: 'dz23-assistant' as const,
  }))
  const service = new AssistantConversationService({
    identity: { ownsHarnessSession: () => input.owned !== false },
    tenancy: { authorizationFor: () => input.allowed === false ? undefined : ({
      userId: 'user-1', orgId: 'org-1', tenantId: 'tenant-1', role: input.role ?? 'builder',
    }) },
    launcher: { launchTenantConversation },
    sessions: { inspect, prompt, cancel },
    ...(input.randomRequestId === true ? {} : { createRequestId: () => 'request-1' }),
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

    const viewer = fixture({ role: 'viewer' })
    await expect(viewer.service.open(identitySession())).rejects.toEqual(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(viewer.launchTenantConversation).not.toHaveBeenCalled()
  })

  it('lets a viewer read an owned transcript but never create, send or cancel work', async () => {
    const viewer = fixture({ role: 'viewer' })
    await expect(viewer.service.snapshot(identitySession(), 'conversation-1')).resolves.toMatchObject({
      conversation_id: 'conversation-1',
    })
    await expect(viewer.service.send(identitySession(), 'conversation-1', 'execute', new AbortController().signal))
      .rejects.toEqual(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => viewer.service.cancel(identitySession(), 'conversation-1'))
      .toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(viewer.prompt).not.toHaveBeenCalled()
    expect(viewer.cancel).not.toHaveBeenCalled()
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

    const generated = fixture({ randomRequestId: true })
    const receipt = await generated.service.send(identitySession(), 'conversation-1', 'id seguro', new AbortController().signal)
    expect(receipt.request_id).toMatch(/^[0-9a-f-]{36}$/u)
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

    // Falha do Harness é indisponibilidade, NÃO "conversa não encontrada": a
    // posse já foi verificada antes desta chamada, e dizer que a conversa sumiu
    // faria a pessoa acreditar que perdeu o histórico por uma queda passageira.
    f.inspect.mockRejectedValueOnce(new Error('storage path /private'))
    await expect(f.service.snapshot(identitySession(), 'conversation-1')).rejects.toEqual(expect.objectContaining({
      code: 'SESSION_UNAVAILABLE', message: expect.not.stringContaining('/private'),
    }))
    // E continua sendo 404 quando a conversa realmente não é da pessoa.
    const foreign = fixture({ owned: false })
    await expect(foreign.service.snapshot(identitySession(), 'conversa-de-outro'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
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

  it('uses friendly labels for every supported assistant action and accepts only closed outcomes', () => {
    const labels = [
      ['studio_agent_list', 'Consultar assistentes disponíveis'],
      ['studio_agent_start', 'Iniciar um assistente especializado'],
      ['studio_agent_status', 'Acompanhar o trabalho do assistente'],
      ['studio_agent_cancel', 'Interromper o trabalho do assistente'],
      ['studio_agent_apply', 'Aplicar uma proposta ao projeto'],
      ['studio_team_start', 'Coordenar uma equipe de assistentes'],
      ['studio_echo', 'Executar uma ação do DZ23 STUDIO'],
      ['foreign', 'Ação do assistente'],
    ] as const
    for (const [name, label] of labels) {
      expect(sanitizeAssistantEvent(event('tool/call', 1, { callId: `call-${name}`, name }))).toMatchObject({ label })
    }
    for (const outcome of ['allowed-once', 'rejected', 'cancelled', 'unavailable'] as const) {
      expect(sanitizeAssistantEvent(event('approval/decided', 2, { id: `approval-${outcome}`, outcome }))).toMatchObject({ outcome })
    }
    expect(sanitizeAssistantEvent(event('assistant/message', 3, {
      message: { id: 'complete', content: [{ type: 'text', text: 'fim' }] },
    }))).toMatchObject({ interrupted: false })
    expect(sanitizeAssistantEvent(event('tool/call', 4, { callId: 'generic', name: 123 }))).toMatchObject({ label: 'Ação do assistente' })
  })

  it('drops malformed events, invalid decisions and empty messages', () => {
    const malformed = [
      null, [], {}, { type: 'turn/start', seq: -1, time: 1, data: {} },
      { type: 'turn/start', seq: 0.5, time: 1, data: {} },
      { type: 'turn/start', seq: 0, time: Number.NaN, data: {} },
      { type: 'turn/start', seq: 0, time: 1, data: null },
      event('user/message', 1, { id: '', source: { kind: 'user' }, content: [] }),
      event('user/message', 1, { id: 'x', source: { kind: 'user' }, content: null }),
      event('user/message', 1, { id: 'x', source: { kind: 'user' }, content: [{ type: 'image' }] }),
      event('assistant/message', 2, { message: null }),
      event('tool/call', 3, { callId: '', name: 'studio_agent_start' }),
      event('tool/call', 3, { callId: 'x'.repeat(257), name: 'studio_agent_start' }),
      event('tool/call', 3, { callId: 'a\0b', name: 'studio_agent_start' }),
      event('tool/result', 4, { message: {} }),
      event('tool/result', 4, { message: null }),
      event('approval/asked', 5, { id: '', toolName: 'x' }),
      event('approval/asked', 5, { id: 'valid-id', toolName: 123 }),
      event('approval/decided', 6, { id: 'x', outcome: 'invented' }),
    ]
    const projected = malformed.map(sanitizeAssistantEvent)
    expect(projected.filter(value => value !== undefined)).toEqual([
      expect.objectContaining({ type: 'approval.requested', tool_label: 'Ação do assistente' }),
    ])
    expect(sanitizeAssistantSnapshot('empty', malformed)).toEqual({
      conversation_id: 'empty', cursor: 6,
      events: [expect.objectContaining({ type: 'approval.requested', tool_label: 'Ação do assistente' })],
      truncated: false,
    })
  })

  it('projeta a compactação real do Harness sem vazar resumo, modelo, provedor ou erro', () => {
    const values = [
      event('compaction/start', 20, { compactionId: 'comp-1', sourceCommandId: 'cmd-1', turn: 3 }),
      event('compaction/summary', 21, {
        compactionId: 'comp-1',
        sourceCommandId: 'cmd-1',
        summary: [{ type: 'text', text: 'RESUMO INTERNO SIGILOSO' }],
        rawOutput: [{ type: 'text', text: 'SAIDA CRUA DO MODELO' }],
        llmStreamCall: true,
        provider: 'provedor-secreto',
        model: 'modelo-secreto',
        maxTokens: 4096,
        usage: { inputTokens: 900, outputTokens: 120 },
        shadowedRange: { start: 2, end: 18 },
        shadowedSeqs: [2, 3, 4, 5, 6, 7],
        shadowedTokenCount: 12_345,
      }),
      event('compaction/end', 22, { compactionId: 'comp-1', sourceCommandId: 'cmd-1', turn: 3 }),
    ]
    const snapshot = sanitizeAssistantSnapshot('conversation-1', values)
    expect(snapshot.events).toEqual([
      { type: 'compaction.state', seq: 20, at: 120, compaction_id: 'comp-1', state: 'summarizing' },
      { type: 'compaction.state', seq: 21, at: 121, compaction_id: 'comp-1', state: 'committing', items: 6, tokens: 12_345 },
      { type: 'compaction.state', seq: 22, at: 122, compaction_id: 'comp-1', state: 'completed' },
    ])
    const wire = JSON.stringify(snapshot)
    expect(wire).not.toMatch(/RESUMO INTERNO|SAIDA CRUA|provedor-secreto|modelo-secreto|rawOutput|usage|maxTokens|cmd-1/u)
    // Nenhuma fração de progresso atravessa: o contrato upstream não tem uma.
    expect(wire).not.toMatch(/percent|progress|"ratio"/u)
  })

  it('conta apenas o que o Harness realmente informou e nunca inventa número nem texto de erro', () => {
    // Contagens ausentes ou impossíveis são omitidas, não chutadas.
    expect(sanitizeAssistantEvent(event('compaction/summary', 1, {
      compactionId: 'comp-2', shadowedTokenCount: -5, shadowedSeqs: 'nada',
    }))).toEqual({ type: 'compaction.state', seq: 1, at: 101, compaction_id: 'comp-2', state: 'committing' })
    expect(sanitizeAssistantEvent(event('compaction/summary', 2, {
      compactionId: 'comp-2', shadowedTokenCount: 1.5, shadowedSeqs: [],
    }))).toEqual({ type: 'compaction.state', seq: 2, at: 102, compaction_id: 'comp-2', state: 'committing', items: 0 })

    // Fim com erro vira estado de falha; o texto do erro fica no servidor.
    expect(sanitizeAssistantEvent(event('compaction/end', 3, {
      compactionId: 'comp-2', error: 'ENOENT /home/pessoa/segredo.json',
    }))).toEqual({ type: 'compaction.state', seq: 3, at: 103, compaction_id: 'comp-2', state: 'failed' })

    // Sem identidade de compactação não há evento: melhor nada do que um estado órfão.
    for (const broken of [{}, { compactionId: '' }, { compactionId: 1 }, { compactionId: 'a\u0000b' }]) {
      expect(sanitizeAssistantEvent(event('compaction/start', 4, broken))).toBeUndefined()
      expect(sanitizeAssistantEvent(event('compaction/end', 5, broken))).toBeUndefined()
      expect(sanitizeAssistantEvent(event('compaction/summary', 6, broken))).toBeUndefined()
    }
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
