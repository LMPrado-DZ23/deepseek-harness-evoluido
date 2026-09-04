import { describe, expect, it } from 'vitest'
import { evaluateManifest } from '../src/manifest.ts'
import { generatePublisherKeyPair, publicKeyFromPrivatePem, signManifest, SigningError } from '../src/signing.ts'

const manifest = { schema_version: 1, id: 'agenda-local', name: 'Agenda local', version: '1.0.0', kind: 'skill', publisher: { id: 'dz23', name: 'DZ23' }, tier: 'T0' }

describe('publisher signing helpers', () => {
  it('generates a key pair whose public half verifies what the private half signed, through the Studio evaluator', () => {
    const pair = generatePublisherKeyPair()
    expect(pair.privateKeyPem).toContain('BEGIN PRIVATE KEY')
    expect(publicKeyFromPrivatePem(pair.privateKeyPem)).toBe(pair.publicKeyBase64)
    const signed = signManifest(manifest, pair.privateKeyPem)
    expect(typeof signed.signature).toBe('string')
    expect(evaluateManifest(signed, { dz23: pair.publicKeyBase64 })).toMatchObject({ verification: 'verified', effectiveTier: 'T0' })
    // another publisher's key does not verify it
    expect(evaluateManifest(signed, { dz23: generatePublisherKeyPair().publicKeyBase64 }).verification).toBe('invalid')
    // and the manifest without `permissions` (schema default) still verifies: signed as supplied
    expect('permissions' in signed).toBe(false)
  })

  it('refuses invalid manifests, the reserved smtp kind, non-Ed25519 keys and accidental re-signing', () => {
    const pair = generatePublisherKeyPair()
    expect(() => signManifest({ ...manifest, kind: 'nope' }, pair.privateKeyPem)).toThrow(SigningError)
    expect(() => signManifest({ ...manifest, kind: 'smtp' }, pair.privateKeyPem)).toThrow(/reserved/u)
    expect(() => signManifest(manifest, 'not a pem')).toThrow(/valid PEM/u)
    const signed = signManifest(manifest, pair.privateKeyPem)
    expect(() => signManifest(signed, pair.privateKeyPem)).toThrow(/already signed/u)
    const resigned = signManifest({ ...signed, version: '1.0.1' }, pair.privateKeyPem, { replace: true })
    expect(resigned.signature).not.toBe(signed.signature)
    expect(evaluateManifest(resigned, { dz23: pair.publicKeyBase64 }).verification).toBe('verified')
  })
})
