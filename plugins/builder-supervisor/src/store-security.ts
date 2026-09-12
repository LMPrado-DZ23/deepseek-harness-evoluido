import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'
import type { Stats } from 'node:fs'
import { posix } from 'node:path'

export const TEMPLATE_MANIFEST_MAX_BYTES = 2 * 1024 * 1024
export const TEMPLATE_ENTRY_MAX_BYTES = 64 * 1024 * 1024
export const TEMPLATE_STORE_MAX_BYTES = 512 * 1024 * 1024
export const TEMPLATE_STORE_MAX_ENTRIES = 10_000

export type TemplateManifestEntry =
  | { readonly path: string; readonly type: 'directory' }
  | { readonly path: string; readonly type: 'file'; readonly bytes: number; readonly sha256: string }

export interface TemplateStoreManifest {
  readonly version: 1
  readonly template_store_version: string
  readonly tree_sha256: string
  readonly entries: readonly TemplateManifestEntry[]
  /**
   * Assinatura Ed25519 (base64) sobre os bytes canônicos do manifesto SEM ela.
   *
   * OPCIONAL, e a versão do manifesto NÃO sobe: um armazenamento provisionado
   * antes de a assinatura existir continua legível, e a versão é comparada
   * byte a byte em três lugares — subi-la recusaria toda instalação existente.
   * Ausente significa NÃO ASSINADO, e nunca "assinado por alguém que não
   * conferimos": o veredito viaja em `templateStoreSignatureVerdict`.
   *
   * **HOJE NINGUÉM CONSULTA ESSE VEREDITO.** Uma revisão adversarial apontou,
   * com razão, que `templateStoreSignatureVerdict` não tem chamador em
   * produção: nenhuma chave de publicador é configurada em lugar nenhum, e
   * `supervisor-config.ts` confere bytes canônicos, versão e `tree_sha256` —
   * integridade, não ORIGEM. Na prática, um manifesto sem assinatura e um
   * assinado por qualquer pessoa são aceitos do mesmo jeito, e a única barreira
   * de origem que sobra é o `--manifest-sha256` digitado à mão na CLI.
   *
   * Isto está escrito aqui porque quem ler este arquivo precisa saber o que ele
   * AINDA NÃO protege. Ligar a conferência exige custódia de uma chave privada
   * de publicação — decisão do Prado, a mesma dependência do P-02 — e uma
   * versão nova do envelope de configuração; está registrado em EB-08 e T-31,
   * e o veredito NÃO foi removido porque a capacidade é desenhada e correta,
   * só não tem chave.
   */
  readonly signature?: string
}

/**
 * Os bytes que são ASSINADOS: o manifesto sem a assinatura.
 *
 * A assinatura fica fora do que ela cobre por necessidade — assinar um
 * documento que já contém a própria assinatura é impossível — e essa exclusão
 * é a razão de existirem duas formas canônicas neste arquivo.
 * @param value - o manifesto.
 * @returns os bytes canônicos, sem assinatura.
 */
export function canonicalTemplateStoreManifestBytes(value: unknown): Buffer {
  const manifest = parseTemplateStoreManifest(value)
  const entries = manifest.entries.map(entry => entry.type === 'directory'
    ? { path: entry.path, type: entry.type }
    : { path: entry.path, type: entry.type, bytes: entry.bytes, sha256: entry.sha256 })
  return Buffer.from(`${JSON.stringify({
    version: manifest.version,
    template_store_version: manifest.template_store_version,
    tree_sha256: manifest.tree_sha256,
    entries,
  })}\n`, 'utf8')
}

/**
 * A forma canônica DE DISCO: a mesma, com a assinatura no fim quando existe.
 *
 * É esta que é comparada com o arquivo lido e é esta que entra no hash da
 * autoridade — senão um armazenamento poderia perder a assinatura sem que o
 * hash gravado mudasse.
 * @param value - o manifesto.
 * @returns os bytes canônicos do arquivo.
 */
