import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

const storedIdentityUserSchema = z.object({
  user_id: z.string().min(1),
  email: z.email(),
  display_name: z.string().min(1),
  bootstrap_owner: z.boolean().optional(),
  /** Presente somente enquanto a criacao inicial do espaco ainda precisa terminar. */
  bootstrap_provisioning_pending: z.literal(true).optional(),
  role: z.enum(['owner', 'admin', 'builder', 'viewer']).optional(),
  org_id: z.string().min(1),
  tenant_id: z.string().min(1),
  created_at: z.iso.datetime(),
}).strict()

/** Accepts the pre-P29-B `role` field only for storage migration and strips it. */
export const identityUserSchema = storedIdentityUserSchema.transform(({ role: _legacyRole, ...user }) => user)

export const passkeyCredentialSchema = z.object({
  credential_id: z.string().min(1),
  user_id: z.string().min(1),
  public_key: z.string().min(1),
  counter: z.number().int().nonnegative(),
  transports: z.array(z.string()),
  device_label: z.string().min(1),
  created_at: z.iso.datetime(),
  last_used_at: z.iso.datetime().nullable(),
}).strict()

export const sessionRecordSchema = z.object({
  session_id: z.string().min(1),
  user_id: z.string().min(1),
  org_id: z.string().min(1),
  tenant_id: z.string().min(1),
  token_hash: z.string().regex(/^[a-f0-9]{64}$/),
  csrf_hash: z.string().regex(/^[a-f0-9]{64}$/),
  device_label: z.string().min(1),
  user_agent: z.string(),
  ip_truncated: z.string(),
  created_at: z.iso.datetime(),
  last_seen_at: z.iso.datetime(),
  expires_sliding_at: z.iso.datetime(),
  expires_absolute_at: z.iso.datetime(),
  last_strong_auth_at: z.iso.datetime().nullable(),
  last_strong_auth_method: z.literal('passkey').nullable(),
  revoked_at: z.iso.datetime().nullable(),
  revoked_reason: z.string().nullable(),
  harness_session_ids: z.array(z.string().min(1)),
  /**
   * A semente do token CSRF desta sessão.
   *
   * O token CSRF era função DETERMINÍSTICA e imutável do token de sessão:
   * `GET /csrf` devolvia sempre o mesmo valor, e um vazamento pontual (log de
   * proxy, extensão, captura de tela) valia pelo resto da vida da sessão — até
   * 90 dias. Com a semente, ele pode ser trocado sem derrubar a sessão, e é
   * trocado em toda elevação de identidade.
   *
   * OPCIONAL de propósito: sessão gravada antes deste campo continua abrindo, e
   * o domínio não muda de versão. Ausente significa "ainda derivado do token",
   * que é exatamente o que aquelas sessões têm.
   */
  csrf_seed: z.string().regex(/^[A-Za-z0-9_-]{16,200}$/).optional(),
}).strict()

export const challengeRecordSchema = z.object({
  challenge_id: z.string().min(1),
  challenge_hash: z.string().regex(/^[a-f0-9]{64}$/),
  purpose: z.enum(['registration', 'authentication', 'step-up']),
  user_id: z.string().min(1),
  session_id: z.string().min(1).nullable(),
  created_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  consumed_at: z.iso.datetime().nullable(),
}).strict()

export const magicCodeRecordSchema = z.object({
  magic_code_id: z.string().min(1),
  email: z.email(),
  code_hash: z.string().regex(/^[a-f0-9]{64}$/),
  org_id: z.string().min(1),
  tenant_id: z.string().min(1),
  attempts: z.number().int().nonnegative().max(5),
  created_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  consumed_at: z.iso.datetime().nullable(),
}).strict()

export const identityAuditRecordSchema = z.object({
  audit_id: z.string().min(1),
  event_type: z.enum([
    'magic_code_requested', 'magic_code_suppressed', 'magic_code_send_failed', 'login_succeeded', 'login_failed', 'passkey_registered',
    'step_up_succeeded', 'session_revoked', 'all_sessions_revoked',
    'harness_session_bound', 'harness_session_unbound', 'personal_mode_disabled', 'enrollment_closed',
    'invitation_created', 'invitation_accepted', 'role_changed', 'workspace_created',
  ]),
  user_id: z.string().min(1).nullable(),
  session_id: z.string().min(1).nullable(),
  org_id: z.string().min(1),
  tenant_id: z.string().min(1),
  created_at: z.iso.datetime(),
  outcome: z.enum(['success', 'failure']),
  reason: z.string().min(1),
}).strict()

export type IdentityUser = z.infer<typeof identityUserSchema>
export type PasskeyCredential = z.infer<typeof passkeyCredentialSchema>
export type SessionRecord = z.infer<typeof sessionRecordSchema>
export type ChallengeRecord = z.infer<typeof challengeRecordSchema>
export type MagicCodeRecord = z.infer<typeof magicCodeRecordSchema>
export type IdentityAuditRecord = z.infer<typeof identityAuditRecordSchema>

declare const keyBrand: unique symbol
export type IdentityKey = string & { readonly [keyBrand]: true }

export const STUDIO_IDENTITY_USERS_PHYSICAL_DOMAIN = 'studio_identity_users'
export const STUDIO_IDENTITY_USERS_LOGICAL_DOMAIN = 'studio.identity.users'
export const STUDIO_IDENTITY_CREDENTIALS_PHYSICAL_DOMAIN = 'studio_identity_credentials'
export const STUDIO_IDENTITY_CREDENTIALS_LOGICAL_DOMAIN = 'studio.identity.credentials'
export const STUDIO_IDENTITY_SESSIONS_PHYSICAL_DOMAIN = 'studio_identity_sessions'
export const STUDIO_IDENTITY_SESSIONS_LOGICAL_DOMAIN = 'studio.identity.sessions'
export const STUDIO_IDENTITY_AUDIT_PHYSICAL_DOMAIN = 'studio_identity_audit'
export const STUDIO_IDENTITY_AUDIT_LOGICAL_DOMAIN = 'studio.identity.audit'

export const identityUsersDomainSpec = defineDomain({
  name: STUDIO_IDENTITY_USERS_PHYSICAL_DOMAIN,
  version: 1,
  tables: {
    users: domainTable<IdentityKey, IdentityUser>(identityUserSchema),
    magic_codes: domainTable<IdentityKey, MagicCodeRecord>(magicCodeRecordSchema),
  },
})

export const identityCredentialsDomainSpec = defineDomain({
  name: STUDIO_IDENTITY_CREDENTIALS_PHYSICAL_DOMAIN,
  version: 1,
  tables: {
    credentials: domainTable<IdentityKey, PasskeyCredential>(passkeyCredentialSchema),
    challenges: domainTable<IdentityKey, ChallengeRecord>(challengeRecordSchema),
  },
})

export const identitySessionsDomainSpec = defineDomain({
  name: STUDIO_IDENTITY_SESSIONS_PHYSICAL_DOMAIN,
  version: 1,
  tables: {
    sessions: domainTable<IdentityKey, SessionRecord>(sessionRecordSchema),
  },
})

export const identityAuditDomainSpec = defineDomain({
  name: STUDIO_IDENTITY_AUDIT_PHYSICAL_DOMAIN,
  version: 1,
  tables: {
    events: domainTable<IdentityKey, IdentityAuditRecord>(identityAuditRecordSchema),
  },
})
