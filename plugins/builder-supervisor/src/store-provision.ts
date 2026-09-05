import { createHash, randomBytes } from 'node:crypto'
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
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import { posix } from 'node:path'
import {
  PRODUCTION_BUILDER_ROOT_POLICY,
  validateBuilderSupervisorRootPolicy,
  type BuilderSupervisorRootPolicy,
} from './supervisor-config.js'
import {
  TEMPLATE_ENTRY_MAX_BYTES,
  TEMPLATE_MANIFEST_MAX_BYTES,
  TEMPLATE_STORE_MAX_BYTES,
  TEMPLATE_STORE_MAX_ENTRIES,
  assertSafeStoreStat,
  assertSourceIdentity,
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
  readonly tenant_id: string
  readonly instance_id: string
  readonly template_store_version: string
  readonly template_store_sha256: string
  readonly manifest_sha256: string
  readonly config_reference: string
}

interface ProvisionIdentity {
  readonly pid: number
  readonly boot_id: string
  readonly start_ticks: string
  readonly claim: string
}

interface ProvisionLock {
  readonly recoveredStaleOwner: boolean
  readonly release: () => Promise<void>
}

export async function provisionBuilderSupervisor(request: BuilderProvisionRequest): Promise<BuilderProvisionResult> {
  try {
    if (process.platform !== 'linux' || process.getuid === undefined) invalidRequest()
    const roots = request.roots ?? PRODUCTION_BUILDER_ROOT_POLICY
    validateBuilderSupervisorRootPolicy(roots)
    const tenantId = provisionIdentifier(request.tenantId)
    const instanceId = provisionIdentifier(request.instanceId)
    const sourceRoot = canonicalSourceRoot(request.sourceRoot)
    const manifestPath = manifestReferencePath(request.manifestReference)
    const expectedManifestSha256 = sha256Value(request.manifestSha256)
    const imageDigest = imageDigestValue(request.imageDigest)
    const policySha256 = sha256Value(request.policySha256)
    assertSourceOutsideManagedRoots(sourceRoot, manifestPath, roots)
    await Promise.all(managedRoots(roots).map(assertPrivateRoot))

    const stateInstanceRoot = await ensureTenantInstance(roots.stateRoot, tenantId, instanceId)
    const lock = await acquireProvisionLock(stateInstanceRoot)
    try {
      const manifest = await loadPinnedManifest(manifestPath, expectedManifestSha256)
      const sourceEntries = await inspectSourceTree(sourceRoot)
      assertTreeMatchesManifest(sourceEntries, manifest.entries)
      const templateStoreParent = await ensurePrivateDirectory(posix.join(stateInstanceRoot, 'template-store'))
      await recoverInterruptedStaging(templateStoreParent)
      const storePath = posix.join(templateStoreParent, manifest.template_store_version)
      if (await exists(storePath)) {
        await recoverInterruptedStoreTarget(storePath, manifest, lock.recoveredStaleOwner)
      }
      await publishTemplateStore(sourceRoot, templateStoreParent, storePath, manifest)

      const configDirectory = await ensureTenantInstance(roots.configRoot, tenantId, instanceId)
      const secretDirectory = await ensureTenantInstance(roots.secretRoot, tenantId, instanceId)
      await ensurePrivateDirectory(posix.join(roots.socketRoot, tenantId))
      await ensurePrivateDirectory(posix.join(roots.socketRoot, tenantId, instanceId))
      await ensurePrivateDirectory(posix.join(roots.artifactRoot, tenantId))
      await ensurePrivateDirectory(posix.join(roots.artifactRoot, tenantId, instanceId))
      await ensurePrivateDirectory(posix.join(roots.exportRoot, tenantId))
      await ensurePrivateDirectory(posix.join(roots.exportRoot, tenantId, instanceId))
      await ensurePrivateDirectory(posix.join(stateInstanceRoot, 'journal'))
      const configPath = posix.join(configDirectory, 'supervisor.json')
      const configExists = await exists(configPath)
      await recoverAuthorityLinkTemps(configDirectory, secretDirectory, configExists)
      if (configExists) throw new BuilderProvisionError('ALREADY_PROVISIONED')
      await recoverPartialAuthority(configDirectory, secretDirectory)

      const token = randomBytes(32).toString('base64url')
      const tokenPath = posix.join(secretDirectory, 'token')
      const imagePath = posix.join(configDirectory, 'builder-image.sha256')
      const storeHashPath = posix.join(configDirectory, 'template-store.sha256')
      const manifestHashPath = posix.join(configDirectory, 'template-manifest.sha256')
      const policyPath = posix.join(configDirectory, 'policy.sha256')
      await writeAuthorityFile(tokenPath, `${token}\n`, 0o400)
      await writeAuthorityFile(imagePath, `${imageDigest}\n`, 0o600)
      await writeAuthorityFile(storeHashPath, `${manifest.tree_sha256}\n`, 0o600)
      await writeAuthorityFile(manifestHashPath, `${expectedManifestSha256}\n`, 0o600)
      await writeAuthorityFile(policyPath, `${policySha256}\n`, 0o600)
      const config = {
        version: 1,
        tenant_id: tenantId,
        instance_id: instanceId,
        socket_path: posix.join(roots.socketRoot, tenantId, instanceId, 'builder.sock'),
        artifact_root: posix.join(roots.artifactRoot, tenantId, instanceId),
        export_root: posix.join(roots.exportRoot, tenantId, instanceId),
        journal_root: posix.join(roots.stateRoot, tenantId, instanceId, 'journal'),
        docker_socket_path: roots.dockerSocketPath,
        bearer_token_ref: `file:${tokenPath}`,
        image_digest_ref: `file:${imagePath}`,
        template_store_version: manifest.template_store_version,
        template_store_sha256_ref: `file:${storeHashPath}`,
        policy_sha256_ref: `file:${policyPath}`,
      }
      await writeAuthorityFile(configPath, `${JSON.stringify(config)}\n`, 0o600)
      await syncDirectory(configDirectory)
      await syncDirectory(secretDirectory)
      return {
        state: 'CREATED', tenant_id: tenantId, instance_id: instanceId,
        template_store_version: manifest.template_store_version,
        template_store_sha256: manifest.tree_sha256,
        manifest_sha256: expectedManifestSha256,
        config_reference: `file:${configPath}`,
      }
    } finally {
      await lock.release()
    }
  } catch (error) {
    if (error instanceof BuilderProvisionError) throw error
    throw new BuilderProvisionError('INVALID_PROVISION_REQUEST')
  }
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

async function publishTemplateStore(sourceRoot: string, parent: string, target: string, manifest: TemplateStoreManifest): Promise<void> {
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
    ...['builder-image.sha256', 'template-store.sha256', 'template-manifest.sha256', 'policy.sha256'].map(name => posix.join(configDirectory, name)),
  ]
  for (const path of paths) {
    if (!await exists(path)) continue
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !trustedOwner(stat) || await realpath(path) !== path) recoveryFailed()
    await unlink(path)
  }
}