export function canonicalSignedTemplateStoreManifestBytes(value: unknown): Buffer {
  const manifest = parseTemplateStoreManifest(value)
  if (manifest.signature === undefined) return canonicalTemplateStoreManifestBytes(manifest)
  const unsigned = canonicalTemplateStoreManifestBytes(manifest).toString('utf8').trimEnd()
  return Buffer.from(`${unsigned.slice(0, -1)},"signature":${JSON.stringify(manifest.signature)}}\n`, 'utf8')
}

export function parseTemplateStoreManifest(value: unknown): TemplateStoreManifest {
  const record = exactRecord(value, ['version', 'template_store_version', 'tree_sha256', 'entries'], ['signature'])
  if (record.signature !== undefined && !isSignature(record.signature)) invalid()
  if (record.version !== 1 || !isVersion(record.template_store_version) || !isSha256(record.tree_sha256) || !Array.isArray(record.entries)) invalid()
  if (record.entries.length < 1 || record.entries.length > TEMPLATE_STORE_MAX_ENTRIES) invalid()
  const entries = record.entries.map(parseEntry).sort(compareEntries)
  if (new Set(entries.map(entry => entry.path)).size !== entries.length) invalid()
  if (new Set(entries.map(entry => entry.path.toLowerCase())).size !== entries.length) invalid()
  const directories = new Set(entries.filter(entry => entry.type === 'directory').map(entry => entry.path))
  let bytes = 0
  for (const entry of entries) {
    if (entry.type === 'file') {
      bytes = checkedTemplateStoreByteTotal(bytes, entry.bytes)
    }
    assertParentsDeclared(entry, directories)
  }
  const manifest = {
    version: 1 as const,
    template_store_version: record.template_store_version,
    tree_sha256: record.tree_sha256,
    entries,
    ...(record.signature === undefined ? {} : { signature: record.signature as string }),
  }
  if (computeTemplateTreeSha256(manifest.template_store_version, entries) !== manifest.tree_sha256) invalid()
  return manifest
}

/** Uma assinatura Ed25519 em base64: 64 bytes, sempre. */
function isSignature(value: unknown): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9+/]{86}==$/u.test(value)
}

export class TemplateSigningError extends Error {
  constructor(readonly code: 'KEY_INVALID' | 'ALREADY_SIGNED', message: string) { super(message) }
}

/**
 * Assina um manifesto de armazenamento de template.
 *
 * A chave privada é passada, usada uma vez e descartada: ela nunca mora neste
 * repositório, e é isso que separa "o produto sabe assinar" de "o produto
 * carrega a chave de assinar".
 * @param manifest - o manifesto a assinar.
 * @param privateKey - a chave Ed25519, em PEM PKCS#8.
 * @param options.replace - reassinar um manifesto que já tem assinatura.
 * @returns o manifesto com assinatura.
 */
export function signTemplateStoreManifest(
  manifest: unknown,
  privateKey: string | KeyObject,
  options: { readonly replace?: boolean } = {},
): TemplateStoreManifest {
  const parsed = parseTemplateStoreManifest(manifest)
  // Recusa substituir uma assinatura por acidente: trocar a de outra pessoa
  // pela nossa sem querer transformaria um artefato de terceiro em nosso.
  if (parsed.signature !== undefined && options.replace !== true) {
    throw new TemplateSigningError('ALREADY_SIGNED', 'manifest already signed')
  }
  let key: KeyObject
  try { key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey }
  catch { throw new TemplateSigningError('KEY_INVALID', 'private key is not a valid PEM') }
  if (key.asymmetricKeyType !== 'ed25519') throw new TemplateSigningError('KEY_INVALID', 'private key must be Ed25519')
  // Não é preciso remover a assinatura anterior aqui: quem exclui é a forma
  // canônica, e é lá que essa exclusão está provada. Removê-la de novo neste
  // ponto seria uma segunda cópia da mesma regra, livre para divergir.
  return { ...parsed, signature: sign(null, canonicalTemplateStoreManifestBytes(parsed), key).toString('base64') }
}

/**
 * O veredito da assinatura de um armazenamento de template.
 *
 * `UNSIGNED` é um estado próprio, e não uma reprovação: uma instalação
 * provisionada antes de a assinatura existir não é um ataque. O que ele NÃO
 * pode virar é "assinado" — quem lê este veredito é quem decide se aceita um
 * armazenamento sem prova de origem.
 */
