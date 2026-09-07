import { z } from 'zod';
export declare const agentRunStatusSchema: z.ZodEnum<{
    PENDING_APPROVAL: "PENDING_APPROVAL";
    RUNNING: "RUNNING";
    PROPOSED: "PROPOSED";
    APPLIED: "APPLIED";
    FAILED: "FAILED";
    CANCELLED: "CANCELLED";
    BUDGET_EXCEEDED: "BUDGET_EXCEEDED";
    REJECTED: "REJECTED";
    UNKNOWN: "UNKNOWN";
}>;
export declare const agentRunSchema: z.ZodObject<{
    run_id: z.ZodString;
    org_id: z.ZodString;
    tenant_id: z.ZodString;
    workspace_id: z.ZodString;
    parent_session_id: z.ZodString;
    coordinator_session_id: z.ZodString;
    provider: z.ZodEnum<{
        "spawn-in-process": "spawn-in-process";
        codex: "codex";
        "claude-code": "claude-code";
    }>;
    worktree_path: z.ZodString;
    repository_path: z.ZodString;
    base_commit: z.ZodString;
    status: z.ZodEnum<{
        PENDING_APPROVAL: "PENDING_APPROVAL";
        RUNNING: "RUNNING";
        PROPOSED: "PROPOSED";
        APPLIED: "APPLIED";
        FAILED: "FAILED";
        CANCELLED: "CANCELLED";
        BUDGET_EXCEEDED: "BUDGET_EXCEEDED";
        REJECTED: "REJECTED";
        UNKNOWN: "UNKNOWN";
    }>;
    changed_files: z.ZodArray<z.ZodString>;
    diff_bytes: z.ZodNumber;
    diff_sha256: z.ZodString;
    main_changed_during_run: z.ZodBoolean;
    approved_by: z.ZodString;
    approved_at: z.ZodISODateTime;
    diagnostic: z.ZodNullable<z.ZodString>;
    created_at: z.ZodISODateTime;
    updated_at: z.ZodISODateTime;
}, z.core.$strict>;
export declare const agentLeaseSchema: z.ZodObject<{
    lease_id: z.ZodString;
    run_id: z.ZodString;
    org_id: z.ZodString;
    tenant_id: z.ZodString;
    workspace_id: z.ZodString;
    repository_path: z.ZodString;
    paths: z.ZodArray<z.ZodString>;
    active: z.ZodBoolean;
    created_at: z.ZodISODateTime;
    released_at: z.ZodNullable<z.ZodISODateTime>;
}, z.core.$strict>;
export type AgentRunRecord = z.infer<typeof agentRunSchema>;
export type AgentLeaseRecord = z.infer<typeof agentLeaseSchema>;
declare const agentRunKeyBrand: unique symbol;
declare const agentLeaseKeyBrand: unique symbol;
export type AgentRunKey = string & {
    readonly [agentRunKeyBrand]: true;
};
export type AgentLeaseKey = string & {
    readonly [agentLeaseKeyBrand]: true;
};
export declare const STUDIO_AGENT_RUNS_PHYSICAL_DOMAIN = "studio_agent_runs";
export declare const STUDIO_AGENT_RUNS_LOGICAL_DOMAIN = "studio.agent.runs";
export declare const STUDIO_AGENT_LEASES_PHYSICAL_DOMAIN = "studio_agent_leases";
export declare const STUDIO_AGENT_LEASES_LOGICAL_DOMAIN = "studio.agent.leases";
export declare const studioAgentRunsDomainSpec: {
    name: string;
    version: number;
    tables: {
        runs: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<AgentRunKey, {
            run_id: string;
            org_id: string;
            tenant_id: string;
            workspace_id: string;
            parent_session_id: string;
            coordinator_session_id: string;
            provider: "spawn-in-process" | "codex" | "claude-code";
            worktree_path: string;
            repository_path: string;
            base_commit: string;
            status: "PENDING_APPROVAL" | "RUNNING" | "PROPOSED" | "APPLIED" | "FAILED" | "CANCELLED" | "BUDGET_EXCEEDED" | "REJECTED" | "UNKNOWN";
            changed_files: string[];
            diff_bytes: number;
            diff_sha256: string;
            main_changed_during_run: boolean;
            approved_by: string;
            approved_at: string;
            diagnostic: string | null;
            created_at: string;
            updated_at: string;
        }>;
    };
};
export declare const studioAgentLeasesDomainSpec: {
    name: string;
    version: number;
    tables: {
        leases: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<AgentLeaseKey, {
            lease_id: string;
            run_id: string;
            org_id: string;
            tenant_id: string;
            workspace_id: string;
            repository_path: string;
            paths: string[];
            active: boolean;
            created_at: string;
            released_at: string | null;
        }>;
    };
};
export {};
//# sourceMappingURL=model.d.ts.map