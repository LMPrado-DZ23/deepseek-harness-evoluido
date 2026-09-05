import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, resolve, sep } from 'node:path'
import { BuilderSupervisorError } from './model.js'
import type { ReplayClaimPort, RpcReplayPort, RpcReplayValue } from './replay.js'

const DEFAULT_RETENTION_MS = 24 * 60 * 60_000
interface PendingRpcResult { readonly state: 'pending'; readonly fingerprint: string; readonly created_at: number }
interface PersistedRpcResult { readonly state: 'complete'; readonly fingerprint: string; readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: string; readonly completed_at: number }
export interface PersistentReplayRuntime {
  readonly platform: NodeJS.Platform
  readonly getuid: (() => number) | undefined
  readonly randomHex: (bytes: number) => string
  readonly inspectDirectory?: (path: string) => Promise<{ readonly resolved: string; readonly directory: boolean; readonly symbolicLink: boolean; readonly mode: number; readonly uid: number }>
}
const SYSTEM_RUNTIME: PersistentReplayRuntime = {
  platform: process.platform,
  getuid: () => process.getuid!(),
  randomHex: bytes => randomBytes(bytes).toString('hex'),
}

export class FileRpcReplayGuard implements RpcReplayPort {
  readonly #directory: string
  readonly #inflight = new Map<string, { readonly fingerprint: string; readonly result: Promise<RpcReplayValue> }>()
  #tail: Promise<void> = Promise.resolve()
  constructor(directory: string, private readonly maximum = 65_536, private readonly retentionMs = DEFAULT_RETENTION_MS, private readonly now: () => number = Date.now, private readonly runtime: PersistentReplayRuntime = SYSTEM_RUNTIME) {
    if (!resolve(directory).startsWith(resolve(dirname(directory)) + sep) || !Number.isSafeInteger(maximum) || maximum < 1 || !Number.isSafeInteger(retentionMs) || retentionMs < 1) throw new Error('INVALID_REPLAY_CONFIGURATION')
    this.#directory = resolve(directory)
  }
  async run(requestId: string, fingerprint: string, operation: () => Promise<RpcReplayValue>): Promise<RpcReplayValue> {
    if (!/^req_[a-f0-9]{32}$/u.test(requestId) || !/^[a-f0-9]{64}$/u.test(fingerprint)) throw new BuilderSupervisorError('REQUEST_REPLAY')
    const current = this.#inflight.get(requestId)
    if (current !== undefined) {
      if (current.fingerprint !== fingerprint) throw new BuilderSupervisorError('REQUEST_ID_CONFLICT')
      return clone(await current.result)
    }
    const result = this.#runNew(requestId, fingerprint, operation)
    this.#inflight.set(requestId, { fingerprint, result })
    try { return clone(await result) } finally { this.#inflight.delete(requestId) }
  }

  async #runNew(requestId: string, fingerprint: string, operation: () => Promise<RpcReplayValue>): Promise<RpcReplayValue> {
    const path = resolve(this.#directory, `${requestId}.json`)
    const existing = await this.#exclusive(async () => {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 }); await assertPrivateDirectory(this.#directory, this.runtime)
      await this.#collectExpired()
      const found = await readResult(path, this.runtime)
      if (found !== undefined) {
        if (found.fingerprint !== fingerprint) throw new BuilderSupervisorError('REQUEST_ID_CONFLICT')
        if (found.state === 'pending') throw new BuilderSupervisorError('RECOVERY_FAILED')
        return found
      }
      const entries = (await readdir(this.#directory)).filter(name => /^req_[a-f0-9]{32}\.json$/u.test(name))
      if (entries.length >= this.maximum) throw new BuilderSupervisorError('REPLAY_CAPACITY')
      await writeExclusive(path, { state: 'pending', fingerprint, created_at: this.now() } satisfies PendingRpcResult, this.runtime)
      await syncDirectory(this.#directory, this.runtime)
      return undefined
    })
    if (existing !== undefined) return decodeResult(existing)

    let result: RpcReplayValue
    try { result = await operation() }
    catch (error) {
      await this.#exclusive(async () => {
        const pending = await readResult(path, this.runtime)
        if (pending?.state === 'pending' && pending.fingerprint === fingerprint) { await rm(path); await syncDirectory(this.#directory, this.runtime) }
      })
      throw error
    }
    await this.#exclusive(async () => {
      const pending = await readResult(path, this.runtime)
      if (pending?.state !== 'pending' || pending.fingerprint !== fingerprint) throw new BuilderSupervisorError('RECOVERY_FAILED')
      const temp = resolve(this.#directory, `.${requestId}-${process.pid}-${this.runtime.randomHex(8)}`)
      try { await writeExclusive(temp, encodeResult(fingerprint, result, this.now()), this.runtime); await rename(temp, path); await syncDirectory(this.#directory, this.runtime) }
      catch (error) { await rm(temp, { force: true }); throw error }
    })
    return clone(result)
  }

  async #collectExpired(): Promise<void> {
    const threshold = this.now() - this.retentionMs
    for (const name of await readdir(this.#directory)) {
      if (!/^req_[a-f0-9]{32}\.json$/u.test(name)) continue
      const path = resolve(this.#directory, name); const value = await readResult(path, this.runtime)
      if (value?.state === 'complete' && value.completed_at <= threshold) await rm(path)
    }
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail; let release!: () => void
    this.#tail = new Promise(resolveTail => { release = resolveTail }); await previous
    try { return await operation() } finally { release() }
  }
}

export class FileReplayGuard implements ReplayClaimPort {
  readonly #directory: string
  #tail: Promise<void> = Promise.resolve()
  constructor(directory: string, private readonly maximum = 65_536, private readonly retentionMs = DEFAULT_RETENTION_MS, private readonly now: () => number = Date.now, private readonly runtime: PersistentReplayRuntime = SYSTEM_RUNTIME) {
    if (!resolve(directory).startsWith(resolve(dirname(directory)) + sep) || !Number.isSafeInteger(maximum) || maximum < 1 || !Number.isSafeInteger(retentionMs) || retentionMs < 1) throw new Error('INVALID_REPLAY_CONFIGURATION')
    this.#directory = resolve(directory)
  }
  async claim(requestId: string): Promise<void> {
    const previous = this.#tail; let release!: () => void; this.#tail = new Promise(resolveTail => { release = resolveTail }); await previous
    try { await this.#claimExclusive(requestId) } finally { release() }
  }
  async #claimExclusive(requestId: string): Promise<void> {
    const path = resolve(this.#directory, requestId)
    if (basename(path) !== requestId || !path.startsWith(this.#directory + sep)) throw new BuilderSupervisorError('REQUEST_REPLAY')
    if (!/^req_[a-f0-9]{32}$/u.test(requestId)) throw new BuilderSupervisorError('REQUEST_REPLAY')
    await mkdir(this.#directory, { recursive: true, mode: 0o700 }); await assertPrivateDirectory(this.#directory, this.runtime)
    const now = this.now()
    for (const name of await readdir(this.#directory)) {
      if (!/^req_[a-f0-9]{32}$/u.test(name)) continue
      const item = resolve(this.#directory, name); const expiresAt = await readExpiry(item, this.runtime)
      if (expiresAt <= now) await rm(item)
    }
    try { await lstat(path); throw new BuilderSupervisorError('REQUEST_REPLAY') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if ((await readdir(this.#directory)).filter(name => /^req_[a-f0-9]{32}$/u.test(name)).length >= this.maximum) throw new BuilderSupervisorError('REPLAY_CAPACITY')
    await writeExclusive(path, { expires_at: now + this.retentionMs }, this.runtime); await syncDirectory(this.#directory, this.runtime)
  }
}

interface ActiveBuildClaim { readonly state: 'active'; readonly build_id_hash: string }
interface CompleteBuildClaim { readonly state: 'complete'; readonly build_id_hash: string; readonly completed_at: number }
type BuildClaim = ActiveBuildClaim | CompleteBuildClaim
export interface BuildIdClaimPort { claim(buildId: string): Promise<void>; release?(buildId: string): Promise<void>; complete?(buildId: string): Promise<void> }
export class FileBuildIdGuard implements BuildIdClaimPort {
  #tail: Promise<void> = Promise.resolve()
  constructor(private readonly directory: string, private readonly maximum = 65_536, private readonly retentionMs = DEFAULT_RETENTION_MS, private readonly now: () => number = Date.now, private readonly runtime: PersistentReplayRuntime = SYSTEM_RUNTIME) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || !Number.isSafeInteger(retentionMs) || retentionMs < 1) throw new Error('INVALID_BUILD_CLAIM_CONFIGURATION')
  }
  async claim(buildId: string): Promise<void> {
    validateBuildId(buildId)
    const previous = this.#tail; let release!: () => void; this.#tail = new Promise(resolveTail => { release = resolveTail }); await previous
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 }); await assertPrivateDirectory(resolve(this.directory), this.runtime)
      const now = this.now(); const names = (await readdir(this.directory)).filter(name => /^build_[a-f0-9]{64}\.json$/u.test(name))
      for (const name of names) { const path = resolve(this.directory, name); const claim = await readBuildClaim(path, this.runtime); if (claim.state === 'complete' && claim.completed_at <= now - this.retentionMs) await rm(path) }
      const digest = buildDigest(buildId); const path = resolve(this.directory, `build_${digest}.json`)
      try { await lstat(path); throw new BuilderSupervisorError('BUILD_ALREADY_EXISTS') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const count = (await readdir(this.directory)).filter(name => /^build_[a-f0-9]{64}\.json$/u.test(name)).length
      if (count >= this.maximum) throw new BuilderSupervisorError('REPLAY_CAPACITY')
      await writeExclusive(path, { state: 'active', build_id_hash: digest } satisfies ActiveBuildClaim, this.runtime); await syncDirectory(this.directory, this.runtime)
    } finally { release() }
  }
  async release(buildId: string): Promise<void> {
    validateBuildId(buildId)
    await rm(resolve(this.directory, `build_${buildDigest(buildId)}.json`), { force: true })
  }
  async complete(buildId: string): Promise<void> {
    validateBuildId(buildId); const digest = buildDigest(buildId); const path = resolve(this.directory, `build_${digest}.json`)
    const claim = await readBuildClaim(path, this.runtime)
    if (claim.state !== 'active' || claim.build_id_hash !== digest) throw new BuilderSupervisorError('RECOVERY_FAILED')
    await writeReplace(path, { state: 'complete', build_id_hash: digest, completed_at: this.now() } satisfies CompleteBuildClaim, this.runtime)
  }
}

async function assertPrivateDirectory(path: string, runtime: PersistentReplayRuntime): Promise<void> {
  const inspected = runtime.inspectDirectory === undefined
    ? await (async () => { const stat = await lstat(path); return { resolved: await realpath(path), directory: stat.isDirectory(), symbolicLink: stat.isSymbolicLink(), mode: stat.mode, uid: stat.uid } })()
    : await runtime.inspectDirectory(path)
  if (inspected.resolved !== path || !inspected.directory || inspected.symbolicLink) throw new Error('UNSAFE_REPLAY_DIRECTORY')
  if (runtime.platform !== 'win32' && ((inspected.mode & 0o077) !== 0 || (runtime.getuid !== undefined && inspected.uid !== runtime.getuid()))) throw new Error('UNSAFE_REPLAY_DIRECTORY')
}
function noFollow(runtime: PersistentReplayRuntime): number { return runtime.platform === 'linux' ? constants.O_NOFOLLOW : 0 }

async function readResult(path: string, runtime: PersistentReplayRuntime): Promise<PersistedRpcResult | PendingRpcResult | undefined> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | noFollow(runtime)); const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 768 * 1024) throw new BuilderSupervisorError('RECOVERY_FAILED')
    const value = JSON.parse(await handle.readFile('utf8')) as Record<string, unknown>
    const expectedKeys = value.state === 'pending' ? ['created_at', 'fingerprint', 'state'] : ['body', 'completed_at', 'fingerprint', 'headers', 'state', 'status']
    if (Object.keys(value).sort().join('\0') !== expectedKeys.join('\0')) throw new BuilderSupervisorError('RECOVERY_FAILED')
    if (typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(value.fingerprint) || (value.state !== 'pending' && value.state !== 'complete')) throw new BuilderSupervisorError('RECOVERY_FAILED')
    const timestamp = value.state === 'pending' ? value.created_at : value.completed_at
    if (!Number.isSafeInteger(timestamp) || Number(timestamp) < 0) throw new BuilderSupervisorError('RECOVERY_FAILED')
    if (value.state === 'pending') return value as unknown as PendingRpcResult
    if (!Number.isSafeInteger(value.status) || Number(value.status) < 100 || Number(value.status) > 599 || typeof value.body !== 'string' || value.body.length > 700_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.body) || typeof value.headers !== 'object' || value.headers === null || Array.isArray(value.headers) || Object.keys(value.headers).length > 32 || Object.entries(value.headers).some(([key, item]) => !/^[a-z0-9-]{1,64}$/u.test(key) || typeof item !== 'string' || item.length > 8_192)) throw new BuilderSupervisorError('RECOVERY_FAILED')
    return value as unknown as PersistedRpcResult
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    if (error instanceof BuilderSupervisorError) throw error
    throw new BuilderSupervisorError('RECOVERY_FAILED')
  }
  finally { await handle?.close() }
}
async function readExpiry(path: string, runtime: PersistentReplayRuntime): Promise<number> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | noFollow(runtime)); const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 128) throw new BuilderSupervisorError('RECOVERY_FAILED')
    const value = JSON.parse(await handle.readFile('utf8')) as Record<string, unknown>
    if (Object.keys(value).join('') !== 'expires_at' || !Number.isSafeInteger(value.expires_at) || Number(value.expires_at) < 0) throw new BuilderSupervisorError('RECOVERY_FAILED')
    return Number(value.expires_at)
  } catch (error) {
    if (error instanceof BuilderSupervisorError) throw error
    throw new BuilderSupervisorError('RECOVERY_FAILED')
  } finally { await handle?.close() }
}
async function readBuildClaim(path: string, runtime: PersistentReplayRuntime): Promise<BuildClaim> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | noFollow(runtime)); const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256) throw new BuilderSupervisorError('RECOVERY_FAILED')
    const value = JSON.parse(await handle.readFile('utf8')) as Record<string, unknown>
    const keys = value.state === 'active' ? ['build_id_hash', 'state'] : ['build_id_hash', 'completed_at', 'state']
    if (Object.keys(value).sort().join('\0') !== keys.join('\0') || typeof value.build_id_hash !== 'string' || !/^[a-f0-9]{64}$/u.test(value.build_id_hash)) throw new BuilderSupervisorError('RECOVERY_FAILED')
    if (value.state === 'active') return value as unknown as ActiveBuildClaim
    if (value.state !== 'complete' || !Number.isSafeInteger(value.completed_at) || Number(value.completed_at) < 0) throw new BuilderSupervisorError('RECOVERY_FAILED')
    return value as unknown as CompleteBuildClaim
  } catch (error) {
    if (error instanceof BuilderSupervisorError) throw error
    throw new BuilderSupervisorError('RECOVERY_FAILED')
  } finally { await handle?.close() }
}
async function writeExclusive(path: string, value: unknown, runtime: PersistentReplayRuntime): Promise<void> {
  let handle
  try { handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow(runtime), 0o600); await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8'); await handle.sync() }
  finally { await handle?.close() }
}
async function writeReplace(path: string, value: unknown, runtime: PersistentReplayRuntime): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await assertPrivateDirectory(dirname(path), runtime)
  const temp = resolve(dirname(path), `.${basename(path)}-${process.pid}-${runtime.randomHex(8)}`)
  try { await writeExclusive(temp, value, runtime); await rename(temp, path); await syncDirectory(dirname(path), runtime) } catch (error) { await rm(temp, { force: true }); throw error }
}
function encodeResult(fingerprint: string, value: RpcReplayValue, completedAt: number): PersistedRpcResult { return { state: 'complete', fingerprint, status: value.status, headers: { ...value.headers }, body: Buffer.from(value.body).toString('base64'), completed_at: completedAt } }
function decodeResult(value: PersistedRpcResult): RpcReplayValue { return { status: value.status, headers: { ...value.headers }, body: Buffer.from(value.body, 'base64') } }
function clone(value: RpcReplayValue): RpcReplayValue { return { status: value.status, headers: { ...value.headers }, body: Buffer.from(value.body) } }
function validateBuildId(value: string): void { if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(value)) throw new BuilderSupervisorError('BUILD_ALREADY_EXISTS') }
function buildDigest(value: string): string { return createHash('sha256').update(value).digest('hex') }
async function syncDirectory(path: string, runtime: PersistentReplayRuntime): Promise<void> { if (runtime.platform === 'win32') return; const handle = await open(path, constants.O_RDONLY); try { await handle.sync() } finally { await handle.close() } }
