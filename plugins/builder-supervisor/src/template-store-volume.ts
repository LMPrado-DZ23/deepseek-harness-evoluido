import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdtemp, open, readdir, realpath, rm, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { posix } from 'node:path'
import type { DockerEnginePort } from './docker-engine.js'
import { isBuilderRuntimeScopeId, isInstallationId, type BuilderRuntimeScopeId } from './runtime-scope.js'
import {
  TEMPLATE_ENTRY_MAX_BYTES,
  TEMPLATE_STORE_MAX_BYTES,
  assertSafeStoreStat,
  assertUnchangedStoreStat,
  checkedTemplateStoreByteTotal,
  checkedTemplateStoreEntryCount,
  computeTemplateTreeSha256,
  imageDigestValue,
  parseTemplateStoreManifest,
  templateEntryPath,
  templateVersion,
  type TemplateManifestEntry,
  type TemplateStoreManifest,
} from './store-security.js'

const BLOCK = 512
/*
  O arquivo baixado carrega o store inteiro mais os cabeçalhos: 512 bytes por
  entrada, mais um cabeçalho PAX e o registro dele para cada caminho longo, e o
  enchimento de cada arquivo até o bloco. 256 MiB por cima do teto do store
  cobrem as 60.000 entradas com folga.
*/
const ARCHIVE_LIMIT = TEMPLATE_STORE_MAX_BYTES + 256 * 1024 * 1024
/** O maior caminho aceito dentro do arquivo, com o `tree/` na frente. */
const MAX_TAR_PATH_BYTES = 1024
/** O maior registro PAX aceito: um caminho e, no máximo, os tempos. */
const PAX_LIMIT = 8 * 1024
/** As chaves PAX que o Docker pode escrever e que não mudam o conteúdo. */
const PAX_TEMPO = new Set(['mtime', 'atime', 'ctime'])
const CLEANUP_TIMEOUT_MS = 10_000
const MATERIALIZATION_TIMEOUT_MS = 10 * 60_000
export const TEMPLATE_STORE_VERIFICATION_TIMEOUT_MS = 8 * 60_000
export const TEMPLATE_STORE_VERIFICATION_CLEANUP_BUDGET_MS = 12 * CLEANUP_TIMEOUT_MS
const TEMPLATE_STORE_CLAIM_SAFETY_MARGIN_MS = 5 * 60_000
export const TEMPLATE_STORE_CLAIM_TTL_MS = TEMPLATE_STORE_VERIFICATION_TIMEOUT_MS + TEMPLATE_STORE_VERIFICATION_CLEANUP_BUDGET_MS + TEMPLATE_STORE_CLAIM_SAFETY_MARGIN_MS
const TRANSPORT_TTL_MS = 12 * 60_000
const TRANSPORT_COMMAND = ['node', '-e', `setTimeout(()=>process.exit(0),${TRANSPORT_TTL_MS})`] as const
const CLAIM_COMMAND = ['node', '-e', `setTimeout(()=>process.exit(0),${TEMPLATE_STORE_CLAIM_TTL_MS})`] as const

export type TemplateStoreVolumeErrorCode =
  | 'TEMPLATE_STORE_ABORTED'
  | 'TEMPLATE_STORE_BUSY'
  | 'TEMPLATE_STORE_CLEANUP_INCOMPLETE'
  | 'TEMPLATE_STORE_INVALID'
  | 'TEMPLATE_STORE_TARGET_MISMATCH'

export class TemplateStoreVolumeError extends Error {
  constructor(readonly code: TemplateStoreVolumeErrorCode) { super(code); this.name = 'TemplateStoreVolumeError' }
}

export interface TemplateStoreVolumeIdentity {
  readonly installationId: string
  readonly scopeId: BuilderRuntimeScopeId
  readonly version: string
  readonly treeSha256: string
}

export interface TemplateStoreVolumeOptions extends TemplateStoreVolumeIdentity {
  readonly engine: DockerEnginePort
  readonly imageDigest: `sha256:${string}`
  readonly sourceEnvelope: string
  readonly manifest: TemplateStoreManifest
}

export interface TemplateStoreVolumeResult {
  readonly state: 'CREATED' | 'REUSED'
  readonly volumeName: string
  readonly treeSha256: string
}

