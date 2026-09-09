import { authenticatedMutation, assertRequestTrust, singleHeader, IdentityError, } from '@dz23-studio/identity';
import { assertRouteContracts, roleAllows, studioRoleSchema, } from '@dz23-studio/policy';
import { z } from 'zod';
import { StudioTenancyService, TenancyError } from './service.js';
import { t } from './i18n.js';
const JSON_LIMIT = 64 * 1024;
const workspaceSchema = z.object({ name: z.string().min(1).max(120) }).strict();
const invitationSchema = z.object({ workspace_id: z.string().min(1), email: z.email(), role: studioRoleSchema }).strict();
const acceptSchema = z.object({ token: z.string().min(20) }).strict();
const roleSchema = z.object({ role: studioRoleSchema }).strict();
export const TENANCY_ROUTE_CONTRACTS = [
    { method: 'GET', path: '/workspaces', access: 'authorized', permission: 'workspace.read', scope: 'org' },
    { method: 'POST', path: '/workspaces', access: 'authorized', permission: 'workspace.create', scope: 'org' },
    { method: 'GET', path: '/workspaces/:workspaceId/members', access: 'authorized', permission: 'members.read', scope: 'workspace' },
    { method: 'POST', path: '/invitations', access: 'authorized', permission: 'members.manage', scope: 'workspace' },
    { method: 'POST', path: '/invitations/accept', access: 'authenticated', permission: null, scope: 'invitation' },
    { method: 'PATCH', path: '/memberships/:membershipId', access: 'authorized', permission: 'members.manage', scope: 'workspace' },
];
assertRouteContracts(TENANCY_ROUTE_CONTRACTS);
export function createTenancyHttpHandler(config) {
    return async (request, response) => {
        try {
            assertRequestTrust(request, config);
            const path = new URL(request.url ?? '/', 'http://local').pathname;
            const route = path.slice('/api/studio/tenancy'.length);
            const match = matchRoute(request.method, route);
            if (match === undefined)
                return json(response, 404, { error: t('http.rotaNaoEncontrada') });
            const session = await authenticatedMutation(request, config.identity);
            const actor = config.service.actorFromSession(session);
            if (request.method === 'GET' && route === '/workspaces') {
                return json(response, 200, { workspaces: config.service.listWorkspaces(actor) });
            }
            if (request.method === 'POST' && route === '/workspaces') {
                const body = workspaceSchema.parse(await readJson(request));
                return json(response, 201, { workspace: await config.service.createWorkspace(actor, body.name) });
            }
            if (request.method === 'GET' && match.template === '/workspaces/:workspaceId/members') {
                return json(response, 200, { members: config.service.listMembers(actor, match.parameter) });
            }
            if (request.method === 'POST' && route === '/invitations') {
                const body = invitationSchema.parse(await readJson(request));
                const result = await config.service.invite(actor, body.workspace_id, body.email, body.role);
                return json(response, 202, { invitation_id: result.invitation.invitation_id });
            }
            if (request.method === 'POST' && route === '/invitations/accept') {
                const body = acceptSchema.parse(await readJson(request));
                const user = config.identity.userForSession(session);
                return json(response, 200, { membership: await config.service.acceptInvitation(user, body.token) });
            }
            const body = roleSchema.parse(await readJson(request));
            return json(response, 200, { membership: await config.service.changeRole(actor, match.parameter, body.role) });
        }
        catch (error) {
            const status = error instanceof TenancyError
                ? error.code === 'not-found' ? 404 : error.code === 'forbidden' || error.code === 'last-owner' ? 403 : 400
                : error instanceof IdentityError ? error.code === 'locked' ? 429 : 401
                    : 400;
            return json(response, status, { error: error instanceof Error ? error.message : t('http.solicitacaoInvalida') });
        }
    };
}
function matchRoute(method, path) {
    for (const contract of TENANCY_ROUTE_CONTRACTS) {
        if (contract.method !== method)
            continue;
        if (!contract.path.includes(':')) {
            if (contract.path === path)
                return { contract, template: contract.path, parameter: '' };
            continue;
        }
        const [before, after] = contract.path.split(/:[^/]+/u);
        if (path.startsWith(before) && path.endsWith(after) && path.length > before.length + after.length) {
            return { contract, template: contract.path, parameter: path.slice(before.length, after === '' ? undefined : -after.length) };
        }
    }
    return undefined;
}
export function authorizeRoute(role, permission) {
    if (!roleAllows(role, permission))
        throw new TenancyError('forbidden', t('http.seuPapelNaoPermite'));
}
async function readJson(request) {
    if (!singleHeader(request.headers['content-type'])?.toLowerCase().startsWith('application/json'))
        throw new Error('Envie os dados em formato JSON.');
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > JSON_LIMIT)
            throw new Error(t('http.solicitacaoGrandeDemais'));
        chunks.push(bytes);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function json(response, status, body) {
    if (response.writableEnded)
        return;
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
    });
    response.end(JSON.stringify(body));
}
