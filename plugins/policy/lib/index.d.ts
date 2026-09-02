import type { Context } from '@deepseek-ai/cordis';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
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
}, z.core.$strict>;
export type PolicyAuditRecord = z.infer<typeof policyAuditRecordSchema>;
export interface StudioPolicyRuntime {
    auditRecords(): readonly PolicyAuditRecord[];
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
}
export interface StudioPolicyOptions {
    readonly rules?: Readonly<Record<string, ToolPolicyRule>>;
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
export {};
//# sourceMappingURL=index.d.ts.map