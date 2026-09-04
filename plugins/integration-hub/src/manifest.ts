import { createPublicKey, verify } from 'node:crypto'
import type { PolicyTier } from '@dz23-studio/policy'
import { z } from 'zod'
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

/**
 * D16 policy floor per kind: an integration that reaches outside the machine
 * or can write never sits below T1; an unsigned or unknown tier is T2.
 */
export function policyFloor(kind: IntegrationKind, manifest: IntegrationManifest): PolicyTier {
  const external = manifest.endpoint !== undefined && !isLoopback(manifest.endpoint)
  const writes = manifest.permissions.some(permission => permission === 'write.project' || permission === 'network.outbound' || permission === 'email.send' || permission === 'secrets.read')
  if (kind === 'mcp' && external) return 'T2'
  if (kind === 'mcp' || kind === 'webhook' || writes) return 'T1'
  return 'T0'
}

function isLoopback(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname
    return host === '127.0.0.1' || host === '::1' || host === 'localhost' || host.endsWith('.localhost')
  } catch { return false }
}

/** Most restrictive of the manifest's declared tier and the policy floor; missing/invalid declared tier → T2. */
export function effectiveTier(kind: IntegrationKind, manifest: IntegrationManifest): PolicyTier {
  const declared = (['T0', 'T1', 'T2', 'T3'] as const).includes(manifest.tier as PolicyTier) ? (manifest.tier as PolicyTier) : 'T2'
  const floor = policyFloor(kind, manifest)
  return TIER_RANK[declared] >= TIER_RANK[floor] ? declared : floor
}

export function canonicalManifestBytes(manifest: IntegrationManifest): Buffer {
  const { signature: _signature, ...rest } = manifest
  return Buffer.from(JSON.stringify(sortKeys(rest)), 'utf8')
}

export function evaluateManifest(input: unknown, publisherKeys: PublisherKeys): ManifestEvaluation {
  const parsed = integrationManifestSchema.safeParse(input)
  if (!parsed.success) {
    return { manifest: null, verification: 'invalid', effectiveTier: 'T2', reasons: parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join('.') || '$'}: ${issue.message}`) }
  }
  const manifest = parsed.data
  const tier = effectiveTier(manifest.kind, manifest)
  const reasons: string[] = []
  if (manifest.tier !== tier) reasons.push(`tier efetivo ${tier} (declarado: ${manifest.tier ?? 'ausente'})`)
  if (manifest.signature === undefined) return { manifest, verification: 'unverified', effectiveTier: tier, reasons: [...reasons, 'sem assinatura'] }
  const publicKey = publisherKeys[manifest.publisher.id]
  if (publicKey === undefined) return { manifest, verification: 'unverified', effectiveTier: tier, reasons: [...reasons, 'publicador sem chave cadastrada'] }
  let valid = false
  try {
    const key = createPublicKey(publicKey.includes('BEGIN') ? publicKey : { key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' })
    valid = verify(null, canonicalManifestBytes(manifest), key, Buffer.from(manifest.signature, 'base64'))
  } catch { valid = false }
  if (!valid) return { manifest, verification: 'invalid', effectiveTier: tier, reasons: [...reasons, 'assinatura inválida'] }
  return { manifest, verification: 'verified', effectiveTier: tier, reasons }
}

export const manifestEvaluationSchema = z.object({
  verification: z.enum(['verified', 'unverified', 'invalid']),
  effective_tier: z.enum(['T0', 'T1', 'T2', 'T3']),
  reasons: z.array(z.string()),
}).strict()

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortKeys(v)]))
  }
  return value
}