export async function ensureTemplateStoreVolume(options: TemplateStoreVolumeOptions, signal: AbortSignal): Promise<TemplateStoreVolumeResult> {
  const input = validateOptions(options)
  const operationSignal = AbortSignal.any([signal, AbortSignal.timeout(MATERIALIZATION_TIMEOUT_MS)])
  assertNotAborted(operationSignal)
  await verifySealedEnvelope(options.sourceEnvelope, input.manifest, operationSignal)
  const name = templateStoreVolumeName(input.installationId, input.scopeId, input.version, input.treeSha256)
  const claim = await acquireMaterializationClaim(options.engine, options.imageDigest, input, name, operationSignal)
  const labels = { ...templateStoreVolumeLabels(input), 'dz23.materialization_nonce': claim.nonce }
  const materializerTransporterLabels = { ...transporterLabels(input), 'dz23.materialization_nonce': claim.nonce }
  let volumeOwnedByClaim = false
  let container: string | undefined
  const containerName = transporterName(name)
  let archives: StagedArchives | undefined
  let operationError: unknown
  try {
    const existing = await exactVolume(options.engine, name, operationSignal)
    if (existing !== undefined) {
      if (!hasExactIdentity(existing, templateStoreVolumeLabels(input))) mismatch()
      if (await verifyTemplateStoreVolumeInternal({ ...input, engine: options.engine, imageDigest: options.imageDigest, volumeName: name }, operationSignal, claim)) {
        return await finishClaim(options.engine, claim, { state: 'REUSED', volumeName: name, treeSha256: input.treeSha256 })
      }
      const nonce = record(record(existing).Labels)['dz23.materialization_nonce']
      if (nonce !== claim.nonce) mismatch()
      volumeOwnedByClaim = true
      await options.engine.removeVolume(name, cleanupSignal())
      if (await exactVolume(options.engine, name, cleanupSignal()) !== undefined) cleanupFailed()
    }
    volumeOwnedByClaim = true
    await options.engine.createVolume(name, labels, {}, operationSignal)
    const created = await exactVolume(options.engine, name, operationSignal)
    if (created === undefined || !hasExactIdentity(created, labels) || record(record(created).Labels)['dz23.materialization_nonce'] !== claim.nonce) busy()
    container = await options.engine.createContainer(containerName, transporterBody(options.imageDigest, labels, name, false), operationSignal)
    await options.engine.startContainer(container, operationSignal)
    if (!await downloadedVolumeIsEmpty(options.engine, container, operationSignal)) mismatch()
    archives = await stageEnvelopeArchives(options.sourceEnvelope, input.manifest, operationSignal)
    await options.engine.putArchive(container, '/template-store', archives.treePath, archives.treeBytes, operationSignal)
    assertNotAborted(operationSignal)
    await options.engine.putArchive(container, '/template-store', archives.markerPath, archives.markerBytes, operationSignal)
    if (!await downloadAndValidate(options.engine, container, input.version, input.treeSha256, false, operationSignal)) invalid()
  } catch (error) { operationError = error }

  const cleanupErrors: unknown[] = []
  const captureCleanupError = (error: unknown): number => cleanupErrors.push(error)
  if (container !== undefined) {
    await options.engine.stopContainer(container, cleanupSignal()).catch(captureCleanupError)
    await options.engine.removeContainer(container, cleanupSignal()).catch(captureCleanupError)
    await exactTransporter(options.engine, containerName, materializerTransporterLabels, cleanupSignal()).then(row => { if (row !== undefined) cleanupErrors.push(new TemplateStoreVolumeError('TEMPLATE_STORE_CLEANUP_INCOMPLETE')) }, captureCleanupError)
  }
  await archives?.dispose().catch(captureCleanupError)
  let volumeStateSafeForClaimRelease = operationError === undefined || !volumeOwnedByClaim
  if (operationError !== undefined && volumeOwnedByClaim) {
    let inspectionFailed = false
    const current = await exactVolume(options.engine, name, cleanupSignal()).catch(error => { inspectionFailed = true; cleanupErrors.push(error); return undefined })
    if (!inspectionFailed) {
      if (current === undefined) volumeStateSafeForClaimRelease = true
      else {
        const ownNonce = record(record(current).Labels)['dz23.materialization_nonce'] === claim.nonce
        const ownIdentity = hasExactIdentity(current, labels)
        if (ownNonce && ownIdentity) {
          await options.engine.removeVolume(name, cleanupSignal()).catch(captureCleanupError)
          let proofFailed = false
          const after = await exactVolume(options.engine, name, cleanupSignal()).catch(error => { proofFailed = true; cleanupErrors.push(error); return undefined })
          if (!proofFailed) volumeStateSafeForClaimRelease = after === undefined || record(record(after).Labels)['dz23.materialization_nonce'] !== claim.nonce
        } else if (!ownNonce) volumeStateSafeForClaimRelease = true
        else cleanupErrors.push(new TemplateStoreVolumeError('TEMPLATE_STORE_TARGET_MISMATCH'))
      }
    }
  }
  const leftoverContainers = await options.engine.listContainers({ label: transporterFilter(input, claim.nonce) }, cleanupSignal()).catch(error => { cleanupErrors.push(error); return [{}] })
  if (cleanupErrors.length === 0 && leftoverContainers.length === 0 && volumeStateSafeForClaimRelease) await releaseMaterializationClaim(options.engine, claim).catch(captureCleanupError)
  if (cleanupErrors.length > 0 || leftoverContainers.length > 0 || !volumeStateSafeForClaimRelease) cleanupFailed()
  if (operationError !== undefined) {
    if (operationSignal.aborted) throw new TemplateStoreVolumeError('TEMPLATE_STORE_ABORTED')
    throw normalizeError(operationError)
  }
  return { state: 'CREATED', volumeName: name, treeSha256: input.treeSha256 }
}

export interface VerifyTemplateStoreVolumeOptions extends TemplateStoreVolumeIdentity {
  readonly engine: DockerEnginePort
  readonly imageDigest: `sha256:${string}`
  readonly volumeName?: string
}

export async function verifyTemplateStoreVolume(options: VerifyTemplateStoreVolumeOptions, signal: AbortSignal): Promise<boolean> {
  const operationSignal = AbortSignal.any([signal, AbortSignal.timeout(TEMPLATE_STORE_VERIFICATION_TIMEOUT_MS)])
  assertNotAborted(operationSignal)
  const input = validateIdentity(options)
  imageDigestValue(options.imageDigest)
  const name = templateStoreVolumeName(input.installationId, input.scopeId, input.version, input.treeSha256)
  if (options.volumeName !== undefined && options.volumeName !== name) invalid()
  let claim: MaterializationClaim
  try { claim = await acquireMaterializationClaim(options.engine, options.imageDigest, input, name, operationSignal) }
  catch (error) {
    if (error instanceof TemplateStoreVolumeError && error.code === 'TEMPLATE_STORE_BUSY') return false
    if (operationSignal.aborted) throw new TemplateStoreVolumeError('TEMPLATE_STORE_ABORTED')
    throw normalizeError(error)
  }
  let result: boolean | undefined
  let operationError: unknown
  try { result = await verifyTemplateStoreVolumeInternal({ ...input, engine: options.engine, imageDigest: options.imageDigest, volumeName: name }, operationSignal, claim) }
  catch (error) { operationError = error }
  if (operationError instanceof TemplateStoreVolumeError && (operationError.code === 'TEMPLATE_STORE_TARGET_MISMATCH' || operationError.code === 'TEMPLATE_STORE_CLEANUP_INCOMPLETE')) throw operationError
  await releaseMaterializationClaim(options.engine, claim)
  if (operationError !== undefined) throw normalizeError(operationError)
  return result === true
}

