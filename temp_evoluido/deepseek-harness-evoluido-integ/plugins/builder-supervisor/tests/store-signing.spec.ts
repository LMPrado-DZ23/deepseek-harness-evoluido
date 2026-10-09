import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  TemplateSigningError,
  canonicalSignedTemplateStoreManifestBytes,
  canonicalTemplateStoreManifestBytes,
  computeTemplateTreeSha256,
  parseTemplateStoreManifest,
  signTemplateStoreManifest,
  templateStoreSignatureVerdict,
  type TemplateManifestEntry,
} from '../src/store-security.ts'

function keys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyBase64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  }
}

const entries: TemplateManifestEntry[] = [
  { path: 'src', type: 'directory' },
  { path: 'src/app.ts', type: 'file', bytes: 12, sha256: 'a'.repeat(64) },
]

function manifest(version = '1.0.0') {
  return {
    version: 1 as const,
    template_store_version: version,
    tree_sha256: computeTemplateTreeSha256(version, entries),
    entries,
  }
}

describe('assinar o armazenamento de template', () => {
  it('a assinatura cobre o manifesto SEM ela', () => {
    // Assinar um documento que já contém a própria assinatura é impossível, e
    // é por isso que existem duas formas canônicas.
    const key = keys()
    const signed = signTemplateStoreManifest(manifest(), key.privateKeyPem)
    expect(signed.signature).toMatch(/^[A-Za-z0-9+/]{86}==$/u)
    expect(canonicalTemplateStoreManifestBytes(signed)).toEqual(canonicalTemplateStoreManifestBytes(manifest()))
    expect(canonicalSignedTemplateStoreManifestBytes(signed)).not.toEqual(canonicalTemplateStoreManifestBytes(signed))
  })

  it('a forma de disco volta a ser lida igual', () => {
    const key = keys()
    const signed = signTemplateStoreManifest(manifest(), key.privateKeyPem)
    const bytes = canonicalSignedTemplateStoreManifestBytes(signed)
    const reparsed = parseTemplateStoreManifest(JSON.parse(bytes.toString('utf8')) as unknown)
    expect(reparsed.signature).toBe(signed.signature)
    expect(canonicalSignedTemplateStoreManifestBytes(reparsed)).toEqual(bytes)
  })

  it('sem assinatura, a forma de disco é a mesma de antes', () => {
    // Uma instalação provisionada antes de a assinatura existir não pode ver o
    // arquivo dela mudar de bytes.
    expect(canonicalSignedTemplateStoreManifestBytes(manifest())).toEqual(canonicalTemplateStoreManifestBytes(manifest()))
  })

  it('a chave precisa ser Ed25519, e um PEM quebrado é recusado', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    expect(() => signTemplateStoreManifest(manifest(), rsa.privateKey)).toThrow(TemplateSigningError)
    expect(() => signTemplateStoreManifest(manifest(), 'não é pem')).toThrow(TemplateSigningError)
  })

  it('reassinar por acidente é recusado', () => {
    // Trocar a assinatura de outra pessoa pela nossa sem querer transformaria
    // um artefato de terceiro em nosso.
    const key = keys()
    const signed = signTemplateStoreManifest(manifest(), key.privateKeyPem)
    expect(() => signTemplateStoreManifest(signed, key.privateKeyPem)).toThrow(TemplateSigningError)
    expect(signTemplateStoreManifest(signed, keys().privateKeyPem, { replace: true }).signature).not.toBe(signed.signature)
  })
})

