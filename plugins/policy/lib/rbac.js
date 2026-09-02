import { z } from 'zod';
export const studioRoleSchema = z.enum(['owner', 'admin', 'builder', 'viewer']);
export const studioPermissionSchema = z.enum([
    'identity.self',
    'workspace.read',
    'workspace.create',
    'workspace.manage',
    'members.read',
    'members.manage',
    'integrations.manage',
    'project.read',
    'project.write',
    'project.publish_staging',
    'project.delete',
    'audit.read',
    'invitation.accept',
]);
const ROLE_PERMISSIONS = {
    owner: new Set(studioPermissionSchema.options),
    admin: new Set([
        'identity.self', 'workspace.read',
        'members.read', 'members.manage', 'integrations.manage', 'project.read',
        'project.write', 'project.publish_staging', 'audit.read', 'invitation.accept',
    ]),
    builder: new Set([
        'identity.self', 'workspace.read', 'members.read', 'project.read',
        'project.write', 'project.publish_staging', 'invitation.accept',
    ]),
    viewer: new Set([
        'identity.self', 'workspace.read', 'members.read', 'project.read', 'invitation.accept',
    ]),
};
export function roleAllows(role, permission) {
    return ROLE_PERMISSIONS[role].has(permission);
}
export function roleCanAssign(actor, target) {
    if (actor === 'owner')
        return true;
    return actor === 'admin' && (target === 'builder' || target === 'viewer');
}
export const studioRouteContractSchema = z.object({
    method: z.enum(['GET', 'POST', 'PATCH', 'DELETE']),
    path: z.string().startsWith('/'),
    access: z.enum(['public', 'authenticated', 'authorized']),
    permission: studioPermissionSchema.nullable(),
    scope: z.enum(['none', 'identity', 'org', 'workspace', 'project', 'invitation']),
}).strict().superRefine((route, context) => {
    if (route.access === 'authorized' && route.permission === null) {
        context.addIssue({ code: 'custom', message: 'Rota autorizada exige permissão.' });
    }
    if (route.access !== 'authorized' && route.permission !== null) {
        context.addIssue({ code: 'custom', message: 'Rota pública/autenticada não pode declarar permissão RBAC.' });
    }
});
export function assertRouteContracts(contracts) {
    const keys = new Set();
    for (const contract of contracts) {
        studioRouteContractSchema.parse(contract);
        const key = `${contract.method} ${contract.path}`;
        if (keys.has(key))
            throw new Error(`Contrato de rota duplicado: ${key}`);
        keys.add(key);
    }
}