async function verifyTemplateStoreVolumeInternal(options: VerifyTemplateStoreVolumeOptions & { readonly volumeName: string }, signal: AbortSignal, allowedClaim: MaterializationClaim): Promise<boolean> {
  const input = validateIdentity(options)
  imageDigestValue(options.imageDigest)
  const name = options.volumeName
  const claim = await exactClaim(options.engine, `${name}-claim`, signal)
  if (claim === undefined) return false
  const claimIdentity = record(record(claim).Labels)
  if (identifier(claim) !== allowedClaim.id || claimIdentity['dz23.materialization_nonce'] !== allowedClaim.nonce || !hasExactIdentity(claim, claimLabels(input, allowedClaim.nonce, allowedClaim.expiresAt)) || record(claim).State !== 'running') return false
  const labels = templateStoreVolumeLabels(input)
  const volume = await exactVolume(options.engine, name, signal)
  if (volume === undefined || !hasExactIdentity(volume, labels)) return false
  const volumeNonce = record(record(volume).Labels)['dz23.materialization_nonce']
  if (typeof volumeNonce !== 'string' || !/^[a-f0-9]{32}$/u.test(volumeNonce)) return false
  let container: string | undefined
  const containerName = transporterName(name)
  const containerLabels = { ...transporterLabels(input), 'dz23.materialization_nonce': allowedClaim.nonce }
  let valid = false
  let cleanupError: unknown
  let operationError: unknown
  const captureCleanupError = (error: unknown): void => { cleanupError ??= error }
  try {
    const transporterVolumeLabels = { ...labels, 'dz23.materialization_nonce': allowedClaim.nonce }
    container = await options.engine.createContainer(containerName, transporterBody(options.imageDigest, transporterVolumeLabels, name, true), signal)
    await options.engine.startContainer(container, signal)
    valid = await downloadAndValidate(options.engine, container, input.version, input.treeSha256, false, signal)
  } catch (error) {
    if (signal.aborted) operationError = new TemplateStoreVolumeError('TEMPLATE_STORE_ABORTED')
    if (error instanceof TemplateStoreVolumeError && error.code === 'TEMPLATE_STORE_INVALID') valid = false
    else operationError ??= error
  }
  finally {
    let observed: Record<string, unknown> | undefined
    try { observed = await exactTransporter(options.engine, containerName, containerLabels, cleanupSignal()) }
    catch (error) { captureCleanupError(error) }
    if (observed !== undefined) {
      const observedId = identifier(observed)
      if (observedId === undefined || !/^[a-f0-9]{12,64}$/u.test(observedId) || (container !== undefined && container !== observedId)) captureCleanupError(new TemplateStoreVolumeError('TEMPLATE_STORE_CLEANUP_INCOMPLETE'))
      else {
        await options.engine.stopContainer(observedId, cleanupSignal()).catch(captureCleanupError)
        await options.engine.removeContainer(observedId, cleanupSignal()).catch(captureCleanupError)
      }
    }
    await exactTransporter(options.engine, containerName, containerLabels, cleanupSignal()).then(row => { if (row !== undefined) cleanupError ??= new TemplateStoreVolumeError('TEMPLATE_STORE_CLEANUP_INCOMPLETE') }, captureCleanupError)
    await exactVolume(options.engine, name, cleanupSignal()).then(row => {
      if (row === undefined || !hasExactIdentity(row, labels) || record(record(row).Labels)['dz23.materialization_nonce'] !== volumeNonce) cleanupError ??= new TemplateStoreVolumeError('TEMPLATE_STORE_CLEANUP_INCOMPLETE')
    }, captureCleanupError)
  }
  if (cleanupError !== undefined) cleanupFailed()
  if (operationError !== undefined) throw normalizeError(operationError)
  return valid
}

export function templateStoreVolumeName(installationId: string, scopeId: BuilderRuntimeScopeId, version: string, treeSha256: string): string {
  const input = validateIdentity({ installationId, scopeId, version, treeSha256 })
  const digest = createHash('sha256').update('dz23-template-volume\0v1\0').update(input.installationId).update('\0').update(input.scopeId).update('\0').update(input.version).update('\0').update(input.treeSha256).digest('hex')
  return `dz23-template-${digest.slice(0, 32)}`
}

export function templateStoreVolumeLabels(inputValue: TemplateStoreVolumeIdentity): Readonly<Record<string, string>> {
  const input = validateIdentity(inputValue)
  return Object.freeze({
    'dz23.managed': 'builder-template-store',
    'com.dz23.studio.installation-id': input.installationId,
    'com.dz23.studio.scope-id': input.scopeId,
    'dz23.template_version': input.version,
    'dz23.template_sha256': input.treeSha256,
  })
}

export function templateStoreUstarEntryPath(value: unknown): string {
  /*
    O nome é histórico: o arquivo nasceu só com USTAR, que guarda no máximo 100
    bytes de nome (mais 155 de prefixo, cortados numa barra). O store REAL do
    pnpm nomeia cada arquivo pelo hash — 126 caracteres num só segmento —, e
    nenhum deles cabe. Medido em 19/09/2026 no primeiro store real: TODOS os
    arquivos do store eram recusados aqui. O caminho longo agora vai num
    cabeçalho PAX (`path=`), que é o que o próprio Docker escreve ao exportar o
    volume.
  */
  try {
    // `templateEntryPath` já limita o caminho a 512 bytes, e `tree/` mais 512
    // cabe em `MAX_TAR_PATH_BYTES`: todo caminho válido é representável. A
    // função fica como o ponto único onde "cabe no arquivo" é decidido.
    return templateEntryPath(value)
  } catch { return invalid() }
}

interface ValidatedOptions extends TemplateStoreVolumeIdentity { readonly manifest: TemplateStoreManifest }
function validateOptions(options: TemplateStoreVolumeOptions): ValidatedOptions {
  try {
    const identity = validateIdentity(options)
    imageDigestValue(options.imageDigest)
    if (typeof options.sourceEnvelope !== 'string' || !posix.isAbsolute(options.sourceEnvelope) || posix.normalize(options.sourceEnvelope) !== options.sourceEnvelope || options.sourceEnvelope === '/' || options.sourceEnvelope.endsWith('/') || options.sourceEnvelope.includes('\\') || options.sourceEnvelope.includes('\0')) invalid()
    const manifest = parseTemplateStoreManifest(options.manifest)
    for (const entry of manifest.entries) templateStoreUstarEntryPath(entry.path)
    if (manifest.template_store_version !== identity.version || manifest.tree_sha256 !== identity.treeSha256) mismatch()
    return { ...identity, manifest }
  } catch (error) { if (error instanceof TemplateStoreVolumeError) throw error; return invalid() }
}

function validateIdentity(input: TemplateStoreVolumeIdentity): TemplateStoreVolumeIdentity {
  try {
    if (!isInstallationId(input.installationId) || !isBuilderRuntimeScopeId(input.scopeId)) invalid()
    const version = templateVersion(input.version)
    if (!/^[a-f0-9]{64}$/u.test(input.treeSha256)) invalid()
    return { installationId: input.installationId, scopeId: input.scopeId, version, treeSha256: input.treeSha256 }
  } catch (error) { if (error instanceof TemplateStoreVolumeError) throw error; return invalid() }
}

async function exactVolume(engine: DockerEnginePort, name: string, signal: AbortSignal): Promise<Record<string, unknown> | undefined> {
  const rows = await engine.listVolumes({ name: [name] }, signal)
  const exact = rows.filter(row => identifier(row) === name)
  if (exact.length > 1 || rows.some(row => identifier(row) !== name)) mismatch()
  return exact[0] as Record<string, unknown> | undefined
}

/**
 * As etiquetas que a IMAGEM traz, e não quem criou o recurso.
 *
 * O Docker copia as etiquetas da imagem para todo contêiner criado dela. A
 * imagem do construtor herda do Ubuntu `org.opencontainers.image.ref.name` e
 * `org.opencontainers.image.version`, e o `org.` no começo casava com a guarda
 * de "etiqueta que parece identidade de organização": medido em 19/09/2026 na
 * primeira instalação real, o gerente recusava o PRÓPRIO contêiner de reserva
 * com `TEMPLATE_STORE_TARGET_MISMATCH`, e nenhum escopo subia. O espaço de nomes
 * OCI é padrão e não carrega inquilino nenhum; só ele fica de fora.
 */
