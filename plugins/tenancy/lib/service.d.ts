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