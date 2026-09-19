import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants, type Stats } from 'node:fs'
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  statfs,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import { posix } from 'node:path'
import {
  PRODUCTION_BUILDER_ROOT_POLICY,
  loadBuilderSupervisorConfigEnvelope,
  validateBuilderSupervisorRootPolicy,
  type BuilderSupervisorRootPolicy,
} from './supervisor-config.js'
import {
  builderRuntimeSocketPath,
  deriveBuilderRuntimeScopeId,
  isInstallationId,
  type BuilderRuntimeScopeId,
} from './runtime-scope.js'
import {
  TEMPLATE_ENTRY_MAX_BYTES,
  TEMPLATE_MANIFEST_MAX_BYTES,
  TEMPLATE_STORE_MAX_BYTES,
  TEMPLATE_STORE_MAX_ENTRIES,
  assertSafeStoreStat,
  assertSourceIdentity,
  canonicalSignedTemplateStoreManifestBytes,
  canonicalSourceRoot,
  computeTemplateTreeSha256,
  imageDigestValue,
  isSafeStagingName,
  manifestReferencePath,
  parseTemplateStoreManifest,
  provisionIdentifier,
  sha256Value,
  templateEntryPath,
  type TemplateManifestEntry,
  type TemplateStoreManifest,
} from './store-security.js'
import { templateStoreUstarEntryPath } from './template-store-volume.js'

export type BuilderProvisionErrorCode =
  | 'ALREADY_PROVISIONED'
  | 'INVALID_PROVISION_REQUEST'
  | 'PROVISION_BUSY'
  | 'PROVISION_RECOVERY_FAILED'
  | 'SOURCE_CHANGED'
  | 'SOURCE_UNSAFE'
  | 'TARGET_MISMATCH'

export class BuilderProvisionError extends Error {
  constructor(readonly code: BuilderProvisionErrorCode) {
    super(code)
    this.name = 'BuilderProvisionError'
  }
}

export interface BuilderProvisionRequest {
  readonly installationId: string
  readonly tenantId: string
  readonly instanceId: string
  readonly sourceRoot: string
  readonly manifestReference: string
  readonly manifestSha256: string
  readonly imageDigest: string
  readonly policySha256: string
  readonly roots?: BuilderSupervisorRootPolicy
}

export interface BuilderProvisionResult {
  readonly state: 'CREATED'
  readonly scope_id: BuilderRuntimeScopeId
  readonly template_store_version: string
  readonly template_store_sha256: string
  readonly manifest_sha256: string
  readonly config_reference: string
  readonly config_sha256: string
}

interface ProvisionIdentity {
  readonly pid: number
  readonly boot_id: string
  readonly start_ticks: string
  readonly claim: string
}

interface ProvisionLock {
  readonly recoveredStaleOwner: boolean
  readonly completeRecovery: () => Promise<void>
  readonly release: () => Promise<void>
}

interface ProvenProvisionLock {
  readonly owner: ProvisionIdentity
  readonly stat: Stats
  readonly claimPath: string
  readonly takeoverPath?: string
}

interface RetiredProvisionLock {
  readonly owner: ProvisionIdentity
  readonly stat: Stats
  readonly claimPath?: string
  readonly takeoverPath?: string
  readonly grantsRecovery: boolean
}

export interface BuilderProvisionRuntime {
  readonly afterStaleLockProof?: (lockPath: string) => Promise<void>
  readonly beforeStaleLockPathUnlink?: (lockPath: string) => Promise<void>
  readonly afterStaleLockPathUnlink?: (lockPath: string) => Promise<void>
  readonly afterProvisionCoordinatorAcquired?: (phase: 'acquire' | 'cleanup' | 'release') => Promise<void>
  readonly afterProvisionGuardOpenMissing?: () => Promise<void>
  readonly beforeProvisionLockRelease?: (lockPath: string) => Promise<void>
  readonly afterTemplateStoreEntryCopied?: (entryPath: string) => Promise<void>
}

const DEFAULT_PROVISION_RUNTIME: BuilderProvisionRuntime = Object.freeze({})
const PROVISION_GUARD_NAME = '.provision.guard'
const PROVISION_FLOCK_PATH = '/usr/bin/flock'
const PROVISION_FLOCK_BUSY_EXIT = 200
const PROVISION_FLOCK_TIMEOUT_MS = 2_000
const PROVISION_FLOCK_STDERR_LIMIT = 4_096
const EXT4_SUPER_MAGIC = 0xef53
const XFS_SUPER_MAGIC = 0x58465342
const PROVISION_CLAIM = /^\.claim-[a-f0-9]{32}$/u
const PROVISION_TAKEOVER = /^\.takeover-[a-f0-9]{32}$/u
const PROVISION_ARTIFACT_LIMIT = 128

