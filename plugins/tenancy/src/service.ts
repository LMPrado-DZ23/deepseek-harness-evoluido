import { randomUUID } from 'node:crypto'
import type { EmailSender } from '@dz23-studio/identity'
import { KeyedMutex, newOpaqueSecret, secretHash } from '@dz23-studio/identity'
import { roleAllows, roleCanAssign, type StudioPermission, type StudioRole } from '@dz23-studio/policy'
import type { IdentityUser, SessionRecord, StudioIdentityService } from '@dz23-studio/identity'
import type { Invitation, Membership, Organization, Workspace } from './model.js'
import { t } from './i18n.js'

const INVITATION_TTL = 72 * 60 * 60 * 1_000

export interface TenancyRepository {
  organizations(): readonly Organization[]
  putOrganization(record: Organization): Promise<void>
  workspaces(): readonly Workspace[]
  putWorkspace(record: Workspace): Promise<void>
  memberships(): readonly Membership[]
  putMembership(record: Membership): Promise<void>
  invitations(): readonly Invitation[]
  putInvitation(record: Invitation): Promise<void>
}

export interface TenancyActor {
  readonly userId: string
  readonly email: string
  readonly orgId: string
  readonly tenantId: string
}

export interface TenancyAuthorization {
  readonly userId: string
  readonly orgId: string
  readonly tenantId: string
  readonly role: StudioRole
}

export class TenancyError extends Error {
  constructor(
    readonly code: 'invalid' | 'not-found' | 'forbidden' | 'expired' | 'replay' | 'last-owner',
    message: string,
  ) {
    super(message)
  }
}

export interface TenancyServiceOptions {
  readonly repository: TenancyRepository
  readonly identity: StudioIdentityService
  readonly emailSender: Pick<EmailSender, 'sendInvitation'>
  readonly now?: () => Date
  readonly createId?: () => string
  readonly createSecret?: () => string
}

export class StudioTenancyService {
  readonly #repository: TenancyRepository
  readonly #identity: StudioIdentityService
  readonly #emailSender: Pick<EmailSender, 'sendInvitation'>
  readonly #now: () => Date
  readonly #createId: () => string
  readonly #createSecret: () => string
  readonly #mutex = new KeyedMutex()

  constructor(options: TenancyServiceOptions) {
    this.#repository = options.repository
    this.#identity = options.identity
    this.#emailSender = options.emailSender
    this.#now = options.now ?? (() => new Date())
    this.#createId = options.createId ?? randomUUID
    this.#createSecret = options.createSecret ?? newOpaqueSecret
  }

