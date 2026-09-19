import { describe, expect, it, vi } from 'vitest'
import type { SessionRecord } from '@dz23-studio/identity'
import { lembretesDaConversa } from '../src/assistant-schedules.js'
import { AssistantConversationService, type AssistantConversationControllerPort } from '../src/assistant-conversation.js'
import { routeAssistantConversation, ASSISTANT_CONVERSATION_PREFIX } from '../src/index.js'

/*
  O FORMATO dos eventos é o que `schedule_create`/`schedule_delete` gravam no
  registro (`schedule/change`, versão 1). A leitura usa a dobra DO HARNESS,
  e estes casos provam que a tela vê o mesmo que o disparo vê.
*/
const mudanca = (seq: number, data: unknown) => ({ type: 'schedule/change', seq, time: seq, data }) as never
const criar = (seq: number, schedule: Record<string, unknown>) => mudanca(seq, { version: 1, operation: 'create', schedule })
const AGORA = Date.parse('2026-09-19T12:00:00.000Z')

describe('os lembretes da conversa, lidos do registro', () => {
  it('lista os ativos em ordem de hora, com tipo, intervalo e atraso', () => {
    const leitura = lembretesDaConversa([
      criar(1, { id: 'schedule-1', kind: 'every', prompt: 'ver pedidos', everySeconds: 3600, scheduledAt: '2026-09-19T13:00:00.000Z' }),
      criar(2, { id: 'schedule-2', kind: 'after', prompt: 'conferir vendas', afterSeconds: 60, scheduledAt: '2026-09-19T11:01:00.000Z' }),
      { type: 'user/message', seq: 3, time: 3, data: {} } as never,
    ], AGORA)
    expect(leitura).toEqual({ estado: 'ok', lembretes: [
      { id: 'schedule-2', tipo: 'uma-vez', proximo: '2026-09-19T11:01:00.000Z', atrasado: true, texto: 'conferir vendas' },
      { id: 'schedule-1', tipo: 'repetido', proximo: '2026-09-19T13:00:00.000Z', atrasado: false, intervaloSegundos: 3600, texto: 'ver pedidos' },
    ] })
  })

  it('um lembrete cancelado sai da lista', () => {
    const leitura = lembretesDaConversa([
      criar(1, { id: 'schedule-1', kind: 'every', prompt: 'x', everySeconds: 300, scheduledAt: '2026-09-19T13:00:00.000Z' }),
      mudanca(2, { version: 1, operation: 'delete', id: 'schedule-1' }),
    ], AGORA)
    expect(leitura).toEqual({ estado: 'ok', lembretes: [] })
  })

  it('registro que não fecha é ILEGÍVEL, e não lista vazia', () => {
    expect(lembretesDaConversa([mudanca(1, { version: 1, operation: 'delete', id: 'schedule-9' })], AGORA)).toEqual({ estado: 'ilegivel' })
    expect(lembretesDaConversa([mudanca(1, { version: 99 })], AGORA)).toEqual({ estado: 'ilegivel' })
  })
})

describe('a rota e o serviço', () => {
  const sessao = { session_id: 's', user_id: 'user-1', org_id: 'org-1', tenant_id: 'tenant-1', harness_session_ids: ['conversation-1'] } as unknown as SessionRecord
  const servico = (inspect: AssistantConversationControllerPort['inspect'], dono = true) => new AssistantConversationService({
    identity: { ownsHarnessSession: () => dono },
    tenancy: { authorizationFor: () => ({ userId: 'user-1', orgId: 'org-1', tenantId: 'tenant-1', role: 'viewer' }) },
    launcher: { launchTenantConversation: vi.fn() },
    sessions: { inspect, prompt: vi.fn(), cancel: vi.fn() },
    now: () => AGORA,
  })

  it('só GET, e só com uma conversa válida', () => {
    expect(routeAssistantConversation('GET', `${ASSISTANT_CONVERSATION_PREFIX}/c1/schedules`)).toEqual({ kind: 'schedules', conversationId: 'c1' })
    expect(routeAssistantConversation('POST', `${ASSISTANT_CONVERSATION_PREFIX}/c1/schedules`)).toEqual({ kind: 'method-not-allowed' })
  })

  it('lê com o relógio do serviço, e quem só lê pode ler', async () => {
    // 12h30 é FUTURO para o relógio do serviço (12h) e passado para o relógio
    // real de quem roda o teste: só o relógio injetado dá `atrasado: false`.
    const inspect = vi.fn(async () => ({ events: [criar(1, { id: 'schedule-1', kind: 'every', prompt: 'x', everySeconds: 300, scheduledAt: '2026-09-19T12:30:00.000Z' })] }))
    await expect(servico(inspect).lembretes(sessao, 'conversation-1')).resolves.toMatchObject({ estado: 'ok', lembretes: [{ id: 'schedule-1', atrasado: false }] })
  })

  it('conversa de outro dono não existe; Harness indisponível diz isso', async () => {
    await expect(servico(vi.fn(), false).lembretes(sessao, 'conversation-1')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(servico(vi.fn(async () => { throw new Error('x') })).lembretes(sessao, 'conversation-1')).rejects.toMatchObject({ code: 'SESSION_UNAVAILABLE' })
  })
})
