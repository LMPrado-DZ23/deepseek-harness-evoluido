import { describe, expect, it } from 'vitest'
import { EMAIL_DO_DONO_PESSOAL, emailDoDono } from '../src/index.ts'

const local = { userId: 'user_local', orgId: 'org_local', tenantId: 'tenant_local' }
const ana = { user_id: 'u1', org_id: 'o1', tenant_id: 't1', email: 'ana@exemplo.com' }

describe('emailDoDono', () => {
  it('a pessoa registrada usa o próprio e-mail', () => {
    expect(emailDoDono([ana], { userId: 'u1', orgId: 'o1', tenantId: 't1' })).toBe('ana@exemplo.com')
  })
  it('na instalação pessoal (ninguém cadastrado), o dono é a pessoa do computador', () => {
    expect(emailDoDono([], local)).toBe(EMAIL_DO_DONO_PESSOAL)
    expect(EMAIL_DO_DONO_PESSOAL).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u)
  })
  it('com alguém cadastrado, o pessoal deixa de valer; e outro ator não vira dono', () => {
    expect(emailDoDono([ana], local)).toBeUndefined()
    expect(emailDoDono([], { userId: 'intruso', orgId: 'org_local', tenantId: 'tenant_local' })).toBeUndefined()
  })
})