export async function provisionBuilderSupervisor(
  request: BuilderProvisionRequest,
  runtime: BuilderProvisionRuntime = DEFAULT_PROVISION_RUNTIME,
): Promise<BuilderProvisionResult> {
  try {
    if (process.platform !== 'linux' || process.getuid === undefined) invalidRequest()
    const roots = request.roots ?? PRODUCTION_BUILDER_ROOT_POLICY
    validateBuilderSupervisorRootPolicy(roots)
    const installationId = installationIdentifier(request.installationId)
    const tenantId = provisionIdentifier(request.tenantId)
    const instanceId = provisionIdentifier(request.instanceId)
    const scopeId = deriveBuilderRuntimeScopeId({ installationId, tenantId, instanceId })
    const scopePaths = {
      config: scopeInstancePath(roots.configRoot, scopeId),
      secret: scopeInstancePath(roots.secretRoot, scopeId),
      socket: scopeInstancePath(roots.socketRoot, scopeId),
      artifact: scopeInstancePath(roots.artifactRoot, scopeId),
      export: scopeInstancePath(roots.exportRoot, scopeId),
      state: scopeInstancePath(roots.stateRoot, scopeId),
    }
    const socketPath = builderRuntimeSocketPath(roots.socketRoot, scopeId)
    const sourceRoot = canonicalSourceRoot(request.sourceRoot)
    const manifestPath = manifestReferencePath(request.manifestReference)
    const expectedManifestSha256 = sha256Value(request.manifestSha256)
    const imageDigest = imageDigestValue(request.imageDigest)
    const policySha256 = sha256Value(request.policySha256)
    assertSourceOutsideManagedRoots(sourceRoot, manifestPath, roots)
    await Promise.all(managedRoots(roots).map(assertPrivateRoot))

    // Manifest compatibility and the entire source are proven before the first
    // managed path is created. An entry that cannot be encoded by the strict
    // USTAR materializer therefore fails without leaving provisioning effects.
    const manifest = await loadPinnedManifest(manifestPath, expectedManifestSha256)
    for (const entry of manifest.entries) templateStoreUstarEntryPath(entry.path)
    // A forma DE DISCO, com assinatura quando houver: senão um armazenamento
    // poderia perder a assinatura sem que o hash da autoridade mudasse.
    const canonicalManifestBytes = canonicalSignedTemplateStoreManifestBytes(manifest)
    const canonicalManifestSha256 = createHash('sha256').update(canonicalManifestBytes).digest('hex')
    const sourceEntries = await inspectSourceTree(sourceRoot)
    assertTreeMatchesManifest(sourceEntries, manifest.entries)

    const configPath = posix.join(scopePaths.config, 'supervisor.json')
    const authorityAlreadyPublished = await exists(configPath)
    const stateInstanceRoot = authorityAlreadyPublished
      ? await requireScopeInstance(roots.stateRoot, scopePaths.state)
      : await ensureScopeInstance(roots.stateRoot, scopePaths.state)
    const lock = await acquireProvisionLock(stateInstanceRoot, runtime)
    try {
      if (await exists(configPath)) {
        const configDirectory = await requireScopeInstance(roots.configRoot, scopePaths.config)
        const secretDirectory = await requireScopeInstance(roots.secretRoot, scopePaths.secret)
        await recoverAuthorityLinkTemps(configDirectory, secretDirectory, true)
        const authority = {
          roots, installationId, tenantId, instanceId, scopeId, manifest,
          canonicalManifestSha256, imageDigest, policySha256, configPath,
        }
        // Authenticate the immutable target already named by this scope before
        // touching template-store. A request for another version therefore
        // cannot materialize that version and only then discover the conflict.
        await existingProvisionResult(authority)
        const templateStoreParent = await requirePrivateDirectory(posix.join(stateInstanceRoot, 'template-store'))
        const storePath = posix.join(templateStoreParent, manifest.template_store_version)
        if (!await exists(storePath)) mismatch()
        await recoverInterruptedStaging(templateStoreParent)
        await recoverInterruptedStoreTarget(storePath, manifest, lock.recoveredStaleOwner)
        await verifyPublishedStore(storePath, manifest)
        // Pin the result to a second authority read after store validation so a
        // cooperative reprovision never returns a stale pre-check envelope.
        const existing = await existingProvisionResult(authority)
        await lock.completeRecovery()
        return existing
      }
      const templateStoreParent = await ensurePrivateDirectory(posix.join(stateInstanceRoot, 'template-store'))
      await recoverInterruptedStaging(templateStoreParent)
      const storePath = posix.join(templateStoreParent, manifest.template_store_version)
      if (await exists(storePath)) {
        await recoverInterruptedStoreTarget(storePath, manifest, lock.recoveredStaleOwner)
      }
      await publishTemplateStore(sourceRoot, templateStoreParent, storePath, manifest, runtime)

      const configDirectory = await ensureScopeInstance(roots.configRoot, scopePaths.config)
      const secretDirectory = await ensureScopeInstance(roots.secretRoot, scopePaths.secret)
      await ensureScopeInstance(roots.socketRoot, scopePaths.socket)
      const artifactDirectory = await ensureScopeInstance(roots.artifactRoot, scopePaths.artifact)
      const exportDirectory = await ensureScopeInstance(roots.exportRoot, scopePaths.export)
      const journalDirectory = await ensurePrivateDirectory(posix.join(stateInstanceRoot, 'journal'))
      const replayDirectory = await ensurePrivateDirectory(posix.join(stateInstanceRoot, 'rpc-replay'))
      const configExists = await exists(configPath)
      await recoverAuthorityLinkTemps(configDirectory, secretDirectory, configExists)
      if (configExists) {
        const existing = await existingProvisionResult({
          roots, installationId, tenantId, instanceId, scopeId, manifest,
          canonicalManifestSha256, imageDigest, policySha256, configPath,
        })
        await lock.completeRecovery()
        return existing
      }
      await recoverPartialAuthority(configDirectory, secretDirectory)

      const token = randomBytes(32).toString('base64url')
      const tokenPath = posix.join(secretDirectory, 'token')
      const imagePath = posix.join(configDirectory, 'builder-image.sha256')
      const storeHashPath = posix.join(configDirectory, 'template-store.sha256')
      const manifestHashPath = posix.join(configDirectory, 'template-manifest.sha256')
      const canonicalManifestPath = posix.join(configDirectory, 'template-store.manifest.json')
      const policyPath = posix.join(configDirectory, 'policy.sha256')
      await writeAuthorityFile(tokenPath, `${token}\n`, 0o400)
      await writeAuthorityFile(imagePath, `${imageDigest}\n`, 0o600)
      await writeAuthorityFile(storeHashPath, `${manifest.tree_sha256}\n`, 0o600)
      await writeAuthorityFile(manifestHashPath, `${canonicalManifestSha256}\n`, 0o600)
      await writeAuthorityFile(canonicalManifestPath, canonicalManifestBytes, 0o600)
      await writeAuthorityFile(policyPath, `${policySha256}\n`, 0o600)
      const config = {
        version: 2,
        installation_id: installationId,
        tenant_id: tenantId,
        instance_id: instanceId,
        socket_path: socketPath,
        artifact_root: artifactDirectory,
        export_root: exportDirectory,
        journal_root: journalDirectory,
        replay_root: replayDirectory,
        docker_socket_path: roots.dockerSocketPath,
        bearer_token_ref: `file:${tokenPath}`,
        image_digest_ref: `file:${imagePath}`,
        template_store_version: manifest.template_store_version,
        template_store_sha256_ref: `file:${storeHashPath}`,
        template_store_manifest_ref: `file:${canonicalManifestPath}`,
        policy_sha256_ref: `file:${policyPath}`,
      }
      await writeAuthorityFile(configPath, `${JSON.stringify(config)}\n`, 0o600)
      await syncDirectory(configDirectory)
      await syncDirectory(secretDirectory)
      const created = await existingProvisionResult({
        roots, installationId, tenantId, instanceId, scopeId, manifest,
        canonicalManifestSha256, imageDigest, policySha256, configPath,
      })
      await lock.completeRecovery()
      return created
    } finally {
      await lock.release()
    }
  } catch (error) {
    if (error instanceof BuilderProvisionError) throw error
    throw new BuilderProvisionError('INVALID_PROVISION_REQUEST')
  }
}

interface ExistingProvisionInput {
  readonly roots: BuilderSupervisorRootPolicy
  readonly installationId: string
  readonly tenantId: string
  readonly instanceId: string
  readonly scopeId: BuilderRuntimeScopeId
  readonly manifest: TemplateStoreManifest
  readonly canonicalManifestSha256: string
  readonly imageDigest: `sha256:${string}`
  readonly policySha256: string
  readonly configPath: string
}

async function existingProvisionResult(input: ExistingProvisionInput): Promise<BuilderProvisionResult> {
  try {
    const loaded = await loadBuilderSupervisorConfigEnvelope(`file:${input.configPath}`, input.roots)
    const config = loaded.config
    if (config.installationId !== input.installationId || config.tenantId !== input.tenantId || config.instanceId !== input.instanceId ||
      config.scopeId !== input.scopeId || config.imageDigest !== input.imageDigest || config.policySha256 !== input.policySha256 ||
      config.templateStoreVersion !== input.manifest.template_store_version || config.templateStoreSha256 !== input.manifest.tree_sha256 ||
      config.templateStoreManifest === undefined || !canonicalSignedTemplateStoreManifestBytes(config.templateStoreManifest).equals(canonicalSignedTemplateStoreManifestBytes(input.manifest))) mismatch()
    await verifyAuthoritySha256(posix.join(posix.dirname(input.configPath), 'template-manifest.sha256'), input.canonicalManifestSha256)
    return {
      state: 'CREATED', scope_id: input.scopeId,
      template_store_version: input.manifest.template_store_version,
      template_store_sha256: input.manifest.tree_sha256,
      manifest_sha256: input.canonicalManifestSha256,
      config_reference: `file:${input.configPath}`,
      config_sha256: loaded.envelopeSha256,
    }
  } catch (error) {
    if (error instanceof BuilderProvisionError) throw error
    return mismatch()
  }
}

