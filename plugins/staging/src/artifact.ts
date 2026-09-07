import { createHash, timingSafeEqual } from 'node:crypto'
import { stagingArtifactSchema, stagingProviderReceiptSchema, type StagingArtifact, type StagingProviderReceipt } from './model.js'

export interface StagingRequestFingerprintInput {
  readonly kind: 'PUBLISH' | 'ROLLBACK'
  readonly orgId: string
  readonly tenantId: string
  readonly projectId: string
  readonly operationId: string
  readonly providerId: string
  readonly targetRef: string
  readonly artifact: StagingArtifact
  readonly rollbackFromReleaseId?: string | null
  readonly rollbackTargetReleaseId?: string | null
}

export function stagingRequestFingerprint(input: StagingRequestFingerprintInput): string {
  const artifact = stagingArtifactSchema.parse(input.artifact)
  return createHash('sha256').update(JSON.stringify([
    1,
    input.kind,
    input.orgId,
    input.tenantId,
    input.projectId,
    input.operationId,
    input.providerId,
    input.targetRef,
    artifact.project_id,
    artifact.run_id,
    artifact.artifact_ref,
    artifact.artifact_sha256,
    artifact.manifest_sha256,
    artifact.acceptance_sha256,
    artifact.sbom_sha256,
    artifact.provenance_sha256,
    artifact.builder_image_digest,
    artifact.policy_sha256,
    input.rollbackFromReleaseId ?? null,
    input.rollbackTargetReleaseId ?? null,
  ])).digest('hex')
}

export function stagingReleaseId(fingerprint: string): string {
  return `stg-${createHash('sha256').update(`dz23-staging-v1\0${fingerprint}`).digest('hex')}`
}

export function stagingTargetKey(input: {
  readonly providerId: string
  readonly targetRef: string
}): string {
  return createHash('sha256').update(JSON.stringify([
    1,
    input.providerId,
    input.targetRef,
  ])).digest('hex')
}

export function matchesProviderReceipt(expected: {
  readonly providerId: string
  readonly targetRef: string
  readonly operationId: string
  readonly artifactSha256: string
  readonly kind: 'PUBLISH' | 'ROLLBACK'
  readonly targetGeneration: number
}, value: unknown): value is StagingProviderReceipt {
  const parsed = stagingProviderReceiptSchema.safeParse(value)
  if (!parsed.success) return false
  const receipt = parsed.data
  return receipt.environment === 'staging'
    && same(receipt.provider_id, expected.providerId)
    && same(receipt.target_ref, expected.targetRef)
    && same(receipt.operation_id, expected.operationId)
    && same(receipt.artifact_sha256, expected.artifactSha256)
    && receipt.kind === expected.kind
    && receipt.target_generation === expected.targetGeneration
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}