async function recoverAuthorityLinkTemps(configDirectory: string, secretDirectory: string, preserveTargets: boolean): Promise<void> {
  const configTargets = ['supervisor.json', 'builder-image.sha256', 'template-store.sha256', 'template-manifest.sha256', 'policy.sha256'].map(name => posix.join(configDirectory, name))
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

async function writeAuthorityFile(path: string, value: string, mode: 0o400 | 0o600): Promise<void> {
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

async function acquireProvisionLock(instanceRoot: string): Promise<ProvisionLock> {
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
  const startTicks = await processStartTicks(process.pid)
  let recoveredStaleOwner = false
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const suffix = randomBytes(16).toString('hex')
    const claimName = `.claim-${suffix}`
    const claimPath = posix.join(instanceRoot, claimName)
    const lockPath = posix.join(instanceRoot, '.provision.lock')
    const identity: ProvisionIdentity = { pid: process.pid, boot_id: bootId, start_ticks: startTicks, claim: claimName }
    let handle: FileHandle | undefined
    let acquired = false
    try {
      handle = await open(claimPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400)
      await handle.writeFile(`${JSON.stringify(identity)}\n`, 'utf8'); await handle.chmod(0o400); await handle.sync(); await handle.close(); handle = undefined
      try { await link(claimPath, lockPath) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (await lockOwnerAlive(lockPath, bootId)) throw new BuilderProvisionError('PROVISION_BUSY')
        await removeStaleLock(lockPath)
        recoveredStaleOwner = true
        continue
      }
      acquired = true
      return { recoveredStaleOwner, release: async () => {
        const [claim, lock] = await Promise.all([lstat(claimPath), lstat(lockPath)])
        if (!sameIdentity(claim, lock)) recoveryFailed()
        await unlink(lockPath)
        await unlink(claimPath)
        await syncDirectory(instanceRoot)
      } }
    } finally {
      await handle?.close()
      if (!acquired && await exists(claimPath)) await unlink(claimPath).catch(() => undefined)
    }
  }
  recoveryFailed()
}

async function lockOwnerAlive(lockPath: string, bootId: string): Promise<boolean> {
  let handle: FileHandle | undefined
  try {
    handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = await handle.stat(); const linked = await lstat(lockPath)
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 2 || (opened.mode & 0o7777) !== 0o400 || !trustedOwner(opened) || !sameIdentity(opened, linked) || opened.size < 2 || opened.size > 1024 || await realpath(lockPath) !== lockPath) recoveryFailed()
    const value = JSON.parse(await handle.readFile('utf8')) as unknown
    const owner = parseLockIdentity(value)
    if (owner.boot_id !== bootId) return false
    try { return await processStartTicks(owner.pid) === owner.start_ticks }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  } finally { await handle?.close() }
}

async function removeStaleLock(lockPath: string): Promise<void> {
  const raw = JSON.parse(await readFile(lockPath, 'utf8')) as unknown
  const owner = parseLockIdentity(raw)
  const claimPath = posix.join(posix.dirname(lockPath), owner.claim)
  const [lockStat, claimStat] = await Promise.all([lstat(lockPath), lstat(claimPath)])
  if (!sameIdentity(lockStat, claimStat) || lockStat.nlink !== 2) recoveryFailed()
  await unlink(lockPath)
  await unlink(claimPath)
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

async function ensureTenantInstance(root: string, tenantId: string, instanceId: string): Promise<string> {
  const tenant = await ensurePrivateDirectory(posix.join(root, tenantId))
  return ensurePrivateDirectory(posix.join(tenant, instanceId))
}

async function ensurePrivateDirectory(path: string): Promise<string> {
  await mkdir(path, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || !trustedOwner(stat) || (stat.mode & 0o777) !== 0o700 || await realpath(path) !== path) recoveryFailed()
  return path
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
