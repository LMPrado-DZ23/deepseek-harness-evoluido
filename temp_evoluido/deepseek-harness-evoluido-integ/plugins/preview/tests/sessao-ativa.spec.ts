import { describe, expect, it } from 'vitest'
import { sessaoAtiva } from '../src/index.ts'

const agora = Date.parse('2026-09-20T08:00:00.000Z')
const base = { user_id: 'u', org_id: 'o', tenant_id: 't', revoked_at: null as string | null, expires_absolute_at: '2026-09-21T00:00:00.000Z', expires_sliding_at: '2026-09-20T09:00:00.000Z' }
const pedido = { sessionId: 's', userId: 'u', orgId: 'o', tenantId: 't' }
const pessoal = { session_id: 'session_local', user_id: 'user_local', org_id: 'org_local', tenant_id: 'tenant_local', revoked_at: null, expires_absolute_at: '2026-09-20T08:00:00.000Z', expires_sliding_at: '2026-09-20T08:00:00.000Z' }
const pedidoPessoal = { sessionId: 'session_local', userId: 'user_local', orgId: 'org_local', tenantId: 'tenant_local' }

describe('sessaoAtiva', () => {
  it('a sessão gravada vale dentro dos prazos e sem revogação', () => {
    expect(sessaoAtiva([{ ...base, session_id: 's' }], undefined, pedido, agora)).toBe(true)
    expect(sessaoAtiva([{ ...base, session_id: 's', revoked_at: 'x' }], undefined, pedido, agora)).toBe(false)
    expect(sessaoAtiva([{ ...base, session_id: 's', expires_sliding_at: '2026-09-20T07:00:00.000Z' }], undefined, pedido, agora)).toBe(false)
  })
  it('a sessão PESSOAL vale enquanto a identidade a oferece, mesmo com os prazos no instante', () => {
    expect(sessaoAtiva([], pessoal, pedidoPessoal, agora)).toBe(true)
    expect(sessaoAtiva([], undefined, pedidoPessoal, agora)).toBe(false)
  })
  it('a pessoal não serve para outro pedido', () => {
    expect(sessaoAtiva([], pessoal, pedido, agora)).toBe(false)
  })
})
