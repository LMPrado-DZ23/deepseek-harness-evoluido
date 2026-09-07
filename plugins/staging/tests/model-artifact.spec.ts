import { describe, expect, it } from 'vitest'
import {
  matchesProviderReceipt,
  stagingReleaseId,
  stagingRequestFingerprint,
  stagingTargetKey,
} from '../src/artifact.js'
import {
  stagingArtifactSchema,
  stagingProviderConfigSchema,
  stagingProviderReceiptSchema,
  stagingReleaseSchema,
  STUDIO_STAGING_RELEASES_LOGICAL_DOMAIN,
  STUDIO_STAGING_RELEASES_PHYSICAL_DOMAIN,
} from '../src/model.js'
import { artifact, digest, fixedNow } from './helpers.js'

describe('staging model and immutable request identity', () => {
  const successfulRelease = () => ({
    release_id: `stg-${digest('a')}`,
    operation_id: 'op-1', request_fingerprint: digest('b'), target_key: digest('c'),
    target_generation: 3, effect_lease_id: 'lease-1', effect_lease_expires_at: '2026-09-07T12:05:00.000Z',
    kind: 'PUBLISH' as const, org_id: 'org-a', tenant_id: 'tenant-a', project_id: 'project-1',
    run_id: 'run-1', artifact: artifact(), provider_id: 'provider-a', environment: 'staging' as const,
    target_ref: 'dz23-target:team', state: 'STAGING_OK' as const, version: 4,
    created_by: 'user-a', source_session_id: 'session-a', requested_approval_id: 'approval-1',
    approval_id: 'approval-1', approved_at: fixedNow, created_at: fixedNow,
    last_transition_at: fixedNow, started_at: fixedNow, finished_at: fixedNow, reconciled_at: null,
    provider_receipt: {
      provider_id: 'provider-a', environment: 'staging' as const, target_ref: 'dz23-target:team',
      operation_id: 'op-1', kind: 'PUBLISH' as const, target_generation: 3,
      artifact_sha256: artifact().artifact_sha256, receipt_ref: 'dz23-receipt:1', observed_at: fixedNow,
    },
    failure_code: null, rollback_from_release_id: null, rollback_from_generation: null,
    rollback_target_release_id: null,
  })

  it('uses the physical storage grammar and a separate logical dotted name', () => {
    expect(STUDIO_STAGING_RELEASES_PHYSICAL_DOMAIN).toBe('studio_staging_releases')
    expect(STUDIO_STAGING_RELEASES_LOGICAL_DOMAIN).toBe('studio.staging.releases')
  })

  it('accepts only opaque sealed artifacts with all required attestations', () => {
    expect(stagingArtifactSchema.parse(artifact())).toEqual(artifact())
    expect(stagingArtifactSchema.safeParse({ ...artifact(), artifact_ref: 'C:\\mutable\\artifact' }).success).toBe(false)
    expect(stagingArtifactSchema.safeParse({ ...artifact(), sbom_sha256: null }).success).toBe(false)
  })

  it('makes production structurally invalid in provider configuration and receipts', () => {
    expect(stagingProviderConfigSchema.safeParse({ provider_id: 'provider-a', environment: 'staging', target_ref: 'dz23-target:team' }).success).toBe(true)
    expect(stagingProviderConfigSchema.safeParse({ provider_id: 'provider-a', environment: 'production', target_ref: 'dz23-target:team' }).success).toBe(false)
    expect(stagingProviderReceiptSchema.safeParse({
      provider_id: 'provider-a', environment: 'production', target_ref: 'dz23-target:team',
      operation_id: 'op-1', kind: 'PUBLISH', target_generation: 1,
      artifact_sha256: digest('a'), receipt_ref: 'dz23-receipt:1', observed_at: fixedNow,
    }).success).toBe(false)
  })

  it('produces a stable fingerprint and release id for every security-relevant field', () => {
    const input = {
      kind: 'PUBLISH' as const, orgId: 'org-a', tenantId: 'tenant-a', projectId: 'project-1', operationId: 'op-1',
      providerId: 'provider-a', targetRef: 'dz23-target:team', artifact: artifact(),
    }
    const first = stagingRequestFingerprint(input)
    expect(stagingRequestFingerprint(structuredClone(input))).toBe(first)
    expect(stagingRequestFingerprint({ ...input, targetRef: 'dz23-target:other' })).not.toBe(first)
    expect(stagingRequestFingerprint({ ...input, artifact: artifact('run-2', '9') })).not.toBe(first)
    expect(stagingReleaseId(first)).toMatch(/^stg-[a-f0-9]{64}$/u)
    expect(stagingReleaseId(first)).toBe(stagingReleaseId(first))
    expect(stagingTargetKey({ providerId: 'provider-a', targetRef: 'dz23-target:team' }))
      .toBe(stagingTargetKey({ providerId: 'provider-a', targetRef: 'dz23-target:team' }))
    expect(stagingTargetKey({ providerId: 'provider-a', targetRef: 'dz23-target:team' }))
      .not.toBe(stagingTargetKey({ providerId: 'provider-a', targetRef: 'dz23-target:other' }))
  })

  it('matches a receipt only when provider, staging target, operation and digest are exact', () => {
    const expected = {
      providerId: 'provider-a', targetRef: 'dz23-target:team', operationId: 'op-1',
      artifactSha256: digest('a'), kind: 'PUBLISH' as const, targetGeneration: 7,
    }
    const receipt = {
      provider_id: 'provider-a', environment: 'staging', target_ref: 'dz23-target:team', operation_id: 'op-1',
      kind: 'PUBLISH', target_generation: 7,
      artifact_sha256: digest('a'), receipt_ref: 'dz23-receipt:1', observed_at: fixedNow,
    }
    expect(matchesProviderReceipt(expected, receipt)).toBe(true)
    expect(matchesProviderReceipt(expected, { ...receipt, artifact_sha256: digest('b') })).toBe(false)
    expect(matchesProviderReceipt(expected, { ...receipt, target_ref: 'dz23-target:other' })).toBe(false)
    expect(matchesProviderReceipt(expected, { ...receipt, kind: 'ROLLBACK' })).toBe(false)
    expect(matchesProviderReceipt(expected, { ...receipt, target_generation: 8 })).toBe(false)
    expect(matchesProviderReceipt(expected, { ...receipt, environment: 'production' })).toBe(false)
    expect(matchesProviderReceipt(expected, { ...receipt, extra: true })).toBe(false)
  })

  it('rejects impossible state, receipt, rollback and timestamp combinations', () => {
    const release = successfulRelease()
    expect(stagingReleaseSchema.parse(release)).toEqual(release)
    const invalid = [
      { ...release, approval_id: null },
      { ...release, provider_receipt: { ...release.provider_receipt, provider_id: 'provider-b' } },
      { ...release, rollback_from_release_id: `stg-${digest('d')}` },
      { ...release, state: 'ROLLING_BACK' },
      { ...release, state: 'REQUESTED', finished_at: null, provider_receipt: null },
      { ...release, state: 'STAGING', started_at: null, finished_at: null, provider_receipt: null },
      { ...release, state: 'FAILED', provider_receipt: null, failure_code: null },
      { ...release, state: 'FAILED', approval_id: null, approved_at: null, provider_receipt: null, failure_code: 'EFFECT_WITHOUT_APPROVAL' },
      { ...release, state: 'RECONCILIATION_REQUIRED', finished_at: null, provider_receipt: null, failure_code: null },
      { ...release, started_at: '2026-09-07T11:59:00.000Z' },
      { ...release, finished_at: '2026-09-07T11:59:00.000Z' },
      { ...release, last_transition_at: '2026-09-07T11:59:00.000Z' },
      { ...release, effect_lease_expires_at: '2026-09-07T11:59:00.000Z' },
      { ...release, started_at: '2026-09-07T12:02:00+00:00', finished_at: '2026-09-07T12:01:00Z' },
      { ...release, finished_at: '2026-09-07T12:01:00+00:00', last_transition_at: '2026-09-07T12:00:30Z' },
      { ...release, reconciled_at: '2026-09-07T12:01:00+00:00', last_transition_at: '2026-09-07T12:00:30Z' },
      { ...release, state: 'STAGING', finished_at: null, provider_receipt: null, reconciled_at: fixedNow },
      {
        ...release,
        kind: 'ROLLBACK', state: 'ROLLED_BACK', rollback_from_release_id: null,
        rollback_from_generation: null, rollback_target_release_id: null,
        provider_receipt: { ...release.provider_receipt, kind: 'ROLLBACK' },
      },
      {
        ...release,
        kind: 'ROLLBACK', state: 'STAGING_OK', rollback_from_release_id: `stg-${digest('d')}`,
        rollback_from_generation: 2, rollback_target_release_id: `stg-${digest('e')}`,
        provider_receipt: { ...release.provider_receipt, kind: 'ROLLBACK' },
      },
    ]
    expect(invalid.map(candidate => stagingReleaseSchema.safeParse(candidate).success)).toEqual(invalid.map(() => false))
  })
})
