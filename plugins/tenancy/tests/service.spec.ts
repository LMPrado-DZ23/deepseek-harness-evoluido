import { describe, expect, it, vi } from 'vitest'
import type { EmailSender, IdentityUser, StudioIdentityService } from '@dz23-studio/identity'
import type { Invitation, Membership, Organization, Workspace } from '../src/model.ts'
import { StudioTenancyService, type TenancyActor, type TenancyRepository } from '../src/service.ts'

class MemoryRepository implements TenancyRepository {
  readonly orgMap = new Map<string, Organization>()
  readonly workspaceMap = new Map<string, Workspace>()
  readonly membershipMap = new Map<string, Membership>()
  readonly invitationMap = new Map<string, Invitation>()
  failNextWorkspaceWrite = false
  organizations() { return [...this.orgMap.values()] }
  putOrganization(value: Organization) { this.orgMap.set(value.org_id, value); return Promise.resolve() }
  workspaces() { return [...this.workspaceMap.values()] }
  putWorkspace(value: Workspace) {
    if (this.failNextWorkspaceWrite) {
      this.failNextWorkspaceWrite = false
      return Promise.reject(new Error('simulated workspace write failure'))
    }
    this.workspaceMap.set(value.workspace_id, value)
    return Promise.resolve()
  }
  memberships() { return [...this.membershipMap.values()] }
  putMembership(value: Membership) { this.membershipMap.set(value.membership_id, value); return Promise.resolve() }
  invitations() { return [...this.invitationMap.values()] }
  putInvitation(value: Invitation) { this.invitationMap.set(value.invitation_id, value); return Promise.resolve() }
}

const owner: IdentityUser = {
  user_id: 'owner', email: 'owner@example.com', display_name: 'Owner', bootstrap_owner: true,
  org_id: 'org-a', tenant_id: 'workspace-a', created_at: '2026-09-02T12:00:00.000Z',
}
const actor: TenancyActor = { userId: 'owner', email: owner.email, orgId: 'org-a', tenantId: 'workspace-a' }

function harness() {
  const repository = new MemoryRepository()
  const invitations: Parameters<EmailSender['sendInvitation']>[0][] = []
  const identity = {
    recordAdministrationEvent: vi.fn(() => Promise.resolve()),
    userForSession: vi.fn(() => owner),
    userRecords: vi.fn(() => [owner]),
  } as unknown as StudioIdentityService
  let now = new Date('2026-09-02T12:00:00.000Z')
  let id = 0
  const service = new StudioTenancyService({
    repository,
    identity,
    emailSender: { sendInvitation: message => { invitations.push(message); return Promise.resolve() } },
    now: () => new Date(now),
    createId: () => `id-${++id}`,
    createSecret: () => `secret-token-${id}`,
  })
  return { repository, invitations, identity, service, setNow: (value: string) => { now = new Date(value) } }
}

async function boot(h: ReturnType<typeof harness>) {
  await h.service.ensureBootstrap(owner)
}

