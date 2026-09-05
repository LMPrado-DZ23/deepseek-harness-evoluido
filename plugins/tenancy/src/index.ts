import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { principalForAgent } from '@dz23-studio/identity'
import type {} from '@dz23-studio/policy'
import { createTenancyHttpHandler } from './http.js'
import {
  studioMembershipsDomainSpec,
  studioOrgsDomainSpec,
  studioWorkspacesDomainSpec,
  type Invitation,
  type Membership,
  type Organization,
  type TenancyKey,
  type Workspace,
} from './model.js'
import { StudioTenancyService, type TenancyRepository } from './service.js'

export * from './http.js'
export * from './model.js'
export * from './service.js'

export const name = 'dz23-studio-tenancy'
export const inject = ['agents', 'storageDomain', 'webServer', 'studioIdentity', 'studioPolicy']

export interface TenancyPluginConfig {
  readonly allowedHosts?: readonly string[]
  readonly allowedOrigins?: readonly string[]
  readonly now?: () => Date
  readonly createId?: () => string
  readonly createSecret?: () => string
}

export interface StudioTenancyRuntime {
  readonly service: StudioTenancyService
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    studioTenancy: StudioTenancyRuntime
  }
}

class DomainTenancyRepository implements TenancyRepository {
  constructor(
    private readonly orgTable: KvTable<TenancyKey, Organization>,
    private readonly workspaceTable: KvTable<TenancyKey, Workspace>,
    private readonly membershipTable: KvTable<TenancyKey, Membership>,
    private readonly invitationTable: KvTable<TenancyKey, Invitation>,
  ) {}

  organizations(): readonly Organization[] { return values(this.orgTable) }
  putOrganization(record: Organization): Promise<void> { return this.orgTable.put(record.org_id as TenancyKey, record) }
  workspaces(): readonly Workspace[] { return values(this.workspaceTable) }
  putWorkspace(record: Workspace): Promise<void> { return this.workspaceTable.put(record.workspace_id as TenancyKey, record) }
  memberships(): readonly Membership[] { return values(this.membershipTable) }
  putMembership(record: Membership): Promise<void> { return this.membershipTable.put(record.membership_id as TenancyKey, record) }
  invitations(): readonly Invitation[] { return values(this.invitationTable) }
  putInvitation(record: Invitation): Promise<void> { return this.invitationTable.put(record.invitation_id as TenancyKey, record) }
}

function values<T>(table: KvTable<TenancyKey, T>): T[] {
  return [...table.entries()].map(([, value]) => value)
}

export async function apply(ctx: Context, config: TenancyPluginConfig = {}): Promise<void> {
  const [orgDomain, workspaceDomain, membershipDomain]: [
    Domain<typeof studioOrgsDomainSpec>,
    Domain<typeof studioWorkspacesDomainSpec>,
    Domain<typeof studioMembershipsDomainSpec>,
  ] = await Promise.all([
    ctx.storageDomain.open(studioOrgsDomainSpec),
    ctx.storageDomain.open(studioWorkspacesDomainSpec),
    ctx.storageDomain.open(studioMembershipsDomainSpec),
  ])
  ctx.effect(() => async () => {
    await Promise.all([orgDomain.close(), workspaceDomain.close(), membershipDomain.close()])
  }, 'dz23-studio-tenancy.domainClose')

  const service = new StudioTenancyService({
    repository: new DomainTenancyRepository(
      orgDomain.table('orgs'),
      workspaceDomain.table('workspaces'),
      membershipDomain.table('memberships'),
      membershipDomain.table('invitations'),
    ),
    identity: ctx.studioIdentity.service,
    emailSender: { sendInvitation: message => ctx.studioIdentity.service.sendInvitation(message) },
    ...(config.now === undefined ? {} : { now: config.now }),
    ...(config.createId === undefined ? {} : { createId: config.createId }),
    ...(config.createSecret === undefined ? {} : { createSecret: config.createSecret }),
  })

  for (const user of ctx.studioIdentity.service.userRecords()) await service.ensureBootstrap(user)
  const unsetEnrollment = ctx.studioIdentity.service.setEnrollmentResolver(email => service.enrollmentGrantFor(email))
  const unsetProvisioner = ctx.studioIdentity.service.setUserProvisioner((user, source) => (
    source === 'bootstrap' ? service.ensureBootstrap(user) : Promise.resolve()
  ))
  type RegistrySessionId = Parameters<typeof ctx.agents.get>[0]
  const agentLookup = {
    getBySessionId: (sessionId: string) => ctx.agents.get(sessionId as RegistrySessionId),
  }
  const unsetAuthorization = ctx.studioPolicy.setAuthorizationResolver(execution => {
    const principal = principalForAgent(ctx.studioIdentity.service, agentLookup, execution.agent)
    return principal === undefined
      ? undefined
      : service.authorizationFor(principal.userId, principal.orgId, principal.tenantId)
  })
  ctx.effect(() => () => { unsetAuthorization(); unsetProvisioner(); unsetEnrollment() }, 'dz23-studio-tenancy.resolvers')
  ctx.provide('studioTenancy', { service })

  const port = ctx.webServer.port
  const defaultHost = `127.0.0.1:${port}`
  const defaultOrigin = `http://localhost:${port}`
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/studio/tenancy',
    handler: createTenancyHttpHandler({
      service,
      identity: ctx.studioIdentity.service,
      allowedHosts: config.allowedHosts ?? [defaultHost, `localhost:${port}`],
      allowedOrigins: config.allowedOrigins ?? [defaultOrigin, `http://${defaultHost}`],
    }),
  }), 'dz23-studio-tenancy.http')
}
