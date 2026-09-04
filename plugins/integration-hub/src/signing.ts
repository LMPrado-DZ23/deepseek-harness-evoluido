/**
 * Publisher-side helpers for signed integration manifests (D16). Pure functions
 * over the canonical form defined in `manifest.ts`, so a publisher can produce
 * exactly the bytes the Studio verifies. The private key never leaves the
 * caller: it is passed in, used once and discarded.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { canonicalManifestBytes } from './manifest.js'
import { integrationManifestSchema } from './model.js'

export interface PublisherKeyPair {
  /** PKCS#8 PEM — a secret: store it in the publisher's vault, never in the repository or in a manifest. */
  readonly privateKeyPem: string
  /** SPKI DER base64 — what the Studio operator puts in `publisherKeys` / `DZ23_HUB_PUBLISHER_KEYS`. */
  readonly publicKeyBase64: string
}

export function generatePublisherKeyPair(): PublisherKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyBase64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  }
}

export function publicKeyFromPrivatePem(privateKeyPem: string): string {
  return createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'der' }).toString('base64')
}

export class SigningError extends Error {
  constructor(readonly code: 'MANIFEST_INVALID' | 'KEY_INVALID' | 'ALREADY_SIGNED', message: string) { super(message) }
}

/**
 * Validate the manifest (same schema the Studio applies) and return a copy with
 * `signature` over the canonical bytes of the manifest AS GIVEN (no defaults
 * added, no trimming). Refuses a manifest that already carries a signature so a
 * stale one is never silently replaced by accident; pass `{ replace: true }` to
 * re-sign after an edit.
 */
export function signManifest(manifest: Readonly<Record<string, unknown>>, privateKey: string | KeyObject, options: { replace?: boolean } = {}): Record<string, unknown> {
  if ('signature' in manifest && options.replace !== true) throw new SigningError('ALREADY_SIGNED', 'manifest already signed')
  const { signature: _previous, ...unsigned } = manifest
  const parsed = integrationManifestSchema.safeParse(unsigned)
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map(issue => issue.path.join('.') || '$'))]
    throw new SigningError('MANIFEST_INVALID', `invalid manifest fields: ${fields.join(', ')}`)
  }
  if (parsed.data.kind === 'smtp') throw new SigningError('MANIFEST_INVALID', 'kind smtp is reserved for the Studio SMTP setting')
  let key: KeyObject
  try { key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey } catch { throw new SigningError('KEY_INVALID', 'private key is not a valid PEM') }
  if (key.asymmetricKeyType !== 'ed25519') throw new SigningError('KEY_INVALID', 'private key must be Ed25519')
  const signature = sign(null, canonicalManifestBytes(unsigned), key).toString('base64')
  return { ...unsigned, signature }
}