const ETIQUETA_OCI_DA_IMAGEM = /^org\.opencontainers\.image\.[a-z0-9.-]+$/u

export function hasExactIdentity(row: unknown, expected: Readonly<Record<string, string>>): boolean {
  const labels = record(record(row).Labels)
  if (Object.keys(labels).some(key => !ETIQUETA_OCI_DA_IMAGEM.test(key) && /(?:^|[._-])(?:tenant|org|instance)(?:[._-]|$)/iu.test(key))) return false
  return Object.entries(expected).every(([key, value]) => labels[key] === value)
}

function transporterFilter(input: TemplateStoreVolumeIdentity, nonce?: string): readonly string[] {
  return [
    'dz23.managed=builder-template-transporter',
    `com.dz23.studio.installation-id=${input.installationId}`,
    `com.dz23.studio.scope-id=${input.scopeId}`,
    `dz23.template_version=${input.version}`,
    `dz23.template_sha256=${input.treeSha256}`,
    ...(nonce === undefined ? [] : [`dz23.materialization_nonce=${nonce}`]),
  ]
}

function transporterLabels(input: TemplateStoreVolumeIdentity): Readonly<Record<string, string>> {
  return Object.fromEntries(transporterFilter(input).map(item => item.split(/=(.*)/su).slice(0, 2) as [string, string]))
}

function transporterName(volume: string): string { return `${volume}-transport-${randomBytes(4).toString('hex')}` }

interface MaterializationClaim { readonly id: string; readonly name: string; readonly nonce: string; readonly expiresAt: number; readonly labels: Readonly<Record<string, string>> }
async function acquireMaterializationClaim(engine: DockerEnginePort, image: `sha256:${string}`, input: TemplateStoreVolumeIdentity, volume: string, signal: AbortSignal): Promise<MaterializationClaim> {
  const name = `${volume}-claim`
  let recoveryAvailable = true
  while (true) {
    const nonce = randomBytes(16).toString('hex'); const expiresAt = Date.now() + TEMPLATE_STORE_CLAIM_TTL_MS; const labels = claimLabels(input, nonce, expiresAt)
    let id: string
    try {
      id = await engine.createContainer(name, claimBody(image, labels), signal)
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'DOCKER_STATUS_409') throw error
      if (!recoveryAvailable) busy()
      recoveryAvailable = false
      const stale = await exactClaim(engine, name, signal)
      if (stale === undefined) busy()
      const state = record(stale).State
      const staleLabels = record(record(stale).Labels)
      const nonceValue = staleLabels['dz23.materialization_nonce']; const expiresValue = staleLabels['dz23.materialization_expires_at']
      if (typeof nonceValue !== 'string' || !/^[a-f0-9]{32}$/u.test(nonceValue) || typeof expiresValue !== 'string' || !/^[1-9][0-9]{12}$/u.test(expiresValue) || !hasExactIdentity(stale, claimLabels(input, nonceValue, Number(expiresValue)))) mismatch()
      if ((state !== 'created' && state !== 'exited' && state !== 'dead') || Date.now() < Number(expiresValue)) busy()
      const id = identifier(stale); if (id === undefined) mismatch()
      await removeStaleTransporters(engine, input, volume, nonceValue)
      const occupied = await exactVolume(engine, volume, signal)
      if (occupied !== undefined) {
        const occupiedLabels = record(record(occupied).Labels)
        if (!hasExactIdentity(occupied, templateStoreVolumeLabels(input))) mismatch()
        if (occupiedLabels['dz23.materialization_nonce'] === nonceValue) {
          await cleanupOrFail(engine.removeVolume(volume, cleanupSignal()))
          if (await exactVolume(engine, volume, cleanupSignal()) !== undefined) cleanupFailed()
        }
      }
      await cleanupOrFail(engine.removeContainer(id, cleanupSignal()))
      if (await exactClaim(engine, name, cleanupSignal()) !== undefined) cleanupFailed()
      continue
    }
    try { await engine.startContainer(id, signal) }
    catch (error) { await cleanupOrFail(engine.removeContainer(id, cleanupSignal())); throw error }
    return { id, name, nonce, expiresAt, labels }
  }
}

async function removeStaleTransporters(engine: DockerEnginePort, input: TemplateStoreVolumeIdentity, volume: string, nonce: string): Promise<void> {
  const filter = transporterFilter(input, nonce)
  const rows = await cleanupOrFail(engine.listContainers({ label: filter }, cleanupSignal()))
  if (rows.length > 1) mismatch()
  const expectedLabels = { ...transporterLabels(input), 'dz23.materialization_nonce': nonce }
  const expectedName = new RegExp(`^/${volume}-transport-[a-f0-9]{8}$`, 'u')
  for (const row of rows) {
    const names = record(row).Names; const id = identifier(row)
    if (!Array.isArray(names) || names.length !== 1 || typeof names[0] !== 'string' || !expectedName.test(names[0]) || id === undefined || !/^[a-f0-9]{12,64}$/u.test(id) || !hasExactIdentity(row, expectedLabels)) mismatch()
    await cleanupOrFail(engine.stopContainer(id, cleanupSignal()))
    await cleanupOrFail(engine.removeContainer(id, cleanupSignal()))
  }
  if ((await cleanupOrFail(engine.listContainers({ label: filter }, cleanupSignal()))).length > 0) cleanupFailed()
}

async function exactClaim(engine: DockerEnginePort, name: string, signal: AbortSignal): Promise<Record<string, unknown> | undefined> {
  const rows = await engine.listContainers({ name: [name] }, signal)
  const exact = rows.filter(row => containerHasName(row, name))
  if (exact.length > 1 || rows.some(row => !containerHasName(row, name))) mismatch()
  return exact[0] as Record<string, unknown> | undefined
}

async function exactTransporter(engine: DockerEnginePort, name: string, labels: Readonly<Record<string, string>>, signal: AbortSignal): Promise<Record<string, unknown> | undefined> {
  const rows = await engine.listContainers({ name: [name] }, signal)
  const exact = rows.filter(row => containerHasName(row, name))
  if (exact.length > 1 || rows.some(row => !containerHasName(row, name)) || (exact[0] !== undefined && !hasExactIdentity(exact[0], labels))) mismatch()
  return exact[0] as Record<string, unknown> | undefined
}

function containerHasName(row: unknown, name: string): boolean {
  const names = record(row).Names
  return Array.isArray(names) && names.some(value => value === `/${name}`)
}

