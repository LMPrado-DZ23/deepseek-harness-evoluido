import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, statfs, unlink, type FileHandle } from 'node:fs/promises'
import { posix } from 'node:path'
import {
  builderRuntimeRegistryPath,
  loadBuilderRuntimeRegistry,
  parseBuilderRuntimeRegistryBytes,
  type BuilderRuntimeRegistry,
  type BuilderRuntimeRegistrySlot,
} from './manager-registry.js'
import { isBuilderRuntimeScopeId, isInstallationId, type BuilderRuntimeScopeId } from './runtime-scope.js'
import {
  loadPinnedBuilderSupervisorConfig,
  validateBuilderSupervisorRootPolicy,
  type BuilderSupervisorRootPolicy,
} from './supervisor-config.js'

const EXT4_SUPER_MAGIC = 0xef53
const XFS_SUPER_MAGIC = 0x58465342
const FLOCK_PATH = '/usr/bin/flock'
const FLOCK_BUSY_EXIT = 200
const FLOCK_TIMEOUT_MS = 7_000
const MAX_SLOTS = 512
const TEMP = /^\.runtime-registry\.[a-f0-9]{32}\.tmp$/u
const AUTHORITY_TEMP = /^\.runtime-registry-authority\.[a-f0-9]{32}\.tmp$/u
const AUTHORITY_MAX_BYTES = 1024 * 1024

export type BuilderRegistryWriteErrorCode =
  | 'INVALID_RUNTIME_ACTIVATION'
  | 'RUNTIME_REGISTRY_BUSY'
  | 'RUNTIME_REGISTRY_CONFLICT'
  | 'RUNTIME_REGISTRY_FULL'
  | 'RUNTIME_REGISTRY_RECOVERY_FAILED'

export class BuilderRegistryWriteError extends Error {
  constructor(readonly code: BuilderRegistryWriteErrorCode) { super(code); this.name = 'BuilderRegistryWriteError' }
}

export interface BuilderRuntimeActivationRequest {
  readonly installationId: string
  readonly scopeId: BuilderRuntimeScopeId
  readonly configReference: `file:${string}`
  readonly configSha256: string
  readonly roots: BuilderSupervisorRootPolicy
}

export interface BuilderRuntimeActivationResult {
  readonly state: 'ACTIVATED' | 'UNCHANGED'
  readonly generation: number
  readonly registryReference: `file:${string}`
  readonly registrySha256: string
  readonly scopeId: BuilderRuntimeScopeId
}

export interface BuilderRegistryWriterRuntime {
  readonly beforeRegistryRename?: () => Promise<void>
  readonly afterRegistryRename?: () => Promise<void>
  readonly afterAuthorityCommitted?: () => Promise<void>
}

interface RegistryWriterAuthority {
  readonly version: 1
  readonly installationId: string
  readonly phase: 'pending' | 'committed'
  readonly generation: number
  readonly registrySha256: string
  readonly previousRegistrySha256?: string
  readonly registryBytes: Buffer
}

