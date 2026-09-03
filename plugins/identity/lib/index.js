import { isIP } from 'node:net';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { createIdentityHttpHandler } from './http.js';
import { MemoryEmailSender, SmtpEmailSender } from './email.js';
import { identityAuditDomainSpec, identityCredentialsDomainSpec, identitySessionsDomainSpec, identityUsersDomainSpec, } from './model.js';
import { SimpleWebAuthnProvider } from './passkey.js';
import { StudioIdentityService } from './service.js';
export * from './crypto.js';
export * from './email.js';
export * from './http.js';
export * from './model.js';
export * from './mutex.js';
export * from './passkey.js';
export * from './rate-limit.js';
export * from './service.js';
export const name = 'dz23-studio-identity';
/** Resolve identity through an explicitly recorded agent lineage, never through ambient process state. */
export function identityStateForAgent(service, agents, agent, bindHost) {
    for (const candidate of agentLineage(agents, agent)) {
        const state = service.identityStateForHarnessSession(String(candidate.session.id), bindHost);
        if (state.authenticated)
            return state;
    }
    return { authenticated: false, strongIdentityVerified: false };
}
/** Resolve the tenant principal through the same durable parentSession lineage. */
export function principalForAgent(service, agents, agent) {
    for (const candidate of agentLineage(agents, agent)) {
        const principal = service.principalForHarnessSession(String(candidate.session.id));
        if (principal !== undefined)
            return principal;
    }
    return undefined;
}
function* agentLineage(agents, start) {
    const seen = new Set();
    let current = start;
    while (current !== undefined && !seen.has(String(current.session.id))) {
        seen.add(String(current.session.id));
        yield current;
        const parent = current.session.header?.parentSession;
        current = parent === undefined ? undefined : agents.get(parent);
    }
}
export const inject = ['agents', 'storageDomain', 'webServer', 'studioPolicy', 'credentials'];
class DomainIdentityRepository {
    userTable;
    credentialTable;
    challengeTable;
    magicCodeTable;
    sessionTable;
    auditTable;
    constructor(userTable, credentialTable, challengeTable, magicCodeTable, sessionTable, auditTable) {
        this.userTable = userTable;
        this.credentialTable = credentialTable;
        this.challengeTable = challengeTable;
        this.magicCodeTable = magicCodeTable;
        this.sessionTable = sessionTable;
        this.auditTable = auditTable;
    }
    users() { return values(this.userTable); }
    putUser(record) { return this.userTable.put(record.user_id, record); }
    credentials() { return values(this.credentialTable); }
    putCredential(record) { return this.credentialTable.put(record.credential_id, record); }
    challenges() { return values(this.challengeTable); }
    putChallenge(record) { return this.challengeTable.put(record.challenge_id, record); }
    magicCodes() { return values(this.magicCodeTable); }
    putMagicCode(record) { return this.magicCodeTable.put(record.magic_code_id, record); }
    sessions() { return values(this.sessionTable); }
    putSession(record) { return this.sessionTable.put(record.session_id, record); }
    audits() { return values(this.auditTable); }
    putAudit(record) { return this.auditTable.put(record.audit_id, record); }
}
function values(table) {
    return [...table.entries()].map(([, value]) => value);
}
export async function apply(ctx, config = {}) {
    const rpId = config.rpId ?? 'localhost';
    assertValidRpId(rpId);
    if (ctx.webServer.host !== '127.0.0.1' && config.edge?.required === false) {
        throw new Error('O modo servidor não permite desativar edge.required.');
    }
    const edgeRequired = config.edge?.required ?? ctx.webServer.host !== '127.0.0.1';
    const edgeSecretRef = config.edge?.secretRef === undefined ? undefined : credentialRef(config.edge.secretRef);
    if (edgeRequired && edgeSecretRef === undefined) {
        throw new Error('O modo servidor exige edge.secretRef para validar a borda Caddy.');
    }
    if (edgeRequired && config.enrollment === 'open') {
        throw new Error('A borda autenticada proíbe enrollment aberto; configure bootstrap-email ou closed.');
    }
    const [usersDomain, credentialsDomain, sessionsDomain, auditDomain] = await Promise.all([
        ctx.storageDomain.open(identityUsersDomainSpec),
        ctx.storageDomain.open(identityCredentialsDomainSpec),
        ctx.storageDomain.open(identitySessionsDomainSpec),
        ctx.storageDomain.open(identityAuditDomainSpec),
    ]);
    ctx.effect(() => async () => {
        await Promise.all([usersDomain.close(), credentialsDomain.close(), sessionsDomain.close(), auditDomain.close()]);
    }, 'dz23-studio-identity.domainClose');
    const repository = new DomainIdentityRepository(usersDomain.table('users'), credentialsDomain.table('credentials'), credentialsDomain.table('challenges'), usersDomain.table('magic_codes'), sessionsDomain.table('sessions'), auditDomain.table('events'));
    const port = ctx.webServer.port;
    const defaultHost = `127.0.0.1:${port}`;
    const defaultOrigin = `http://localhost:${port}`;
    const email = resolveEmailSender(ctx, config, edgeRequired);
    let harnessAuthenticationUrl;
    ctx.inject(['connection'], (connectionCtx) => {
        harnessAuthenticationUrl = baseUrl => connectionCtx.connection.authenticatedUrl(baseUrl);
        return () => { harnessAuthenticationUrl = undefined; };
    });
    const service = new StudioIdentityService({
        repository,
        passkeys: config.passkeys ?? new SimpleWebAuthnProvider(),
        emailSender: email.sender,
        rpName: config.rpName ?? 'DZ23 STUDIO',
        rpId,
        expectedOrigin: config.expectedOrigin ?? defaultOrigin,
        defaultOrgId: config.defaultOrgId ?? 'org_local',
        defaultTenantId: config.defaultTenantId ?? 'tenant_local',
        enrollment: config.enrollment ?? (!edgeRequired && ctx.webServer.host === '127.0.0.1' ? 'open' : 'closed'),
        personalModeAllowed: !edgeRequired,
        ...(config.now === undefined ? {} : { now: config.now }),
        ...(config.createId === undefined ? {} : { createId: config.createId }),
        ...(config.createSecret === undefined ? {} : { createSecret: config.createSecret }),
        ...(config.createMagicCode === undefined ? {} : { createMagicCode: config.createMagicCode }),
    });
    ctx.provide('studioIdentity', {
        service,
        ...(email.capture === undefined ? {} : { developmentEmailCapture: email.capture }),
    });
    const unsetResolver = ctx.studioPolicy.setIdentityResolver(execution => {
        return identityStateForAgent(service, ctx.agents, execution.agent, ctx.webServer.host);
    });
    ctx.effect(() => unsetResolver, 'dz23-studio-identity.policyResolver');
    ctx.effect(() => ctx.webServer.register({
        kind: 'prefix',
        path: '/api/studio/identity',
        handler: createIdentityHttpHandler({
            service,
            bindHost: ctx.webServer.host,
            allowedHosts: config.allowedHosts ?? [defaultHost, `localhost:${port}`],
            allowedOrigins: config.allowedOrigins ?? [defaultOrigin, `http://${defaultHost}`],
            edgeRequired,
            ...(edgeSecretRef === undefined ? {} : {
                resolveEdgeSecret: async () => (await ctx.credentials.resolve(edgeSecretRef))?.value,
            }),
            harnessAuthenticationUrl: baseUrl => harnessAuthenticationUrl?.(baseUrl),
        }),
    }), 'dz23-studio-identity.http');
}
export function assertValidRpId(rpId) {
    const domain = rpId.toLowerCase();
    const validDomain = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
    if (isIP(rpId) !== 0 || (domain !== 'localhost' && !validDomain.test(domain))) {
        throw new Error('rpId deve ser localhost ou um nome de domínio, nunca um endereço IP, porta ou URL.');
    }
}
function resolveEmailSender(ctx, config, edgeRequired) {
    if (config.emailSender !== undefined)
        return { sender: config.emailSender };
    if (config.email?.kind === 'smtp') {
        return { sender: new SmtpEmailSender(ctx.credentials, credentialRef(config.email.secretRef)) };
    }
    if (config.email?.kind === 'memory' && ctx.webServer.host === '127.0.0.1') {
        const capture = new MemoryEmailSender();
        return { sender: capture, capture };
    }
    if (ctx.webServer.host !== '127.0.0.1' || edgeRequired) {
        throw new Error('O modo servidor exige um provedor SMTP configurado por referência de segredo.');
    }
    const capture = new MemoryEmailSender();
    return { sender: capture, capture };
}
