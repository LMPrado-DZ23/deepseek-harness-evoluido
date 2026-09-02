import type { IncomingMessage, ServerResponse } from 'node:http';
import { type StudioIdentityService } from '@dz23-studio/identity';
import { roleAllows, type StudioPermission } from '@dz23-studio/policy';
import { StudioTenancyService } from './service.js';
export declare const TENANCY_ROUTE_CONTRACTS: readonly [{
    readonly method: "GET";
    readonly path: "/workspaces";
    readonly access: "authorized";
    readonly permission: "workspace.read";
    readonly scope: "org";
}, {
    readonly method: "POST";
    readonly path: "/workspaces";
    readonly access: "authorized";
    readonly permission: "workspace.create";
    readonly scope: "org";
}, {
    readonly method: "GET";
    readonly path: "/workspaces/:workspaceId/members";
    readonly access: "authorized";
    readonly permission: "members.read";
    readonly scope: "workspace";
}, {
    readonly method: "POST";
    readonly path: "/invitations";
    readonly access: "authorized";
    readonly permission: "members.manage";
    readonly scope: "workspace";
}, {
    readonly method: "POST";
    readonly path: "/invitations/accept";
    readonly access: "authenticated";
    readonly permission: null;
    readonly scope: "invitation";
}, {
    readonly method: "PATCH";
    readonly path: "/memberships/:membershipId";
    readonly access: "authorized";
    readonly permission: "members.manage";
    readonly scope: "workspace";
}];
export interface TenancyHttpConfig {
    readonly service: StudioTenancyService;
    readonly identity: StudioIdentityService;
    readonly allowedHosts: readonly string[];
    readonly allowedOrigins: readonly string[];
}
export declare function createTenancyHttpHandler(config: TenancyHttpConfig): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
export declare function authorizeRoute(role: Parameters<typeof roleAllows>[0], permission: StudioPermission): void;
//# sourceMappingURL=http.d.ts.map