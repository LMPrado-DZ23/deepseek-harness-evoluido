import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { studioRoleSchema } from '@dz23-studio/policy';
import { z } from 'zod';
export const organizationSchema = z.object({
    org_id: z.string().min(1),
    name: z.string().min(1).max(120),
    owner_user_id: z.string().min(1),
    created_at: z.iso.datetime(),
}).strict();
export const workspaceSchema = z.object({
    workspace_id: z.string().min(1),
    org_id: z.string().min(1),
    name: z.string().min(1).max(120),
    created_by: z.string().min(1),
    created_at: z.iso.datetime(),
    archived_at: z.iso.datetime().nullable(),
}).strict();
export const membershipSchema = z.object({
    membership_id: z.string().min(1),
    org_id: z.string().min(1),
    workspace_id: z.string().min(1),
    user_id: z.string().min(1),
    email: z.email(),
    role: studioRoleSchema,
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
}).strict();
export const invitationSchema = z.object({
    invitation_id: z.string().min(1),
    org_id: z.string().min(1),
    workspace_id: z.string().min(1),
    email: z.email(),
    role: studioRoleSchema,
    token_hash: z.string().regex(/^[a-f0-9]{64}$/),
    invited_by: z.string().min(1),
    created_at: z.iso.datetime(),
    expires_at: z.iso.datetime(),
    accepted_at: z.iso.datetime().nullable(),
    revoked_at: z.iso.datetime().nullable(),
}).strict();
export const STUDIO_ORGS_PHYSICAL_DOMAIN = 'studio_orgs';
export const STUDIO_ORGS_LOGICAL_DOMAIN = 'studio.orgs';
export const STUDIO_WORKSPACES_PHYSICAL_DOMAIN = 'studio_workspaces';
export const STUDIO_WORKSPACES_LOGICAL_DOMAIN = 'studio.workspaces';
export const STUDIO_MEMBERSHIPS_PHYSICAL_DOMAIN = 'studio_memberships';
export const STUDIO_MEMBERSHIPS_LOGICAL_DOMAIN = 'studio.memberships';
export const studioOrgsDomainSpec = defineDomain({
    name: STUDIO_ORGS_PHYSICAL_DOMAIN,
    version: 1,
    tables: { orgs: domainTable(organizationSchema) },
});
export const studioWorkspacesDomainSpec = defineDomain({
    name: STUDIO_WORKSPACES_PHYSICAL_DOMAIN,
    version: 1,
    tables: { workspaces: domainTable(workspaceSchema) },
});
export const studioMembershipsDomainSpec = defineDomain({
    name: STUDIO_MEMBERSHIPS_PHYSICAL_DOMAIN,
    version: 1,
    tables: {
        memberships: domainTable(membershipSchema),
        invitations: domainTable(invitationSchema),
    },
});
