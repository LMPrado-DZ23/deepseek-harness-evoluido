import { createPrivateKey, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
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

  /**
   * The publisher-side helper is what a partner runs on their own machine with their own private
   * key in hand. Two of its refusals had never been executed: an Ed25519 check reached with a real
   * key of the wrong type, and the `KeyObject` form of the parameter — the form a caller who
   * already holds the loaded key uses, and the only one that skips `createPrivateKey` entirely.
   */
  it('checks a real key of the wrong type and signs the same bytes from an already-loaded key', () => {
    const pair = generatePublisherKeyPair()
    // A perfectly valid private key — of the wrong algorithm. `sign(null, ...)` needs Ed25519, and
    // without this check the caller gets a library error instead of a sentence about the key.
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    expect(() => signManifest(manifest, rsa)).toThrow(new SigningError('KEY_INVALID', 'private key must be Ed25519'))
    // And the key may arrive already loaded, not as PEM: the same bytes must come out.
    const asObject = signManifest(manifest, createPrivateKey(pair.privateKeyPem))
    expect(asObject.signature).toBe(signManifest(manifest, pair.privateKeyPem).signature)
    expect(evaluateManifest(asObject, { dz23: pair.publicKeyBase64 }).verification).toBe('verified')
  })

  it('refuses invalid manifests, the reserved smtp kind, non-Ed25519 keys and accidental re-signing', () => {
    const pair = generatePublisherKeyPair()
    expect(() => signManifest({ ...manifest, kind: 'nope' }, pair.privateKeyPem)).toThrow(SigningError)
    expect(() => signManifest({ ...manifest, kind: 'smtp' }, pair.privateKeyPem)).toThrow(/reserved/u)
    expect(() => signManifest(manifest, 'not a pem')).toThrow(/valid PEM/u)
    expect(() => signManifest(manifest, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey)).toThrow(/Ed25519/u)
    expect(signManifest(manifest, generateKeyPairSync('ed25519').privateKey).signature).toBeTypeOf('string')
    const signed = signManifest(manifest, pair.privateKeyPem)
    expect(() => signManifest(signed, pair.privateKeyPem)).toThrow(/already signed/u)
    const resigned = signManifest({ ...signed, version: '1.0.1' }, pair.privateKeyPem, { replace: true })
    expect(resigned.signature).not.toBe(signed.signature)
    expect(evaluateManifest(resigned, { dz23: pair.publicKeyBase64 }).verification).toBe('verified')
  })
})