async function verifyAuthoritySha256(path: string, expected: string): Promise<void> {
  let handle: FileHandle | undefined
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = await handle.stat(); const linked = await lstat(path)
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1 || (opened.mode & 0o7777) !== 0o600 || !trustedOwner(opened) ||
      !sameIdentity(opened, linked) || await realpath(path) !== path || opened.size !== 65 || await handle.readFile('utf8') !== `${expected}\n`) mismatch()
  } finally { await handle?.close() }
}

async function loadPinnedManifest(path: string, expectedSha256: string): Promise<TemplateStoreManifest> {
  let handle: FileHandle | undefined
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = await handle.stat()
    const linked = await lstat(path)
    assertSourceIdentity(before, linked, 'file')
    if (before.size < 2 || before.size > TEMPLATE_MANIFEST_MAX_BYTES || await realpath(path) !== path) unsafeSource()
    const raw = await readPinnedBytes(handle, before.size)
    const after = await handle.stat()
    if (!sameIdentity(before, after) || createHash('sha256').update(raw).digest('hex') !== expectedSha256) sourceChanged()
    return parseTemplateStoreManifest(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(raw)) as unknown)
  } catch (error) {
    if (error instanceof BuilderProvisionError) throw error
    return unsafeSource()
  } finally {
    await handle?.close()
  }
}

async function readPinnedBytes(handle: FileHandle, expectedBytes: number): Promise<Buffer> {
  const buffer = Buffer.alloc(expectedBytes + 1)
  let position = 0
  while (position < buffer.length) {
    const { bytesRead } = await handle.read(buffer, position, buffer.length - position, position)
    if (bytesRead === 0) break
    position += bytesRead
  }
  if (position !== expectedBytes) sourceChanged()
  return buffer.subarray(0, position)
}

/**
 * As entradas de um store, do jeito que o PROVISIONAMENTO as confere.
 *
 * Exportada para o instalador gerar o manifesto com ESTE percurso, e não com um
 * segundo. `assertTreeMatchesManifest` compara o manifesto com o que este
 * percurso devolve; um instalador que andasse a árvore do jeito dele
 * produziria um manifesto certo até o primeiro caso de borda em que os dois
 * discordassem — nome com caixa diferente, arquivo com dois links, limite de
 * entradas — e aí o provisionamento recusaria o que o instalador acabou de
 * gerar.
 * @param root - a raiz do store.
 * @returns as entradas, na ordem do percurso.
 */
export async function inspectTemplateStoreSourceTree(root: string): Promise<TemplateManifestEntry[]> {
  return inspectSourceTree(root)
}

async function inspectSourceTree(root: string): Promise<TemplateManifestEntry[]> {
  try { return await inspectSourceTreeUnchecked(root) }
  catch (error) {
    if (error instanceof BuilderProvisionError) throw error
    return unsafeSource()
  }
}

async function inspectSourceTreeUnchecked(root: string): Promise<TemplateManifestEntry[]> {
  const rootStat = await lstat(root)
  assertSafeStoreStat(rootStat, 'directory', false)
  if (await realpath(root) !== root || !trustedOwner(rootStat) || (rootStat.mode & 0o022) !== 0) unsafeSource()
  const entries: TemplateManifestEntry[] = []
  const foldedPaths = new Set<string>()
  let totalBytes = 0
  const visit = async (relative: string): Promise<void> => {
    const directory = relative === '' ? root : posix.join(root, relative)
    const names = (await readdir(directory)).sort((a, b) => Buffer.from(a).compare(Buffer.from(b)))
    for (const name of names) {
      if (name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) unsafeSource()
      const entryPath = relative === '' ? name : posix.join(relative, name)
      templateEntryPath(entryPath)
      const folded = entryPath.toLowerCase()
      if (foldedPaths.has(folded) || entries.length >= TEMPLATE_STORE_MAX_ENTRIES) unsafeSource()
      foldedPaths.add(folded)
      const absolute = posix.join(root, entryPath)
      const stat = await lstat(absolute)
      if (stat.isSymbolicLink() || await realpath(absolute) !== absolute) unsafeSource()
      if (stat.isDirectory()) {
        entries.push({ path: entryPath, type: 'directory' })
        await visit(entryPath)
      } else if (stat.isFile() && stat.nlink === 1 && stat.size <= TEMPLATE_ENTRY_MAX_BYTES) {
        totalBytes += stat.size
        if (!Number.isSafeInteger(totalBytes) || totalBytes > TEMPLATE_STORE_MAX_BYTES) unsafeSource()
        entries.push({ path: entryPath, type: 'file', bytes: stat.size, sha256: await hashSecureSourceFile(absolute, stat) })
      } else unsafeSource()
    }
  }
  await visit('')
  return entries
}

async function hashSecureSourceFile(path: string, expected: Stats): Promise<string> {
  let handle: FileHandle | undefined
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = await handle.stat()
    assertSourceIdentity(before, expected, 'file')
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let position = 0
    while (position < before.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - position), position)
      if (bytesRead === 0) sourceChanged()
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    const after = await handle.stat()
    const linked = await lstat(path)
    if (!sameIdentity(before, after) || !sameIdentity(before, linked) || await realpath(path) !== path) sourceChanged()
    return hash.digest('hex')
  } finally { await handle?.close() }
}

async function publishTemplateStore(
  sourceRoot: string,
  parent: string,
  target: string,
  manifest: TemplateStoreManifest,
  runtime: BuilderProvisionRuntime,
): Promise<void> {
  const staging = posix.join(parent, `.staging-${randomBytes(16).toString('hex')}`)
  let targetClaimed = false
  try {
    try {
      await mkdir(target, { mode: 0o700 })
      targetClaimed = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await verifyPublishedStore(target, manifest)
      return
    }
    await mkdir(staging, { mode: 0o700 })
    for (const entry of manifest.entries) {
      const destination = posix.join(staging, entry.path)
      if (entry.type === 'directory') await mkdir(destination, { mode: 0o700 })
      else await copyPinnedFile(posix.join(sourceRoot, entry.path), destination, entry)
      await runtime.afterTemplateStoreEntryCopied?.(entry.path)
    }
    const after = await inspectSourceTree(sourceRoot)
    assertTreeMatchesManifest(after, manifest.entries)
    const tree = posix.join(target, 'tree')
    await rename(staging, tree)
    await sealStore(tree, manifest.entries)
    await verifyStoreTree(tree, manifest)
    await writeCompletionMarker(posix.join(target, '.complete'), manifest.tree_sha256)
    await syncDirectory(target)
    await chmod(target, 0o555)
    await syncDirectory(target)
    await syncDirectory(parent)
    await verifyPublishedStore(target, manifest)
  } catch (error) {
    if (await exists(staging)) {
      await makeStagingRemovable(staging)
      await rm(staging, { recursive: true, force: true })
    }
    if (targetClaimed && await exists(target)) {
      await makeStagingRemovable(target)
      await rm(target, { recursive: true, force: true })
      await syncDirectory(parent)
    }
    throw error
  }
}