function claimLabels(input: TemplateStoreVolumeIdentity, nonce: string, expiresAt: number): Readonly<Record<string, string>> {
  return { ...templateStoreVolumeLabels(input), 'dz23.managed': 'builder-template-claim', 'dz23.materialization_nonce': nonce, 'dz23.materialization_expires_at': String(expiresAt) }
}

function claimBody(image: `sha256:${string}`, labels: Readonly<Record<string, string>>): Readonly<Record<string, unknown>> {
  return sandboxBody(image, CLAIM_COMMAND, labels, [], false)
}

async function releaseMaterializationClaim(engine: DockerEnginePort, claim: MaterializationClaim): Promise<void> {
  const current = await exactClaim(engine, claim.name, cleanupSignal())
  if (current === undefined || identifier(current) !== claim.id || record(current).State !== 'running' || !hasExactIdentity(current, claim.labels)) cleanupFailed()
  await cleanupOrFail(engine.stopContainer(claim.id, cleanupSignal()))
  await cleanupOrFail(engine.removeContainer(claim.id, cleanupSignal()))
  if (await exactClaim(engine, claim.name, cleanupSignal()) !== undefined) cleanupFailed()
}

async function finishClaim<T>(engine: DockerEnginePort, claim: MaterializationClaim, value: T): Promise<T> { await releaseMaterializationClaim(engine, claim); return value }

export function templateStoreTransporterBody(image: `sha256:${string}`, identity: TemplateStoreVolumeIdentity, volume: string, readOnly: boolean): Readonly<Record<string, unknown>> {
  imageDigestValue(image)
  const input = validateIdentity(identity)
  if (volume !== templateStoreVolumeName(input.installationId, input.scopeId, input.version, input.treeSha256)) invalid()
  return transporterBody(image, templateStoreVolumeLabels(input), volume, readOnly)
}

function transporterBody(image: `sha256:${string}`, volumeLabels: Readonly<Record<string, string>>, volume: string, readOnly: boolean): Readonly<Record<string, unknown>> {
  const identity: TemplateStoreVolumeIdentity = {
    installationId: volumeLabels['com.dz23.studio.installation-id']!,
    scopeId: volumeLabels['com.dz23.studio.scope-id']! as BuilderRuntimeScopeId,
    version: volumeLabels['dz23.template_version']!,
    treeSha256: volumeLabels['dz23.template_sha256']!,
  }
  const nonce = volumeLabels['dz23.materialization_nonce']
  return sandboxBody(image, TRANSPORT_COMMAND, { ...transporterLabels(identity), ...(nonce === undefined ? {} : { 'dz23.materialization_nonce': nonce }) }, [{ Type: 'volume', Source: volume, Target: '/template-store', ReadOnly: readOnly }], true)
}

function sandboxBody(image: `sha256:${string}`, command: readonly string[], labels: Readonly<Record<string, string>>, mounts: readonly unknown[], autoRemove: boolean): Readonly<Record<string, unknown>> {
  return { Image: image, Cmd: command, WorkingDir: '/', User: '10001:10001', Env: ['HOME=/tmp', 'XDG_CONFIG_HOME=/tmp/.config'], Labels: labels, NetworkDisabled: true,
    HostConfig: {
      NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], AutoRemove: autoRemove,
      PidsLimit: 32, Memory: 256 * 1024 * 1024, NanoCpus: 500_000_000, OomKillDisable: false,
      PublishAllPorts: false, PortBindings: {}, IpcMode: 'private', Mounts: mounts,
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=16777216,uid=10001,gid=10001' }, Ulimits: [{ Name: 'nofile', Soft: 128, Hard: 128 }],
    },
    LogConfig: { Type: 'local', Config: { 'max-size': '64k', 'max-file': '1' } },
  }
}

interface StagedArchives { readonly treePath: string; readonly treeBytes: number; readonly markerPath: string; readonly markerBytes: number; dispose(): Promise<void> }
async function stageEnvelopeArchives(root: string, manifest: TemplateStoreManifest, signal: AbortSignal): Promise<StagedArchives> {
  const stage = await mkdtemp(posix.join(tmpdir().replaceAll('\\', '/'), 'dz23-template-volume-'))
  const treePath = posix.join(stage, 'tree.tar'); const markerPath = posix.join(stage, 'marker.tar')
  try {
    const treeBytes = await writeTreeArchive(treePath, posix.join(root, 'tree'), manifest, signal)
    const marker = Buffer.from(`${manifest.tree_sha256}\n`, 'utf8')
    const markerBytes = await writeMarkerArchive(markerPath, marker)
    return { treePath, treeBytes, markerPath, markerBytes, dispose: async () => rm(stage, { recursive: true, force: true }) }
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error }
}

async function writeTreeArchive(path: string, root: string, manifest: TemplateStoreManifest, signal: AbortSignal): Promise<number> {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow(), 0o600)
  let bytes = 0
  try {
    bytes += await writeTemplateStoreBytes(handle, tarHeader('tree/', 0, '5', 0o555))
    for (const entry of manifest.entries) {
      assertNotAborted(signal)
      const name = `tree/${templateStoreUstarEntryPath(entry.path)}`
      if (entry.type === 'directory') { bytes += await writeTemplateStoreBytes(handle, tarHeader(name, 0, '5', 0o555)); continue }
      const source = posix.join(root, entry.path); const input = await open(source, constants.O_RDONLY | noFollow())
      try {
        const before = await input.stat(); assertSafeStoreStat(before, 'file', true)
        if (before.size !== entry.bytes) mismatch()
        bytes += await writeTemplateStoreBytes(handle, tarHeader(name, before.size, '0', 0o444))
        const streamed = await streamTemplateStoreFile(input, before.size, signal, async value => { bytes += await writeTemplateStoreBytes(handle, value) })
        const after = await input.stat(); assertUnchangedStoreStat(before, after, 'file')
        if (streamed.sha256 !== entry.sha256) mismatch()
        const padding = (BLOCK - before.size % BLOCK) % BLOCK; if (padding > 0) bytes += await writeTemplateStoreBytes(handle, Buffer.alloc(padding))
      } finally { await input.close() }
    }
    bytes += await writeTemplateStoreBytes(handle, Buffer.alloc(BLOCK * 2)); await handle.sync()
    return bytes
  } finally { await handle.close() }
}

async function writeMarkerArchive(path: string, value: Buffer): Promise<number> {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow(), 0o600); let bytes = 0
  try {
    bytes += await writeTemplateStoreBytes(handle, tarHeader('.complete', value.byteLength, '0', 0o444)); bytes += await writeTemplateStoreBytes(handle, value)
    bytes += await writeTemplateStoreBytes(handle, Buffer.alloc((BLOCK - value.byteLength % BLOCK) % BLOCK))
    bytes += await writeTemplateStoreBytes(handle, Buffer.alloc(BLOCK * 2)); await handle.sync(); return bytes
  } finally { await handle.close() }
}

