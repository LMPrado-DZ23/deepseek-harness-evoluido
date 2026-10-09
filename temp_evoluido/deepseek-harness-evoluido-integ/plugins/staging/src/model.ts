import { z } from 'zod'

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const timestampSchema = z.iso.datetime()
const identifierSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
const providerIdSchema = z.string().min(2).max(64).regex(/^[a-z][a-z0-9-]+$/u)
const opaqueRefSchema = z.string().min(3).max(500).regex(/^[a-z][a-z0-9+.-]{1,31}:[^\s\u0000-\u001f\u007f]+$/u)
const failureCodeSchema = z.string().min(2).max(96).regex(/^[A-Z][A-Z0-9_]+$/u)

export const stagingActionSchema = z.enum(['staging.publish', 'staging.rollback'])
export type StagingAction = z.infer<typeof stagingActionSchema>

export const stagingArtifactSchema = z.object({
  project_id: identifierSchema,
  run_id: identifierSchema,
  artifact_ref: opaqueRefSchema,
  artifact_sha256: sha256Schema,
  manifest_sha256: sha256Schema,
  acceptance_sha256: sha256Schema,
  sbom_sha256: sha256Schema,
  provenance_sha256: sha256Schema,
  builder_image_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  policy_sha256: sha256Schema,
}).strict()
export type StagingArtifact = z.infer<typeof stagingArtifactSchema>

export const stagingApprovalReceiptSchema = z.object({
  approval_id: identifierSchema,
  action: stagingActionSchema,
  subject_id: identifierSchema,
  fingerprint: sha256Schema,
  user_id: identifierSchema,
  session_id: identifierSchema,
  org_id: identifierSchema,
  tenant_id: identifierSchema,
  approved_at: timestampSchema,
}).strict()
export type StagingApprovalReceipt = z.infer<typeof stagingApprovalReceiptSchema>

export const stagingProviderReceiptSchema = z.object({
  provider_id: providerIdSchema,
  environment: z.literal('staging'),
  target_ref: opaqueRefSchema,
  operation_id: identifierSchema,
  kind: z.enum(['PUBLISH', 'ROLLBACK']),
  target_generation: z.number().int().positive(),
  artifact_sha256: sha256Schema,
  receipt_ref: opaqueRefSchema,
  observed_at: timestampSchema,
}).strict()
export type StagingProviderReceipt = z.infer<typeof stagingProviderReceiptSchema>

export const stagingProviderConfigSchema = z.object({
  provider_id: providerIdSchema,
  environment: z.literal('staging'),
  target_ref: opaqueRefSchema,
}).strict()

export const stagingReleaseStateSchema = z.enum([
  'APPROVAL_PENDING', 'REQUESTED', 'STAGING', 'STAGING_OK', 'ROLLBACK_REQUESTED', 'ROLLING_BACK',
  'ROLLED_BACK', 'FAILED', 'RECONCILIATION_REQUIRED',
])
export type StagingReleaseState = z.infer<typeof stagingReleaseStateSchema>

const stagingReleaseShape = z.object({
  release_id: z.string().regex(/^stg-[a-f0-9]{64}$/u),
  operation_id: identifierSchema,
  request_fingerprint: sha256Schema,
  target_key: sha256Schema,
  target_generation: z.number().int().positive(),
  effect_lease_id: identifierSchema,
  effect_lease_expires_at: timestampSchema,
  kind: z.enum(['PUBLISH', 'ROLLBACK']),
  org_id: identifierSchema,
  tenant_id: identifierSchema,
  project_id: identifierSchema,
  run_id: identifierSchema,
  artifact: stagingArtifactSchema,
  provider_id: providerIdSchema,
  environment: z.literal('staging'),
  target_ref: opaqueRefSchema,
  state: stagingReleaseStateSchema,
  version: z.number().int().positive(),
  created_by: identifierSchema,
  source_session_id: identifierSchema,
  requested_approval_id: identifierSchema,
  approval_id: identifierSchema.nullable(),
  approved_at: timestampSchema.nullable(),
  created_at: timestampSchema,
  last_transition_at: timestampSchema,
  started_at: timestampSchema.nullable(),
  finished_at: timestampSchema.nullable(),
  reconciled_at: timestampSchema.nullable(),
  provider_receipt: stagingProviderReceiptSchema.nullable(),
  failure_code: failureCodeSchema.nullable(),
  rollback_from_release_id: z.string().regex(/^stg-[a-f0-9]{64}$/u).nullable(),
  rollback_from_generation: z.number().int().positive().nullable(),
  rollback_target_release_id: z.string().regex(/^stg-[a-f0-9]{64}$/u).nullable(),
}).strict()