async function copyPinnedFile(source: string, destination: string, entry: Extract<TemplateManifestEntry, { type: 'file' }>): Promise<void> {
  let input: FileHandle | undefined
  let output: FileHandle | undefined
  try {
    const linkedBefore = await lstat(source)
    input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
    const openedBefore = await input.stat()
    assertSourceIdentity(openedBefore, linkedBefore, 'file')
    if (openedBefore.size !== entry.bytes) sourceChanged()
    output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let position = 0
    while (position < entry.bytes) {
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, entry.bytes - position), position)
      if (bytesRead === 0) sourceChanged()
      const chunk = buffer.subarray(0, bytesRead)
      hash.update(chunk)
      let written = 0
      while (written < chunk.length) {
        const result = await output.write(chunk, written, chunk.length - written, position + written)
        if (result.bytesWritten === 0) sourceChanged()
        written += result.bytesWritten
      }
      position += bytesRead
    }
    await output.chmod(0o444)
    await output.sync()
    const openedAfter = await input.stat()
    const linkedAfter = await lstat(source)
    if (!sameIdentity(openedBefore, openedAfter) || !sameIdentity(openedBefore, linkedAfter) || await realpath(source) !== source || hash.digest('hex') !== entry.sha256) sourceChanged()
  } finally {
    await output?.close()
    await input?.close()
  }
}

async function sealStore(root: string, entries: readonly TemplateManifestEntry[]): Promise<void> {
  const directories = entries.filter((entry): entry is Extract<TemplateManifestEntry, { type: 'directory' }> => entry.type === 'directory')
    .sort((left, right) => right.path.split('/').length - left.path.split('/').length)
  for (const entry of directories) {
    const path = posix.join(root, entry.path)
    await chmod(path, 0o555)
    await syncDirectory(path)
  }
  await chmod(root, 0o555)
  await syncDirectory(root)
}

async function verifyPublishedStore(root: string, manifest: TemplateStoreManifest): Promise<void> {
  try {
    const rootStat = await lstat(root)
    assertSafeStoreStat(rootStat, 'directory', true)
    if (await realpath(root) !== root) mismatch()
    await verifyStoreEnvelope(root, manifest)
  } catch { return mismatch() }
}

async function verifyStoreEnvelope(root: string, manifest: TemplateStoreManifest): Promise<void> {
  const names = await readBoundedNames(root, 2)
  if (names.length !== 2 || !names.includes('.complete') || !names.includes('tree')) mismatch()
  const marker = posix.join(root, '.complete')
  const markerStat = await lstat(marker)
  assertSafeStoreStat(markerStat, 'file', true)
  if (markerStat.size !== 65 || await realpath(marker) !== marker || (await readFile(marker, 'utf8')) !== `${manifest.tree_sha256}\n`) mismatch()
  await verifyStoreTree(posix.join(root, 'tree'), manifest)
}

async function verifyStoreTree(root: string, manifest: TemplateStoreManifest): Promise<void> {
  try {
    const rootStat = await lstat(root)
    assertSafeStoreStat(rootStat, 'directory', true)
    if (await realpath(root) !== root) mismatch()
    const actual = await inspectReadonlyTree(root, manifest.entries)
    if (!treesEqual(actual, manifest.entries)) mismatch()
    if (computeTemplateTreeSha256(manifest.template_store_version, actual) !== manifest.tree_sha256) mismatch()
  } catch { return mismatch() }
}

async function inspectReadonlyTree(root: string, expectedEntries: readonly TemplateManifestEntry[]): Promise<TemplateManifestEntry[]> {
  const entries: TemplateManifestEntry[] = []
  const expected = new Map(expectedEntries.map(entry => [entry.path, entry]))
  const foldedPaths = new Set<string>()
  let totalBytes = 0
  const visit = async (relative: string): Promise<void> => {
    const directory = relative === '' ? root : posix.join(root, relative)
    const handle = await opendir(directory)
    for await (const item of handle) {
      const name = item.name
      const entryPath = relative === '' ? name : posix.join(relative, name)
      templateEntryPath(entryPath)
      const folded = entryPath.toLowerCase()
      if (foldedPaths.has(folded) || entries.length >= TEMPLATE_STORE_MAX_ENTRIES) mismatch()
      foldedPaths.add(folded)
      const expectedEntry = expected.get(entryPath)
      if (expectedEntry === undefined) mismatch()
      const absolute = posix.join(root, entryPath)
      const stat = await lstat(absolute)
      if (stat.isDirectory()) {
        if (expectedEntry.type !== 'directory') mismatch()
        assertSafeStoreStat(stat, 'directory', true)
        entries.push({ path: entryPath, type: 'directory' })
        await visit(entryPath)
      } else {
        if (expectedEntry.type !== 'file' || stat.size !== expectedEntry.bytes || stat.size > TEMPLATE_ENTRY_MAX_BYTES) mismatch()
        totalBytes += stat.size
        if (!Number.isSafeInteger(totalBytes) || totalBytes > TEMPLATE_STORE_MAX_BYTES) mismatch()
        assertSafeStoreStat(stat, 'file', true)
        entries.push({ path: entryPath, type: 'file', bytes: stat.size, sha256: await hashSecureSourceFile(absolute, stat) })
      }
    }
  }
  await visit('')
  if (entries.length !== expectedEntries.length) mismatch()
  return entries
}

async function writeCompletionMarker(path: string, treeSha256: string): Promise<void> {
  let handle: FileHandle | undefined
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400)
    await handle.writeFile(`${treeSha256}\n`, 'utf8')
    await handle.chmod(0o444)
    await handle.sync()
  } finally { await handle?.close() }
}

function assertTreeMatchesManifest(actual: readonly TemplateManifestEntry[], expected: readonly TemplateManifestEntry[]): void {
  if (!treesEqual(actual, expected)) sourceChanged()
}

function treesEqual(left: readonly TemplateManifestEntry[], right: readonly TemplateManifestEntry[]): boolean {
  const normalize = (entries: readonly TemplateManifestEntry[]) => JSON.stringify([...entries].sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path))))
  return normalize(left) === normalize(right)
}

async function recoverInterruptedStaging(parent: string): Promise<void> {
  for (const name of await readdir(parent)) {
    if (!name.startsWith('.staging-') && !name.startsWith('.orphan-')) continue
    if (!isSafeStagingName(name)) recoveryFailed()
    const path = posix.join(parent, name)
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) recoveryFailed()
    await makeStagingRemovable(path)
    await rm(path, { recursive: true })
  }
  await syncDirectory(parent)
}

