import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, resolve, sep } from 'node:path'
import { BuilderSupervisorError } from './model.js'
import type { ReplayClaimPort } from './replay.js'
import type { RpcReplayPort, RpcReplayValue } from './replay.js'

interface PendingRpcResult { readonly state: 'pending'; readonly fingerprint: string }
interface PersistedRpcResult { readonly state: 'complete'; readonly fingerprint: string; readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: string }

export class FileRpcReplayGuard implements RpcReplayPort {
  readonly #directory: string
  #tail: Promise<void> = Promise.resolve()
  constructor(directory: string, private readonly maximum = 65_536) {
    if (!resolve(directory).startsWith(resolve(dirname(directory)) + sep) || !Number.isSafeInteger(maximum) || maximum < 1) throw new Error('INVALID_REPLAY_CONFIGURATION')
    this.#directory = resolve(directory)
  }
  async run(requestId: string, fingerprint: string, operation: () => Promise<RpcReplayValue>): Promise<RpcReplayValue> {
    if (!/^req_[a-f0-9]{32}$/u.test(requestId) || !/^[a-f0-9]{64}$/u.test(fingerprint)) throw new BuilderSupervisorError('REQUEST_REPLAY')
    const previous = this.#tail; let release!: () => void; this.#tail = new Promise(resolveTail => { release = resolveTail }); await previous
    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 }); await assertPrivateDirectory(this.#directory)
      const path = resolve(this.#directory, `${requestId}.json`)
      const existing = await readResult(path)
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) throw new BuilderSupervisorError('REQUEST_ID_CONFLICT')
        if (existing.state === 'pending') throw new BuilderSupervisorError('RECOVERY_FAILED')
        return decodeResult(existing)
      }
      if ((await readdir(this.#directory)).length >= this.maximum) throw new BuilderSupervisorError('REPLAY_CAPACITY')
      let reservation
      try { reservation = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow(), 0o600); await reservation.writeFile(`${JSON.stringify({ state: 'pending', fingerprint } satisfies PendingRpcResult)}\n`, 'utf8'); await reservation.sync() }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const raced = await readResult(path); if (raced === undefined || raced.fingerprint !== fingerprint) throw new BuilderSupervisorError('REQUEST_ID_CONFLICT')
        if (raced.state === 'pending') throw new BuilderSupervisorError('RECOVERY_FAILED')
        return decodeResult(raced)
      } finally { await reservation?.close() }
      await syncDirectory(this.#directory)
      const result = await operation(); const persisted = encodeResult(fingerprint, result); const temp = resolve(this.#directory, `.${requestId}-${process.pid}-${Date.now()}`)
      let handle
      try { handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow(), 0o600); await handle.writeFile(`${JSON.stringify(persisted)}\n`, 'utf8'); await handle.sync() }
      catch (error) { await rm(temp, { force: true }); throw error }
      finally { await handle?.close() }
      await rename(temp, path); await syncDirectory(this.#directory)
      return { status: result.status, headers: { ...result.headers }, body: Buffer.from(result.body) }
    } finally { release() }
  }
}