export const stagingReleaseSchema = stagingReleaseShape.superRefine((release, context) => {
  const approved = release.approval_id !== null && release.approved_at !== null
  const started = release.started_at !== null
  const finished = release.finished_at !== null
  const hasReceipt = release.provider_receipt !== null
  const hasFailure = release.failure_code !== null
  const rollbackRefs = release.rollback_from_release_id !== null && release.rollback_target_release_id !== null
  const createdAt = Date.parse(release.created_at)
  const lastTransitionAt = Date.parse(release.last_transition_at)
  const leaseExpiresAt = Date.parse(release.effect_lease_expires_at)
  const startedAt = release.started_at === null ? null : Date.parse(release.started_at)
  const finishedAt = release.finished_at === null ? null : Date.parse(release.finished_at)
  const reconciledAt = release.reconciled_at === null ? null : Date.parse(release.reconciled_at)

  const invalid = (message: string): void => context.addIssue({ code: 'custom', message })
  if ((release.approval_id === null) !== (release.approved_at === null)) invalid('approval receipt fields must be paired')
  if (started && !approved) invalid('an external effect cannot start without approval')
  if (release.reconciled_at !== null && (!finished || (release.state !== 'FAILED' && release.state !== 'STAGING_OK' && release.state !== 'ROLLED_BACK'))) invalid('reconciled_at requires a terminal reconciled state')
  if (release.kind === 'PUBLISH' && (release.rollback_from_release_id !== null || release.rollback_from_generation !== null || release.rollback_target_release_id !== null)) invalid('publish cannot contain rollback references')
  if (release.kind === 'ROLLBACK' && (!rollbackRefs || release.rollback_from_generation === null)) invalid('rollback requires release references and active generation')
  if (release.provider_receipt !== null && (
    release.provider_receipt.provider_id !== release.provider_id
    || release.provider_receipt.target_ref !== release.target_ref
    || release.provider_receipt.operation_id !== release.operation_id
    || release.provider_receipt.kind !== release.kind
    || release.provider_receipt.target_generation !== release.target_generation
    || release.provider_receipt.artifact_sha256 !== release.artifact.artifact_sha256
  )) invalid('provider receipt does not match the immutable release')
  if (release.kind === 'PUBLISH' && (release.state === 'ROLLBACK_REQUESTED' || release.state === 'ROLLING_BACK' || release.state === 'ROLLED_BACK')) invalid('publish has an invalid rollback state')
  if (release.kind === 'ROLLBACK' && (release.state === 'REQUESTED' || release.state === 'STAGING' || release.state === 'STAGING_OK')) invalid('rollback has an invalid publish state')

  switch (release.state) {
    case 'APPROVAL_PENDING':
      if (approved || started || finished || hasReceipt || (hasFailure && release.failure_code !== 'APPROVAL_STATUS_UNKNOWN')) invalid('approval pending must not claim approval, execution or outcome')
      break
    case 'REQUESTED':
    case 'ROLLBACK_REQUESTED':
      if (!approved || started || finished || hasReceipt || hasFailure) invalid('requested state requires approval and no execution outcome')
      break
    case 'STAGING':
    case 'ROLLING_BACK':
      if (!approved || !started || finished || hasReceipt || hasFailure) invalid('running state requires approval and start only')
      break
    case 'STAGING_OK':
    case 'ROLLED_BACK':
      if (!approved || !started || !finished || !hasReceipt || hasFailure) invalid('successful state requires approval, execution and exact provider receipt')
      break
    case 'FAILED':
      if (!finished || hasReceipt || !hasFailure) invalid('failed state requires a local terminal failure without provider receipt')
      break
    case 'RECONCILIATION_REQUIRED':
      if (!approved || !started || finished || !hasFailure) invalid('reconciliation state requires an unresolved started effect')
      if (hasReceipt !== (release.failure_code === 'CONFLICTING_EXTERNAL_EFFECT')) invalid('only a conflicting accepted effect may retain a receipt during reconciliation')
      break
  }

  if (leaseExpiresAt < createdAt) invalid('effect lease expires before created_at')
  if (startedAt !== null && startedAt < createdAt) invalid('started_at precedes created_at')
  if (finishedAt !== null && finishedAt < createdAt) invalid('finished_at precedes created_at')
  if (finishedAt !== null && startedAt !== null && finishedAt < startedAt) invalid('finished_at precedes started_at')
  if (reconciledAt !== null && reconciledAt < createdAt) invalid('reconciled_at precedes created_at')
  if (lastTransitionAt < createdAt) invalid('last_transition_at precedes created_at')
  if (startedAt !== null && lastTransitionAt < startedAt) invalid('last_transition_at precedes started_at')
  if (finishedAt !== null && lastTransitionAt < finishedAt) invalid('last_transition_at precedes finished_at')
  if (reconciledAt !== null && lastTransitionAt < reconciledAt) invalid('last_transition_at precedes reconciled_at')
})
export type StagingRelease = z.infer<typeof stagingReleaseSchema>

export const STUDIO_STAGING_RELEASES_PHYSICAL_DOMAIN = 'studio_staging_releases'
export const STUDIO_STAGING_RELEASES_LOGICAL_DOMAIN = 'studio.staging.releases'
