import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { canonicalManifestBytes, effectiveTier, evaluateManifest, policyFloor } from '../src/manifest.ts'
import type { IntegrationManifest } from '../src/model.ts'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publisherKeys = { 'dz23': publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }

function manifest(overrides: Partial<IntegrationManifest> = {}): IntegrationManifest {
  return { schema_version: 1, id: 'calendar-sync', name: 'Agenda', version: '1.0.0', kind: 'skill', publisher: { id: 'dz23', name: 'DZ23' }, permissions: [], ...overrides } as IntegrationManifest
}
function signed(value: IntegrationManifest): IntegrationManifest {
  return { ...value, signature: sign(null, canonicalManifestBytes(value), privateKey).toString('base64') }
}

describe('D16 manifest evaluation', () => {
  it('applies the policy floor: missing tier → T2, external MCP never below T2, local MCP/webhook/writes never below T1, read-only skill T0', () => {
    expect(effectiveTier('skill', manifest())).toBe('T2')
    expect(effectiveTier('skill', manifest({ tier: 'T0' }))).toBe('T0')
    expect(effectiveTier('skill', manifest({ tier: 'bogus' }))).toBe('T2')
    expect(policyFloor('mcp', manifest({ kind: 'mcp', endpoint: 'http://127.0.0.1:8080' }))).toBe('T1')
    expect(policyFloor('mcp', manifest({ kind: 'mcp', endpoint: 'https://mcp.example.com' }))).toBe('T2')
    expect(effectiveTier('mcp', manifest({ kind: 'mcp', endpoint: 'https://mcp.example.com', tier: 'T0' }))).toBe('T2')
    expect(effectiveTier('mcp', manifest({ kind: 'mcp', endpoint: 'https://mcp.example.com', tier: 'T3' }))).toBe('T3')
    expect(effectiveTier('webhook', manifest({ kind: 'webhook', tier: 'T0' }))).toBe('T1')
    expect(effectiveTier('skill', manifest({ tier: 'T0', permissions: ['write.project'] }))).toBe('T1')
    expect(effectiveTier('skill', manifest({ tier: 'T0', permissions: ['email.send'] }))).toBe('T2')
    expect(effectiveTier('skill', manifest({ tier: 'T0', permissions: ['network.outbound'] }))).toBe('T2')
  })

  it('caps anything below verified at T2 (D16): an unsigned T0 skill is T2, a signed T0 skill stays T0', () => {
    const unsignedSkill = evaluateManifest(manifest({ tier: 'T0' }), publisherKeys)
    expect(unsignedSkill).toMatchObject({ verification: 'unverified', effectiveTier: 'T2' })
    expect(unsignedSkill.reasons.some(reason => reason.includes('T2') && reason.includes('T0'))).toBe(true)
    expect(evaluateManifest(signed(manifest({ tier: 'T0' })), publisherKeys).effectiveTier).toBe('T0')
    expect(evaluateManifest(manifest({ tier: 'T3' }), publisherKeys).effectiveTier).toBe('T3')
    expect(evaluateManifest({ ...signed(manifest({ tier: 'T0' })), name: 'x' }, publisherKeys)).toMatchObject({ verification: 'invalid', effectiveTier: 'T2' })
  })

  it('signs the manifest exactly as supplied: no defaults, no trimming, keys in code-point order', () => {
    // A publisher who never sends `permissions` (schema default) must still verify.
    const withoutPermissions: Record<string, unknown> = { schema_version: 1, id: 'calendar-sync', name: 'Agenda', version: '1.0.0', kind: 'skill', publisher: { id: 'dz23', name: 'DZ23' }, tier: 'T0' }
    const signature = sign(null, canonicalManifestBytes(withoutPermissions), privateKey).toString('base64')
    expect(evaluateManifest({ ...withoutPermissions, signature }, publisherKeys)).toMatchObject({ verification: 'verified', effectiveTier: 'T0' })
    // Key order of the input does not matter; the canonical form is one byte string.
    const reordered = { tier: 'T0', publisher: { name: 'DZ23', id: 'dz23' }, kind: 'skill', version: '1.0.0', name: 'Agenda', id: 'calendar-sync', schema_version: 1 }
    expect(canonicalManifestBytes(reordered).equals(canonicalManifestBytes(withoutPermissions))).toBe(true)
    expect(canonicalManifestBytes({ b: 1, a: 2, Z: 3 }).toString()).toBe('{"Z":3,"a":2,"b":1}')
  })

  it('never puts library messages in the reasons shown to people', () => {
    const invalid = evaluateManifest({ schema_version: 2, id: 'X', kind: 'nope' }, publisherKeys)
    for (const reason of invalid.reasons) expect(reason).not.toMatch(/expected|received|invalid_|Invalid enum/iu)
  })

  it('verifies a real Ed25519 signature, flags tampering and unknown publishers, and rejects malformed manifests', () => {
    const good = signed(manifest({ tier: 'T0' }))
    expect(evaluateManifest(good, publisherKeys)).toMatchObject({ verification: 'verified', effectiveTier: 'T0', reasons: [] })
    const tampered = { ...good, name: 'Agenda alterada' }
    expect(evaluateManifest(tampered, publisherKeys)).toMatchObject({ verification: 'invalid', reasons: expect.arrayContaining([expect.stringContaining('assinatura não confere')]) })
    expect(evaluateManifest(manifest(), publisherKeys)).toMatchObject({ verification: 'unverified', effectiveTier: 'T2', reasons: expect.arrayContaining([expect.stringContaining('Sem assinatura')]) })
    expect(evaluateManifest(signed(manifest({ publisher: { id: 'someone', name: 'Alguém' } })), publisherKeys)).toMatchObject({ verification: 'unverified', reasons: expect.arrayContaining([expect.stringContaining('chave cadastrada')]) })
    expect(evaluateManifest(good, { dz23: 'not-a-key' })).toMatchObject({ verification: 'invalid' })
    const invalid = evaluateManifest({ schema_version: 2, id: 'X' }, publisherKeys)
    expect(invalid.manifest).toBeNull()
    expect(invalid.verification).toBe('invalid')
    expect(invalid.reasons.length).toBeGreaterThan(0)
    expect(evaluateManifest({ ...manifest(), extra: true }, publisherKeys).manifest).toBeNull()
  })
})