  async ensureBootstrap(user: IdentityUser): Promise<void> {
    if (user.bootstrap_owner !== true) return
    const now = this.#now().toISOString()
    if (!this.#repository.organizations().some(org => org.org_id === user.org_id)) {
      await this.#repository.putOrganization({
        org_id: user.org_id,
        name: 'Meu DZ23 STUDIO',
        owner_user_id: user.user_id,
        created_at: now,
      })
    }
    if (!this.#membership(user.user_id, user.tenant_id)) {
      await this.#repository.putMembership({
        membership_id: membershipId(user.user_id, user.tenant_id),
        org_id: user.org_id,
        workspace_id: user.tenant_id,
        user_id: user.user_id,
        email: user.email,
        role: 'owner',
        created_at: now,
        updated_at: now,
      })
    }
    if (!this.#repository.workspaces().some(workspace => workspace.workspace_id === user.tenant_id)) {
      await this.#repository.putWorkspace({
        workspace_id: user.tenant_id,
        org_id: user.org_id,
        name: t('service.meuEspacoTrabalho'),
        created_by: user.user_id,
        created_at: now,
        archived_at: null,
      })
    }
  }

  /**
   * A qual organização um e-mail AINDA SEM CONTA pertence, pelo convite aberto.
   *
   * Quem vence é o convite MAIS ANTIGO, e essa inversão é o conserto de um
   * sequestro de matrícula entre organizações. Antes vencia o mais RECENTE:
   * a organização A convidava `vitima@corp.com`; qualquer dono de outra
   * organização B que soubesse o e-mail emitia um convite para o mesmo
   * endereço — e passava, porque a recusa por e-mail que já pertence a outra
   * organização só olha usuário EXISTENTE, e a vítima ainda não existia. No
   * primeiro acesso, o convite de B era o mais novo e ganhava: a pessoa
   * nascia dentro do inquilino do ATACANTE, e tudo o que ela criasse depois —
   * projetos, conversas, anexos — nascia legível para os donos de B. A
   * organização A perdia a pessoa de forma permanente, porque o convite dela
   * passava a ser recusado.
   *
   * Duas defesas, e as duas precisam existir: `#inviteLocked` recusa criar um
   * convite para um e-mail que já tem convite aberto em OUTRA organização, e
   * aqui o mais antigo vence — para que nenhum convite gravado antes desta
   * regra possa ser ultrapassado por recência.
   * @param email - o endereço, na forma que a pessoa digitou.
   * @returns a organização, o inquilino e o papel do convite, ou `undefined`.
   */
  enrollmentGrantFor(email: string) {
    const normalized = normalizeEmail(email)
    const invitation = this.#repository.invitations()
      .filter(candidate => candidate.email === normalized && candidate.accepted_at === null
        && candidate.revoked_at === null && Date.parse(candidate.expires_at) > this.#now().getTime())
      .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.invitation_id.localeCompare(right.invitation_id))[0]
    return invitation === undefined ? undefined : {
      orgId: invitation.org_id,
      tenantId: invitation.workspace_id,
      role: invitation.role,
    }
  }

  authorizationFor(userId: string, orgId: string, tenantId: string): TenancyAuthorization | undefined {
    const membership = this.#repository.memberships().find(candidate => candidate.user_id === userId
      && candidate.org_id === orgId && candidate.workspace_id === tenantId)
    return membership === undefined ? undefined : { userId, orgId, tenantId, role: membership.role }
  }

  actorFromSession(session: SessionRecord): TenancyActor {
    const user = this.#identity.userForSession(session)
    return { userId: user.user_id, email: user.email, orgId: session.org_id, tenantId: session.tenant_id }
  }

  listWorkspaces(actor: TenancyActor): readonly Workspace[] {
    const allowed = new Set(this.#repository.memberships()
      .filter(membership => membership.user_id === actor.userId && membership.org_id === actor.orgId)
      .map(membership => membership.workspace_id))
    return this.#repository.workspaces().filter(workspace => allowed.has(workspace.workspace_id)
      && workspace.archived_at === null)
  }

  listMembers(actor: TenancyActor, workspaceId: string): readonly Membership[] {
    this.#authorize(actor, workspaceId, 'members.read')
    return this.#repository.memberships().filter(membership => membership.workspace_id === workspaceId
      && membership.org_id === actor.orgId)
  }

  async createWorkspace(actor: TenancyActor, name: string): Promise<Workspace> {
    this.#authorize(actor, actor.tenantId, 'workspace.create')
    const normalizedName = name.trim()
    if (normalizedName === '') throw new TenancyError('invalid', t('service.digiteNomeEspacoTrabalho'))
    const now = this.#now().toISOString()
    const workspace: Workspace = {
      workspace_id: this.#createId(),
      org_id: actor.orgId,
      name: normalizedName,
      created_by: actor.userId,
      created_at: now,
      archived_at: null,
    }
    await this.#repository.putMembership({
      membership_id: membershipId(actor.userId, workspace.workspace_id),
      org_id: actor.orgId,
      workspace_id: workspace.workspace_id,
      user_id: actor.userId,
      email: actor.email,
      role: 'owner',
      created_at: now,
      updated_at: now,
    })
    await this.#repository.putWorkspace(workspace)
    await this.#identity.recordAdministrationEvent('workspace_created', actor.userId, actor.orgId, workspace.workspace_id, t('service.espacoTrabalhoCriado'))
    return workspace
  }

  async invite(actor: TenancyActor, workspaceId: string, email: string, role: StudioRole): Promise<{ invitation: Invitation; token: string }> {
    return this.#mutex.run(`invite:${workspaceId}:${email.trim().toLowerCase()}`, () => this.#inviteLocked(actor, workspaceId, email, role))
  }

  async #inviteLocked(actor: TenancyActor, workspaceId: string, email: string, role: StudioRole): Promise<{ invitation: Invitation; token: string }> {
    const actorMembership = this.#authorize(actor, workspaceId, 'members.manage')
    if (!roleCanAssign(actorMembership.role, role)) throw new TenancyError('forbidden', t('service.seuPapelNaoPode'))
    const normalized = normalizeEmail(email)
    const existingUser = this.#identity.userRecords().find(user => user.email === normalized)
    if (existingUser !== undefined && existingUser.org_id !== actor.orgId) {
      throw new TenancyError('forbidden', t('service.esteMailJaPertence'))
    }
    // A mesma regra, para quem AINDA NÃO TEM CONTA. Sem ela, a recusa acima
    // não alcançava justamente o caso perigoso: a pessoa convidada por outra
    // organização e que ainda não entrou. Qualquer dono que soubesse o e-mail
    // emitia um convite concorrente e sequestrava a matrícula dela.
    const pendingElsewhere = this.#repository.invitations().some(candidate => candidate.email === normalized
      && candidate.org_id !== actor.orgId && candidate.accepted_at === null && candidate.revoked_at === null
      && Date.parse(candidate.expires_at) > this.#now().getTime())
    if (pendingElsewhere) throw new TenancyError('forbidden', t('service.esteMailJaPertence'))
    if (this.#repository.memberships().some(member => member.workspace_id === workspaceId && member.email === normalized)) {
      throw new TenancyError('invalid', t('service.estaPessoaJaParticipa'))
    }
    const workspace = this.#workspace(actor.orgId, workspaceId)
    const now = this.#now()
    await Promise.all(this.#repository.invitations()
      .filter(previous => previous.workspace_id === workspaceId && previous.email === normalized
        && previous.accepted_at === null && previous.revoked_at === null)
      .map(previous => this.#repository.putInvitation({ ...previous, revoked_at: now.toISOString() })))
    const token = this.#createSecret()
    const invitation: Invitation = {
      invitation_id: this.#createId(),
      org_id: actor.orgId,
      workspace_id: workspaceId,
      email: normalized,
      role,
      token_hash: secretHash(token),
      invited_by: actor.userId,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + INVITATION_TTL).toISOString(),
      accepted_at: null,
      revoked_at: null,
    }
    await this.#repository.putInvitation(invitation)
    await this.#emailSender.sendInvitation({
      to: normalized, token, workspaceName: workspace.name, role, expiresInHours: 72,
    })
    await this.#identity.recordAdministrationEvent('invitation_created', actor.userId, actor.orgId, workspaceId, t('audit.invitationCreated'))
    return { invitation, token }
  }

  async acceptInvitation(user: IdentityUser, token: string): Promise<Membership> {
    const tokenHash = secretHash(token)
    return this.#mutex.run(`invitation:${tokenHash}`, async () => {
      const invitation = this.#invitationForUser(user, tokenHash)
      return this.#mutex.run(
        `invite:${invitation.workspace_id}:${invitation.email}`,
        () => this.#mutex.run(
          `membership:${membershipId(user.user_id, invitation.workspace_id)}`,
          () => this.#acceptInvitationLocked(user, tokenHash),
        ),
      )
    })
  }

  async #acceptInvitationLocked(user: IdentityUser, tokenHash: string): Promise<Membership> {
    const invitation = this.#invitationForUser(user, tokenHash)
    if (invitation.revoked_at !== null || invitation.accepted_at !== null) throw new TenancyError('replay', t('service.esteConviteNaoEsta'))
    if (Date.parse(invitation.expires_at) <= this.#now().getTime()) throw new TenancyError('expired', t('errors.invitationExpired'))
    if (user.org_id !== invitation.org_id) throw new TenancyError('forbidden', t('service.esteConvitePertenceOutra'))
    this.#workspace(invitation.org_id, invitation.workspace_id)
    if (this.#membership(user.user_id, invitation.workspace_id) !== undefined) {
      throw new TenancyError('replay', t('service.estaPessoaJaParticipa'))
    }
    const now = this.#now().toISOString()
    const membership: Membership = {
      membership_id: membershipId(user.user_id, invitation.workspace_id),
      org_id: invitation.org_id,
      workspace_id: invitation.workspace_id,
      user_id: user.user_id,
      email: user.email,
      role: invitation.role,
      created_at: now,
      updated_at: now,
    }
    await this.#repository.putMembership(membership)
    await this.#repository.putInvitation({ ...invitation, accepted_at: now })
    await this.#identity.recordAdministrationEvent('invitation_accepted', user.user_id, invitation.org_id, invitation.workspace_id, t('audit.invitationAccepted'))
    return membership
  }

  #invitationForUser(user: IdentityUser, tokenHash: string): Invitation {
    const invitation = this.#repository.invitations().find(candidate => candidate.token_hash === tokenHash)
    if (invitation === undefined || invitation.email !== user.email) {
      throw new TenancyError('not-found', t('service.conviteInvalidoNaoEncontrado'))
    }
    return invitation
  }

  async changeRole(actor: TenancyActor, membershipIdValue: string, role: StudioRole): Promise<Membership> {
    return this.#mutex.run(`membership:${membershipIdValue}`, () => this.#changeRoleLocked(actor, membershipIdValue, role))
  }

  async #changeRoleLocked(actor: TenancyActor, membershipIdValue: string, role: StudioRole): Promise<Membership> {
    const target = this.#repository.memberships().find(candidate => candidate.membership_id === membershipIdValue)
    if (target === undefined || target.org_id !== actor.orgId) throw new TenancyError('not-found', t('service.membroNaoEncontrado'))
    const actorMembership = this.#authorize(actor, target.workspace_id, 'members.manage')
    if (!roleCanAssign(actorMembership.role, role)) throw new TenancyError('forbidden', t('service.seuPapelNaoPode'))
    if (target.role === 'owner' && actorMembership.role !== 'owner') throw new TenancyError('forbidden', t('service.somentePessoaProprietariaPode'))
    if (target.role === 'owner' && role !== 'owner') {
      const owners = this.#repository.memberships().filter(member => member.workspace_id === target.workspace_id && member.role === 'owner')
      if (owners.length <= 1) throw new TenancyError('last-owner', t('service.espacoPrecisaManterMenos'))
    }
    const updated = { ...target, role, updated_at: this.#now().toISOString() }
    await this.#repository.putMembership(updated)
    await this.#identity.recordAdministrationEvent('role_changed', actor.userId, target.org_id, target.workspace_id, t('audit.memberRoleChanged'))
    return updated
  }

  #membership(userId: string, workspaceId: string): Membership | undefined {
    return this.#repository.memberships().find(candidate => candidate.user_id === userId && candidate.workspace_id === workspaceId)
  }

  #authorize(actor: TenancyActor, workspaceId: string, permission: StudioPermission): Membership {
    const membership = this.#membership(actor.userId, workspaceId)
    if (membership === undefined || membership.org_id !== actor.orgId) throw new TenancyError('not-found', t('service.espacoTrabalhoNaoEncontrado'))
    if (!roleAllows(membership.role, permission)) throw new TenancyError('forbidden', t('http.seuPapelNaoPermite'))
    return membership
  }

  #workspace(orgId: string, workspaceId: string): Workspace {
    const workspace = this.#repository.workspaces().find(candidate => candidate.workspace_id === workspaceId
      && candidate.org_id === orgId && candidate.archived_at === null)
    if (workspace === undefined) throw new TenancyError('not-found', t('service.espacoTrabalhoNaoEncontrado'))
    return workspace
  }
}

function membershipId(userId: string, workspaceId: string): string {
  return `membership:${workspaceId}:${userId}`
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new TenancyError('invalid', t('service.digiteMailValido'))
  return normalized
}