export async function activateBuilderRuntimeSlot(
  request: BuilderRuntimeActivationRequest,
  runtime: BuilderRegistryWriterRuntime = {},
): Promise<BuilderRuntimeActivationResult> {
  try {
    if (process.platform !== 'linux' || process.getuid === undefined || !isInstallationId(request.installationId) ||
      !isBuilderRuntimeScopeId(request.scopeId) || !/^[a-f0-9]{64}$/u.test(request.configSha256)) invalid()
    validateBuilderSupervisorRootPolicy(request.roots)
    const expectedConfig = `file:${posix.join(request.roots.configRoot, 'instances', request.scopeId, 'supervisor.json')}` as const
    if (request.configReference !== expectedConfig) invalid()
    const config = await loadPinnedBuilderSupervisorConfig(request.configReference, request.configSha256, request.roots)
    if (config.installationId !== request.installationId || config.scopeId !== request.scopeId) conflict()

    const stateManager = await ensurePrivateDirectory(posix.join(request.roots.stateRoot, 'manager'))
    const configManager = await ensurePrivateDirectory(posix.join(request.roots.configRoot, 'manager'))
    const filesystem = await statfs(stateManager)
    assertRegistryHost(stateManager, filesystem.type)
    const guard = await openPermanentGuard(posix.join(stateManager, 'runtime-registry.guard'), stateManager)
    try {
      await acquireGuard(guard.handle)
      await assertGuard(guard.path, guard.identity, await guard.handle.stat())
      await recoverTemps(configManager)
      await recoverAuthorityTemps(stateManager)
      const registryPath = builderRuntimeRegistryPath(request.roots)
      const registryReference = `file:${registryPath}` as const
      const authorityPath = posix.join(stateManager, 'runtime-registry-authority.json')
      let current = await loadOptionalRegistry(registryReference, request.roots)
      const authority = await loadOptionalAuthority(authorityPath, request.roots)
      current = await reconcileAuthority(authority, current, authorityPath, registryPath, registryReference, stateManager, configManager, request.roots)
      if (current !== undefined && current.installationId !== request.installationId) conflict()
      const exact = current?.slots.find(slot => slot.scopeId === request.scopeId)
      if (exact !== undefined) {
        if (exact.configReference !== request.configReference || exact.configSha256 !== request.configSha256 || exact.state !== 'active') conflict()
        return result('UNCHANGED', current!, registryReference, request.scopeId)
      }
      if ((current?.slots.length ?? 0) >= MAX_SLOTS) full()
      if (current !== undefined && current.generation >= Number.MAX_SAFE_INTEGER) full()
      const slot: BuilderRuntimeRegistrySlot = {
        scopeId: request.scopeId,
        configReference: request.configReference,
        configSha256: request.configSha256,
        state: 'active',
      }
      const generation = (current?.generation ?? 0) + 1
      const bytes = canonicalRegistryBytes(request.installationId, generation, [...(current?.slots ?? []), slot])
      const registrySha256 = createHash('sha256').update(bytes).digest('hex')
      const pending = authorityBytes({
        installationId: request.installationId,
        phase: 'pending', generation, registrySha256,
        ...(current === undefined ? {} : { previousRegistrySha256: current.sha256 }),
        registryBytes: bytes,
      })
      await publishAuthority(authorityPath, pending, stateManager)
      await publishRegistry(registryPath, bytes, configManager, runtime)
      await publishAuthority(authorityPath, authorityBytes({ installationId: request.installationId, phase: 'committed', generation, registrySha256, registryBytes: bytes }), stateManager)
      await runtime.afterAuthorityCommitted?.()
      const published = await loadBuilderRuntimeRegistry(registryReference, request.roots)
      if (published.installationId !== request.installationId || published.generation !== generation ||
        published.slots.length !== (current?.slots.length ?? 0) + 1 ||
        !published.slots.some(candidate => sameSlot(candidate, slot))) recoveryFailed()
      return result('ACTIVATED', published, registryReference, request.scopeId)
    } finally {
      await guard.handle.close()
    }
  } catch (error) {
    if (error instanceof BuilderRegistryWriteError) throw error
    throw new BuilderRegistryWriteError('INVALID_RUNTIME_ACTIVATION')
  }
}

function canonicalRegistryBytes(installationId: string, generation: number, slots: readonly BuilderRuntimeRegistrySlot[]): Buffer {
  const sorted = [...slots].sort((left, right) => Buffer.from(left.scopeId).compare(Buffer.from(right.scopeId)))
  const value = {
    version: 1,
    installation_id: installationId,
    generation,
    slots: sorted.map(slot => ({ scope_id: slot.scopeId, config_ref: slot.configReference, config_sha256: slot.configSha256, state: slot.state })),
  }
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
}

function assertRegistryHost(stateManager: string, filesystemType: number): void {
  if (stateManager === '/mnt' || stateManager.startsWith('/mnt/')) recoveryFailed()
  if (filesystemType !== EXT4_SUPER_MAGIC && filesystemType !== XFS_SUPER_MAGIC) recoveryFailed()
}

