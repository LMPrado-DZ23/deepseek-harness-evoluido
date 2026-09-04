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
    expect(effectiveTier('skill', manifest({ tier: 'T0', permissions: ['email.send'] }))).toBe('T1')
  })

  it('verifies a real Ed25519 signature, flags tampering and unknown publishers, and rejects malformed manifests', () => {
    const good = signed(manifest({ tier: 'T0' }))
    expect(evaluateManifest(good, publisherKeys)).toMatchObject({ verification: 'verified', effectiveTier: 'T0', reasons: [] })
    const tampered = { ...good, name: 'Agenda alterada' }
    expect(evaluateManifest(tampered, publisherKeys)).toMatchObject({ verification: 'invalid', reasons: expect.arrayContaining(['assinatura inválida']) })
    expect(evaluateManifest(manifest(), publisherKeys)).toMatchObject({ verification: 'unverified', effectiveTier: 'T2', reasons: expect.arrayContaining(['sem assinatura']) })
    expect(evaluateManifest(signed(manifest({ publisher: { id: 'someone', name: 'Alguém' } })), publisherKeys)).toMatchObject({ verification: 'unverified', reasons: expect.arrayContaining(['publicador sem chave cadastrada']) })
    expect(evaluateManifest(good, { dz23: 'not-a-key' })).toMatchObject({ verification: 'invalid' })
    const invalid = evaluateManifest({ schema_version: 2, id: 'X' }, publisherKeys)
    expect(invalid.manifest).toBeNull()
    expect(invalid.verification).toBe('invalid')
    expect(invalid.reasons.length).toBeGreaterThan(0)
    expect(evaluateManifest({ ...manifest(), extra: true }, publisherKeys).manifest).toBeNull()
  })
})