async function recoverInterruptedStoreTarget(target: string, manifest: TemplateStoreManifest, recoveredStaleOwner: boolean): Promise<void> {
  const stat = await lstat(target)
  if (!stat.isDirectory() || stat.isSymbolicLink() || !trustedOwner(stat) || await realpath(target) !== target) mismatch()
  if ((stat.mode & 0o7777) === 0o555) return
  if ((stat.mode & 0o7777) !== 0o700) mismatch()
  if (!recoveredStaleOwner) mismatch()
  const names = await readBoundedNames(target, 2)
  if (names.some(name => name !== 'tree' && name !== '.complete')) mismatch()
  if (names.includes('.complete')) {
    await verifyStoreEnvelope(target, manifest)
    await chmod(target, 0o555)
    await syncDirectory(target)
    await syncDirectory(posix.dirname(target))
    return
  }
  await makeStagingRemovable(target)
  await rm(target, { recursive: true })
  await syncDirectory(posix.dirname(target))
}

async function readBoundedNames(directory: string, maximum: number): Promise<string[]> {
  const names: string[] = []
  const handle = await opendir(directory)
  for await (const item of handle) {
    if (names.length >= maximum) mismatch()
    names.push(item.name)
  }
  return names
}

async function makeStagingRemovable(root: string): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    const names = await readdir(directory)
    for (const name of names) {
      const path = posix.join(directory, name)
      const stat = await lstat(path)
      if (stat.isSymbolicLink()) recoveryFailed()
      if (stat.isDirectory()) {
        await chmod(path, 0o700)
        await visit(path)
      } else if (stat.isFile() && stat.nlink === 1) await chmod(path, 0o600)
      else recoveryFailed()
    }
  }
  await chmod(root, 0o700)
  await visit(root)
}

async function recoverPartialAuthority(configDirectory: string, secretDirectory: string): Promise<void> {
  const paths = [
    posix.join(secretDirectory, 'token'),
    ...['builder-image.sha256', 'template-store.sha256', 'template-manifest.sha256', 'template-store.manifest.json', 'policy.sha256'].map(name => posix.join(configDirectory, name)),
  ]
  for (const path of paths) {
    if (!await exists(path)) continue
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !trustedOwner(stat) || await realpath(path) !== path) recoveryFailed()
    await unlink(path)
  }
}

async function recoverAuthorityLinkTemps(configDirectory: string, secretDirectory: string, preserveTargets: boolean): Promise<void> {
  const configTargets = ['supervisor.json', 'builder-image.sha256', 'template-store.sha256', 'template-manifest.sha256', 'template-store.manifest.json', 'policy.sha256'].map(name => posix.join(configDirectory, name))
  await recoverDirectoryLinkTemps(configDirectory, configTargets, preserveTargets)
  await recoverDirectoryLinkTemps(secretDirectory, [posix.join(secretDirectory, 'token')], preserveTargets)
}

async function recoverDirectoryLinkTemps(directory: string, targets: readonly string[], preserveTargets: boolean): Promise<void> {
  for (const name of await readdir(directory)) {
    if (!name.startsWith('.staging-')) continue
    if (!isSafeStagingName(name)) recoveryFailed()
    const staging = posix.join(directory, name)
    const stat = await lstat(staging)
    if (!stat.isFile() || stat.isSymbolicLink() || !trustedOwner(stat) || await realpath(staging) !== staging) recoveryFailed()
    if (stat.nlink === 1) { await unlink(staging); continue }
    if (stat.nlink !== 2) recoveryFailed()
    let target: string | undefined
    for (const candidate of targets) {
      if (!await exists(candidate)) continue
      const candidateStat = await lstat(candidate)
      if (sameIdentity(stat, candidateStat)) { target = candidate; break }
    }
    if (target === undefined) recoveryFailed()
    await unlink(staging)
    if (!preserveTargets) await unlink(target)
  }
}

async function writeAuthorityFile(path: string, value: string | Uint8Array, mode: 0o400 | 0o600): Promise<void> {
  const directory = posix.dirname(path)
  const staging = posix.join(directory, `.staging-${randomBytes(16).toString('hex')}`)
  let handle: FileHandle | undefined
  try {
    handle = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
    await handle.writeFile(value, 'utf8')
    await handle.chmod(mode)
    await handle.sync()
    await handle.close(); handle = undefined
    if (await exists(path)) throw new BuilderProvisionError('ALREADY_PROVISIONED')
    try { await link(staging, path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new BuilderProvisionError('ALREADY_PROVISIONED')
      throw error
    }
    await unlink(staging)
    await syncDirectory(directory)
  } finally {
    await handle?.close()
    await unlink(staging).catch(() => undefined)
  }
}

async function acquireProvisionLock(instanceRoot: string, runtime: BuilderProvisionRuntime): Promise<ProvisionLock> {
  return withProvisionCoordinator(instanceRoot, runtime, 'acquire', async () => {
    const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
    const startTicks = await processStartTicks(process.pid)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const suffix = randomBytes(16).toString('hex')
      const claimName = `.claim-${suffix}`
      const claimPath = posix.join(instanceRoot, claimName)
      const lockPath = posix.join(instanceRoot, '.provision.lock')
      const identity: ProvisionIdentity = { pid: process.pid, boot_id: bootId, start_ticks: startTicks, claim: claimName }
      let handle: FileHandle | undefined
      let claimed: Stats | undefined
      let acquired = false
      try {
        handle = await open(claimPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400)
        await handle.writeFile(`${JSON.stringify(identity)}\n`, 'utf8')
        await handle.chmod(0o400)
        await handle.sync()
        claimed = await handle.stat()
        await handle.close(); handle = undefined
        await syncDirectory(instanceRoot)
        try { await link(claimPath, lockPath) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          const inspected = await inspectProvisionLock(lockPath, bootId)
          if (inspected.live) throw new BuilderProvisionError('PROVISION_BUSY')
          await runtime.afterStaleLockProof?.(lockPath)
          if (!await retireStaleLock(lockPath, inspected.proof, runtime)) continue
          continue
        }
        await syncDirectory(instanceRoot)
        const [claim, lock] = await Promise.all([lstat(claimPath), lstat(lockPath)])
        if (!sameLockMetadata(claimed, claim, 2) || !sameLockMetadata(claimed, lock, 2)) recoveryFailed()
        const current = { owner: identity, stat: lock, claimPath }
        const retired = await collectRetiredProvisionLocks(instanceRoot, current, bootId)
        acquired = true
        let recoveryCompleted = false
        return {
          recoveredStaleOwner: retired.some(item => item.grantsRecovery),
          completeRecovery: async () => {
            if (recoveryCompleted) return
            await withProvisionCoordinator(instanceRoot, runtime, 'cleanup', async () => {
              await assertCurrentProvisionLock(lockPath, current)
              await cleanupRetiredProvisionLocks(instanceRoot, retired)
            })
            recoveryCompleted = true
          },
          release: async () => {
            await withProvisionCoordinator(instanceRoot, runtime, 'release', async () => {
              await runtime.beforeProvisionLockRelease?.(lockPath)
              await assertCurrentProvisionLock(lockPath, current)
              await unlink(lockPath)
              await syncDirectory(instanceRoot)
              if (!await removeProvenLink(claimPath, current.stat, 1)) recoveryFailed()
              await syncDirectory(instanceRoot)
            })
          },
        }
      } finally {
        await handle?.close()
        if (!acquired && claimed !== undefined) {
          const lock = await optionalLstat(lockPath)
          if (lock !== undefined && sameLockObject(claimed, lock)) {
            if (!await removeProvenLink(lockPath, claimed, 2)) recoveryFailed()
            await syncDirectory(instanceRoot)
          }
          const claim = await optionalLstat(claimPath)
          if (claim !== undefined && sameLockObject(claimed, claim)) {
            if (!await removeProvenLink(claimPath, claimed, 1)) recoveryFailed()
            await syncDirectory(instanceRoot)
          }
        }
      }
    }
    recoveryFailed()
  })
}