async function verifySealedEnvelope(root: string, manifest: TemplateStoreManifest, signal: AbortSignal): Promise<void> {
  try {
    const stat = await lstat(root); assertSafeStoreStat(stat, 'directory', true)
    if (await realpath(root) !== root) invalid()
    const names = (await readdir(root)).sort()
    if (names.length !== 2 || names[0] !== '.complete' || names[1] !== 'tree') mismatch()
    const markerPath = posix.join(root, '.complete'); const markerLinked = await lstat(markerPath); const marker = await open(markerPath, constants.O_RDONLY | noFollow())
    try { const markerStat = await marker.stat(); assertSafeStoreStat(markerStat, 'file', true); assertUnchangedStoreStat(markerLinked, markerStat, 'file'); if (markerStat.size !== 65 || await marker.readFile('utf8') !== `${manifest.tree_sha256}\n`) mismatch(); assertUnchangedStoreStat(markerStat, await marker.stat(), 'file') }
    finally { await marker.close() }
    const tree = posix.join(root, 'tree'); const treeStat = await lstat(tree); assertSafeStoreStat(treeStat, 'directory', true)
    const actual = await inspectSealedTree(tree, signal)
    const expected = [...manifest.entries].sort(compareEntries)
    if (JSON.stringify(actual) !== JSON.stringify(expected) || computeTemplateTreeSha256(manifest.template_store_version, actual) !== manifest.tree_sha256) mismatch()
    assertUnchangedStoreStat(stat, await lstat(root), 'directory')
  } catch (error) { if (signal.aborted) throw new TemplateStoreVolumeError('TEMPLATE_STORE_ABORTED'); if (error instanceof TemplateStoreVolumeError) throw error; return invalid() }
}

async function inspectSealedTree(root: string, signal: AbortSignal): Promise<TemplateManifestEntry[]> {
  const entries: TemplateManifestEntry[] = []; let total = 0
  async function visit(directory: string, prefix: string): Promise<void> {
    const directoryBefore = await lstat(directory); assertSafeStoreStat(directoryBefore, 'directory', true)
    const names = (await readdir(directory)).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
    for (const name of names) {
      assertNotAborted(signal); const relative = prefix === '' ? name : `${prefix}/${name}`; templateEntryPath(relative)
      const path = posix.join(directory, name); const stat = await lstat(path)
      if (stat.isSymbolicLink() || await realpath(path) !== path) invalid()
      if (stat.isDirectory()) { assertSafeStoreStat(stat, 'directory', true); entries.push({ path: relative, type: 'directory' }); await visit(path, relative) }
      else if (stat.isFile()) {
        assertSafeStoreStat(stat, 'file', true)
        if (stat.size > TEMPLATE_ENTRY_MAX_BYTES) invalid(); total = checkedTemplateStoreByteTotal(total, stat.size)
        const handle = await open(path, constants.O_RDONLY | noFollow())
        try {
          const before = await handle.stat(); assertSafeStoreStat(before, 'file', true); assertUnchangedStoreStat(stat, before, 'file')
          const streamed = await streamTemplateStoreFile(handle, before.size, signal)
          const after = await handle.stat(); assertUnchangedStoreStat(before, after, 'file'); assertUnchangedStoreStat(after, await lstat(path), 'file')
          entries.push({ path: relative, type: 'file', bytes: before.size, sha256: streamed.sha256 })
        } finally { await handle.close() }
      } else invalid()
      validateTemplateStoreEntryCount(entries.length)
    }
    assertUnchangedStoreStat(directoryBefore, await lstat(directory), 'directory')
  }
  await visit(root, '')
  return entries.sort(compareEntries)
}

async function downloadedVolumeIsEmpty(engine: DockerEnginePort, container: string, signal: AbortSignal): Promise<boolean> {
  return downloadAndValidate(engine, container, 'v1', '0'.repeat(64), true, signal)
}

async function downloadAndValidate(engine: DockerEnginePort, container: string, version: string, treeSha256: string, empty: boolean, signal: AbortSignal): Promise<boolean> {
  const stage = await mkdtemp(posix.join(tmpdir().replaceAll('\\', '/'), 'dz23-template-download-')); const path = posix.join(stage, 'volume.tar')
  let handle: FileHandle | undefined
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollow(), 0o600)
    const downloaded = await engine.downloadArchive(container, '/template-store', handle, ARCHIVE_LIMIT, signal)
    const stat = await handle.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.size !== downloaded.bytes) invalid()
    return await validateTemplateStoreArchive(handle, stat.size, version, treeSha256, empty, signal)
  } catch (error) {
    if (signal.aborted) throw new TemplateStoreVolumeError('TEMPLATE_STORE_ABORTED')
    if (error instanceof TemplateStoreVolumeError && error.code === 'TEMPLATE_STORE_INVALID') return false
    throw error
  }
  finally {
    let cleanupError = false
    if (handle !== undefined && !(await cleanupOutcome(handle.close())).ok) cleanupError = true
    if (!(await cleanupOutcome(rm(stage, { recursive: true, force: true }))).ok) cleanupError = true
    if (cleanupError) cleanupFailed()
  }
}