export type TemplateSignatureVerdict =
  | { readonly state: 'UNSIGNED' }
  | { readonly state: 'SIGNED', readonly publisher: string }
  | { readonly state: 'INVALID_SIGNATURE' }
  | { readonly state: 'UNKNOWN_PUBLISHER' }

/**
 * Confere a assinatura contra as chaves públicas confiadas.
 *
 * @param manifest - o manifesto lido do disco.
 * @param publisherKeys - id do publicador → chave pública Ed25519 (SPKI base64).
 * @returns o veredito.
 */
export function templateStoreSignatureVerdict(
  manifest: unknown,
  publisherKeys: Readonly<Record<string, string>>,
): TemplateSignatureVerdict {
  const parsed = parseTemplateStoreManifest(manifest)
  if (parsed.signature === undefined) return { state: 'UNSIGNED' }
  const { signature, ...unsigned } = parsed
  const payload = canonicalTemplateStoreManifestBytes(unsigned)
  const bytes = Buffer.from(signature, 'base64')
  for (const [publisher, material] of Object.entries(publisherKeys)) {
    // Uma chave que não serve é a chave DAQUELE publicador que não serve, e não
    // o fim da conferência: outra chave configurada ainda pode validar. Por
    // isso a leitura E a verificação ficam dentro do mesmo `try` - uma chave de
    // outro algoritmo pode falhar na hora de verificar, e não na de ler.
    try {
      const key: KeyObject = createPublicKey({ key: Buffer.from(material, 'base64'), format: 'der', type: 'spki' })
      if (verify(null, payload, key, bytes)) return { state: 'SIGNED', publisher }
    } catch { continue }
  }
  // Assinado por ALGUÉM: sem nenhuma chave configurada não dá para dizer se a
  // assinatura é inválida ou se é de um publicador que não conhecemos, e as
  // duas coisas pedem gestos diferentes de quem opera.
  return Object.keys(publisherKeys).length === 0 ? { state: 'UNKNOWN_PUBLISHER' } : { state: 'INVALID_SIGNATURE' }
}

export function checkedTemplateStoreByteTotal(current: number, added: number): number {
  const result = current + added
  if (!Number.isSafeInteger(result) || result > TEMPLATE_STORE_MAX_BYTES) invalid()
  return result
}

export function checkedTemplateStoreEntryCount(count: number): number {
  if (!Number.isSafeInteger(count) || count < 0 || count > TEMPLATE_STORE_MAX_ENTRIES) invalid()
  return count
}

export function computeTemplateTreeSha256(version: string, entries: readonly TemplateManifestEntry[]): string {
  if (!isVersion(version)) invalid()
  const sorted = [...entries].sort(compareEntries)
  const hash = createHash('sha256')
  hash.update('dz23-template-store\0v1\0', 'utf8')
  hash.update(version, 'utf8')
  hash.update('\0', 'utf8')
  for (const entry of sorted) {
    hash.update(entry.type, 'utf8')
    hash.update('\0', 'utf8')
    hash.update(entry.path, 'utf8')
    hash.update('\0', 'utf8')
    if (entry.type === 'file') {
      hash.update(String(entry.bytes), 'utf8')
      hash.update('\0', 'utf8')
      hash.update(entry.sha256, 'utf8')
      hash.update('\0', 'utf8')
    }
  }
  return hash.digest('hex')
}

export function canonicalSourceRoot(value: string): string {
  if (typeof value !== 'string' || !posix.isAbsolute(value) || posix.normalize(value) !== value || value === '/' || value.endsWith('/') || value.includes('\\') || value.includes('\0') || value.includes('://')) invalid()
  return value
}

export function manifestReferencePath(value: string): string {
  if (typeof value !== 'string' || !value.startsWith('file:')) invalid()
  return canonicalSourceRoot(value.slice(5))
}

export function provisionIdentifier(value: string): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value)) invalid()
  return value
}

export function templateVersion(value: string): string {
  if (!isVersion(value)) invalid()
  return value
}

export function sha256Value(value: string): string {
  if (!isSha256(value)) invalid()
  return value
}

