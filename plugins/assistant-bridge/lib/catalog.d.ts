export declare const ASSISTANT_TOOL_NAMES: readonly ["studio_agent_start", "studio_agent_start_sensitive", "studio_agent_resolve_unknown", "studio_agent_list", "studio_agent_review", "studio_agent_cancel", "studio_agent_apply", "studio_team_start", "studio_team_start_sensitive", "studio_team_list", "studio_team_status", "studio_team_continue", "studio_team_continue_sensitive", "studio_team_cancel"];
export type AssistantToolName = typeof ASSISTANT_TOOL_NAMES[number];
/**
 * P36 deliberately exposes only the provider whose filesystem boundary is
 * exercised in-process. External CLI providers remain available to the
 * Phase 3 runtime, but are not configurable through this bridge until their
 * Windows and Linux symlink/junction confinement E2E gates pass.
 */
export declare const ASSISTANT_ALLOWED_PROVIDERS: readonly ["spawn-in-process"];
export type AssistantProvider = typeof ASSISTANT_ALLOWED_PROVIDERS[number];
/** Authoritative, closed catalog for the tools mounted by dz23-assistant. */
export declare const ASSISTANT_TOOL_POLICY: {
    studio_agent_start: {
        source: {
            kind: "studio" | "harness" | "plugin" | "mcp";
            external?: boolean | undefined;
            signed?: boolean | undefined;
            stableChannel?: boolean | undefined;
        };
        inferredTier?: unknown;
        manifestTier?: unknown;
        policyTier?: unknown;
        allowManifestDowngrade?: boolean | undefined;
        blocked?: boolean | undefined;
        sandboxMode?: string | undefined;
        requiredPermission?: "identity.self" | "workspace.read" | "workspace.create" | "workspace.manage" | "members.read" | "members.manage" | "integrations.manage" | "project.read" | "project.write" | "project.publish_staging" | "project.delete" | "audit.read" | "invitation.accept" | undefined;
        scope?: "none" | "org" | "workspace" | "project" | undefined;
    };
    studio_agent_start_sensitive: {
        source: {
            kind: "studio" | "harness" | "plugin" | "mcp";
            external?: boolean | undefined;
            signed?: boolean | undefined;
            stableChannel?: boolean | undefined;
        };
        inferredTier?: unknown;
        manifestTier?: unknown;
        policyTier?: unknown;
        allowManifestDowngrade?: boolean | undefined;
        blocked?: boolean | undefined;
        sandboxMode?: string | undefined;
        requiredPermission?: "identity.self" | "workspace.read" | "workspace.create" | "workspace.manage" | "members.read" | "members.manage" | "integrations.manage" | "project.read" | "project.write" | "project.publish_staging" | "project.delete" | "audit.read" | "invitation.accept" | undefined;
        scope?: "none" | "org" | "workspace" | "project" | undefined;
    };
    studio_agent_resolve_unknown: {
        source: {
            kind: "studio" | "harness" | "plugin" | "mcp";
            external?: boolean | undefined;
            signed?: boolean | undefined;
            stableChannel?: boolean | undefined;
        };
        inferredTier?: unknown;
        manifestTier?: unknown;
        policyTier?: unknown;
        allowManifestDowngrade?: boolean | undefined;
        blocked?: boolean | undefined;
        sandboxMode?: string | undefined;
        requiredPermission?: "identity.self" | "workspace.read" | "workspace.create" | "workspace.manage" | "members.read" | "members.manage" | "integrations.manage" | "project.read" | "project.write" | "project.publish_staging" | "project.delete" | "audit.read" | "invitation.accept" | undefined;
        scope?: "none" | "org" | "workspace" | "project" | undefined;
    };
    studio_agent_list: {
        source: {
            kind: "studio" | "harness" | "plugin" | "mcp";
            external?: boolean | undefined;
            signed?: boolean | undefined;
            stableChannel?: boolean | undefined;
        };
        inferredTier?: unknown;
        manifestTier?: unknown;
        policyTier?: unknown;
        allowManifestDowngrade?: boolean | undefined;
        blocked?: boolean | undefined;
        sandboxMode?: string | undefined;
        requiredPermission?: "identity.self" | "workspace.read" | "workspace.create" | "workspace.manage" | "members.read" | "members.manage" | "integrations.manage" | "project.read" | "project.write" | "project.publish_staging" | "project.delete" | "audit.read" | "invitation.accept" | undefined;
        scope?: "none" | "org" | "workspace" | "project" | undefined;
    };
    studio_agent_review: {
        source: {
            kind: "studio" | "harness" | "plugin" | "mcp";
            external?: boolean | undefined;
            signed?: boolean | undefined;
            stableChannel?: boolean | undefined;
        };
        inferredTier?: unknown;
        manifestTier?: unknown;
        policyTier?: unknown;
        allowManifestDowngrade?: boolean | undefined;
        blocked?: boolean | undefined;
        sandboxMode?: string | undefined;
        requiredPermission?: "identity.self" | "workspace.read" | "workspace.create" | "workspace.manage" | "members.read" | "members.manage" | "integrations.manage" | "project.read" | "project.write" | "project.publish_staging" | "project.delete" | "audit.read" | "invitation.accept" | undefined;
        scope?: "none" | "org" | "workspace" | "project" | undefined;
    };
    studio_agent_cancel: {
        source: {
            kind: "studio" | "harness" | "plugin" | "mcp";
            external?: boolean | undefined;
            signed?: boolean | undefined;
            stableChannel?: boolean | undefined;
        };
        inferredTier?: unknown;
        manifestTier?: unknown;
        policyTier?: unknown;
        allowManifestDowngrade?: boolean | undefined;
        blocked?: boolean | undefined;
        sandboxMode?: string | undefined;
        requiredPermission?: "identity.self" | "workspace.read" | "workspace.create" | "workspace.manage" | "members.read" | "members.manage" | "integrations.manage" | "project.read" | "project.write" | "project.publish_staging" | "project.delete" | "audit.read" | "invitation.accept" | undefined;
        scope?: "none" | "org" | "workspace" | "project" | undefined;
    };
    studio_agent_apply: {
        source: {
            kind: "studio" | "harness" | "plugin" | "mcp";
            external?: boolean | undefined;
            signed?: boolean | undefined;
            stableChannel?: boolean | undefined;
        };
        inferredTier?: unknown;
        manifestTier?: unknown;
        policyTier?: unknown;
        allowManifestDowngrade?: boolean | undefined;
        blocked?: boolean | undefined;
        sandboxMode?: string | undefined;
        requiredPermission?: "identity.self" | "workspace.read" | "workspace.create" | "workspace.manage" | "members.read" | "members.manage" | "integrations.manage" | "project.read" | "project.write" | "project.publish_staging" | "project.delete" | "audit.read" | "invitation.accept" | undefined;
        scope?: "none" | "org" | "workspace" | "project" | undefined;
    };
    studio_team_start: {
        source: {
            kind: "studio" | "harness" | "plugin" | "mcp";
            external?: boolean | undefined;
            signed?: boolean | undefined;
            stableChannel?: boolean | undefined;
        };
        inferredTier?: unknown;
        manifestTier?: unknown;
        policyTier?: unknown;
        allowManifestDowngrade?: boolean | undefined;
        blocked?: boolean | undefined;
        sandboxMode?: string | undefined;
        requiredPermission?: "identity.self" | "workspace.read" | "workspace.create" | "workspace.manage" | "members.read" | "members.manage" | "integrations.manage" | "project.read" | "project.write" | "project.publish_staging" | "project.delete" | "audit.read" | "invitation.accept" | undefined;
        scope?: "none" | "org" | "workspace" | "project" | undefined;
    };
    studio_team_start_sensitive: {
        source: {
            kind: "studio" | "harness" | "plugin" | "mcp";
            external?: boolean | undefined;
            signed?: boolean | undefined;
            stableChannel?: boolean | undefined;
        };
        inferredTier?: unknown;
        manifestTier?: unknown;
        policyTier?: unknown;
        allowManifestDowngrade?: boolean | undefined;
        blocked?: boolean | undefined;
        sandboxMode?: string | undefined;
        requiredPermission?: "identity.self" | "workspace.read" | "workspace.create" | "workspace.manage" | "members.read" | "members.manage" | "integrations.manage" | "project.read" | "project.write" | "project.publish_staging" | "project.delete" | "audit.read" | "invitation.accept" | undefined;
        scope?: "none" | "org" | "workspace" | "project" | undefined;
    };
    studio_team_list: {
        source: {
            kind: "studio" | "harness" | "plugin" | "mcp";
            external?: boolean | undefined;
            signed?: boolean | undefined;
            stableChannel?: boolean | undefined;
        };
        inferredTier?: unknown;
        manifestTier?: unknown;
        policyTier?: unknown;
        allowManifestDowngrade?: boolean | undefined;
        blocked?: boolean | undefined;
        sandboxMode?: string | undefined;
        requiredPermission?: "identity.self" | "workspace.read" | "workspace.create" | "workspace.manage" | "members.read" | "members.manage" | "integrations.manage" | "project.read" | "project.write" | "project.publish_staging" | "project.delete" | "audit.read" | "invitation.accept" | undefined;
        scope?: "none" | "org" | "workspace" | "project" | undefined;
    };
    studio_team_status: {
        source: {
            kind: "studio" | "harness" | "plugin" | "mcp";
            external?: boolean | undefined;
            signed?: boolean | undefined;
            stableChannel?: boolean | undefined;
        };
        inferredTier?: unknown;
        manifestTier?: unknown;
        policyTier?: unknown;
        allowManifestDowngrade?: boolean | undefined;
        blocked?: boolean | undefined;
        sandboxMode?: string | undefined;
        requiredPermission?: "identity.self" | "workspace.read" | "workspace.create" | "workspace.manage" | "members.read" | "members.manage" | "integrations.manage" | "project.read" | "project.write" | "project.publish_staging" | "project.delete" | "audit.read" | "invitation.accept" | undefined;
        scope?: "none" | "org" | "workspace" | "project" | undefined;
    };
    studio_team_continue: {
        source: {
            kind: "studio" | "harness" | "plugin" | "mcp";
            external?: boolean | undefined;
            signed?: boolean | undefined;
            stableChannel?: boolean | undefined;
        };
        inferredTier?: unknown;
        manifestTier?: unknown;
        policyTier?: unknown;
        allowManifestDowngrade?: boolean | undefined;
        blocked?: boolean | undefined;
        sandboxMode?: string | undefined;
        requiredPermission?: "identity.self" | "workspace.read" | "workspace.create" | "workspace.manage" | "members.read" | "members.manage" | "integrations.manage" | "project.read" | "project.write" | "project.publish_staging" | "project.delete" | "audit.read" | "invitation.accept" | undefined;
        scope?: "none" | "org" | "workspace" | "project" | undefined;
    };
    studio_team_continue_sensitive: {
        source: {
            kind: "studio" | "harness" | "plugin" | "mcp";
            external?: boolean | undefined;
            signed?: boolean | undefined;
            stableChannel?: boolean | undefined;
        };
        inferredTier?: unknown;
        manifestTier?: unknown;
        policyTier?: unknown;
        allowManifestDowngrade?: boolean | undefined;
        blocked?: boolean | undefined;
        sandboxMode?: string | undefined;
        requiredPermission?: "identity.self" | "workspace.read" | "workspace.create" | "workspace.manage" | "members.read" | "members.manage" | "integrations.manage" | "project.read" | "project.write" | "project.publish_staging" | "project.delete" | "audit.read" | "invitation.accept" | undefined;
        scope?: "none" | "org" | "workspace" | "project" | undefined;
    };
    studio_team_cancel: {
        source: {
            kind: "studio" | "harness" | "plugin" | "mcp";
            external?: boolean | undefined;
            signed?: boolean | undefined;
            stableChannel?: boolean | undefined;
        };
        inferredTier?: unknown;
        manifestTier?: unknown;
        policyTier?: unknown;
        allowManifestDowngrade?: boolean | undefined;
        blocked?: boolean | undefined;
        sandboxMode?: string | undefined;
        requiredPermission?: "identity.self" | "workspace.read" | "workspace.create" | "workspace.manage" | "members.read" | "members.manage" | "integrations.manage" | "project.read" | "project.write" | "project.publish_staging" | "project.delete" | "audit.read" | "invitation.accept" | undefined;
        scope?: "none" | "org" | "workspace" | "project" | undefined;
    };
};
export declare function assertAssistantToolCatalog(exposedTools: readonly string[], classifiedTools: readonly string[]): void;
//# sourceMappingURL=catalog.d.ts.map