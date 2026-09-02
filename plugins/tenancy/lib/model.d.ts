import { z } from 'zod';
export declare const organizationSchema: z.ZodObject<{
    org_id: z.ZodString;
    name: z.ZodString;
    owner_user_id: z.ZodString;
    created_at: z.ZodISODateTime;
}, z.core.$strict>;
export declare const workspaceSchema: z.ZodObject<{
    workspace_id: z.ZodString;
    org_id: z.ZodString;
    name: z.ZodString;
    created_by: z.ZodString;
    created_at: z.ZodISODateTime;
    archived_at: z.ZodNullable<z.ZodISODateTime>;
}, z.core.$strict>;
export declare const membershipSchema: z.ZodObject<{
    membership_id: z.ZodString;
    org_id: z.ZodString;
    workspace_id: z.ZodString;
    user_id: z.ZodString;
    email: z.ZodEmail;
    role: z.ZodEnum<{
        owner: "owner";
        admin: "admin";
        builder: "builder";
        viewer: "viewer";
    }>;
    created_at: z.ZodISODateTime;
    updated_at: z.ZodISODateTime;
}, z.core.$strict>;
export declare const invitationSchema: z.ZodObject<{
    invitation_id: z.ZodString;
    org_id: z.ZodString;
    workspace_id: z.ZodString;
    email: z.ZodEmail;
    role: z.ZodEnum<{
        owner: "owner";
        admin: "admin";
        builder: "builder";
        viewer: "viewer";
    }>;
    token_hash: z.ZodString;
    invited_by: z.ZodString;
    created_at: z.ZodISODateTime;
    expires_at: z.ZodISODateTime;
    accepted_at: z.ZodNullable<z.ZodISODateTime>;
    revoked_at: z.ZodNullable<z.ZodISODateTime>;
}, z.core.$strict>;
export type Organization = z.infer<typeof organizationSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type Membership = z.infer<typeof membershipSchema>;
export type Invitation = z.infer<typeof invitationSchema>;
declare const tenancyKeyBrand: unique symbol;
export type TenancyKey = string & {
    readonly [tenancyKeyBrand]: true;
};
export declare const STUDIO_ORGS_PHYSICAL_DOMAIN = "studio_orgs";
export declare const STUDIO_ORGS_LOGICAL_DOMAIN = "studio.orgs";
export declare const STUDIO_WORKSPACES_PHYSICAL_DOMAIN = "studio_workspaces";
export declare const STUDIO_WORKSPACES_LOGICAL_DOMAIN = "studio.workspaces";
export declare const STUDIO_MEMBERSHIPS_PHYSICAL_DOMAIN = "studio_memberships";
export declare const STUDIO_MEMBERSHIPS_LOGICAL_DOMAIN = "studio.memberships";
export declare const studioOrgsDomainSpec: {
    name: string;
    version: number;
    tables: {
        orgs: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<TenancyKey, {
            org_id: string;
            name: string;
            owner_user_id: string;
            created_at: string;
        }>;
    };
};
export declare const studioWorkspacesDomainSpec: {
    name: string;
    version: number;
    tables: {
        workspaces: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<TenancyKey, {
            workspace_id: string;
            org_id: string;
            name: string;
            created_by: string;
            created_at: string;
            archived_at: string | null;
        }>;
    };
};
export declare const studioMembershipsDomainSpec: {
    name: string;
    version: number;
    tables: {
        memberships: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<TenancyKey, {
            membership_id: string;
            org_id: string;
            workspace_id: string;
            user_id: string;
            email: string;
            role: "owner" | "admin" | "builder" | "viewer";
            created_at: string;
            updated_at: string;
        }>;
        invitations: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<TenancyKey, {
            invitation_id: string;
            org_id: string;
            workspace_id: string;
            email: string;
            role: "owner" | "admin" | "builder" | "viewer";
            token_hash: string;
            invited_by: string;
            created_at: string;
            expires_at: string;
            accepted_at: string | null;
            revoked_at: string | null;
        }>;
    };
};
export {};
//# sourceMappingURL=model.d.ts.map