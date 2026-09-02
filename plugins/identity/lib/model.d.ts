import { z } from 'zod';
/** Accepts the pre-P29-B `role` field only for storage migration and strips it. */
export declare const identityUserSchema: z.ZodPipe<z.ZodObject<{
    user_id: z.ZodString;
    email: z.ZodEmail;
    display_name: z.ZodString;
    bootstrap_owner: z.ZodOptional<z.ZodBoolean>;
    role: z.ZodOptional<z.ZodEnum<{
        owner: "owner";
        admin: "admin";
        builder: "builder";
        viewer: "viewer";
    }>>;
    org_id: z.ZodString;
    tenant_id: z.ZodString;
    created_at: z.ZodISODateTime;
}, z.core.$strict>, z.ZodTransform<{
    user_id: string;
    email: string;
    display_name: string;
    org_id: string;
    tenant_id: string;
    created_at: string;
    bootstrap_owner?: boolean | undefined;
}, {
    user_id: string;
    email: string;
    display_name: string;
    org_id: string;
    tenant_id: string;
    created_at: string;
    bootstrap_owner?: boolean | undefined;
    role?: "owner" | "admin" | "builder" | "viewer" | undefined;
}>>;
export declare const passkeyCredentialSchema: z.ZodObject<{
    credential_id: z.ZodString;
    user_id: z.ZodString;
    public_key: z.ZodString;
    counter: z.ZodNumber;
    transports: z.ZodArray<z.ZodString>;
    device_label: z.ZodString;
    created_at: z.ZodISODateTime;
    last_used_at: z.ZodNullable<z.ZodISODateTime>;
}, z.core.$strict>;
export declare const sessionRecordSchema: z.ZodObject<{
    session_id: z.ZodString;
    user_id: z.ZodString;
    org_id: z.ZodString;
    tenant_id: z.ZodString;
    token_hash: z.ZodString;
    csrf_hash: z.ZodString;
    device_label: z.ZodString;
    user_agent: z.ZodString;
    ip_truncated: z.ZodString;
    created_at: z.ZodISODateTime;
    last_seen_at: z.ZodISODateTime;
    expires_sliding_at: z.ZodISODateTime;
    expires_absolute_at: z.ZodISODateTime;
    last_strong_auth_at: z.ZodNullable<z.ZodISODateTime>;
    last_strong_auth_method: z.ZodNullable<z.ZodLiteral<"passkey">>;
    revoked_at: z.ZodNullable<z.ZodISODateTime>;
    revoked_reason: z.ZodNullable<z.ZodString>;
    harness_session_ids: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
export declare const challengeRecordSchema: z.ZodObject<{
    challenge_id: z.ZodString;
    challenge_hash: z.ZodString;
    purpose: z.ZodEnum<{
        registration: "registration";
        authentication: "authentication";
        "step-up": "step-up";
    }>;
    user_id: z.ZodString;
    session_id: z.ZodNullable<z.ZodString>;
    created_at: z.ZodISODateTime;
    expires_at: z.ZodISODateTime;
    consumed_at: z.ZodNullable<z.ZodISODateTime>;
}, z.core.$strict>;
export declare const magicCodeRecordSchema: z.ZodObject<{
    magic_code_id: z.ZodString;
    email: z.ZodEmail;
    code_hash: z.ZodString;
    org_id: z.ZodString;
    tenant_id: z.ZodString;
    attempts: z.ZodNumber;
    created_at: z.ZodISODateTime;
    expires_at: z.ZodISODateTime;
    consumed_at: z.ZodNullable<z.ZodISODateTime>;
}, z.core.$strict>;
export declare const identityAuditRecordSchema: z.ZodObject<{
    audit_id: z.ZodString;
    event_type: z.ZodEnum<{
        magic_code_requested: "magic_code_requested";
        magic_code_suppressed: "magic_code_suppressed";
        login_succeeded: "login_succeeded";
        login_failed: "login_failed";
        passkey_registered: "passkey_registered";
        step_up_succeeded: "step_up_succeeded";
        session_revoked: "session_revoked";
        all_sessions_revoked: "all_sessions_revoked";
        harness_session_bound: "harness_session_bound";
        personal_mode_disabled: "personal_mode_disabled";
        enrollment_closed: "enrollment_closed";
        invitation_created: "invitation_created";
        invitation_accepted: "invitation_accepted";
        role_changed: "role_changed";
        workspace_created: "workspace_created";
    }>;
    user_id: z.ZodNullable<z.ZodString>;
    session_id: z.ZodNullable<z.ZodString>;
    org_id: z.ZodString;
    tenant_id: z.ZodString;
    created_at: z.ZodISODateTime;
    outcome: z.ZodEnum<{
        success: "success";
        failure: "failure";
    }>;
    reason: z.ZodString;
}, z.core.$strict>;
export type IdentityUser = z.infer<typeof identityUserSchema>;
export type PasskeyCredential = z.infer<typeof passkeyCredentialSchema>;
export type SessionRecord = z.infer<typeof sessionRecordSchema>;
export type ChallengeRecord = z.infer<typeof challengeRecordSchema>;
export type MagicCodeRecord = z.infer<typeof magicCodeRecordSchema>;
export type IdentityAuditRecord = z.infer<typeof identityAuditRecordSchema>;
declare const keyBrand: unique symbol;
export type IdentityKey = string & {
    readonly [keyBrand]: true;
};
export declare const STUDIO_IDENTITY_USERS_PHYSICAL_DOMAIN = "studio_identity_users";
export declare const STUDIO_IDENTITY_USERS_LOGICAL_DOMAIN = "studio.identity.users";
export declare const STUDIO_IDENTITY_CREDENTIALS_PHYSICAL_DOMAIN = "studio_identity_credentials";
export declare const STUDIO_IDENTITY_CREDENTIALS_LOGICAL_DOMAIN = "studio.identity.credentials";
export declare const STUDIO_IDENTITY_SESSIONS_PHYSICAL_DOMAIN = "studio_identity_sessions";
export declare const STUDIO_IDENTITY_SESSIONS_LOGICAL_DOMAIN = "studio.identity.sessions";
export declare const STUDIO_IDENTITY_AUDIT_PHYSICAL_DOMAIN = "studio_identity_audit";
export declare const STUDIO_IDENTITY_AUDIT_LOGICAL_DOMAIN = "studio.identity.audit";
export declare const identityUsersDomainSpec: {
    name: string;
    version: number;
    tables: {
        users: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<IdentityKey, {
            user_id: string;
            email: string;
            display_name: string;
            org_id: string;
            tenant_id: string;
            created_at: string;
            bootstrap_owner?: boolean | undefined;
        }>;
        magic_codes: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<IdentityKey, {
            magic_code_id: string;
            email: string;
            code_hash: string;
            org_id: string;
            tenant_id: string;
            attempts: number;
            created_at: string;
            expires_at: string;
            consumed_at: string | null;
        }>;
    };
};
export declare const identityCredentialsDomainSpec: {
    name: string;
    version: number;
    tables: {
        credentials: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<IdentityKey, {
            credential_id: string;
            user_id: string;
            public_key: string;
            counter: number;
            transports: string[];
            device_label: string;
            created_at: string;
            last_used_at: string | null;
        }>;
        challenges: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<IdentityKey, {
            challenge_id: string;
            challenge_hash: string;
            purpose: "registration" | "authentication" | "step-up";
            user_id: string;
            session_id: string | null;
            created_at: string;
            expires_at: string;
            consumed_at: string | null;
        }>;
    };
};
export declare const identitySessionsDomainSpec: {
    name: string;
    version: number;
    tables: {
        sessions: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<IdentityKey, {
            session_id: string;
            user_id: string;
            org_id: string;
            tenant_id: string;
            token_hash: string;
            csrf_hash: string;
            device_label: string;
            user_agent: string;
            ip_truncated: string;
            created_at: string;
            last_seen_at: string;
            expires_sliding_at: string;
            expires_absolute_at: string;
            last_strong_auth_at: string | null;
            last_strong_auth_method: "passkey" | null;
            revoked_at: string | null;
            revoked_reason: string | null;
            harness_session_ids: string[];
        }>;
    };
};
export declare const identityAuditDomainSpec: {
    name: string;
    version: number;
    tables: {
        events: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<IdentityKey, {
            audit_id: string;
            event_type: "magic_code_requested" | "magic_code_suppressed" | "login_succeeded" | "login_failed" | "passkey_registered" | "step_up_succeeded" | "session_revoked" | "all_sessions_revoked" | "harness_session_bound" | "personal_mode_disabled" | "enrollment_closed" | "invitation_created" | "invitation_accepted" | "role_changed" | "workspace_created";
            user_id: string | null;
            session_id: string | null;
            org_id: string;
            tenant_id: string;
            created_at: string;
            outcome: "success" | "failure";
            reason: string;
        }>;
    };
};
export {};
//# sourceMappingURL=model.d.ts.map