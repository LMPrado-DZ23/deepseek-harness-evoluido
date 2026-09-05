import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { posix } from 'node:path'
import { isBuilderRuntimeScopeId, isInstallationId, type BuilderRuntimeScopeId } from './runtime-scope.js'
import type { BuilderSupervisorRootPolicy } from './supervisor-config.js'

const REGISTRY_KEYS = ['generation', 'installation_id', 'slots', 'version'] as const
const SLOT_KEYS = ['config_ref', 'config_sha256', 'scope_id', 'state'] as const
const MAX_REGISTRY_BYTES = 512 * 1024
const MAX_SLOTS = 512

export class BuilderRuntimeRegistryError extends Error {
  readonly code = 'INVALID_RUNTIME_REGISTRY'
  constructor() { super('INVALID_RUNTIME_REGISTRY') }
}

export interface BuilderRuntimeRegistrySlot {
  readonly scopeId: BuilderRuntimeScopeId
  readonly configReference: `file:${string}`
  readonly configSha256: string
  readonly state: 'active' | 'retiring'
}

export interface BuilderRuntimeRegistry {
  readonly version: 1
  readonly installationId: string
  readonly generation: number
  readonly slots: readonly BuilderRuntimeRegistrySlot[]
  readonly sha256: string
}

export interface ManagerSecureFileRuntime {
  readonly platform: NodeJS.Platform
  readonly uid: number | undefined
  readonly noFollowFlag: number
  readonly open: (path: string, flags: number) => Promise<FileHandle>
  readonly lstat: (path: string) => Promise<Stats>
  readonly realpath: (path: string) => Promise<string>
}

const DEFAULT_RUNTIME: ManagerSecureFileRuntime = {
  platform: process.platform,
  uid: process.getuid?.(),
  noFollowFlag: constants.O_NOFOLLOW,
  open,
  lstat,
  realpath,
}

export function builderRuntimeRegistryPath(roots: BuilderSupervisorRootPolicy): string {
  if (!canonicalRoot(roots.configRoot)) return invalid()
  return posix.join(roots.configRoot, 'manager', 'runtime-registry.json')
}

export async function loadBuilderRuntimeRegistry(
  registryReference: string,
  roots: BuilderSupervisorRootPolicy,
  runtime: ManagerSecureFileRuntime = DEFAULT_RUNTIME,
): Promise<BuilderRuntimeRegistry> {
  try {
    if (runtime.platform !== 'linux' || runtime.uid === undefined) invalid()
    const expectedPath = builderRuntimeRegistryPath(roots)
    const path = referencePath(registryReference)
    if (path !== expectedPath) invalid()
    const bytes = await readSecureManagerFile(path, MAX_REGISTRY_BYTES, runtime)
    const raw = decodeUtf8(bytes)
    const value = strictRecord(JSON.parse(raw), REGISTRY_KEYS)
    if (value.version !== 1 || !isInstallationId(value.installation_id) || !Number.isSafeInteger(value.generation) || Number(value.generation) < 0) invalid()
    if (!Array.isArray(value.slots) || value.slots.length > MAX_SLOTS) invalid()
    const scopes = new Set<string>()
    const references = new Set<string>()
    const slots = value.slots.map(item => {
      const slot = strictRecord(item, SLOT_KEYS)
      if (!isBuilderRuntimeScopeId(slot.scope_id) || typeof slot.config_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(slot.config_sha256) || (slot.state !== 'active' && slot.state !== 'retiring')) invalid()
      const expectedConfig = posix.join(roots.configRoot, 'instances', slot.scope_id, 'supervisor.json')
      if (typeof slot.config_ref !== 'string' || referencePath(slot.config_ref) !== expectedConfig) invalid()
      if (scopes.has(slot.scope_id) || references.has(slot.config_ref)) invalid()
      scopes.add(slot.scope_id); references.add(slot.config_ref)
      return { scopeId: slot.scope_id, configReference: slot.config_ref as `file:${string}`, configSha256: slot.config_sha256, state: slot.state } satisfies BuilderRuntimeRegistrySlot
    })
    return {
      version: 1,
      installationId: value.installation_id,
      generation: Number(value.generation),
      slots,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  } catch (error) {
    if (error instanceof BuilderRuntimeRegistryError) throw error
    throw new BuilderRuntimeRegistryError()
  }
}

async function readSecureManagerFile(path: string, maximumBytes: number, runtime: ManagerSecureFileRuntime): Promise<Buffer> {
  let handle: FileHandle | undefined
  try {
    handle = await runtime.open(path, constants.O_RDONLY | runtime.noFollowFlag)
    const opened = await handle.stat()
    const linked = await runtime.lstat(path)
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1 || opened.size < 1 || opened.size > maximumBytes) invalid()
    if (!linked.isFile() || linked.isSymbolicLink() || linked.dev !== opened.dev || linked.ino !== opened.ino || linked.nlink !== opened.nlink || linked.uid !== opened.uid || linked.gid !== opened.gid || linked.mode !== opened.mode || await runtime.realpath(path) !== path) invalid()
    const mode = opened.mode & 0o7777
    if ((opened.uid !== 0 && opened.uid !== runtime.uid) || (opened.mode & 0o022) !== 0 || (mode !== 0o400 && mode !== 0o600 && mode !== 0o640)) invalid()
    const value = await handle.readFile()
    if (value.byteLength === 0 || value.includes(0)) invalid()
    return value
  } finally {
    await handle?.close()
  }
}

function decodeUtf8(value: Buffer): string {
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(value)
    return decoded
  } catch { return invalid() }
}

function strictRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid()
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join('\0') !== [...keys].sort().join('\0')) invalid()
  return row
}

function referencePath(reference: string): string {
  if (typeof reference !== 'string' || !reference.startsWith('file:')) return invalid()
  const path = reference.slice(5)
  if (!posix.isAbsolute(path) || path.includes('\\') || path.includes('\0') || path.includes('://') || posix.normalize(path) !== path || path.endsWith('/')) return invalid()
  return path
}

function canonicalRoot(path: string): boolean {
  return posix.isAbsolute(path) && path !== '/' && !path.includes('\\') && !path.includes('\0') && !path.includes('://') && posix.normalize(path) === path && !path.endsWith('/')
}

function invalid(): never { throw new BuilderRuntimeRegistryError() }