async function loadOptionalRegistry(reference: `file:${string}`, roots: BuilderSupervisorRootPolicy): Promise<BuilderRuntimeRegistry | undefined> {
  try { return await loadBuilderRuntimeRegistry(reference, roots) }
  catch (error) {
    const path = reference.slice(5)
    try { await lstat(path) }
    catch (statError) { assertMissing(statError); return undefined }
    throw error
  }
}

function assertMissing(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
}

async function loadOptionalAuthority(path: string, roots: BuilderSupervisorRootPolicy): Promise<RegistryWriterAuthority | undefined> {
  let handle: FileHandle | undefined
  try {
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    const opened = await handle.stat(); const linked = await lstat(path)
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1 || opened.size < 2 || opened.size > AUTHORITY_MAX_BYTES ||
      (opened.mode & 0o7777) !== 0o600 || !trustedOwner(opened) || !sameIdentity(opened, linked) || await realpath(path) !== path) recoveryFailed()
    const bytes = await handle.readFile()
    if (bytes.includes(0)) recoveryFailed()
    let raw: unknown
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown } catch { return recoveryFailed() }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) recoveryFailed()
    const value = raw as Record<string, unknown>
    const keys = ['generation', 'installation_id', 'phase', 'previous_registry_sha256', 'registry_base64', 'registry_sha256', 'version']
    if (Object.keys(value).sort().join('\0') !== keys.join('\0') || value.version !== 1 || !isInstallationId(value.installation_id) ||
      (value.phase !== 'pending' && value.phase !== 'committed') || !Number.isSafeInteger(value.generation) || Number(value.generation) < 1 ||
      typeof value.registry_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.registry_sha256) ||
      !(value.previous_registry_sha256 === null || typeof value.previous_registry_sha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.previous_registry_sha256)) ||
      typeof value.registry_base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value.registry_base64)) recoveryFailed()
    const registryBytes = Buffer.from(value.registry_base64, 'base64')
    if (registryBytes.toString('base64') !== value.registry_base64 || createHash('sha256').update(registryBytes).digest('hex') !== value.registry_sha256) recoveryFailed()
    let registry: BuilderRuntimeRegistry
    try { registry = parseBuilderRuntimeRegistryBytes(registryBytes, roots) } catch { return recoveryFailed() }
    if (!canonicalRegistryBytes(registry.installationId, registry.generation, registry.slots).equals(registryBytes)) recoveryFailed()
    if (registry.installationId !== value.installation_id || registry.generation !== value.generation || registry.sha256 !== value.registry_sha256) recoveryFailed()
    if (value.phase === 'committed' && value.previous_registry_sha256 !== null) recoveryFailed()
    return {
      version: 1, installationId: value.installation_id, phase: value.phase,
      generation: Number(value.generation), registrySha256: value.registry_sha256,
      ...(value.previous_registry_sha256 === null ? {} : { previousRegistrySha256: value.previous_registry_sha256 as string }),
      registryBytes,
    }
  } finally { await handle?.close() }
}

async function reconcileAuthority(
  authority: RegistryWriterAuthority | undefined,
  current: BuilderRuntimeRegistry | undefined,
  authorityPath: string,
  registryPath: string,
  registryReference: `file:${string}`,
  stateManager: string,
  configManager: string,
  roots: BuilderSupervisorRootPolicy,
): Promise<BuilderRuntimeRegistry | undefined> {
  if (authority === undefined) {
    if (current !== undefined) recoveryFailed()
    return undefined
  }
  if (current !== undefined && current.installationId !== authority.installationId) conflict()
  if (authority.phase === 'committed') {
    if (current === undefined || current.sha256 !== authority.registrySha256 || current.generation !== authority.generation) conflict()
    return current
  }
  const previousMatches = authority.previousRegistrySha256 === undefined ? current === undefined : current?.sha256 === authority.previousRegistrySha256
  if (current?.sha256 !== authority.registrySha256) {
    if (!previousMatches) conflict()
    await publishRegistry(registryPath, authority.registryBytes, configManager, {})
    current = await loadBuilderRuntimeRegistry(registryReference, roots)
  }
  if (current.sha256 !== authority.registrySha256 || current.generation !== authority.generation) recoveryFailed()
  await publishAuthority(authorityPath, authorityBytes({ installationId: authority.installationId, phase: 'committed', generation: authority.generation, registrySha256: authority.registrySha256, registryBytes: authority.registryBytes }), stateManager)
  return current
}

