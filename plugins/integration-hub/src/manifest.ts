import { createPublicKey, verify } from 'node:crypto'
import type { PolicyTier } from '@dz23-studio/policy'
import { z } from 'zod'
import { t } from './i18n.js'
import { integrationManifestSchema, type IntegrationKind, type IntegrationManifest } from './model.js'

export type ManifestVerification = 'verified' | 'unverified' | 'invalid'

export interface ManifestEvaluation {
  readonly manifest: IntegrationManifest | null
  readonly verification: ManifestVerification
  readonly effectiveTier: PolicyTier
  readonly reasons: readonly string[]
}

/** Publisher id → Ed25519 public key (SPKI, base64 or PEM). Public keys only: never a secret. */
export type PublisherKeys = Readonly<Record<string, string>>

const TIER_RANK: Readonly<Record<PolicyTier, number>> = { T0: 0, T1: 1, T2: 2, T3: 3 }

/** Anything below `verified` is capped at this floor, whatever the manifest declares (D16). */
export const UNVERIFIED_FLOOR: PolicyTier = 'T2'

/**
 * D16 policy floor per kind: reading the vault is irreversible in the sense
 * that matters here — a leaked credential cannot be un-leaked — so it sits at
 * T3 and needs strong identity; an integration that talks to the outside world
 * (external MCP, outbound network, e-mail) never sits below T2; one that can
 * write inside the workspace never sits below T1; an unknown tier is T2.
 */
export function policyFloor(kind: IntegrationKind, manifest: IntegrationManifest): PolicyTier {
  const external = manifest.endpoint !== undefined && !isLoopback(manifest.endpoint)
  const outbound = manifest.permissions.some(permission => permission === 'network.outbound' || permission === 'email.send')
  const writes = manifest.permissions.some(permission => permission === 'write.project')
  if (manifest.permissions.includes('secrets.read')) return 'T3'
  if ((kind === 'mcp' && external) || kind === 'smtp' || outbound) return 'T2'
  if (kind === 'mcp' || kind === 'webhook' || writes) return 'T1'
  return 'T0'
}

function maxTier(left: PolicyTier, right: PolicyTier): PolicyTier { return TIER_RANK[left] >= TIER_RANK[right] ? left : right }

function isLoopback(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname
    return host === '127.0.0.1' || host === '::1' || host === 'localhost' || host.endsWith('.localhost')
  } catch { return false }
}

/** Most restrictive of the manifest's declared tier and the policy floor; missing/invalid declared tier → T2. */
export function effectiveTier(kind: IntegrationKind, manifest: IntegrationManifest): PolicyTier {
  const declared = (['T0', 'T1', 'T2', 'T3'] as const).includes(manifest.tier as PolicyTier) ? (manifest.tier as PolicyTier) : 'T2'
  return maxTier(declared, policyFloor(kind, manifest))
}

/**
 * Canonical form signed by the publisher: the manifest object exactly as
 * supplied (no defaults added, no trimming), without `signature`, keys sorted
 * by code point at every level, JSON without whitespace, UTF-8. A signer that
 * follows these five rules with any JSON library produces the same bytes.
 */
export function canonicalManifestBytes(manifest: Readonly<Record<string, unknown>>): Buffer {
  const { signature: _signature, ...rest } = manifest
  return Buffer.from(JSON.stringify(sortKeys(rest)), 'utf8')
}

export function evaluateManifest(input: unknown, publisherKeys: PublisherKeys): ManifestEvaluation {
  const parsed = integrationManifestSchema.safeParse(input)
  if (!parsed.success) {
    // Field names only: Zod's English messages never reach the interface.
    const fields = [...new Set(parsed.error.issues.map(issue => issue.path.join('.') || '$'))].slice(0, 5)
    return { manifest: null, verification: 'invalid', effectiveTier: UNVERIFIED_FLOOR, reasons: fields.map(field => t('manifest.reasonInvalidField', { field })) }
  }
  const manifest = parsed.data
  const declaredTier = effectiveTier(manifest.kind, manifest)
  const unverified = (reason: string, verification: 'unverified' | 'invalid'): ManifestEvaluation => {
    const tier = maxTier(declaredTier, UNVERIFIED_FLOOR)
    const reasons = [reason]
    if (tier !== manifest.tier) reasons.push(t('manifest.reasonUnverifiedTier', { tier, declared: manifest.tier ?? t('manifest.tierAbsent') }))
    return { manifest, verification, effectiveTier: tier, reasons }
  }
  if (manifest.signature === undefined) return unverified(t('manifest.reasonUnsigned'), 'unverified')
  const publicKey = publisherKeys[manifest.publisher.id]
  if (publicKey === undefined) return unverified(t('manifest.reasonNoPublisherKey'), 'unverified')
  let valid = false
  try {
    const key = createPublicKey(publicKey.includes('BEGIN') ? publicKey : { key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' })
    valid = verify(null, canonicalManifestBytes(input as Record<string, unknown>), key, Buffer.from(manifest.signature, 'base64'))
  } catch { valid = false }
  if (!valid) return unverified(t('manifest.reasonSignatureInvalid'), 'invalid')
  const reasons: string[] = []
  if (manifest.tier !== declaredTier) reasons.push(t('manifest.reasonTier', { tier: declaredTier, declared: manifest.tier ?? t('manifest.tierAbsent') }))
  return { manifest, verification: 'verified', effectiveTier: declaredTier, reasons }
}

export const manifestEvaluationSchema = z.object({
  verification: z.enum(['verified', 'unverified', 'invalid']),
  effective_tier: z.enum(['T0', 'T1', 'T2', 'T3']),
  reasons: z.array(z.string()),
}).strict()

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    // Code-point order, locale-independent: the same bytes on every machine.
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, sortKeys(v)]))
  }
  return value
}