export class FileReplayGuard implements ReplayClaimPort {
  readonly #directory: string
  #tail: Promise<void> = Promise.resolve()
  constructor(directory: string, private readonly maximum = 65_536) {
    if (!resolve(directory).startsWith(resolve(dirname(directory)) + sep) || !Number.isSafeInteger(maximum) || maximum < 1) throw new Error('INVALID_REPLAY_CONFIGURATION')
    this.#directory = resolve(directory)
  }
  async claim(requestId: string): Promise<void> {
    const previous = this.#tail; let release!: () => void; this.#tail = new Promise(resolve => { release = resolve }); await previous
    try { await this.#claimExclusive(requestId) } finally { release() }
  }
  async #claimExclusive(requestId: string): Promise<void> {
    if (!/^req_[a-f0-9]{32}$/u.test(requestId)) throw new BuilderSupervisorError('REQUEST_REPLAY')
    await mkdir(this.#directory, { recursive: true, mode: 0o700 }); await assertPrivateDirectory(this.#directory)
    const path = resolve(this.#directory, requestId)
    if (basename(path) !== requestId || !path.startsWith(this.#directory + sep)) throw new BuilderSupervisorError('REQUEST_REPLAY')
    try { await access(path); throw new BuilderSupervisorError('REQUEST_REPLAY') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if ((await readdir(this.#directory)).length >= this.maximum) throw new BuilderSupervisorError('REPLAY_CAPACITY')
    let handle
    try { handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow(), 0o600); await handle.writeFile(`${Date.now()}\n`, 'utf8'); await handle.sync() }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new BuilderSupervisorError('REQUEST_REPLAY'); throw error }
    finally { await handle?.close() }
  }
}
export interface BuildIdClaimPort { claim(buildId: string): Promise<void>; release?(buildId: string): Promise<void> }
export class FileBuildIdGuard implements BuildIdClaimPort {
  #tail: Promise<void> = Promise.resolve()
  constructor(private readonly directory: string, private readonly maximum = 65_536) { if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('INVALID_BUILD_CLAIM_CONFIGURATION') }
  async claim(buildId: string): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(buildId)) throw new BuilderSupervisorError('BUILD_ALREADY_EXISTS')
    const previous = this.#tail; let release!: () => void; this.#tail = new Promise(resolve => { release = resolve }); await previous
    try {
      const guard = new FileReplayGuard(this.directory, this.maximum); const digest = createHash('sha256').update(buildId).digest('hex').slice(0, 32)
      try { await guard.claim(`req_${digest}`) } catch (error) { if (error instanceof BuilderSupervisorError && (error.code === 'REQUEST_REPLAY' || error.code === 'REPLAY_CAPACITY')) throw new BuilderSupervisorError(error.code === 'REQUEST_REPLAY' ? 'BUILD_ALREADY_EXISTS' : 'REPLAY_CAPACITY'); throw error }
    } finally { release() }
  }
  async release(buildId: string): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(buildId)) throw new BuilderSupervisorError('BUILD_ALREADY_EXISTS')
    const digest = createHash('sha256').update(buildId).digest('hex').slice(0, 32)
    await rm(resolve(this.directory, `req_${digest}`), { force: true })
  }
}
async function assertPrivateDirectory(path: string): Promise<void> { const resolved = await realpath(path); if (resolved !== path) throw new Error('UNSAFE_REPLAY_DIRECTORY'); const stat = await lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('UNSAFE_REPLAY_DIRECTORY'); if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid()))) throw new Error('UNSAFE_REPLAY_DIRECTORY') }
function noFollow(): number { return process.platform === 'linux' ? constants.O_NOFOLLOW : 0 }

async function readResult(path: string): Promise<PersistedRpcResult | PendingRpcResult | undefined> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | noFollow()); const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 768 * 1024) throw new BuilderSupervisorError('RECOVERY_FAILED')
    const value = JSON.parse(await handle.readFile('utf8')) as Record<string, unknown>
    const expectedKeys = value.state === 'pending' ? ['fingerprint', 'state'] : ['body', 'fingerprint', 'headers', 'state', 'status']
    if (Object.keys(value).sort().join('\0') !== expectedKeys.join('\0')) throw new BuilderSupervisorError('RECOVERY_FAILED')
    if (typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(value.fingerprint) || (value.state !== 'pending' && value.state !== 'complete')) throw new BuilderSupervisorError('RECOVERY_FAILED')
    if (value.state === 'pending') return value as unknown as PendingRpcResult
    if (!Number.isSafeInteger(value.status) || Number(value.status) < 100 || Number(value.status) > 599 || typeof value.body !== 'string' || value.body.length > 700_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.body) || typeof value.headers !== 'object' || value.headers === null || Array.isArray(value.headers) || Object.keys(value.headers).length > 32 || Object.entries(value.headers).some(([key, item]) => !/^[a-z0-9-]{1,64}$/u.test(key) || typeof item !== 'string' || item.length > 8_192)) throw new BuilderSupervisorError('RECOVERY_FAILED')
    return value as unknown as PersistedRpcResult
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  finally { await handle?.close() }
}
function encodeResult(fingerprint: string, value: RpcReplayValue): PersistedRpcResult { return { state: 'complete', fingerprint, status: value.status, headers: { ...value.headers }, body: Buffer.from(value.body).toString('base64') } }
function decodeResult(value: PersistedRpcResult): RpcReplayValue { return { status: value.status, headers: { ...value.headers }, body: Buffer.from(value.body, 'base64') } }
async function syncDirectory(path: string): Promise<void> { if (process.platform === 'win32') return; const handle = await open(path, constants.O_RDONLY); try { await handle.sync() } finally { await handle.close() } }
