import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { policyTierSchema } from '@dz23-studio/policy'
import { z } from 'zod'

const scope = { org_id: z.string().min(1), tenant_id: z.string().min(1) }
const timestamp = z.iso.datetime()
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)

/** Environment-style credential reference (the Harness credential seam grammar). The value never leaves the vault. */
export const secretRefSchema = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/u)

export const integrationKindSchema = z.enum(['smtp', 'mcp', 'skill', 'webhook'])
export type IntegrationKind = z.infer<typeof integrationKindSchema>

export const integrationPermissionSchema = z.enum([
  'read.project', 'write.project', 'network.outbound', 'filesystem.workspace', 'secrets.read', 'email.send',
])

/**
 * Integration manifest v1 (D16). `signature` is an Ed25519 signature (base64)
 * over the canonical JSON of the manifest without the `signature` field.
 */
export const integrationManifestSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/u),
  name: z.string().trim().min(1).max(120),
  version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  kind: integrationKindSchema,
  publisher: z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/u), name: z.string().trim().min(1).max(120) }).strict(),
  tier: z.string().optional(),
  permissions: z.array(integrationPermissionSchema).max(20).default([]),
  endpoint: z.string().url().optional(),
  description: z.string().trim().max(500).optional(),
  signature: z.string().base64().optional(),
}).strict()
export type IntegrationManifest = z.infer<typeof integrationManifestSchema>

export const verificationSchema = z.enum(['verified', 'unverified', 'invalid'])

export const studioIntegrationSchema = z.object({
  integration_id: z.string().min(1), ...scope,
  kind: integrationKindSchema,
  name: z.string().min(1).max(120),
  manifest: integrationManifestSchema.nullable(),
  effective_tier: policyTierSchema,
  verification: verificationSchema,
  enabled: z.boolean(),
  /** For `smtp`: the credential reference name. Never a value. */
  secret_ref: secretRefSchema.nullable(),
  created_by: z.string().min(1),
  created_at: timestamp, updated_at: timestamp,
}).strict()
export type StudioIntegration = z.infer<typeof studioIntegrationSchema>

export const studioExportSchema = z.object({
  export_id: z.string().min(1), ...scope,
  project_id: z.string().min(1), run_id: z.string().min(1),
  file_name: z.string().min(1), path: z.string().min(1), sha256, size_bytes: z.number().int().nonnegative(),
  entries: z.number().int().nonnegative(),
  created_by: z.string().min(1), created_at: timestamp,
}).strict()
export type StudioExport = z.infer<typeof studioExportSchema>

export const hubEventSchema = z.object({
  event_id: z.string().min(1), ...scope,
  actor_user_id: z.string().min(1),
  action: z.enum(['smtp.configured', 'smtp.tested', 'integration.registered', 'integration.enabled', 'integration.disabled', 'export.created', 'approval.recorded']),
  subject_id: z.string().min(1),
  outcome: z.enum(['success', 'failure', 'not-executed']),
  detail: z.string().max(500),
  created_at: timestamp,
}).strict()
export type HubEvent = z.infer<typeof hubEventSchema>

const brand = Symbol('hub-key')
export type HubKey = string & { readonly [brand]: true }

export const studioIntegrationsDomainSpec = defineDomain({
  name: 'studio_integrations', version: 1,
  tables: {
    integrations: domainTable<HubKey, StudioIntegration>(studioIntegrationSchema),
    exports: domainTable<HubKey, StudioExport>(studioExportSchema),
    events: domainTable<HubKey, HubEvent>(hubEventSchema),
  },
})
