import { describe, expect, it, vi } from 'vitest'
import { StudioTenancyService } from '../src/service.ts'

/*
  O ESCOPO PESSOAL NÃO TEM CONVITE, porque não tem a quem convidar.

  Numa instalação local recém-baixada ninguém está registrado, e portanto não
  existe participação gravada em tabela nenhuma. Sem a resposta abaixo, quem
  acabou de abrir o FRIGG lê "Você não participa deste espaço de trabalho" no
  próprio computador — medido em 18/09/2026, logo depois de a porta pessoal da
  identidade abrir e as rotas de trabalho passarem a autenticar.
*/
const sessaoPessoal = {
  session_id: 'session_local', user_id: 'user_local', org_id: 'org_local', tenant_id: 'tenant_local',
}

function servico(options: { readonly pessoal: boolean; readonly memberships?: readonly unknown[] }) {
  const repository = {
    memberships: () => options.memberships ?? [],
    workspaces: () => [],
    organizations: () => [],
    invitations: () => [],
    putMembership: vi.fn(), putWorkspace: vi.fn(), putOrganization: vi.fn(), putInvitation: vi.fn(),
    putAudit: vi.fn(), audits: () => [],
  }
  const identity = { personalSession: () => (options.pessoal ? sessaoPessoal : undefined) }
  return new StudioTenancyService({ repository, identity } as never)
}

describe('a autorizacao do escopo pessoal', () => {
  it('a dona do computador e OWNER do proprio escopo', () => {
    expect(servico({ pessoal: true }).authorizationFor('user_local', 'org_local', 'tenant_local'))
      .toEqual({ userId: 'user_local', orgId: 'org_local', tenantId: 'tenant_local', role: 'owner' })
  })

  it('so vale para os identificadores QUE A IDENTIDADE declarou', () => {
    // Um pedido que traga outro escopo não vira dono por estar em modo pessoal.
    const alvo = servico({ pessoal: true })
    expect(alvo.authorizationFor('user_local', 'outra-org', 'tenant_local')).toBeUndefined()
    expect(alvo.authorizationFor('outro-usuario', 'org_local', 'tenant_local')).toBeUndefined()
    expect(alvo.authorizationFor('user_local', 'org_local', 'outro-espaco')).toBeUndefined()
  })

  it('assim que alguem se registra, o escopo pessoal SOME', () => {
    // `personalSession()` devolve `undefined` no instante em que passa a haver
    // a quem convidar, e a resposta some junto.
    expect(servico({ pessoal: false }).authorizationFor('user_local', 'org_local', 'tenant_local')).toBeUndefined()
  })

  it('participacao gravada continua mandando, e o papel e o dela', () => {
    const alvo = servico({
      pessoal: true,
      memberships: [{ user_id: 'u', org_id: 'o', workspace_id: 'w', role: 'viewer' }],
    })
    expect(alvo.authorizationFor('u', 'o', 'w')).toEqual({ userId: 'u', orgId: 'o', tenantId: 'w', role: 'viewer' })
  })
})