async function inspectProvisionLock(
  lockPath: string,
  bootId: string,
): Promise<{ readonly live: true } | { readonly live: false; readonly proof: ProvenProvisionLock }> {
  let handle: FileHandle | undefined
  try {
    handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = await handle.stat(); const linked = await lstat(lockPath)
    if (!opened.isFile() || opened.isSymbolicLink() || (opened.nlink !== 2 && opened.nlink !== 3) || (opened.mode & 0o7777) !== 0o400 || !trustedOwner(opened) || !sameIdentity(opened, linked) || opened.size < 2 || opened.size > 1024 || await realpath(lockPath) !== lockPath) recoveryFailed()
    const value = JSON.parse(await handle.readFile('utf8')) as unknown
    const owner = parseLockIdentity(value)
    const claimPath = posix.join(posix.dirname(lockPath), owner.claim)
    const claim = await lstat(claimPath)
    if (!sameLockMetadata(opened, claim, opened.nlink) || await realpath(claimPath) !== claimPath) recoveryFailed()
    const takeoverPath = opened.nlink === 3 ? await findBoundTakeoverPath(posix.dirname(lockPath), opened) : undefined
    const proof = { owner, stat: opened, claimPath, ...(takeoverPath === undefined ? {} : { takeoverPath }) }
    if (owner.boot_id !== bootId) return { live: false, proof }
    return await provisionIdentityLive(owner) ? { live: true } : { live: false, proof }
  } finally { await handle?.close() }
}

async function retireStaleLock(lockPath: string, proof: ProvenProvisionLock, runtime: BuilderProvisionRuntime): Promise<boolean> {
  let handle: FileHandle | undefined
  const takeoverPath = proof.takeoverPath ?? posix.join(posix.dirname(lockPath), `.takeover-${randomBytes(16).toString('hex')}`)
  let takeoverPresent = proof.takeoverPath !== undefined
  let lockPathUnlinked = false
  try {
    try { handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
    const opened = await handle.stat()
    const linked = await lstat(lockPath)
    const expectedLinks = takeoverPresent ? 3 : 2
    if (!sameLockMetadata(proof.stat, opened, expectedLinks) || !sameLockMetadata(proof.stat, linked, expectedLinks) || await realpath(lockPath) !== lockPath) return false
    const currentOwner = parseLockIdentity(JSON.parse(await handle.readFile('utf8')) as unknown)
    if (!sameProvisionIdentity(currentOwner, proof.owner)) return false
    if (!takeoverPresent) {
      await link(lockPath, takeoverPath)
      takeoverPresent = true
      await syncDirectory(posix.dirname(lockPath))
    }
    if (!await everyLockLinkMatches(proof.stat, [lockPath, proof.claimPath, takeoverPath], 3) || !sameLockMetadata(proof.stat, await handle.stat(), 3)) recoveryFailed()
    await runtime.beforeStaleLockPathUnlink?.(lockPath)
    if (!await everyLockLinkMatches(proof.stat, [lockPath, proof.claimPath, takeoverPath], 3) || !sameLockMetadata(proof.stat, await handle.stat(), 3)) recoveryFailed()
    await unlink(lockPath)
    lockPathUnlinked = true
    await syncDirectory(posix.dirname(lockPath))
    await runtime.afterStaleLockPathUnlink?.(lockPath)
    return true
  } finally {
    await handle?.close()
    if (takeoverPresent && !lockPathUnlinked) {
      const takeover = await optionalLstat(takeoverPath)
      if (takeover !== undefined && sameLockMetadata(proof.stat, takeover, 3)) {
        await unlink(takeoverPath)
        await syncDirectory(posix.dirname(lockPath))
      } else if (takeover !== undefined) recoveryFailed()
    }
  }
}

async function collectRetiredProvisionLocks(instanceRoot: string, current: ProvenProvisionLock, bootId: string): Promise<RetiredProvisionLock[]> {
  const names = (await readdir(instanceRoot)).filter(name => name.startsWith('.claim-') || name.startsWith('.takeover-'))
  if (names.length > PROVISION_ARTIFACT_LIMIT) recoveryFailed()
  const groups = new Map<string, Array<{ name: string; path: string; owner: ProvisionIdentity; stat: Stats }>>()
  for (const name of names) {
    if ((!PROVISION_CLAIM.test(name) && !PROVISION_TAKEOVER.test(name)) || name === posix.basename(current.claimPath)) {
      if (name === posix.basename(current.claimPath)) continue
      recoveryFailed()
    }
    const path = posix.join(instanceRoot, name)
    const inspected = await inspectProvisionArtifact(path)
    if (sameLockObject(current.stat, inspected.stat)) recoveryFailed()
    const key = `${inspected.stat.dev}:${inspected.stat.ino}`
    const group = groups.get(key) ?? []
    group.push({ name, path, ...inspected })
    groups.set(key, group)
  }
  const retired: RetiredProvisionLock[] = []
  for (const group of groups.values()) {
    const first = group[0]
    if (first === undefined || await provisionIdentityLive(first.owner, bootId)) throw new BuilderProvisionError('PROVISION_BUSY')
    if (group.some(item => !sameProvisionIdentity(item.owner, first.owner))) recoveryFailed()
    const claims = group.filter(item => PROVISION_CLAIM.test(item.name))
    const takeovers = group.filter(item => PROVISION_TAKEOVER.test(item.name))
    if (claims.length === 1 && takeovers.length === 1 && group.length === 2 && group.every(item => sameLockMetadata(first.stat, item.stat, 2)) && claims[0]!.name === first.owner.claim) {
      retired.push({ owner: first.owner, stat: first.stat, claimPath: claims[0]!.path, takeoverPath: takeovers[0]!.path, grantsRecovery: true })
      continue
    }
    if (group.length === 1 && first.stat.nlink === 1 && ((claims.length === 1 && first.name === first.owner.claim) || takeovers.length === 1)) {
      retired.push({ owner: first.owner, stat: first.stat, ...(claims.length === 1 ? { claimPath: first.path } : { takeoverPath: first.path }), grantsRecovery: false })
      continue
    }
    recoveryFailed()
  }
  return retired
}

async function inspectProvisionArtifact(path: string): Promise<{ owner: ProvisionIdentity; stat: Stats }> {
  let handle: FileHandle | undefined
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = await handle.stat()
    const linked = await lstat(path)
    if (!opened.isFile() || opened.isSymbolicLink() || (opened.nlink !== 1 && opened.nlink !== 2) || (opened.mode & 0o7777) !== 0o400 || !trustedOwner(opened) || opened.size < 2 || opened.size > 1024 || !sameIdentity(opened, linked) || await realpath(path) !== path) recoveryFailed()
    return { owner: parseLockIdentity(JSON.parse(await handle.readFile('utf8')) as unknown), stat: opened }
  } finally { await handle?.close() }
}