function authorityBytes(input: Omit<RegistryWriterAuthority, 'version'>): Buffer {
  return Buffer.from(`${JSON.stringify({
    version: 1,
    installation_id: input.installationId,
    phase: input.phase,
    generation: input.generation,
    registry_sha256: input.registrySha256,
    previous_registry_sha256: input.previousRegistrySha256 ?? null,
    registry_base64: input.registryBytes.toString('base64'),
  })}\n`, 'utf8')
}

async function publishAuthority(path: string, bytes: Buffer, directory: string): Promise<void> {
  const temp = posix.join(directory, `.runtime-registry-authority.${randomBytes(16).toString('hex')}.tmp`)
  await publishAtomic(path, bytes, directory, temp)
}

async function publishRegistry(path: string, bytes: Buffer, directory: string, runtime: BuilderRegistryWriterRuntime): Promise<void> {
  const temp = posix.join(directory, `.runtime-registry.${randomBytes(16).toString('hex')}.tmp`)
  await publishAtomic(path, bytes, directory, temp, runtime)
}

async function publishAtomic(path: string, bytes: Buffer, directory: string, temp: string, runtime: BuilderRegistryWriterRuntime = {}): Promise<void> {
  let handle: FileHandle | undefined
  try {
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    await handle.writeFile(bytes)
    await handle.chmod(0o600)
    await handle.sync()
    await handle.close(); handle = undefined
    await runtime.beforeRegistryRename?.()
    await rename(temp, path)
    await syncDirectory(directory)
    await runtime.afterRegistryRename?.()
  } finally {
    await handle?.close()
    await unlink(temp).catch(() => undefined)
  }
}

async function recoverTemps(directory: string): Promise<void> {
  const names = (await readdir(directory)).filter(name => name.startsWith('.runtime-registry.'))
  if (names.length > 16 || names.some(name => !TEMP.test(name))) recoveryFailed()
  for (const name of names) {
    const path = posix.join(directory, name)
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !trustedOwner(stat) || (stat.mode & 0o7777) !== 0o600 || await realpath(path) !== path) recoveryFailed()
    await unlink(path)
  }
  if (names.length > 0) await syncDirectory(directory)
}

async function recoverAuthorityTemps(directory: string): Promise<void> {
  const names = (await readdir(directory)).filter(name => name.startsWith('.runtime-registry-authority.'))
  if (names.length > 16 || names.some(name => !AUTHORITY_TEMP.test(name))) recoveryFailed()
  for (const name of names) {
    const path = posix.join(directory, name); const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !trustedOwner(stat) || (stat.mode & 0o7777) !== 0o600 || await realpath(path) !== path) recoveryFailed()
    await unlink(path)
  }
  if (names.length > 0) await syncDirectory(directory)
}

async function ensurePrivateDirectory(path: string): Promise<string> {
  await mkdir(path, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || !trustedOwner(stat) || (stat.mode & 0o7777) !== 0o700 || await realpath(path) !== path) recoveryFailed()
  return path
}

interface GuardOpenTestRuntime {
  readonly afterOpenMissing?: () => Promise<void>
  readonly beforeCreate?: () => Promise<void>
  readonly afterCreated?: () => Promise<void>
}

