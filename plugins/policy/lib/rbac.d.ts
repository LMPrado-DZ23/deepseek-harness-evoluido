import { z } from 'zod';
export declare const studioRoleSchema: z.ZodEnum<{
    owner: "owner";
    admin: "admin";
    builder: "builder";
    viewer: "viewer";
}>;
export type StudioRole = z.infer<typeof studioRoleSchema>;
export declare const studioPermissionSchema: z.ZodEnum<{
    "identity.self": "identity.self";
    "workspace.read": "workspace.read";
    "workspace.create": "workspace.create";
    "workspace.manage": "workspace.manage";
    "members.read": "members.read";
    "members.manage": "members.manage";
    "integrations.manage": "integrations.manage";
    "project.read": "project.read";
    "project.write": "project.write";
    "project.publish_staging": "project.publish_staging";
    "project.delete": "project.delete";
    "audit.read": "audit.read";
    "invitation.accept": "invitation.accept";
}>;
export type StudioPermission = z.infer<typeof studioPermissionSchema>;
export declare function roleAllows(role: StudioRole, permission: StudioPermission): boolean;
export declare function roleCanAssign(actor: StudioRole, target: StudioRole): boolean;
export declare const studioRouteContractSchema: z.ZodObject<{
    method: z.ZodEnum<{
        GET: "GET";
        POST: "POST";
        PATCH: "PATCH";
        DELETE: "DELETE";
    }>;
    path: z.ZodString;
    access: z.ZodEnum<{
        public: "public";
        authenticated: "authenticated";
        authorized: "authorized";
    }>;
    permission: z.ZodNullable<z.ZodEnum<{
        "identity.self": "identity.self";
        "workspace.read": "workspace.read";
        "workspace.create": "workspace.create";
        "workspace.manage": "workspace.manage";
        "members.read": "members.read";
        "members.manage": "members.manage";
        "integrations.manage": "integrations.manage";
        "project.read": "project.read";
        "project.write": "project.write";
        "project.publish_staging": "project.publish_staging";
        "project.delete": "project.delete";
        "audit.read": "audit.read";
        "invitation.accept": "invitation.accept";
    }>>;
    scope: z.ZodEnum<{
        none: "none";
        identity: "identity";
        org: "org";
        workspace: "workspace";
        project: "project";
        invitation: "invitation";
    }>;
}, z.core.$strict>;
export type StudioRouteContract = z.infer<typeof studioRouteContractSchema>;
export declare function assertRouteContracts(contracts: readonly StudioRouteContract[]): void;
//# sourceMappingURL=rbac.d.ts.map