describe('StudioTenancyService', () => {
  it('creates the canonical organization, workspace and owner membership idempotently', async () => {
    const h = harness()
    await boot(h)
    await boot(h)
    await h.service.ensureBootstrap({ ...owner, user_id: 'viewer', bootstrap_owner: false })
    expect(h.repository.organizations()).toEqual([expect.objectContaining({ org_id: 'org-a', owner_user_id: 'owner' })])
    expect(h.repository.workspaces()).toEqual([expect.objectContaining({ workspace_id: 'workspace-a', org_id: 'org-a' })])
    expect(h.repository.memberships()).toEqual([expect.objectContaining({ user_id: 'owner', role: 'owner' })])
  })

  it('lists only actor memberships and rejects cross-workspace reads without leaking data', async () => {
    const h = harness()
    await boot(h)
    h.repository.workspaceMap.set('workspace-b', {
      workspace_id: 'workspace-b', org_id: 'org-b', name: 'Segredo', created_by: 'other',
      created_at: '2026-09-02T12:00:00.000Z', archived_at: null,
    })
    expect(h.service.listWorkspaces(actor).map(value => value.workspace_id)).toEqual(['workspace-a'])
    expect(() => h.service.listMembers(actor, 'workspace-b')).toThrow(/não encontrado/)
    expect(h.service.authorizationFor('owner', 'org-a', 'workspace-a')).toMatchObject({ role: 'owner' })
    expect(h.service.authorizationFor('owner', 'org-b', 'workspace-b')).toBeUndefined()
    expect(h.service.actorFromSession({ user_id: 'owner', org_id: 'org-a', tenant_id: 'workspace-a' } as never)).toEqual(actor)
  })

  it('creates a workspace inside the actor organization and blocks builders', async () => {
    const h = harness()
    await boot(h)
    await expect(h.service.createWorkspace(actor, '  Produto novo  ')).resolves.toMatchObject({ name: 'Produto novo', org_id: 'org-a' })
    expect(h.repository.memberships()).toContainEqual(expect.objectContaining({ workspace_id: 'id-1', user_id: 'owner', role: 'owner' }))
    await expect(h.service.createWorkspace(actor, ' ')).rejects.toMatchObject({ code: 'invalid' })
    const current = h.repository.memberships()[0]!
    h.repository.membershipMap.set(current.membership_id, { ...current, role: 'builder' })
    await expect(h.service.createWorkspace(actor, 'Bloqueado')).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('invites with server-owned scope, revokes prior invites and accepts once for the matching email', async () => {
    const h = harness()
    await boot(h)
    const first = await h.service.invite(actor, 'workspace-a', ' New@Example.com ', 'builder')
    expect(first.invitation).toMatchObject({ org_id: 'org-a', workspace_id: 'workspace-a', email: 'new@example.com', role: 'builder' })
    expect(first.invitation.token_hash).not.toContain(first.token)
    expect(h.invitations[0]).toMatchObject({ to: 'new@example.com', workspaceName: 'Meu espaço de trabalho' })
    expect(h.service.enrollmentGrantFor('new@example.com')).toEqual({ orgId: 'org-a', tenantId: 'workspace-a', role: 'builder' })
    const second = await h.service.invite(actor, 'workspace-a', 'new@example.com', 'viewer')
    expect(h.repository.invitationMap.get(first.invitation.invitation_id)?.revoked_at).not.toBeNull()
    // Propriedade INVERTIDA de propósito: quem vence é o convite MAIS ANTIGO.
    // A versão anterior fazia o mais RECENTE vencer, e isso era metade de um
    // sequestro de matrícula entre organizações — ver o teste dedicado abaixo.
    // Dentro da MESMA organização a mudança não muda nada, porque `invite`
    // revoga o convite anterior: só existe um ativo. O desempate por recência
    // só decidia alguma coisa para linhas que não passaram por `invite`.
    h.repository.invitationMap.set('newer-active', {
      ...second.invitation, invitation_id: 'newer-active', created_at: '2026-09-02T12:01:00.000Z', role: 'admin',
    })
    expect(h.service.enrollmentGrantFor('new@example.com')).toMatchObject({ role: 'viewer' })
    h.repository.invitationMap.delete('newer-active')
    const invitedUser = { ...owner, user_id: 'new-user', email: 'new@example.com', bootstrap_owner: false }
    await expect(h.service.acceptInvitation({ ...invitedUser, email: 'wrong@example.com' }, second.token)).rejects.toMatchObject({ code: 'not-found' })
    const accepted = await h.service.acceptInvitation(invitedUser, second.token)
    expect(accepted).toMatchObject({ user_id: 'new-user', workspace_id: 'workspace-a', role: 'viewer' })
    expect(h.service.enrollmentGrantFor('new@example.com')).toBeUndefined()
    await expect(h.service.acceptInvitation(invitedUser, second.token)).rejects.toMatchObject({ code: 'replay' })
    await expect(h.service.invite(actor, 'workspace-a', 'new@example.com', 'viewer')).rejects.toMatchObject({ code: 'invalid' })
  })

  it('rejects expired invitations and concurrent double acceptance', async () => {
    const h = harness()
    await boot(h)
    const expired = await h.service.invite(actor, 'workspace-a', 'late@example.com', 'viewer')
    h.setNow('2026-09-06T12:00:00.000Z')
    expect(h.service.enrollmentGrantFor('late@example.com')).toBeUndefined()
    await expect(h.service.acceptInvitation({ ...owner, user_id: 'late', email: 'late@example.com' }, expired.token))
      .rejects.toMatchObject({ code: 'expired' })
    h.setNow('2026-09-02T12:00:00.000Z')
    const current = await h.service.invite(actor, 'workspace-a', 'race@example.com', 'builder')
    const raceUser = { ...owner, user_id: 'race', email: 'race@example.com', bootstrap_owner: false }
    const results = await Promise.allSettled([
      h.service.acceptInvitation(raceUser, current.token),
      h.service.acceptInvitation(raceUser, current.token),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  })

  it('enforces role assignment and preserves a last owner', async () => {
    const h = harness()
    await boot(h)
    h.repository.membershipMap.set('member-viewer', {
      membership_id: 'member-viewer', org_id: 'org-a', workspace_id: 'workspace-a',
      user_id: 'viewer', email: 'viewer@example.com', role: 'viewer',
      created_at: '2026-09-02T12:00:00.000Z', updated_at: '2026-09-02T12:00:00.000Z',
    })
    await expect(h.service.changeRole(actor, 'member-viewer', 'admin')).resolves.toMatchObject({ role: 'admin' })
    const adminActor = { userId: 'viewer', email: 'viewer@example.com', orgId: 'org-a', tenantId: 'workspace-a' }
    await expect(h.service.changeRole(adminActor, 'membership:workspace-a:owner', 'viewer')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(h.service.changeRole(actor, 'membership:workspace-a:owner', 'viewer')).rejects.toMatchObject({ code: 'last-owner' })
    await expect(h.service.changeRole(actor, 'missing', 'viewer')).rejects.toMatchObject({ code: 'not-found' })
    h.repository.membershipMap.set('second-owner', {
      ...h.repository.membershipMap.get('member-viewer')!, membership_id: 'second-owner', role: 'owner',
    })
    await expect(h.service.changeRole(actor, 'second-owner', 'viewer')).resolves.toMatchObject({ role: 'viewer' })
  })

  it('validates email and uses production-safe factories when omitted', async () => {
    const h = harness()
    await boot(h)
    await expect(h.service.invite(actor, 'workspace-a', 'bad', 'viewer')).rejects.toMatchObject({ code: 'invalid' })
    const service = new StudioTenancyService({
      repository: h.repository,
      identity: h.identity,
      emailSender: { sendInvitation: () => Promise.resolve() },
    })
    const result = await service.invite(actor, 'workspace-a', 'secure@example.com', 'viewer')
    expect(result.invitation.invitation_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('covers adversarial membership, archived workspace and role-assignment branches', async () => {
    const h = harness()
    await boot(h)
    h.repository.membershipMap.set('foreign-member', {
      membership_id: 'foreign-member', org_id: 'org-b', workspace_id: 'workspace-a',
      user_id: 'foreign', email: 'foreign@example.com', role: 'viewer',
      created_at: '2026-09-02T12:00:00.000Z', updated_at: '2026-09-02T12:00:00.000Z',
    })
    expect(h.service.listMembers(actor, 'workspace-a')).toHaveLength(1)
    const workspace = h.repository.workspaceMap.get('workspace-a')!
    h.repository.workspaceMap.set('workspace-a', { ...workspace, archived_at: '2026-09-02T12:01:00.000Z' })
    expect(h.service.listWorkspaces(actor)).toEqual([])
    await expect(h.service.invite(actor, 'workspace-a', 'archived@example.com', 'viewer'))
      .rejects.toMatchObject({ code: 'not-found' })
    h.repository.workspaceMap.set('workspace-a', workspace)

    const ownerMembership = h.repository.membershipMap.get('membership:workspace-a:owner')!
    h.repository.membershipMap.set(ownerMembership.membership_id, { ...ownerMembership, role: 'admin' })
    await expect(h.service.invite(actor, 'workspace-a', 'owner2@example.com', 'owner'))
      .rejects.toMatchObject({ code: 'forbidden' })
    h.repository.membershipMap.set('target-viewer', {
      ...ownerMembership, membership_id: 'target-viewer', user_id: 'target', email: 'target@example.com', role: 'viewer',
    })
    await expect(h.service.changeRole(actor, 'target-viewer', 'admin'))
      .rejects.toMatchObject({ code: 'forbidden' })
  })

  it('does not turn an owner invitation into ownership before token acceptance', async () => {
    const h = harness()
    await boot(h)
    await h.service.invite(actor, 'workspace-a', 'pending-owner@example.com', 'owner')
    await h.service.ensureBootstrap({
      ...owner, user_id: 'pending-owner', email: 'pending-owner@example.com', bootstrap_owner: false,
    })
    expect(h.service.authorizationFor('pending-owner', 'org-a', 'workspace-a')).toBeUndefined()
  })

  it('fails closed when a legacy identity has no explicit bootstrap provenance', async () => {
    const h = harness()
    const { bootstrap_owner: _bootstrapOwner, ...legacyUser } = owner
    await h.service.ensureBootstrap(legacyUser)
    expect(h.repository.organizations()).toEqual([])
    expect(h.repository.workspaces()).toEqual([])
    expect(h.repository.memberships()).toEqual([])
  })

  it('rejects multi-organization acceptance while sessions have a single active organization', async () => {
    const h = harness()
    await boot(h)
    vi.mocked(h.identity.userRecords).mockReturnValueOnce([
      owner,
      { ...owner, user_id: 'registered-elsewhere', email: 'registered@example.com', org_id: 'org-b', bootstrap_owner: false },
    ])
    await expect(h.service.invite(actor, 'workspace-a', 'registered@example.com', 'viewer'))
      .rejects.toMatchObject({ code: 'forbidden' })
    const invitation = await h.service.invite(actor, 'workspace-a', 'other-org@example.com', 'viewer')
    await expect(h.service.acceptInvitation({
      ...owner, user_id: 'other-org', email: 'other-org@example.com', org_id: 'org-b', bootstrap_owner: false,
    }, invitation.token)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('does not let an admin create an ownerless workspace', async () => {
    const h = harness()
    await boot(h)
    const membership = h.repository.membershipMap.get('membership:workspace-a:owner')!
    h.repository.membershipMap.set(membership.membership_id, { ...membership, role: 'admin' })
    await expect(h.service.createWorkspace(actor, 'Sem proprietário')).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('never exposes an active workspace before its owner membership is durable', async () => {
    const h = harness()
    await boot(h)
    h.repository.failNextWorkspaceWrite = true
    await expect(h.service.createWorkspace(actor, 'Falha segura')).rejects.toThrow(/simulated workspace write failure/)
    expect(h.repository.workspaceMap.has('id-1')).toBe(false)
    expect(h.repository.membershipMap.get('membership:id-1:owner')).toMatchObject({ role: 'owner' })
  })

  it('never exposes the bootstrap workspace before its owner membership is durable', async () => {
    const h = harness()
    h.repository.failNextWorkspaceWrite = true
    await expect(boot(h)).rejects.toThrow(/simulated workspace write failure/)
    expect(h.repository.workspaceMap.has('workspace-a')).toBe(false)
    expect(h.repository.membershipMap.get('membership:workspace-a:owner')).toMatchObject({ role: 'owner' })
    await expect(boot(h)).resolves.toBeUndefined()
    expect(h.repository.workspaceMap.has('workspace-a')).toBe(true)
  })

  it('rejects invitation acceptance for archived workspaces and existing memberships', async () => {
    const archived = harness()
    await boot(archived)
    const archivedInvite = await archived.service.invite(actor, 'workspace-a', 'archived-user@example.com', 'viewer')
    const workspace = archived.repository.workspaceMap.get('workspace-a')!
    archived.repository.workspaceMap.set('workspace-a', { ...workspace, archived_at: '2026-09-02T12:01:00.000Z' })
    await expect(archived.service.acceptInvitation({
      ...owner, user_id: 'archived-user', email: 'archived-user@example.com', bootstrap_owner: false,
    }, archivedInvite.token)).rejects.toMatchObject({ code: 'not-found' })

    const existing = harness()
    await boot(existing)
    const existingInvite = await existing.service.invite(actor, 'workspace-a', 'existing@example.com', 'viewer')
    existing.repository.membershipMap.set('membership:workspace-a:existing', {
      membership_id: 'membership:workspace-a:existing', org_id: 'org-a', workspace_id: 'workspace-a',
      user_id: 'existing', email: 'existing@example.com', role: 'builder',
      created_at: '2026-09-02T12:00:00.000Z', updated_at: '2026-09-02T12:00:00.000Z',
    })
    await expect(existing.service.acceptInvitation({
      ...owner, user_id: 'existing', email: 'existing@example.com', bootstrap_owner: false,
    }, existingInvite.token)).rejects.toMatchObject({ code: 'replay' })
    expect(existing.service.authorizationFor('existing', 'org-a', 'workspace-a')?.role).toBe('builder')
  })

  it('serializes different active tokens that target the same membership', async () => {
    const h = harness()
    await boot(h)
    const first = await h.service.invite(actor, 'workspace-a', 'same@example.com', 'builder')
    const second = await h.service.invite(actor, 'workspace-a', 'same@example.com', 'viewer')
    h.repository.invitationMap.set(first.invitation.invitation_id, { ...first.invitation, revoked_at: null })
    const user = { ...owner, user_id: 'same', email: 'same@example.com', bootstrap_owner: false }
    const results = await Promise.allSettled([
      h.service.acceptInvitation(user, first.token),
      h.service.acceptInvitation(user, second.token),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(h.repository.memberships().filter(member => member.user_id === 'same')).toHaveLength(1)
  })
})

describe('ACHADO: uma organização não rouba a matrícula de quem outra convidou', () => {
  it('convidar para um e-mail com convite ABERTO em outra organização é RECUSADO', async () => {
    // O caminho inteiro do ataque: a organização A convida `vitima@corp.com`.
    // Qualquer dono de outra organização B que soubesse o e-mail emitia um
    // convite para o mesmo endereço — e passava, porque a recusa por "este
    // e-mail já pertence a outra organização" só olhava usuário EXISTENTE, e a
    // vítima ainda não existia. No primeiro acesso o convite de B era o mais
    // RECENTE e vencia: a pessoa nascia dentro do inquilino do ATACANTE, e
    // tudo o que ela criasse depois nascia legível para os donos de B. A
    // organização A perdia a pessoa de forma permanente.
    const h = harness()
    await boot(h)
    await h.service.invite(actor, 'workspace-a', 'vitima@corp.com', 'builder')

    // Agora a organização B tenta o mesmo e-mail.
    const atacante = { ...actor, userId: 'u-b', orgId: 'org-b', tenantId: 'workspace-b' }
    h.repository.workspaceMap.set('workspace-b', {
      workspace_id: 'workspace-b', org_id: 'org-b', name: 'Espaço do atacante',
      created_by: 'u-b', created_at: '2026-09-02T12:00:00.000Z', archived_at: null,
    })
    h.repository.membershipMap.set('m-b', {
      membership_id: 'm-b', org_id: 'org-b', workspace_id: 'workspace-b',
      user_id: 'u-b', email: 'b@example.com', role: 'owner',
      created_at: '2026-09-02T12:00:00.000Z', updated_at: '2026-09-02T12:00:00.000Z',
    })
    await expect(h.service.invite(atacante, 'workspace-b', 'vitima@corp.com', 'owner'))
      .rejects.toMatchObject({ code: 'forbidden' })

    // E a matrícula continua sendo da organização que convidou primeiro.
    expect(h.service.enrollmentGrantFor('vitima@corp.com'))
      .toEqual({ orgId: 'org-a', tenantId: 'workspace-a', role: 'builder' })
  })

  it('mesmo com dois convites abertos, o MAIS ANTIGO vence', async () => {
    // Segunda camada, e ela precisa existir: um convite gravado ANTES desta
    // regra — ou por qualquer caminho que não passe por `invite` — não pode ser
    // ultrapassado por recência. Recência é exatamente a alavanca do ataque.
    const h = harness()
    await boot(h)
    const primeiro = await h.service.invite(actor, 'workspace-a', 'vitima@corp.com', 'builder')
    h.repository.invitationMap.set('de-outra-org', {
      ...primeiro.invitation, invitation_id: 'de-outra-org', org_id: 'org-b', workspace_id: 'workspace-b',
      role: 'owner', created_at: '2026-09-02T12:05:00.000Z',
    })
    expect(h.service.enrollmentGrantFor('vitima@corp.com'))
      .toEqual({ orgId: 'org-a', tenantId: 'workspace-a', role: 'builder' })
  })

  it('convidar de novo DENTRO da mesma organização continua funcionando', async () => {
    // A trava não pode pegar o caso normal: trocar o papel de um convite ainda
    // não aceito é coisa de todo dia, e `invite` revoga o anterior.
    const h = harness()
    await boot(h)
    await h.service.invite(actor, 'workspace-a', 'nova@corp.com', 'viewer')
    await expect(h.service.invite(actor, 'workspace-a', 'nova@corp.com', 'builder')).resolves.toBeDefined()
    expect(h.service.enrollmentGrantFor('nova@corp.com')).toMatchObject({ role: 'builder' })
  })
})
