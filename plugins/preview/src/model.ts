import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

const timestamp = z.iso.datetime()
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
const scope = { org_id: z.string().min(1), tenant_id: z.string().min(1) }

export const previewStateSchema = z.enum([
  'REQUESTED', 'STARTING', 'READY', 'STOPPING', 'STOPPED', 'FAILED', 'EXPIRED',
])
export type PreviewState = z.infer<typeof previewStateSchema>

export const previewRecordSchema = z.object({
  preview_id: z.string().min(1),
  ...scope,
  project_id: z.string().min(1),
  run_id: z.string().min(1),
  artifact_sha256: sha256,
  created_by: z.string().min(1),
  source_session_id: z.string().min(1),
  hostname: z.string().regex(/^p-[a-f0-9]{24}\.dz23\.localhost$/u),
  state: previewStateSchema,
  created_at: timestamp,
  ready_at: timestamp.nullable(),
  expires_at: timestamp,
  stopped_at: timestamp.nullable(),
  stop_reason: z.enum(['user', 'expired', 'failed', 'reconciled', 'replaced']).nullable(),
  failure_code: z.string().min(1).nullable(),
  runtime_ref: z.string().min(1).max(200).nullable(),
  health: z.enum(['PENDING', 'OK', 'DOWN']),
}).strict()

export const previewAdmissionSchema = z.object({
  admission_id: z.string().min(1),
  preview_id: z.string().min(1),
  ...scope,
  user_id: z.string().min(1),
  source_session_id: z.string().min(1),
  ticket_hash: sha256,
  cookie_hash: sha256.nullable(),
  created_at: timestamp,
  expires_at: timestamp,
  exchanged_at: timestamp.nullable(),
  revoked_at: timestamp.nullable(),
}).strict()

export type PreviewRecord = z.infer<typeof previewRecordSchema>
export type PreviewAdmission = z.infer<typeof previewAdmissionSchema>

declare const previewKeyBrand: unique symbol
export type PreviewKey = string & { readonly [previewKeyBrand]: true }

export const STUDIO_PREVIEWS_PHYSICAL_DOMAIN = 'studio_previews'
export const STUDIO_PREVIEWS_LOGICAL_DOMAIN = 'studio.previews'
export const STUDIO_PREVIEW_ADMISSIONS_PHYSICAL_DOMAIN = 'studio_preview_admissions'
export const STUDIO_PREVIEW_ADMISSIONS_LOGICAL_DOMAIN = 'studio.preview.admissions'

export const studioPreviewsDomainSpec = defineDomain({
  name: STUDIO_PREVIEWS_PHYSICAL_DOMAIN,
  version: 1,
  tables: { previews: domainTable<PreviewKey, PreviewRecord>(previewRecordSchema) },
})

export const studioPreviewAdmissionsDomainSpec = defineDomain({
  name: STUDIO_PREVIEW_ADMISSIONS_PHYSICAL_DOMAIN,
  version: 1,
  tables: { admissions: domainTable<PreviewKey, PreviewAdmission>(previewAdmissionSchema) },
})
