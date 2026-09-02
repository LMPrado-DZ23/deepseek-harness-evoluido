import { createTenancyHttpHandler } from './http.js';
import { studioMembershipsDomainSpec, studioOrgsDomainSpec, studioWorkspacesDomainSpec, } from './model.js';
import { StudioTenancyService } from './service.js';
export * from './http.js';
export * from './model.js';
export * from './service.js';
export const name = 'dz23-studio-tenancy';
export const inject = ['storageDomain', 'webServer', 'studioIdentity', 'studioPolicy'];
class DomainTenancyRepository {
    orgTable;
    workspaceTable;
    membershipTable;
    invitationTable;
    constructor(orgTable, workspaceTable, membershipTable, invitationTable) {
        this.orgTable = orgTable;
        this.workspaceTable = workspaceTable;
        this.membershipTable = membershipTable;
        this.invitationTable = invitationTable;
    }
    organizations() { return values(this.orgTable); }
    putOrganization(record) { return this.orgTable.put(record.org_id, record); }
    workspaces() { return values(this.workspaceTable); }
    putWorkspace(record) { return this.workspaceTable.put(record.workspace_id, record); }
    memberships() { return values(this.membershipTable); }
    putMembership(record) { return this.membershipTable.put(record.membership_id, record); }
    invitations() { return values(this.invitationTable); }
    putInvitation(record) { return this.invitationTable.put(record.invitation_id, record); }
}
function values(table) {
    return [...table.entries()].map(([, value]) => value);
}
export async function apply(ctx, config = {}) {
    const [orgDomain, workspaceDomain, membershipDomain] = await Promise.all([
        ctx.storageDomain.open(studioOrgsDomainSpec),
        ctx.storageDomain.open(studioWorkspacesDomainSpec),
        ctx.storageDomain.open(studioMembershipsDomainSpec),
    ]);
    ctx.effect(() => async () => {
        await Promise.all([orgDomain.close(), workspaceDomain.close(), membershipDomain.close()]);
    }, 'dz23-studio-tenancy.domainClose');
    const service = new StudioTenancyService({
        repository: new DomainTenancyRepository(orgDomain.table('orgs'), workspaceDomain.table('workspaces'), membershipDomain.table('memberships'), membershipDomain.table('invitations')),
        identity: ctx.studioIdentity.service,
        emailSender: { sendInvitation: message => ctx.studioIdentity.service.sendInvitation(message) },
        ...(config.now === undefined ? {} : { now: config.now }),
        ...(config.createId === undefined ? {} : { createId: config.createId }),
        ...(config.createSecret === undefined ? {} : { createSecret: config.createSecret }),
    });
    for (const user of ctx.studioIdentity.service.userRecords())
        await service.ensureBootstrap(user);
    const unsetEnrollment = ctx.studioIdentity.service.setEnrollmentResolver(email => service.enrollmentGrantFor(email));
    const unsetProvisioner = ctx.studioIdentity.service.setUserProvisioner((user, source) => (source === 'bootstrap' ? service.ensureBootstrap(user) : Promise.resolve()));
    const unsetAuthorization = ctx.studioPolicy.setAuthorizationResolver(execution => {
        const harnessSessionId = execution.agent === undefined ? '' : String(execution.agent.session.id);
        const principal = ctx.studioIdentity.service.principalForHarnessSession(harnessSessionId);
        return principal === undefined
            ? undefined
            : service.authorizationFor(principal.userId, principal.orgId, principal.tenantId);
    });
    ctx.effect(() => () => { unsetAuthorization(); unsetProvisioner(); unsetEnrollment(); }, 'dz23-studio-tenancy.resolvers');
    ctx.provide('studioTenancy', { service });
    const port = ctx.webServer.port;
    const defaultHost = `127.0.0.1:${port}`;
    const defaultOrigin = `http://localhost:${port}`;
    ctx.effect(() => ctx.webServer.register({
        kind: 'prefix',
        path: '/api/studio/tenancy',
        handler: createTenancyHttpHandler({
            service,
            identity: ctx.studioIdentity.service,
            allowedHosts: config.allowedHosts ?? [defaultHost, `localhost:${port}`],
            allowedOrigins: config.allowedOrigins ?? [defaultOrigin, `http://${defaultHost}`],
        }),
    }), 'dz23-studio-tenancy.http');
}