describe('conferir a assinatura', () => {
  it('assinado pela chave configurada diz QUEM assinou', () => {
    const key = keys()
    const signed = signTemplateStoreManifest(manifest(), key.privateKeyPem)
    expect(templateStoreSignatureVerdict(signed, { dz23: key.publicKeyBase64 }))
      .toEqual({ state: 'SIGNED', publisher: 'dz23' })
  })

  it('sem assinatura é UNSIGNED, e nunca "assinado"', () => {
    // Não é reprovação: é um estado próprio, e quem lê decide se aceita um
    // armazenamento sem prova de origem.
    expect(templateStoreSignatureVerdict(manifest(), { dz23: keys().publicKeyBase64 })).toEqual({ state: 'UNSIGNED' })
  })

  it('assinatura de OUTRA chave não passa', () => {
    const signed = signTemplateStoreManifest(manifest(), keys().privateKeyPem)
    expect(templateStoreSignatureVerdict(signed, { dz23: keys().publicKeyBase64 })).toEqual({ state: 'INVALID_SIGNATURE' })
  })

  it('manifesto alterado depois de assinado não passa', () => {
    // É este o ponto da assinatura: o conteúdo mudou, o hash de árvore mudou
    // junto, e a assinatura antiga deixa de valer.
    const key = keys()
    const signed = signTemplateStoreManifest(manifest('1.0.0'), key.privateKeyPem)
    const tampered = { ...manifest('2.0.0'), signature: signed.signature }
    expect(templateStoreSignatureVerdict(tampered, { dz23: key.publicKeyBase64 })).toEqual({ state: 'INVALID_SIGNATURE' })
  })

  it('sem nenhuma chave configurada, assinado é PUBLICADOR DESCONHECIDO', () => {
    // Diferente de inválido: as duas coisas pedem gestos diferentes de quem
    // opera — configurar a chave, ou desconfiar do artefato.
    const signed = signTemplateStoreManifest(manifest(), keys().privateKeyPem)
    expect(templateStoreSignatureVerdict(signed, {})).toEqual({ state: 'UNKNOWN_PUBLISHER' })
  })

  it('uma chave pública ilegível não derruba a conferência das outras', () => {
    const key = keys()
    const signed = signTemplateStoreManifest(manifest(), key.privateKeyPem)
    expect(templateStoreSignatureVerdict(signed, { quebrada: 'não-é-base64-spki', dz23: key.publicKeyBase64 }))
      .toEqual({ state: 'SIGNED', publisher: 'dz23' })
  })

  it('chave de outro algoritmo é ignorada, e sozinha não derruba a conferência', () => {
    const key = keys()
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const rsaPublic = rsa.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    const signed = signTemplateStoreManifest(manifest(), key.privateKeyPem)
    expect(templateStoreSignatureVerdict(signed, { rsa: rsaPublic, dz23: key.publicKeyBase64 }))
      .toEqual({ state: 'SIGNED', publisher: 'dz23' })
    // Sozinha, ela vira um veredito - nunca uma exceção que derruba quem
    // estava conferindo um artefato.
    expect(templateStoreSignatureVerdict(signed, { rsa: rsaPublic })).toEqual({ state: 'INVALID_SIGNATURE' })
  })

  it('reassinar com a MESMA chave dá a mesma assinatura de assinar o não assinado', () => {
    // Prova de que a assinatura cobre o manifesto sem ela: se a assinatura
    // anterior entrasse no que é assinado, as duas seriam diferentes.
    const key = keys()
    const signed = signTemplateStoreManifest(manifest(), key.privateKeyPem)
    const resigned = signTemplateStoreManifest(signed, key.privateKeyPem, { replace: true })
    expect(resigned.signature).toBe(signed.signature)
  })

  it('um campo desconhecido no manifesto é recusado', () => {
    // Conteúdo que ninguém conferiu entrando por uma porta que ninguém
    // declarou.
    expect(() => parseTemplateStoreManifest({ ...manifest(), extra: 1 })).toThrow()
    expect(() => parseTemplateStoreManifest({ ...manifest(), signature: undefined, extra: 'x' })).toThrow()
  })

  it('assinatura com formato errado é recusada na LEITURA', () => {
    // Antes de qualquer conferência: um campo que não é uma assinatura Ed25519
    // não pode nem chegar ao verificador.
    for (const signature of ['curta', 'A'.repeat(86), `${'A'.repeat(85)}==`, 123, null]) {
      expect(() => parseTemplateStoreManifest({ ...manifest(), signature }), String(signature)).toThrow()
    }
  })
})
