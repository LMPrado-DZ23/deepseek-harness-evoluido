import type { Context } from '@deepseek-ai/cordis';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import { type StudioRole } from './rbac.js';
export * from './rbac.js';
export declare const name = "dz23-studio-policy";
export declare const inject: string[];
export declare const policyTierSchema: z.ZodEnum<{
    T0: "T0";
    T1: "T1";
    T2: "T2";
    T3: "T3";
}>;
export type PolicyTier = z.infer<typeof policyTierSchema>;
export declare const policySourceSchema: z.ZodObject<{
    kind: z.ZodEnum<{
        studio: "studio";
        harness: "harness";
        plugin: "plugin";
        mcp: "mcp";
    }>;
    external: z.ZodDefault<z.ZodBoolean>;
    signed: z.ZodOptional<z.ZodBoolean>;
    stableChannel: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>;
/**
 * Os modos de sandbox conhecidos, e o que cada um AUTORIZA.
 *
 * `sandboxMode` continua sendo `string` no schema de propósito: o valor chega
 * de catálogo nosso, de manifesto de integração e do Harness pinado, e recusar
 * no `parse` quebraria a compatibilidade com um modo que o upstream introduza
 * antes de nós.
 *
 * O que muda é como o desconhecido é TRATADO. Antes, três literais eram
 * comparados soltos no meio da função. `'danger-full-access'` escrito errado —
 * `danger_full_access`, `danger-full-acess` — simplesmente não casava, e a
 * escalada obrigatória para T3 **não acontecia**: o portão falhava ABERTO, em
 * silêncio, exatamente no caso mais perigoso.
 *
 * Agora todo modo passa por esta tabela, e o que ela não conhece é tratado
 * como `privileged`. Um erro de digitação passa a custar uma confirmação a
 * mais, e não uma autorização a menos.
 */
export declare const SANDBOX_MODE_CAPABILITIES: {
    readonly 'read-only': {
        readonly write: false;
        readonly network: false;
        readonly privileged: false;
    };
    readonly 'workspace-write': {
        readonly write: true;
        readonly network: false;
        readonly privileged: false;
    };
    readonly 'danger-full-access': {
        readonly write: true;
        readonly network: true;
        readonly privileged: true;
    };
    readonly unavailable: {
        readonly write: true;
        readonly network: true;
        readonly privileged: false;
    };
};
export type SandboxMode = keyof typeof SANDBOX_MODE_CAPABILITIES;
/**
 * O que este modo de sandbox autoriza.
 *
 * Modo ausente NÃO é o mesmo que modo desconhecido: ausente significa que a
 * regra não fala de sandbox, e quem decide então é o tier declarado. Um nome
 * que ninguém reconhece, por outro lado, é uma afirmação que não entendemos —
 * e a resposta segura para isso é assumir o pior.
 * @param mode - o valor cru da regra, possivelmente ausente.
 * @returns as capacidades do modo, ou `undefined` quando não há modo.
 */
export declare function sandboxCapabilities(mode: string | undefined): {
    readonly write: boolean;
    readonly network: boolean;
    readonly privileged: boolean;
} | undefined;
export declare const toolPolicyRuleSchema: z.ZodObject<{
    source: z.ZodObject<{
        kind: z.ZodEnum<{
            studio: "studio";
            harness: "harness";
            plugin: "plugin";
            mcp: "mcp";
        }>;
        external: z.ZodDefault<z.ZodBoolean>;
        signed: z.ZodOptional<z.ZodBoolean>;
        stableChannel: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strict>;
    inferredTier: z.ZodOptional<z.ZodUnknown>;
    manifestTier: z.ZodOptional<z.ZodUnknown>;
    policyTier: z.ZodOptional<z.ZodUnknown>;
    allowManifestDowngrade: z.ZodDefault<z.ZodBoolean>;
    blocked: z.ZodDefault<z.ZodBoolean>;
    sandboxMode: z.ZodOptional<z.ZodString>;
    requiredPermission: z.ZodOptional<z.ZodEnum<{
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
    scope: z.ZodDefault<z.ZodEnum<{
        none: "none";
        org: "org";
        workspace: "workspace";
        project: "project";
    }>>;
}, z.core.$strict>;
export type ToolPolicyRule = z.input<typeof toolPolicyRuleSchema>;
export declare const policyDecisionSchema: z.ZodObject<{
    toolName: z.ZodString;
    effectiveTier: z.ZodEnum<{
        T0: "T0";
        T1: "T1";
        T2: "T2";
        T3: "T3";
    }>;
    kind: z.ZodEnum<{
        allow: "allow";
        ask: "ask";
        deny: "deny";
    }>;
    reason: z.ZodString;
    ruleSource: z.ZodEnum<{
        catalog: "catalog";
        "safe-default": "safe-default";
        "invalid-rule": "invalid-rule";
    }>;
}, z.core.$strict>;
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;
export declare const policyDecisionEventSchema: z.ZodObject<{
    toolName: z.ZodString;
    effectiveTier: z.ZodEnum<{
        T0: "T0";
        T1: "T1";
        T2: "T2";
        T3: "T3";
    }>;
    kind: z.ZodEnum<{
        allow: "allow";
        ask: "ask";
        deny: "deny";
    }>;
    reason: z.ZodString;
    ruleSource: z.ZodEnum<{
        catalog: "catalog";
        "safe-default": "safe-default";
        "invalid-rule": "invalid-rule";
    }>;
    callId: z.ZodString;
}, z.core.$strict>;
export type PolicyDecisionEvent = z.infer<typeof policyDecisionEventSchema>;
export declare const policyAuditRecordSchema: z.ZodObject<{
    audit_id: z.ZodString;
    session_id: z.ZodString;
    org_id: z.ZodString;
    tenant_id: z.ZodString;
    created_at: z.ZodISODateTime;
    tool_name: z.ZodString;
    call_id: z.ZodString;
    effective_tier: z.ZodEnum<{
        T0: "T0";
        T1: "T1";
        T2: "T2";
        T3: "T3";
    }>;
    decision: z.ZodEnum<{
        allow: "allow";
        ask: "ask";
        deny: "deny";
    }>;
    reason: z.ZodString;
    rule_source: z.ZodEnum<{
        catalog: "catalog";
        "safe-default": "safe-default";
        "invalid-rule": "invalid-rule";
    }>;
    user_id: z.ZodOptional<z.ZodString>;
    seq: z.ZodOptional<z.ZodNumber>;
    previous_sha256: z.ZodOptional<z.ZodString>;
    entry_sha256: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type PolicyAuditRecord = z.infer<typeof policyAuditRecordSchema>;
/** Primeira entrada da corrente: nao ha anterior, e o zero diz isso. */
export declare const POLICY_AUDIT_CHAIN_ROOT: string;
/**
 * O selo de uma entrada: SHA-256 do conteudo canonico dela mais o selo da
 * anterior. Trocar qualquer campo, ou reordenar a trilha, muda o selo.
 * @param record - a entrada, com ou sem `entry_sha256`.
 * @returns o selo em hexadecimal.
 */
export declare function policyAuditEntryHash(record: Omit<PolicyAuditRecord, 'entry_sha256'>): string;
export type PolicyAuditChainVerdict = {
    readonly kind: 'intact';
    readonly entries: number;
    readonly head: string;
} | {
    readonly kind: 'unchained';
    readonly entries: number;
    readonly firstUnchainedId: string;
} | {
    readonly kind: 'broken';
    readonly entries: number;
    readonly brokenAuditId: string;
    readonly detail: 'seal' | 'link' | 'sequence';
};
/**
 * Confere a corrente inteira.
 *
 * `broken` distingue tres coisas diferentes: o selo nao bate com o conteudo
 * (alguem reescreveu a linha), o elo nao aponta para a anterior (alguem
 * removeu ou reordenou), ou a posicao pulou (alguem apagou do meio).
 * @param records - as entradas, em qualquer ordem.
 * @returns o veredito.
 */
export declare function verifyPolicyAuditChain(records: readonly PolicyAuditRecord[]): PolicyAuditChainVerdict;
export interface StudioPolicyRuntime {
    auditRecords(): readonly PolicyAuditRecord[];
    /** Confere a corrente da trilha de politica sem sair do processo. */
    verifyAuditChain(): PolicyAuditChainVerdict;
    setIdentityResolver(resolver: (execution: ToolExecution) => PolicyIdentityState): () => void;
    setAuthorizationResolver(resolver: (execution: ToolExecution) => PolicyAuthorizationState | undefined): () => void;
    setDelegationGrantResolver(resolver: (execution: ToolExecution) => PolicyDelegationGrant | undefined): () => void;
}
export interface PolicyIdentityState {
    readonly authenticated: boolean;
    readonly strongIdentityVerified: boolean;
}
export interface PolicyAuthorizationState {
    readonly userId: string;
    readonly orgId: string;
    readonly tenantId: string;
    readonly role: StudioRole;
}
export interface PolicyDelegationGrant {
    readonly approvedTier: Extract<PolicyTier, 'T2' | 'T3'>;
    readonly reason: string;
}
declare const policyAuditKeyBrand: unique symbol;
export type PolicyAuditKey = string & {
    readonly [policyAuditKeyBrand]: true;
};
export declare const STUDIO_POLICY_AUDIT_PHYSICAL_DOMAIN = "studio_policy_audit";
export declare const STUDIO_POLICY_AUDIT_LOGICAL_DOMAIN = "studio.policy.audit";
export declare const studioPolicyAuditDomainSpec: {
    name: string;
    version: number;
    tables: {
        decisions: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<PolicyAuditKey, {
            audit_id: string;
            session_id: string;
            org_id: string;
            tenant_id: string;
            created_at: string;
            tool_name: string;
            call_id: string;
            effective_tier: "T0" | "T1" | "T2" | "T3";
            decision: "allow" | "ask" | "deny";
            reason: string;
            rule_source: "catalog" | "safe-default" | "invalid-rule";
            user_id?: string | undefined;
            seq?: number | undefined;
            previous_sha256?: string | undefined;
            entry_sha256?: string | undefined;
        }>;
    };
};
declare module '@deepseek-ai/cordis' {
    interface Context {
        studioPolicy: StudioPolicyRuntime;
    }
    interface Events {
        'studio-policy/decision'(event: PolicyDecisionEvent): void;
    }
}
export interface PolicyEvaluationContext {
    readonly strongIdentityVerified?: boolean;
    readonly authorization?: PolicyAuthorizationState;
}
export interface StudioPolicyOptions {
    readonly rules?: Readonly<Record<string, ToolPolicyRule>>;
    readonly requireAuthorizationDeclarations?: boolean;
}
export declare class StudioPolicyEngine {
    #private;
    constructor(options?: StudioPolicyOptions);
    evaluate(toolName: string, context?: PolicyEvaluationContext): PolicyDecision;
}
export interface PolicyPluginConfig extends StudioPolicyOptions {
    readonly strongIdentityVerified?: (execution: ToolExecution) => boolean;
    readonly resolveScope?: (execution: ToolExecution) => {
        readonly orgId: string;
        readonly tenantId: string;
    };
    readonly createAuditId?: () => string;
    readonly now?: () => Date;
}
/** Mounts the policy at the authoritative host-side pre-execution seam. */
export declare function apply(ctx: Context, config?: PolicyPluginConfig): Promise<void>;
//# sourceMappingURL=index.d.ts.map