async function findBoundTakeoverPath(instanceRoot: string, expected: Stats): Promise<string> {
  const names = (await readdir(instanceRoot)).filter(name => name.startsWith('.takeover-'))
  if (names.length > PROVISION_ARTIFACT_LIMIT || names.some(name => !PROVISION_TAKEOVER.test(name))) recoveryFailed()
  const matches: string[] = []
  for (const name of names) {
    const path = posix.join(instanceRoot, name)
    const stat = await lstat(path)
    if (sameLockObject(expected, stat)) matches.push(path)
  }
  if (matches.length !== 1 || !sameLockMetadata(expected, await lstat(matches[0]!), 3) || await realpath(matches[0]!) !== matches[0]) recoveryFailed()
  return matches[0]!
}

async function cleanupRetiredProvisionLocks(instanceRoot: string, retired: readonly RetiredProvisionLock[]): Promise<void> {
  for (const item of retired) {
    if (item.takeoverPath !== undefined) {
      const links = item.claimPath === undefined ? 1 : 2
      if (!await removeProvenLink(item.takeoverPath, item.stat, links)) recoveryFailed()
      await syncDirectory(instanceRoot)
    }
    if (item.claimPath !== undefined) {
      if (!await removeProvenLink(item.claimPath, item.stat, 1)) recoveryFailed()
      await syncDirectory(instanceRoot)
    }
  }
}

async function assertCurrentProvisionLock(lockPath: string, current: ProvenProvisionLock): Promise<void> {
  const [claim, lock] = await Promise.all([lstat(current.claimPath), lstat(lockPath)])
  if (!sameLockMetadata(current.stat, claim, 2) || !sameLockMetadata(current.stat, lock, 2) || await realpath(lockPath) !== lockPath || await realpath(current.claimPath) !== current.claimPath) recoveryFailed()
}

async function provisionIdentityLive(owner: ProvisionIdentity, bootId = owner.boot_id): Promise<boolean> {
  if (owner.boot_id !== bootId) return false
  try { return await processStartTicks(owner.pid) === owner.start_ticks }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function withProvisionCoordinator<T>(
  instanceRoot: string,
  runtime: BuilderProvisionRuntime,
  phase: 'acquire' | 'cleanup' | 'release',
  operation: () => Promise<T>,
): Promise<T> {
  // This guard is only a crash-releasing local mutex. Filesystem witnesses and
  // process identities remain the authority. A process with the same UID can
  // replace paths inside instanceRoot and is therefore part of the local TCB.
  const guardPath = posix.join(instanceRoot, PROVISION_GUARD_NAME)
  let guard: FileHandle | undefined
  try {
    await assertProvisionGuardFilesystem(instanceRoot)
    await assertTrustedFlockBinary()
    const opened = await openProvisionGuard(guardPath, instanceRoot, runtime)
    guard = opened.handle
    await acquireProvisionGuard(guard)
    await assertProvisionGuardIdentity(guardPath, opened.identity, await guard.stat())
    await runtime.afterProvisionCoordinatorAcquired?.(phase)
    const result = await operation()
    await assertProvisionGuardIdentity(guardPath, opened.identity, await guard.stat())
    return result
  } catch (error) {
    if (error instanceof BuilderProvisionError) throw error
    return recoveryFailed()
  } finally {
    if (guard !== undefined) {
      try { await guard.close() } catch { recoveryFailed() }
    }
  }
}

async function openProvisionGuard(
  guardPath: string,
  instanceRoot: string,
  runtime: BuilderProvisionRuntime,
): Promise<{ readonly handle: FileHandle; readonly identity: Stats }> {
  let creator: FileHandle | undefined
  let handle: FileHandle | undefined
  try {
    try {
      handle = await open(guardPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await runtime.afterProvisionGuardOpenMissing?.()
      // Creation belongs to the installer/bootstrap boundary. Once any state
      // exists, disappearance of the permanent guard is corruption, not a cue
      // to recreate it at runtime. A valid guard may, however, have appeared
      // after this process observed ENOENT; that is the normal concurrent
      // bootstrap race and must be opened rather than treated as corruption.
      const entries = await readdir(instanceRoot)
      if (!entries.includes(PROVISION_GUARD_NAME)) {
        if (entries.length !== 0) recoveryFailed()
        try {
          creator = await open(guardPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        } catch (createError) {
          if ((createError as NodeJS.ErrnoException).code !== 'EEXIST') throw createError
        }
        if (creator !== undefined) {
          await creator.sync()
          await creator.close()
          creator = undefined
          await syncDirectory(instanceRoot)
        }
      }
      handle = await open(guardPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    }
    const identity = await handle.stat()
    await assertProvisionGuardIdentity(guardPath, identity, identity)
    return { handle, identity }
  } catch (error) {
    await closeIgnoringErrors(creator)
    await closeIgnoringErrors(handle)
    throw error
  }
}

async function assertProvisionGuardIdentity(path: string, expected: Stats, opened: Stats): Promise<void> {
  const linked = await lstat(path)
  if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1 || (opened.mode & 0o7777) !== 0o600 || !trustedOwner(opened) || !sameGuardIdentity(expected, opened) || !sameGuardIdentity(opened, linked) || await realpath(path) !== path) recoveryFailed()
}

async function assertProvisionGuardFilesystem(instanceRoot: string): Promise<void> {
  if (instanceRoot === '/mnt' || instanceRoot.startsWith('/mnt/')) recoveryFailed()
  const filesystem = await statfs(instanceRoot)
  if (filesystem.type !== EXT4_SUPER_MAGIC && filesystem.type !== XFS_SUPER_MAGIC) recoveryFailed()
}

async function assertTrustedFlockBinary(path = PROVISION_FLOCK_PATH): Promise<void> {
  let handle: FileHandle | undefined
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const [opened, linked] = await Promise.all([handle.stat(), lstat(path)])
    if (!opened.isFile() || opened.isSymbolicLink() || opened.uid !== 0 || opened.nlink !== 1 ||
      (opened.mode & 0o022) !== 0 || (opened.mode & 0o111) === 0 ||
      !sameGuardIdentity(opened, linked) || await realpath(path) !== path) recoveryFailed()
  } catch (error) {
    if (error instanceof BuilderProvisionError) throw error
    recoveryFailed()
  } finally { await handle?.close() }
}

async function acquireProvisionGuard(guard: FileHandle): Promise<void> {
  const outcome = await new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly failed: boolean }>((resolve) => {
    const child = spawn(PROVISION_FLOCK_PATH, ['--exclusive', '--nonblock', '--conflict-exit-code', String(PROVISION_FLOCK_BUSY_EXIT), '3'], {
      env: {}, shell: false, windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe', guard.fd],
    })
    let settled = false
    let stderrBytes = 0
    let failed = false
    const stderr = child.stderr
    if (stderr === null) return resolve({ code: null, signal: null, failed: true })
    let timer: NodeJS.Timeout
    let reapTimer: NodeJS.Timeout | undefined
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (reapTimer !== undefined) clearTimeout(reapTimer)
      resolve({ code, signal, failed })
    }
    const killAndBound = (): void => {
      if (failed) return
      failed = true
      if (!child.kill('SIGKILL')) return finish(null, null)
      reapTimer = setTimeout(finish.bind(null, null, 'SIGKILL'), 250)
      reapTimer.unref()
    }
    timer = setTimeout(killAndBound, PROVISION_FLOCK_TIMEOUT_MS)
    timer.unref()
    const consumeStderr = (chunk: Buffer): void => {
      stderrBytes = consumeProvisionFlockStderr(stderrBytes, chunk, killAndBound)
    }
    stderr.on('data', consumeStderr)
    child.once('error', finish.bind(null, null, null))
    child.once('exit', finish)
  })
  classifyProvisionFlockOutcome(outcome)
}

