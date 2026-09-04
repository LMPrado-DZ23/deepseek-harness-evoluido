import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, mkdir, open, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, resolve, sep } from 'node:path'
import { BuilderSupervisorError } from './model.js'
import type { ReplayClaimPort } from './replay.js'

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
export interface BuildIdClaimPort { claim(buildId: string): Promise<void> }
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
}
async function assertPrivateDirectory(path: string): Promise<void> { const resolved = await realpath(path); if (resolved !== path) throw new Error('UNSAFE_REPLAY_DIRECTORY'); const stat = await lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('UNSAFE_REPLAY_DIRECTORY'); if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid()))) throw new Error('UNSAFE_REPLAY_DIRECTORY') }
function noFollow(): number { return process.platform === 'linux' ? constants.O_NOFOLLOW : 0 }