export function imageDigestValue(value: string): `sha256:${string}` {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) invalid()
  return value as `sha256:${string}`
}

export function assertSafeStoreStat(stat: Stats, expected: 'directory' | 'file', sealed: boolean): void {
  if (stat.isSymbolicLink() || (expected === 'directory' ? !stat.isDirectory() : !stat.isFile())) invalid()
  if (expected === 'file' && stat.nlink !== 1) invalid()
  const mode = stat.mode & 0o7777
  if (sealed && mode !== (expected === 'directory' ? 0o555 : 0o444)) invalid()
}

export function assertSourceIdentity(opened: Stats, linked: Stats, expected: 'directory' | 'file'): void {
  assertSafeStoreStat(opened, expected, false)
  assertSafeStoreStat(linked, expected, false)
  if (opened.dev !== linked.dev || opened.ino !== linked.ino) invalid()
}

export function assertUnchangedStoreStat(left: Stats, right: Stats, expected: 'directory' | 'file'): void {
  const common = left.dev === right.dev && left.ino === right.ino && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && (left.mode & 0o7777) === (right.mode & 0o7777)
  const fileFields = expected === 'directory' || (left.size === right.size && left.nlink === right.nlink)
  if (!common || !fileFields) invalid()
}

export function isSafeStagingName(value: string): boolean {
  return /^\.staging-[a-f0-9]{32}$/u.test(value) || /^\.orphan-[a-f0-9]{32}$/u.test(value)
}

function parseEntry(value: unknown): TemplateManifestEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid()
  const record = value as Record<string, unknown>
  if (record.type === 'directory') {
    exactKeys(record, ['path', 'type'])
    return { path: templateEntryPath(record.path), type: 'directory' }
  }
  exactKeys(record, ['bytes', 'path', 'sha256', 'type'])
  if (record.type !== 'file' || !Number.isSafeInteger(record.bytes) || (record.bytes as number) < 0 || (record.bytes as number) > TEMPLATE_ENTRY_MAX_BYTES || !isSha256(record.sha256)) invalid()
  return { path: templateEntryPath(record.path), type: 'file', bytes: record.bytes as number, sha256: record.sha256 }
}

export function templateEntryPath(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || Buffer.byteLength(value, 'utf8') > 512 || value.includes('\\') || value.includes('\0') || posix.isAbsolute(value) || posix.normalize(value) !== value || value === '.' || value.endsWith('/') || !/^[A-Za-z0-9_@+().\[\]-]+(?:\/[A-Za-z0-9_@+().\[\]-]+)*$/u.test(value)) invalid()
  if (value.split('/').some(segment => segment === '.' || segment === '..')) invalid()
  return value
}

function assertParentsDeclared(entry: TemplateManifestEntry, directories: ReadonlySet<string>): void {
  let parent = posix.dirname(entry.path)
  while (parent !== '.') {
    if (!directories.has(parent)) invalid()
    parent = posix.dirname(parent)
  }
}

function compareEntries(left: TemplateManifestEntry, right: TemplateManifestEntry): number {
  return Buffer.from(left.path).compare(Buffer.from(right.path))
}

function exactRecord(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid()
  const record = value as Record<string, unknown>
  exactKeys(record, keys, optional)
  return record
}

/**
 * Todas as chaves exigidas, nenhuma a mais — e, no máximo, as declaradas como
 * opcionais.
 *
 * A regra continua estrita de propósito: um campo desconhecido num manifesto de
 * armazenamento é conteúdo que ninguém conferiu entrando por uma porta que
 * ninguém declarou. O que muda é que uma chave OPCIONAL pode faltar.
 * @param value - o registro lido.
 * @param keys - as chaves obrigatórias.
 * @param optional - as chaves que podem estar ausentes.
 */
function exactKeys(value: Record<string, unknown>, keys: readonly string[], optional: readonly string[] = []): void {
  const present = new Set(Object.keys(value))
  for (const key of keys) { if (!present.delete(key)) invalid() }
  for (const key of optional) present.delete(key)
  if (present.size > 0) invalid()
}

function isVersion(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_.@-]{0,63}$/u.test(value)
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

function invalid(): never { throw new Error('INVALID_TEMPLATE_STORE') }
