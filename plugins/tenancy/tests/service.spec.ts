import { describe, expect, it, vi } from 'vitest'
import type { EmailSender, IdentityUser, StudioIdentityService } from '@dz23-studio/identity'
import type { Invitation, Membership, Organization, Workspace } from '../src/model.ts'
import { StudioTenancyService, type TenancyActor, type TenancyRepository } from '../src/service.ts'

class MemoryRepository implements TenancyRepository {
  readonly orgMap = new Map<string, Organization>()
  readonly workspaceMap = new Map<string, Workspace>()
  readonly membershipMap = new Map<string, Membership>()
  readonly invitationMap = new Map<string, Invitation>()
  organizations() { return [...this.orgMap.values()] }
  putOrganization(value: Organization) { this.orgMap.set(value.org_id, value); return Promise.resolve() }
  workspaces() { return [...this.workspaceMap.values()] }
  putWorkspace(value: Workspace) { this.workspaceMap.set(value.workspace_id, value); return Promise.resolve() }
  memberships() { return [...this.membershipMap.values()] }
  putMembership(value: Membership) { this.membershipMap.set(value.membership_id, value); return Promise.resolve() }
  invitations() { return [...this.invitationMap.values()] }
  putInvitation(value: Invitation) { this.invitationMap.set(value.invitation_id, value); return Promise.resolve() }
}

const owner: IdentityUser = {
  user_id: 'owner', email: 'owner@example.com', display_name: 'Owner', role: 'owner',
  org_id: 'org-a', tenant_id: 'workspace-a', created_at: '2026-09-02T12:00:00.000Z',
}
const actor: TenancyActor = { userId: 'owner', email: owner.email, orgId: 'org-a', tenantId: 'workspace-a' }

function harness() {
  const repository = new MemoryRepository()
  const invitations: Parameters<EmailSender['sendInvitation']>[0][] = []
  const identity = {
    recordAdministrationEvent: vi.fn(() => Promise.resolve()),
    userForSession: vi.fn(() => owner),
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
    await h.service.ensureBootstrap({ ...owner, user_id: 'viewer', role: 'viewer' })
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
    h.repository.invitationMap.set('newer-active', {
      ...second.invitation, invitation_id: 'newer-active', created_at: '2026-09-02T12:01:00.000Z', role: 'admin',
    })
    expect(h.service.enrollmentGrantFor('new@example.com')).toMatchObject({ role: 'admin' })
    h.repository.invitationMap.delete('newer-active')
    const invitedUser = { ...owner, user_id: 'new-user', email: 'new@example.com', role: 'viewer' as const }
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
    const raceUser = { ...owner, user_id: 'race', email: 'race@example.com', role: 'builder' as const }
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
})