async function openPermanentGuard(path: string, directory: string, runtime: GuardOpenTestRuntime = {}): Promise<{ readonly path: string; readonly handle: FileHandle; readonly identity: Stats }> {
  let creator: FileHandle | undefined
  let handle: FileHandle | undefined
  try {
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await runtime.afterOpenMissing?.()
      const entries = await readdir(directory)
      if (entries.length !== 0 && (entries.length !== 1 || entries[0] !== posix.basename(path))) recoveryFailed()
      if (entries.length === 0) {
        await runtime.beforeCreate?.()
        try { creator = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
        catch (createError) { if ((createError as NodeJS.ErrnoException).code !== 'EEXIST') throw createError }
      }
      if (creator !== undefined) { await runtime.afterCreated?.(); await creator.sync(); await creator.close(); creator = undefined; await syncDirectory(directory) }
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    }
    const identity = await handle.stat()
    await assertGuard(path, identity, identity)
    return { path, handle, identity }
  } catch (error) {
    if (creator !== undefined) await creator.close()
    if (handle !== undefined) await handle.close()
    throw error
  }
}

async function assertGuard(path: string, expected: Stats, opened: Stats): Promise<void> {
  const linked = await lstat(path)
  if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1 || (opened.mode & 0o7777) !== 0o600 || !trustedOwner(opened) ||
    !sameIdentity(expected, opened) || !sameIdentity(opened, linked) || await realpath(path) !== path) recoveryFailed()
}

async function acquireGuard(handle: FileHandle): Promise<void> {
  return acquireGuardWithProcess(handle, FLOCK_PATH, FLOCK_TIMEOUT_MS)
}

async function acquireGuardWithProcess(handle: FileHandle, flockPath: string, timeoutMs: number): Promise<void> {
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; failed: boolean }>(resolve => {
    const child = spawn(flockPath, ['--exclusive', '--wait', '5', '--conflict-exit-code', String(FLOCK_BUSY_EXIT), '3'], { env: {}, shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', handle.fd] })
    let settled = false
    const finish = (value: { code: number | null; signal: NodeJS.Signals | null; failed: boolean }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ code: null, signal: 'SIGKILL', failed: true }) }, timeoutMs)
    timer.unref()
    child.once('error', () => finish({ code: null, signal: null, failed: true }))
    child.once('exit', (code, signal) => finish({ code, signal, failed: false }))
  })
  if (!outcome.failed && outcome.code === 0 && outcome.signal === null) return
  if (!outcome.failed && outcome.code === FLOCK_BUSY_EXIT && outcome.signal === null) throw new BuilderRegistryWriteError('RUNTIME_REGISTRY_BUSY')
  recoveryFailed()
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY)
  try { await handle.sync() } finally { await handle.close() }
}

function result(state: 'ACTIVATED' | 'UNCHANGED', registry: BuilderRuntimeRegistry, registryReference: `file:${string}`, scopeId: BuilderRuntimeScopeId): BuilderRuntimeActivationResult {
  return { state, generation: registry.generation, registryReference, registrySha256: registry.sha256, scopeId }
}
function sameSlot(left: BuilderRuntimeRegistrySlot, right: BuilderRuntimeRegistrySlot): boolean { return left.scopeId === right.scopeId && left.configReference === right.configReference && left.configSha256 === right.configSha256 && left.state === right.state }
function trustedOwner(stat: Stats): boolean { const uid = process.getuid?.(); return uid !== undefined && (stat.uid === 0 || stat.uid === uid) }
function sameIdentity(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.gid === right.gid && left.mode === right.mode }
function invalid(): never { throw new BuilderRegistryWriteError('INVALID_RUNTIME_ACTIVATION') }
function conflict(): never { throw new BuilderRegistryWriteError('RUNTIME_REGISTRY_CONFLICT') }
function full(): never { throw new BuilderRegistryWriteError('RUNTIME_REGISTRY_FULL') }
function recoveryFailed(): never { throw new BuilderRegistryWriteError('RUNTIME_REGISTRY_RECOVERY_FAILED') }

export const MANAGER_REGISTRY_WRITER_TEST_ONLY = Object.freeze({
  canonicalRegistryBytes,
  authorityBytes,
  assertRegistryHost,
  acquireGuardWithProcess,
  reconcileAuthority,
  ensurePrivateDirectory,
  openPermanentGuard,
  assertMissing,
})
