import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { roleAllows, studioPermissionSchema, studioRoleSchema, } from './rbac.js';
export * from './rbac.js';
export const name = 'dz23-studio-policy';
export const inject = ['tools', 'storageDomain'];
export const policyTierSchema = z.enum(['T0', 'T1', 'T2', 'T3']);
export const policySourceSchema = z.object({
    kind: z.enum(['studio', 'harness', 'plugin', 'mcp']),
    external: z.boolean().default(false),
    signed: z.boolean().optional(),
    stableChannel: z.boolean().default(true),
}).strict();
export const toolPolicyRuleSchema = z.object({
    source: policySourceSchema,
    inferredTier: z.unknown().optional(),
    manifestTier: z.unknown().optional(),
    policyTier: z.unknown().optional(),
    allowManifestDowngrade: z.boolean().default(false),
    blocked: z.boolean().default(false),
    sandboxMode: z.string().optional(),
    requiredPermission: studioPermissionSchema.optional(),
    scope: z.enum(['none', 'org', 'workspace', 'project']).default('none'),
}).strict();
export const policyDecisionSchema = z.object({
    toolName: z.string().min(1),
    effectiveTier: policyTierSchema,
    kind: z.enum(['allow', 'ask', 'deny']),
    reason: z.string().min(1),
    ruleSource: z.enum(['catalog', 'safe-default', 'invalid-rule']),
}).strict();
export const policyDecisionEventSchema = policyDecisionSchema.extend({
    callId: z.string().min(1),
}).strict();
export const policyAuditRecordSchema = z.object({
    audit_id: z.string().min(1),
    session_id: z.string().min(1),
    org_id: z.string().min(1),
    tenant_id: z.string().min(1),
    created_at: z.iso.datetime(),
    tool_name: z.string().min(1),
    call_id: z.string().min(1),
    effective_tier: policyTierSchema,
    decision: z.enum(['allow', 'ask', 'deny']),
    reason: z.string().min(1),
    rule_source: z.enum(['catalog', 'safe-default', 'invalid-rule']),
}).strict();
export const STUDIO_POLICY_AUDIT_PHYSICAL_DOMAIN = 'studio_policy_audit';
export const STUDIO_POLICY_AUDIT_LOGICAL_DOMAIN = 'studio.policy.audit';
export const studioPolicyAuditDomainSpec = defineDomain({
    name: STUDIO_POLICY_AUDIT_PHYSICAL_DOMAIN,
    version: 1,
    tables: {
        decisions: domainTable(policyAuditRecordSchema),
    },
});
const TIER_RANK = {
    T0: 0,
    T1: 1,
    T2: 2,
    T3: 3,
};
const TIER_BY_RANK = ['T0', 'T1', 'T2', 'T3'];
function validTier(value) {
    const parsed = policyTierSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
}
function mostRestrictive(tiers) {
    return TIER_BY_RANK[Math.max(...tiers.map(tier => TIER_RANK[tier]))];
}
function declaredTier(value) {
    return validTier(value) ?? 'T2';
}
function resolveTier(rule) {
    const inferred = validTier(rule.inferredTier);
    const manifest = validTier(rule.manifestTier);
    const policy = validTier(rule.policyTier);
    const present = [rule.inferredTier, rule.manifestTier, rule.policyTier];
    const hasInvalid = present.some(value => value !== undefined && validTier(value) === undefined);
    let effective;
    if (inferred !== undefined
        && inferred !== 'T3'
        && manifest !== undefined
        && policy !== undefined
        && rule.allowManifestDowngrade
        && TIER_RANK[manifest] < TIER_RANK[inferred]
        && TIER_RANK[policy] < TIER_RANK[inferred]) {
        effective = mostRestrictive([manifest, policy]);
    }
    else {
        const declared = [inferred, manifest, policy].filter((tier) => tier !== undefined);
        effective = declared.length === 0 ? 'T2' : mostRestrictive(declared);
    }
    if (hasInvalid)
        effective = mostRestrictive([effective, declaredTier(undefined)]);
    if (rule.source.kind === 'mcp' && rule.source.external) {
        effective = mostRestrictive([effective, 'T1']);
    }
    if (rule.sandboxMode === 'danger-full-access')
        effective = 'T3';
    if (effective === 'T1'
        && (rule.source.external || (rule.sandboxMode !== 'read-only' && rule.sandboxMode !== 'workspace-write'))) {
        effective = 'T2';
    }
    return effective;
}
function decisionForTier(toolName, effectiveTier, strongIdentityVerified) {
    if (effectiveTier === 'T0') {
        return { toolName, effectiveTier, kind: 'allow', reason: 'Leitura segura autorizada automaticamente.', ruleSource: 'catalog' };
    }
    if (effectiveTier === 'T1') {
        return { toolName, effectiveTier, kind: 'allow', reason: 'Alteração reversível autorizada e registrada.', ruleSource: 'catalog' };
    }
    if (effectiveTier === 'T2') {
        return { toolName, effectiveTier, kind: 'ask', reason: 'Confirmação da pessoa necessária antes de continuar.', ruleSource: 'catalog' };
    }
    if (!strongIdentityVerified) {
        return {
            toolName,
            effectiveTier,
            kind: 'deny',
            reason: 'Ação sensível bloqueada até uma confirmação forte de identidade estar ativa.',
            ruleSource: 'catalog',
        };
    }
    return {
        toolName,
        effectiveTier,
        kind: 'ask',
        reason: 'Confirmação reforçada necessária antes da ação sensível.',
        ruleSource: 'catalog',
    };
}
export class StudioPolicyEngine {
    #rules;
    #requireAuthorizationDeclarations;
    constructor(options = {}) {
        this.#rules = options.rules ?? {};
        this.#requireAuthorizationDeclarations = options.requireAuthorizationDeclarations ?? false;
    }
    evaluate(toolName, context = {}) {
        if (toolName.trim().length === 0) {
            return {
                toolName: '<invalid>',
                effectiveTier: 'T2',
                kind: 'deny',
                reason: 'Ferramenta sem identificação foi bloqueada por segurança.',
                ruleSource: 'invalid-rule',
            };
        }
        const rawRule = this.#rules[toolName];
        if (rawRule === undefined) {
            return {
                toolName,
                effectiveTier: 'T2',
                kind: this.#requireAuthorizationDeclarations ? 'deny' : 'ask',
                reason: this.#requireAuthorizationDeclarations
                    ? 'Ferramenta sem declaração de permissão foi bloqueada.'
                    : 'Ferramenta ainda não classificada: confirmação obrigatória.',
                ruleSource: 'safe-default',
            };
        }
        const parsed = toolPolicyRuleSchema.safeParse(rawRule);
        if (!parsed.success) {
            return {
                toolName,
                effectiveTier: 'T2',
                kind: 'deny',
                reason: 'Regra de segurança inválida: execução bloqueada.',
                ruleSource: 'invalid-rule',
            };
        }
        const rule = parsed.data;
        const effectiveTier = resolveTier(rule);
        if (this.#requireAuthorizationDeclarations && rule.requiredPermission === undefined) {
            return { toolName, effectiveTier, kind: 'deny', reason: 'Ferramenta sem permissão declarada foi bloqueada.', ruleSource: 'invalid-rule' };
        }
        if (rule.requiredPermission !== undefined) {
            const authorization = context.authorization;
            if (authorization === undefined) {
                return { toolName, effectiveTier, kind: 'deny', reason: 'Nenhum vínculo ativo autoriza esta ação.', ruleSource: 'catalog' };
            }
            if (!roleAllows(authorization.role, rule.requiredPermission)) {
                return { toolName, effectiveTier, kind: 'deny', reason: 'Seu papel neste espaço não permite esta ação.', ruleSource: 'catalog' };
            }
        }
        if (rule.blocked) {
            return { toolName, effectiveTier, kind: 'deny', reason: 'Ação bloqueada pela política do DZ23 STUDIO.', ruleSource: 'catalog' };
        }
        if (rule.source.kind === 'plugin' && rule.source.stableChannel && rule.source.signed !== true) {
            return { toolName, effectiveTier, kind: 'deny', reason: 'Plugin não assinado é bloqueado no canal estável.', ruleSource: 'catalog' };
        }
        return decisionForTier(toolName, effectiveTier, context.strongIdentityVerified === true);
    }
}
function requestedScope(execution) {
    const args = execution.arguments;
    if (typeof args !== 'object' || args === null)
        return {};
    const values = args;
    return {
        ...(typeof values.org_id === 'string' ? { orgId: values.org_id } : {}),
        ...(typeof values.tenant_id === 'string' ? { tenantId: values.tenant_id } : {}),
    };
}
function toPreToolDecision(decision) {
    if (decision.kind === 'allow')
        return { kind: 'allow' };
    if (decision.kind === 'ask')
        return { kind: 'ask', reason: decision.reason };
    return { kind: 'deny', reason: decision.reason };
}
/** Mounts the policy at the authoritative host-side pre-execution seam. */
export async function apply(ctx, config = {}) {
    const engine = new StudioPolicyEngine(config);
    let identityResolver = (execution) => ({
        authenticated: true,
        strongIdentityVerified: config.strongIdentityVerified?.(execution) === true,
    });
    let authorizationResolver = (_execution) => undefined;
    let delegationGrantResolver = (_execution) => undefined;
    const domain = await ctx.storageDomain.open(studioPolicyAuditDomainSpec);
    ctx.effect(() => () => domain.close(), 'dz23-studio-policy.domainClose');
    const decisions = domain.table('decisions');
    ctx.provide('studioPolicy', {
        auditRecords: () => [...decisions.entries()].map(([, record]) => record),
        setIdentityResolver: (resolver) => {
            const previous = identityResolver;
            identityResolver = resolver;
            return () => { identityResolver = previous; };
        },
        setAuthorizationResolver: (resolver) => {
            const previous = authorizationResolver;
            authorizationResolver = resolver;
            return () => { authorizationResolver = previous; };
        },
        setDelegationGrantResolver: (resolver) => {
            const previous = delegationGrantResolver;
            delegationGrantResolver = resolver;
            return () => { delegationGrantResolver = previous; };
        },
    });
    ctx.on('tools/pre-execute', async (execution, next) => {
        const identity = execution.agent === undefined
            ? { authenticated: false, strongIdentityVerified: false }
            : identityResolver(execution);
        const authorization = execution.agent === undefined ? undefined : authorizationResolver(execution);
        const requested = requestedScope(execution);
        let decision = execution.agent === undefined
            ? {
                toolName: execution.name,
                effectiveTier: 'T2',
                kind: 'deny',
                reason: 'Execução sem sessão auditável foi bloqueada.',
                ruleSource: 'safe-default',
            }
            : !identity.authenticated
                ? {
                    toolName: execution.name,
                    effectiveTier: 'T2',
                    kind: 'deny',
                    reason: 'Sessão de identidade ausente, expirada ou revogada.',
                    ruleSource: 'safe-default',
                }
                : engine.evaluate(execution.name, {
                    strongIdentityVerified: identity.strongIdentityVerified,
                    ...(authorization === undefined ? {} : { authorization }),
                });
        if (decision.kind !== 'deny' && authorization !== undefined
            && ((requested.orgId !== undefined && requested.orgId !== authorization.orgId)
                || (requested.tenantId !== undefined && requested.tenantId !== authorization.tenantId))) {
            decision = {
                ...decision,
                kind: 'deny',
                reason: 'A ação tentou acessar outra organização ou espaço de trabalho.',
            };
        }
        if (decision.kind === 'ask') {
            const grant = delegationGrantResolver(execution);
            if (grant !== undefined && TIER_RANK[grant.approvedTier] >= TIER_RANK[decision.effectiveTier]) {
                decision = { ...decision, kind: 'allow', reason: grant.reason };
            }
        }
        if (decision.kind === 'allow') {
            const downstream = await next();
            if (downstream.kind !== 'allow') {
                decision = { ...decision, kind: downstream.kind, reason: downstream.reason ?? decision.reason };
            }
        }
        let event = policyDecisionEventSchema.parse({
            ...decision,
            callId: String(execution.callId),
        });
        try {
            const scope = authorization ?? config.resolveScope?.(execution) ?? { orgId: 'org_local', tenantId: 'tenant_local' };
            const auditId = config.createAuditId?.() ?? randomUUID();
            const record = policyAuditRecordSchema.parse({
                audit_id: auditId,
                session_id: execution.agent === undefined ? 'agentless' : String(execution.agent.session.id),
                org_id: scope.orgId,
                tenant_id: scope.tenantId,
                created_at: (config.now?.() ?? new Date()).toISOString(),
                tool_name: event.toolName,
                call_id: event.callId,
                effective_tier: event.effectiveTier,
                decision: event.kind,
                reason: event.reason,
                rule_source: event.ruleSource,
            });
            await decisions.put(auditId, record);
        }
        catch {
            decision = {
                ...decision,
                kind: 'deny',
                reason: 'Não foi possível registrar a auditoria; a ação foi bloqueada.',
            };
            event = policyDecisionEventSchema.parse({ ...decision, callId: String(execution.callId) });
        }
        ctx.emit('studio-policy/decision', event);
        return toPreToolDecision(decision);
    });
}
