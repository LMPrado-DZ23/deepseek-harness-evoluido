import type { EmailSender } from '@dz23-studio/identity';
import { type StudioRole } from '@dz23-studio/policy';
import type { IdentityUser, SessionRecord, StudioIdentityService } from '@dz23-studio/identity';
import type { Invitation, Membership, Organization, Workspace } from './model.js';
export interface TenancyRepository {
    organizations(): readonly Organization[];
    putOrganization(record: Organization): Promise<void>;
    workspaces(): readonly Workspace[];
    putWorkspace(record: Workspace): Promise<void>;
    memberships(): readonly Membership[];
    putMembership(record: Membership): Promise<void>;
    invitations(): readonly Invitation[];
    putInvitation(record: Invitation): Promise<void>;
}
export interface TenancyActor {
    readonly userId: string;
    readonly email: string;
    readonly orgId: string;
    readonly tenantId: string;
}
export interface TenancyAuthorization {
    readonly userId: string;
    readonly orgId: string;
    readonly tenantId: string;
    readonly role: StudioRole;
}
export declare class TenancyError extends Error {
    readonly code: 'invalid' | 'not-found' | 'forbidden' | 'expired' | 'replay' | 'last-owner';
    constructor(code: 'invalid' | 'not-found' | 'forbidden' | 'expired' | 'replay' | 'last-owner', message: string);
}
export interface TenancyServiceOptions {
    readonly repository: TenancyRepository;
    readonly identity: StudioIdentityService;
    readonly emailSender: Pick<EmailSender, 'sendInvitation'>;
    readonly now?: () => Date;
    readonly createId?: () => string;
    readonly createSecret?: () => string;
}
export declare class StudioTenancyService {
    #private;
    constructor(options: TenancyServiceOptions);
    ensureBootstrap(user: IdentityUser): Promise<void>;
    enrollmentGrantFor(email: string): {
        orgId: string;
        tenantId: string;
        role: "owner" | "admin" | "builder" | "viewer";
    } | undefined;
    authorizationFor(userId: string, orgId: string, tenantId: string): TenancyAuthorization | undefined;
    actorFromSession(session: SessionRecord): TenancyActor;
    listWorkspaces(actor: TenancyActor): readonly Workspace[];
    listMembers(actor: TenancyActor, workspaceId: string): readonly Membership[];
    createWorkspace(actor: TenancyActor, name: string): Promise<Workspace>;
    invite(actor: TenancyActor, workspaceId: string, email: string, role: StudioRole): Promise<{
        invitation: Invitation;
        token: string;
    }>;
    acceptInvitation(user: IdentityUser, token: string): Promise<Membership>;
    changeRole(actor: TenancyActor, membershipIdValue: string, role: StudioRole): Promise<Membership>;
}
//# sourceMappingURL=service.d.ts.map