interface ParsedArchive { readonly entries: readonly TemplateManifestEntry[]; readonly marker?: Buffer; readonly treePresent: boolean }
export async function validateTemplateStoreArchive(handle: Pick<FileHandle, 'read'>, size: number, version: string, treeSha256: string, empty: boolean, signal: AbortSignal): Promise<boolean> {
  const parsed = await parseDownloadedArchive(handle, size, signal)
  if (empty) return parsed.entries.length === 0 && parsed.marker === undefined && !parsed.treePresent
  if (parsed.marker?.equals(Buffer.from(`${treeSha256}\n`, 'utf8')) !== true) return false
  let actual: string
  try { actual = computeTemplateTreeSha256(version, parsed.entries); parseTemplateStoreManifest({ version: 1, template_store_version: version, tree_sha256: actual, entries: parsed.entries }) } catch { return invalid() }
  return actual === treeSha256
}
async function parseDownloadedArchive(handle: Pick<FileHandle, 'read'>, size: number, signal: AbortSignal): Promise<ParsedArchive> {
  if (!Number.isSafeInteger(size) || size < BLOCK * 2 || size > ARCHIVE_LIMIT || size % BLOCK !== 0) invalid()
  let offset = 0; let terminated = false; let marker: Buffer | undefined; let total = 0; let count = 0
  const entries: TemplateManifestEntry[] = []; const seen = new Set<string>(); let prefix: '' | 'template-store/' | undefined; let rootSeen = false; let treeSeen = false
  let paxPath: string | undefined
  while (offset + BLOCK <= size) {
    assertNotAborted(signal); const header = await readExact(handle, offset, BLOCK); offset += BLOCK
    if (header.every(byte => byte === 0)) {
      const second = await readExact(handle, offset, BLOCK); offset += BLOCK
      if (!second.every(byte => byte === 0)) invalid()
      while (offset < size) { const trailing = await readExact(handle, offset, Math.min(64 * 1024, size - offset)); if (!trailing.every(byte => byte === 0)) invalid(); offset += trailing.byteLength }
      terminated = true; break
    }
    verifyChecksum(header)
    if (!header.subarray(257, 263).equals(Buffer.from([0x75, 0x73, 0x74, 0x61, 0x72, 0x00])) || !header.subarray(263, 265).equals(Buffer.from('00', 'ascii'))) invalid()
    if (cstring(header.subarray(157, 257)) !== '') invalid()
    if (header[156] === 0x78) {
      // Cabeçalho PAX: vale SÓ para a entrada seguinte, e só pode dizer o caminho.
      const paxSize = parseOctal(header.subarray(124, 136))
      if (paxPath !== undefined || paxSize < 1 || paxSize > PAX_LIMIT) invalid()
      paxPath = paxRecordPath(await readExact(handle, offset, paxSize))
      offset += paxSize + (BLOCK - paxSize % BLOCK) % BLOCK
      if (offset > size) invalid()
      continue
    }
    const rawPrefix = cstring(header.subarray(345, 500))
    const rawName = paxPath ?? `${rawPrefix}${rawPrefix === '' ? '' : '/'}${cstring(header.subarray(0, 100))}`
    paxPath = undefined
    const normalized = normalizeTarPath(rawName); const entryPrefix = normalized === 'template-store' || normalized.startsWith('template-store/') ? 'template-store/' : ''
    prefix ??= entryPrefix
    if (prefix !== entryPrefix) invalid()
    const name = normalized === 'template-store' ? '' : prefix === '' ? normalized : normalized.slice(prefix.length)
    const type = String.fromCharCode(header[156] || 48); const entrySize = parseOctal(header.subarray(124, 136))
    if (type !== '0' && type !== '5') invalid()
    if (type === '5' && entrySize !== 0) invalid()
    const folded = name.toLowerCase(); if (name !== '' && seen.has(folded)) invalid(); if (name !== '') seen.add(folded)
    const mode = parseOctal(header.subarray(100, 108)); const uid = parseOctal(header.subarray(108, 116)); const gid = parseOctal(header.subarray(116, 124))
    if (name === '') {
      if (type !== '5' || rootSeen) invalid()
      rootSeen = true
    }
    else if (name === 'tree') { if (type !== '5' || treeSeen || mode !== 0o555 || uid !== 10_001 || gid !== 10_001) invalid(); treeSeen = true }
    else if (name === '.complete') {
      if (type !== '0' || entrySize !== 65 || marker !== undefined || mode !== 0o444 || uid !== 10_001 || gid !== 10_001) invalid(); marker = await readExact(handle, offset, entrySize)
    } else if (name.startsWith('tree/')) {
      const relative = templateStoreUstarEntryPath(name.slice(5)); count += 1
      try { checkedTemplateStoreEntryCount(count) } catch { invalid() }
      if (type === '5') { if (mode !== 0o555 || uid !== 10_001 || gid !== 10_001) invalid(); entries.push({ path: relative, type: 'directory' }) }
      else {
        if (mode !== 0o444 || uid !== 10_001 || gid !== 10_001 || entrySize > TEMPLATE_ENTRY_MAX_BYTES) invalid(); total = checkedTemplateStoreByteTotal(total, entrySize)
        const content = await readExact(handle, offset, entrySize); entries.push({ path: relative, type: 'file', bytes: entrySize, sha256: createHash('sha256').update(content).digest('hex') })
      }
    } else invalid()
    offset += entrySize + (BLOCK - entrySize % BLOCK) % BLOCK
    if (offset > size) invalid()
  }
  if (!terminated || !rootSeen || paxPath !== undefined || (!emptyArchive(entries, marker) && !treeSeen)) invalid()
  return { entries: entries.sort(compareEntries), ...(marker === undefined ? {} : { marker }), treePresent: treeSeen }
}

function tarHeader(name: string, size: number, type: '0' | '5', mode: number): Buffer {
  const split = trySplitTarPath(name)
  if (split !== undefined) return ustarHeader(split, size, type, mode)
  // O caminho não cabe no USTAR: vai num cabeçalho PAX logo antes, e o
  // cabeçalho comum leva um nome curto que o leitor ignora.
  if (Buffer.byteLength(name) > MAX_TAR_PATH_BYTES) invalid()
  const record = Buffer.from(paxRecord('path', name), 'utf8')
  const padding = Buffer.alloc((BLOCK - record.byteLength % BLOCK) % BLOCK)
  return Buffer.concat([ustarHeader({ name: 'PaxHeader', prefix: '' }, record.byteLength, 'x', 0o444), record, padding, ustarHeader({ name: 'pax-path', prefix: '' }, size, type, mode)])
}

function ustarHeader(split: { readonly name: string; readonly prefix: string }, size: number, type: '0' | '5' | 'x', mode: number): Buffer {
  const header = Buffer.alloc(BLOCK)
  writeText(header, 0, 100, split.name); writeOctal(header, 100, 8, mode); writeOctal(header, 108, 8, 10_001); writeOctal(header, 116, 8, 10_001)
  writeOctal(header, 124, 12, size); writeOctal(header, 136, 12, 0); header.fill(0x20, 148, 156); header[156] = type.charCodeAt(0)
  writeText(header, 257, 6, 'ustar'); writeText(header, 263, 2, '00'); writeText(header, 345, 155, split.prefix); writeOctal(header, 148, 8, header.reduce((sum, byte) => sum + byte, 0)); return header
}

/**
 * Um registro PAX: `<tamanho> <chave>=<valor>\n`, onde o tamanho conta os
 * próprios dígitos — por isso o laço até o número parar de mudar.
 * @param key - a chave.
 * @param value - o valor.
 * @returns o registro.
 */