function consumeProvisionFlockStderr(currentBytes: number, chunk: Buffer, kill: () => void): number {
  const nextBytes = currentBytes + chunk.byteLength
  if (nextBytes > PROVISION_FLOCK_STDERR_LIMIT) kill()
  return nextBytes
}

function classifyProvisionFlockOutcome(outcome: {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly failed: boolean
}): void {
  if (!outcome.failed && outcome.code === 0 && outcome.signal === null) return
  if (!outcome.failed && outcome.code === PROVISION_FLOCK_BUSY_EXIT && outcome.signal === null) throw new BuilderProvisionError('PROVISION_BUSY')
  recoveryFailed()
}

export const STORE_PROVISION_GUARD_TEST_ONLY = Object.freeze({
  assertProvisionGuardFilesystem,
  assertTrustedFlockBinary,
  classifyProvisionFlockOutcome,
  consumeProvisionFlockStderr,
})

function sameGuardIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.gid === right.gid && left.mode === right.mode
}

async function closeIgnoringErrors(handle: FileHandle | undefined): Promise<void> {
  if (handle === undefined) return
  try { await handle.close() } catch { /* best-effort cleanup after a primary failure */ }
}

async function everyLockLinkMatches(expected: Stats, paths: readonly string[], links: number): Promise<boolean> {
  const stats = await Promise.all(paths.map(optionalLstat))
  return stats.every(stat => stat !== undefined && sameLockMetadata(expected, stat, links))
}

async function removeProvenLink(path: string, expected: Stats, links: number): Promise<boolean> {
  const stat = await optionalLstat(path)
  if (stat === undefined || !sameLockMetadata(expected, stat, links)) return false
  try { await unlink(path); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

async function optionalLstat(path: string): Promise<Stats | undefined> {
  try { return await lstat(path) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}

function sameProvisionIdentity(left: ProvisionIdentity, right: ProvisionIdentity): boolean {
  return left.pid === right.pid && left.boot_id === right.boot_id && left.start_ticks === right.start_ticks && left.claim === right.claim
}

function sameLockMetadata(expected: Stats, actual: Stats, links: number): boolean {
  return sameLockObject(expected, actual) && actual.nlink === links
}

function sameLockObject(expected: Stats, actual: Stats): boolean {
  return expected.dev === actual.dev && expected.ino === actual.ino && expected.size === actual.size &&
    expected.uid === actual.uid && expected.gid === actual.gid && expected.mode === actual.mode
}

function parseLockIdentity(value: unknown): ProvisionIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return recoveryFailed()
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join('\0') !== ['boot_id', 'claim', 'pid', 'start_ticks'].join('\0')) recoveryFailed()
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) < 1 || typeof record.boot_id !== 'string' || !/^[a-f0-9-]{36}$/u.test(record.boot_id) || typeof record.start_ticks !== 'string' || !/^[0-9]+$/u.test(record.start_ticks) || typeof record.claim !== 'string' || !/^\.claim-[a-f0-9]{32}$/u.test(record.claim)) recoveryFailed()
  return record as unknown as ProvisionIdentity
}

async function processStartTicks(pid: number): Promise<string> {
  const line = await readFile(`/proc/${pid}/stat`, 'utf8')
  const close = line.lastIndexOf(') ')
  const fields = close < 0 ? [] : line.slice(close + 2).trim().split(/\s+/u)
  const start = fields[19]
  if (start === undefined || !/^[0-9]+$/u.test(start)) recoveryFailed()
  return start
}

function scopeInstancePath(root: string, scopeId: BuilderRuntimeScopeId): string {
  return posix.join(root, 'instances', scopeId)
}

async function ensureScopeInstance(root: string, path: string): Promise<string> {
  const instances = await ensurePrivateDirectory(posix.join(root, 'instances'))
  if (!beneath(instances, path)) return invalidRequest()
  return ensurePrivateDirectory(path)
}

async function requireScopeInstance(root: string, path: string): Promise<string> {
  const instances = await requirePrivateDirectory(posix.join(root, 'instances'))
  if (!beneath(instances, path)) return invalidRequest()
  return requirePrivateDirectory(path)
}

function installationIdentifier(value: unknown): string {
  if (!isInstallationId(value)) return invalidRequest()
  return value
}

async function ensurePrivateDirectory(path: string): Promise<string> {
  await mkdir(path, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || !trustedOwner(stat) || (stat.mode & 0o777) !== 0o700 || await realpath(path) !== path) recoveryFailed()
  return path
}

async function requirePrivateDirectory(path: string): Promise<string> {
  try {
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !trustedOwner(stat) || (stat.mode & 0o777) !== 0o700 || await realpath(path) !== path) mismatch()
    return path
  } catch (error) {
    if (error instanceof BuilderProvisionError) throw error
    return mismatch()
  }
}

async function assertPrivateRoot(path: string): Promise<void> {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || !trustedOwner(stat) || (stat.mode & 0o022) !== 0 || await realpath(path) !== path) invalidRequest()
}

function assertSourceOutsideManagedRoots(sourceRoot: string, manifestPath: string, roots: BuilderSupervisorRootPolicy): void {
  for (const root of managedRoots(roots)) {
    if (beneath(root, sourceRoot) || beneath(sourceRoot, root) || beneath(root, manifestPath) || beneath(manifestPath, root)) invalidRequest()
  }
}

function managedRoots(roots: BuilderSupervisorRootPolicy): string[] {
  return [roots.configRoot, roots.secretRoot, roots.socketRoot, roots.artifactRoot, roots.exportRoot, roots.stateRoot]
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY)
  try { await handle.sync() } finally { await handle.close() }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

function trustedOwner(stat: Stats): boolean {
  const uid = process.getuid?.()
  return uid !== undefined && (stat.uid === 0 || stat.uid === uid)
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.nlink === right.nlink
}

function beneath(root: string, value: string): boolean { return value === root || value.startsWith(`${root}/`) }
function invalidRequest(): never { throw new BuilderProvisionError('INVALID_PROVISION_REQUEST') }
function unsafeSource(): never { throw new BuilderProvisionError('SOURCE_UNSAFE') }
function sourceChanged(): never { throw new BuilderProvisionError('SOURCE_CHANGED') }
function mismatch(): never { throw new BuilderProvisionError('TARGET_MISMATCH') }
function recoveryFailed(): never { throw new BuilderProvisionError('PROVISION_RECOVERY_FAILED') }
