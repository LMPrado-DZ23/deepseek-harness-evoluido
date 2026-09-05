import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises'
import { dirname, posix } from 'node:path'
import { isBuilderRuntimeScopeId, type BuilderRuntimeScopeId } from './runtime-scope.js'

export type BuilderRuntimeHealthState = 'STARTING' | 'HEALTHY' | 'DEGRADED' | 'RETIRING' | 'STOPPED' | 'BLOCKED_EXTERNAL'
export type BuilderRuntimeHealthCode = 'NONE' | 'START_FAILED' | 'CONFIG_INVALID' | 'DRAIN_FAILED' | 'SHUTDOWN_FAILED' | 'EXTERNAL_DEPENDENCY'

export interface BuilderRuntimeHealth {
  readonly version: 1
  readonly scope_id: BuilderRuntimeScopeId
  readonly state: BuilderRuntimeHealthState
  readonly since: string
  readonly updated_at: string
  readonly code: BuilderRuntimeHealthCode
}

export interface BuilderRuntimeHealthPort {
  write(value: BuilderRuntimeHealth): Promise<void>
}

export type BuilderRuntimeHealthMkdir = (path: string, options: { readonly mode: number }) => Promise<unknown>

export class MemoryBuilderRuntimeHealthStore implements BuilderRuntimeHealthPort {
  readonly values = new Map<BuilderRuntimeScopeId, BuilderRuntimeHealth>()
  async write(value: BuilderRuntimeHealth): Promise<void> { this.values.set(value.scope_id, value) }
}

export class FileBuilderRuntimeHealthStore implements BuilderRuntimeHealthPort {
  constructor(private readonly root: string, private readonly uid = process.getuid?.(), private readonly makeDirectory: BuilderRuntimeHealthMkdir = mkdir) {}

  async write(value: BuilderRuntimeHealth): Promise<void> {
    if (process.platform !== 'linux' || this.uid === undefined || !isBuilderRuntimeScopeId(value.scope_id)) throw new Error('INVALID_HEALTH_STORE')
    validateHealth(value)
    const directory = posix.join(this.root, value.scope_id)
    await ensurePrivateDirectory(this.root, this.uid, this.makeDirectory)
    await ensurePrivateDirectory(directory, this.uid, this.makeDirectory)
    const target = posix.join(directory, 'health.json')
    const temporary = posix.join(directory, `.health-${randomBytes(16).toString('hex')}`)
    let handle: FileHandle | undefined
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
      await handle.sync()
      await handle.close(); handle = undefined
      await assertReplaceable(target, this.uid)
      await rename(temporary, target)
      await assertSafeFile(target, this.uid)
      const directoryHandle = await open(directory, 'r')
      try { await directoryHandle.sync() } finally { await directoryHandle.close() }
    } finally {
      await handle?.close()
      await unlink(temporary).catch(() => undefined)
    }
  }
}

export function runtimeHealth(
  scopeId: BuilderRuntimeScopeId,
  state: BuilderRuntimeHealthState,
  previous: BuilderRuntimeHealth | undefined,
  code: BuilderRuntimeHealthCode = 'NONE',
  now = new Date(),
): BuilderRuntimeHealth {
  const timestamp = now.toISOString()
  return { version: 1, scope_id: scopeId, state, since: previous?.state === state ? previous.since : timestamp, updated_at: timestamp, code }
}

export function sanitizeRuntimeHealthCode(error: unknown): { readonly state: 'DEGRADED' | 'BLOCKED_EXTERNAL'; readonly code: BuilderRuntimeHealthCode } {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { readonly code: unknown }).code) : ''
  if (code === 'BLOCKED_EXTERNAL' || code === 'EXTERNAL_DEPENDENCY') return { state: 'BLOCKED_EXTERNAL', code: 'EXTERNAL_DEPENDENCY' }
  if (code === 'INVALID_SUPERVISOR_CONFIGURATION' || code === 'INVALID_RUNTIME_REGISTRY') return { state: 'DEGRADED', code: 'CONFIG_INVALID' }
  return { state: 'DEGRADED', code: 'START_FAILED' }
}

function validateHealth(value: BuilderRuntimeHealth): void {
  const keys = Object.keys(value).sort().join('\0')
  if (keys !== ['code', 'scope_id', 'since', 'state', 'updated_at', 'version'].join('\0') || value.version !== 1 || !isBuilderRuntimeScopeId(value.scope_id)) throw new Error('INVALID_HEALTH_RECORD')
  if (typeof value.state !== 'string' || typeof value.code !== 'string' || typeof value.since !== 'string' || typeof value.updated_at !== 'string' || !['STARTING', 'HEALTHY', 'DEGRADED', 'RETIRING', 'STOPPED', 'BLOCKED_EXTERNAL'].includes(value.state) || !['NONE', 'START_FAILED', 'CONFIG_INVALID', 'DRAIN_FAILED', 'SHUTDOWN_FAILED', 'EXTERNAL_DEPENDENCY'].includes(value.code)) throw new Error('INVALID_HEALTH_RECORD')
  if (!validDate(value.since) || !validDate(value.updated_at)) throw new Error('INVALID_HEALTH_RECORD')
}

async function ensurePrivateDirectory(path: string, uid: number, makeDirectory: BuilderRuntimeHealthMkdir): Promise<void> {
  if (!posix.isAbsolute(path) || path === '/' || posix.normalize(path) !== path || path.includes('\\') || path.includes('\0')) throw new Error('INVALID_HEALTH_STORE')
  const missing: string[] = []; let current = path
  while (true) {
    try { await lstat(current); break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('INVALID_HEALTH_STORE')
      missing.push(current); current = dirname(current)
    }
  }
  await validateDirectoryAncestors(current, uid)
  for (const directory of missing.reverse()) {
    try { await makeDirectory(directory, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('INVALID_HEALTH_STORE') }
    await assertPrivateDirectory(directory, uid)
  }
  await assertPrivateDirectory(path, uid)
}

async function assertPrivateDirectory(path: string, uid: number): Promise<void> {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0 || await realpath(path) !== path) throw new Error('INVALID_HEALTH_STORE')
}

async function validateDirectoryAncestors(path: string, uid: number): Promise<void> {
  let current = path
  while (true) {
    const stat = await lstat(current)
    const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== uid) || ((stat.mode & 0o022) !== 0 && !stickyRoot)) throw new Error('INVALID_HEALTH_STORE')
    const parent = dirname(current); if (parent === current) return; current = parent
  }
}

async function assertReplaceable(path: string, uid: number): Promise<void> {
  try { await assertSafeFile(path, uid) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('INVALID_HEALTH_STORE') }
}

async function assertSafeFile(path: string, uid: number): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat(); const linked = await lstat(path)
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1 || opened.uid !== uid || (opened.mode & 0o177) !== 0 || linked.dev !== opened.dev || linked.ino !== opened.ino || linked.nlink !== opened.nlink || linked.uid !== opened.uid || linked.mode !== opened.mode || await realpath(path) !== path || dirname(path) === path) throw new Error('INVALID_HEALTH_STORE')
  } finally { await handle.close() }
}

function validDate(value: string): boolean {
  const parsed = new Date(value)
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value
}