export function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`
  let length = Buffer.byteLength(body)
  for (;;) { const total = Buffer.byteLength(body) + String(length).length; if (total === length) break; length = total }
  return `${String(length)}${body}`
}

/**
 * O caminho de um cabeçalho PAX — e NADA além dele.
 *
 * Só `path` muda a entrada seguinte; os tempos são aceitos e ignorados, porque
 * o conteúdo é conferido por hash e não por data. Qualquer outra chave (dono,
 * tamanho, link) recusa: ela mudaria o que a entrada É sem passar pelas
 * conferências do cabeçalho comum.
 * @param content - o corpo do cabeçalho PAX.
 * @returns o caminho.
 */
export function paxRecordPath(content: Buffer): string {
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(content) } catch { return invalid() }
  let path: string | undefined; let at = 0
  while (at < text.length) {
    const space = text.indexOf(' ', at); if (space <= at) invalid()
    const lengthText = text.slice(at, space); if (!/^[1-9][0-9]*$/u.test(lengthText)) invalid()
    const recordBytes = Number(lengthText)
    const record = Buffer.from(text.slice(at)).subarray(0, recordBytes).toString('utf8')
    if (Buffer.byteLength(record) !== recordBytes || !record.endsWith('\n')) invalid()
    const pair = record.slice(space - at + 1, -1); const equals = pair.indexOf('='); if (equals <= 0) invalid()
    const key = pair.slice(0, equals); const value = pair.slice(equals + 1)
    if (key === 'path') { if (path !== undefined || value === '' || Buffer.byteLength(value) > MAX_TAR_PATH_BYTES) invalid(); path = value }
    else if (!PAX_TEMPO.has(key)) invalid()
    at += record.length
  }
  if (path === undefined) invalid()
  return path
}

function trySplitTarPath(value: string): { readonly name: string; readonly prefix: string } | undefined {
  if (Buffer.byteLength(value) <= 100) return { name: value, prefix: '' }
  for (let at = value.lastIndexOf('/'); at > 0; at = value.lastIndexOf('/', at - 1)) { const prefix = value.slice(0, at); const name = value.slice(at + 1); if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix } }
  return undefined
}

function writeText(target: Buffer, offset: number, _length: number, value: string): void { Buffer.from(value, 'utf8').copy(target, offset) }
function writeOctal(target: Buffer, offset: number, length: number, value: number): void { writeText(target, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`) }
function verifyChecksum(header: Buffer): void { const expected = parseOctal(header.subarray(148, 156)); const copy = Buffer.from(header); copy.fill(0x20, 148, 156); if (copy.reduce((sum, byte) => sum + byte, 0) !== expected) invalid() }
function parseOctal(value: Buffer): number { const text = cstring(value).trim(); if (!/^[0-7]+$/u.test(text)) invalid(); return Number.parseInt(text, 8) }
function cstring(value: Buffer): string { const zero = value.indexOf(0); const raw = value.subarray(0, zero < 0 ? value.length : zero); try { return new TextDecoder('utf-8', { fatal: true }).decode(raw) } catch { return invalid() } }
function normalizeTarPath(value: string): string { const result = value.replace(/^\.\//u, '').replace(/\/$/u, ''); if (result === '' || result.startsWith('/') || result.includes('\\') || result.includes('\0') || result.split('/').some(part => part === '' || part === '.' || part === '..')) invalid(); return result }
async function readExact(handle: Pick<FileHandle, 'read'>, offset: number, length: number): Promise<Buffer> { const value = Buffer.alloc(length); let readTotal = 0; while (readTotal < length) { const read = await handle.read(value, readTotal, length - readTotal, offset + readTotal); if (read.bytesRead === 0) invalid(); readTotal += read.bytesRead } return value }
export async function streamTemplateStoreFile(handle: Pick<FileHandle, 'read'>, size: number, signal: AbortSignal, consume?: (value: Buffer) => Promise<void>): Promise<{ readonly bytes: number; readonly sha256: string }> {
  const hash = createHash('sha256'); let offset = 0; const chunk = Buffer.allocUnsafe(64 * 1024)
  while (offset < size) {
    assertNotAborted(signal)
    const read = await handle.read(chunk, 0, Math.min(chunk.byteLength, size - offset), offset)
    if (read.bytesRead === 0) mismatch()
    const value = Buffer.from(chunk.subarray(0, read.bytesRead)); hash.update(value); await consume?.(value); offset += read.bytesRead
  }
  return { bytes: offset, sha256: hash.digest('hex') }
}
export async function writeTemplateStoreBytes(handle: Pick<FileHandle, 'write'>, value: Buffer): Promise<number> { let offset = 0; while (offset < value.byteLength) { const written = await handle.write(value, offset, value.byteLength - offset); if (written.bytesWritten === 0) invalid(); offset += written.bytesWritten } return offset }
export function validateTemplateStoreEntryCount(count: number): void { try { checkedTemplateStoreEntryCount(count) } catch { invalid() } }
function compareEntries(left: TemplateManifestEntry, right: TemplateManifestEntry): number { return Buffer.from(left.path).compare(Buffer.from(right.path)) }
function emptyArchive(entries: readonly TemplateManifestEntry[], marker: Buffer | undefined): boolean { return entries.length === 0 && marker === undefined }
function record(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function identifier(value: unknown): string | undefined { const row = record(value); const id = row.Id ?? row.Name; return typeof id === 'string' && id !== '' ? id.replace(/^\//u, '') : undefined }
function noFollow(): number { return constants.O_NOFOLLOW }
function cleanupSignal(): AbortSignal { return AbortSignal.timeout(CLEANUP_TIMEOUT_MS) }
type CleanupOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false }
async function cleanupOutcome<T>(execution: Promise<T>): Promise<CleanupOutcome<T>> { try { return { ok: true, value: await execution } } catch { return { ok: false } } }
async function cleanupOrFail<T>(execution: Promise<T>): Promise<T> { const outcome = await cleanupOutcome(execution); if (!outcome.ok) return cleanupFailed(); return outcome.value }
function assertNotAborted(signal: AbortSignal): void { if (signal.aborted) throw new TemplateStoreVolumeError('TEMPLATE_STORE_ABORTED') }
function normalizeError(error: unknown): Error { if (error instanceof TemplateStoreVolumeError) return error; if (error instanceof DOMException && error.name === 'AbortError') return new TemplateStoreVolumeError('TEMPLATE_STORE_ABORTED'); return error instanceof Error ? error : new TemplateStoreVolumeError('TEMPLATE_STORE_INVALID') }
function invalid(): never { throw new TemplateStoreVolumeError('TEMPLATE_STORE_INVALID') }
function mismatch(): never { throw new TemplateStoreVolumeError('TEMPLATE_STORE_TARGET_MISMATCH') }
function busy(): never { throw new TemplateStoreVolumeError('TEMPLATE_STORE_BUSY') }
function cleanupFailed(): never { throw new TemplateStoreVolumeError('TEMPLATE_STORE_CLEANUP_INCOMPLETE') }
