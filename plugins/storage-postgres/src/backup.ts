import { execFile } from 'node:child_process'
import { constants, existsSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { open, opendir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { bundleRecordCount, sha256, type StorageExportBundle } from './bundle.js'
import { assertPinnedDirectory, childPath, openNewPinnedFile, openPinnedAppendFile, pinnedChildPath, pinDirectory, pinParent, type PinnedDirectory } from './safe-path.js'

/** Ceiling shared by the worker, the operator CLI and the verifier: one number, one behaviour. */
export const BACKUP_MAX_BYTES_DEFAULT = 2 * 1024 * 1024 * 1024

export const BACKUP_FILE_PATTERN = /^studio-backup-([a-z0-9_]+)-(\d{8}T\d{6}\d{3}Z)-([a-f0-9]{6})\.json$/u
export const BACKUP_LEDGER_FILE = 'backups.jsonl'
export const BACKUP_MIN_INTERVAL_MS = 5 * 60 * 1000

export interface BackupResult {
  status: 'created' | 'failed'
  file: string | null
  sha256: string | null
  bytes: number
  records: number
  domains: number
  startedAt: string
  finishedAt: string
  pruned: string[]
  /** Total removed; `pruned` is capped so a neglected directory cannot exhaust memory just by reporting cleanup. */
  prunedCount: number
  error: string | null
}

export type BackupLogLevel = 'info' | 'warn'

/** What actually produces one backup file. The scheduler only names files, prunes and records. */
export interface BackupRunner {
  run(target: string, signal?: AbortSignal): Promise<{ sha256: string; bytes: number; records: number; domains: number }>
}

/**
 * Builds the whole bundle in THIS process. Fine for the operator CLI, which is
 * a process of its own; the Studio uses the child-process runner instead.
 */
export function inProcessBackupRunner(snapshot: () => Promise<StorageExportBundle>, options: { maxBytes?: number } = {}): BackupRunner {
  const maxBytes = options.maxBytes ?? BACKUP_MAX_BYTES_DEFAULT
  return {
    async run(target, signal) {
      throwIfAborted(signal)
      const bundle = await snapshot()
      throwIfAborted(signal)
      const serialized = `${JSON.stringify(bundle)}\n`
      // The same ceiling the worker enforces: this path used to have none at all, so the
      // operator CLI would happily fill the disk where the scheduled backup refuses to.
      if (Buffer.byteLength(serialized) > maxBytes) throw new Error(`backup exceeds the ${String(maxBytes)} byte limit`)
      const parent = await pinParent(target)
      const file = await openNewPinnedFile(parent.directory, parent.name)
      try {
        await file.writeFile(serialized, { encoding: 'utf8' })
        await assertPinnedDirectory(parent.directory)
      } finally {
        await file.close().catch(() => undefined)
        await parent.directory.handle.close().catch(() => undefined)
      }
      return { sha256: sha256(serialized), bytes: Buffer.byteLength(serialized), records: bundleRecordCount(bundle), domains: bundle.domains.length }
    },
  }
}

export interface ChildBackupRunnerOptions {
  dsnRef: string
  schema: string
  ssl: 'off' | 'require' | 'verify-full'
  /** Hard ceiling for the file; beyond it the child gives up and removes what it had written. */
  maxBytes?: number
  /** The child is killed after this long: a stuck backup must never become a stuck Studio. */
  timeoutMs?: number
  /** Heap cap of the child, in MB. It holds one domain at a time, so this is a guard rail, not a target. */
  heapMb?: number
  execPath?: string
  workerPath?: string
  env?: NodeJS.ProcessEnv
}

/**
 * Runs the backup in a separate process (`backup-worker.js`), with a time
 * limit, a size limit and its own heap: the Studio's own memory and event loop
 * are never spent copying the database. The DSN is passed by **reference**;
 * the child reads it from its own environment, like every other seam here.
 */
export function childProcessBackupRunner(options: ChildBackupRunnerOptions): BackupRunner {
  const worker = options.workerPath ?? defaultWorkerPath()
  const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000
  const maxBytes = options.maxBytes ?? BACKUP_MAX_BYTES_DEFAULT
  return {
    run(target, signal) {
      return new Promise((resolvePromise, reject) => {
        execFile(
          options.execPath ?? process.execPath,
          [`--max-old-space-size=${String(options.heapMb ?? 1024)}`, worker,
            '--dsn-ref', options.dsnRef, '--schema', options.schema, '--ssl', options.ssl,
            '--out', target, '--max-bytes', String(maxBytes)],
          { timeout: timeoutMs, maxBuffer: 1024 * 1024, env: options.env ?? process.env, ...(signal === undefined ? {} : { signal }) },
          (error, stdout, stderr) => {
            if (error !== null) {
              const lines = String(stderr).split('\n').map(line => line.trim()).filter(line => line !== '')
              const detail = (lines.find(line => /error/iu.test(line)) ?? lines.at(-1) ?? '').slice(0, 300)
              reject(new Error(detail === '' ? error.message : detail))
              return
            }
            try {
              const report = JSON.parse(String(stdout).trim().split('\n').at(-1) ?? '') as { sha256: string; bytes: number; records: number; domains: number }
              if (typeof report.sha256 !== 'string' || typeof report.bytes !== 'number') throw new Error('backup worker report is malformed')
              resolvePromise(report)
            } catch (parseError) {
              reject(parseError instanceof Error ? parseError : new Error(String(parseError)))
            }
          },
        )
      })
    },
  }
}

/**
 * The compiled worker next to this module. Under a TypeScript runner this file
 * is the source, so the built `lib/` sibling is used instead — the child is a
 * real Node process either way.
 */
export function defaultWorkerPath(): string {
  const candidates = [new URL('./backup-worker.js', import.meta.url), new URL('../lib/backup-worker.js', import.meta.url)]
  const found = candidates.map(url => fileURLToPath(url)).find(path => existsSync(path))
  if (found === undefined) throw new Error('backup worker not found: build the storage-postgres plugin first')
  return found
}

export interface BackupSchedulerOptions {
  /** Either a runner (preferred) or a snapshot function, which is wrapped in the in-process runner. */
  runner?: BackupRunner
  snapshot?: () => Promise<StorageExportBundle>
  directory: string
  /** Backup family, normally the PostgreSQL schema: it names the files and bounds pruning to this family only. */
  label: string
  intervalMs: number
  keep: number
  now?: () => Date
  log?: (level: BackupLogLevel, line: string) => void
  /** Test seam for the per-file suffix; defaults to 6 random hex characters. */
  suffix?: () => string
  signal?: AbortSignal
}

/**
 * Periodic logical backup. Every run writes one self-verifying bundle
 * (`studio-backup-<label>-<stamp>-<suffix>.json`, mode 0600) with a `.sha256`
 * sidecar, appends one line to the `backups.jsonl` ledger and prunes older
 * bundles of the SAME label beyond `keep`. Only files matching
 * BACKUP_FILE_PATTERN with this label are ever removed. `start()` runs a first
 * backup immediately (a Studio that restarts often would otherwise never back
 * up) and then every `intervalMs`. A failed run is recorded and logged as a
 * warning; it never stops the schedule or the Studio.
 */
export class StorageBackupScheduler {
  private timer: NodeJS.Timeout | undefined
  private inFlight: Promise<BackupResult> | undefined
  private queued: Promise<BackupResult> | undefined
  private last: BackupResult | undefined
  private readonly now: () => Date
  private readonly log: (level: BackupLogLevel, line: string) => void
  private readonly suffix: () => string
  private readonly runner: BackupRunner

  constructor(private readonly options: BackupSchedulerOptions) {
    if (options.runner === undefined && options.snapshot === undefined) throw new Error('backup scheduler needs a runner or a snapshot function')
    this.runner = options.runner ?? inProcessBackupRunner(options.snapshot!)
    if (!Number.isInteger(options.keep) || options.keep < 1) throw new Error('backup keep must be a positive integer')
    if (!Number.isFinite(options.intervalMs) || options.intervalMs < BACKUP_MIN_INTERVAL_MS) {
      throw new Error(`backup interval must be at least ${String(BACKUP_MIN_INTERVAL_MS / 60_000)} minutes`)
    }
    if (!/^[a-z0-9_]{1,40}$/u.test(options.label)) throw new Error('backup label must match /^[a-z0-9_]{1,40}$/')
    this.now = options.now ?? (() => new Date())
    this.log = options.log ?? (() => undefined)
    this.suffix = options.suffix ?? (() => randomBytes(3).toString('hex'))
  }

  get lastResult(): BackupResult | undefined { return this.last }

  start(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => { void this.runOnce() }, this.options.intervalMs)
    this.timer.unref()
    void this.runOnce()
  }

  /** Stops the schedule and DRAINS: when it returns, nothing is running and nothing is owed. */
  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    // A queued run only starts when the one in flight ends, so draining takes a couple of rounds.
    while (this.inFlight !== undefined || this.queued !== undefined) {
      await this.inFlight?.catch(() => undefined)
      await this.queued?.catch(() => undefined)
    }
  }

  /**
   * Serialized AND coalesced: at most one run in flight and at most one waiting.
   * A tick that arrives while a copy is running joins the one already queued —
   * otherwise a backup slower than the interval would grow a queue without
   * limit and the machine would spend the rest of its life copying.
   */
  runOnce(): Promise<BackupResult> {
    if (this.inFlight === undefined) {
      const run = this.execute()
      this.inFlight = run
      run.finally(() => { if (this.inFlight === run) this.inFlight = undefined }).catch(() => undefined)
      return run
    }
    this.queued ??= this.inFlight.then(() => this.startQueued(), () => this.startQueued())
    return this.queued
  }

  private startQueued(): Promise<BackupResult> {
    this.queued = undefined
    return this.runOnce()
  }

  /** How many ticks joined the waiting run instead of starting one of their own. */
  get pending(): boolean { return this.queued !== undefined }

  private async execute(): Promise<BackupResult> {
    throwIfAborted(this.options.signal)
    const startedAt = this.now().toISOString()
    const stamp = startedAt.replace(/[-:.]/gu, '')
    const fileName = `studio-backup-${this.options.label}-${stamp}-${this.suffix()}.json`
    let directory: PinnedDirectory | undefined
    let target = ''
    let result: BackupResult
    try {
      directory = await pinDirectory(this.options.directory, true)
      target = childPath(directory, fileName)
      const written = await this.runner.run(target, this.options.signal)
      throwIfAborted(this.options.signal)
      await assertPinnedDirectory(directory)
      const sidecar = await openNewPinnedFile(directory, `${fileName}.sha256`)
      try { await sidecar.writeFile(`${written.sha256}  ${fileName}\n`, { encoding: 'utf8' }) } finally { await sidecar.close() }
      const pruned = await this.prune(directory, fileName)
      result = {
        status: 'created', file: target, sha256: written.sha256, bytes: written.bytes,
        records: written.records, domains: written.domains,
        startedAt, finishedAt: this.now().toISOString(), pruned: pruned.names, prunedCount: pruned.count, error: null,
      }
    } catch (error) {
      // A run that died half-way leaves no half-file behind for the next restore to find.
      if (directory !== undefined) {
        await assertPinnedDirectory(directory).then(async () => {
          await rm(pinnedChildPath(directory!, fileName), { force: true }).catch(() => undefined)
          await rm(pinnedChildPath(directory!, `${fileName}.sha256`), { force: true }).catch(() => undefined)
        }).catch(() => undefined)
      }
      result = {
        status: 'failed', file: null, sha256: null, bytes: 0, records: 0, domains: 0,
        startedAt, finishedAt: this.now().toISOString(), pruned: [], prunedCount: 0,
        error: error instanceof Error ? error.message : String(error),
      }
    }
    this.last = result
    if (directory !== undefined) await this.record(directory, result)
    await directory?.handle.close().catch(() => undefined)
    this.log(result.status === 'created' ? 'info' : 'warn', `storage-postgres backup ${result.status}${result.file === null ? '' : ` ${result.file}`}${result.error === null ? '' : ` (${result.error})`}`)
    return result
  }

  private async prune(directory: PinnedDirectory, current: string): Promise<{ names: string[]; count: number }> {
    const retained: string[] = []
    const pruned: string[] = []
    let count = 0
    await assertPinnedDirectory(directory)
    const listing = await opendir(process.platform === 'linux' ? `/proc/self/fd/${String(directory.handle.fd)}` : directory.path)
    for await (const entry of listing) {
      if (!entry.isFile() || BACKUP_FILE_PATTERN.exec(entry.name)?.[1] !== this.options.label) continue
      retained.push(entry.name)
      retained.sort()
      if (retained.length <= this.options.keep) continue
      let index = retained.findIndex(name => name !== current)
      if (index < 0) continue
      const [name] = retained.splice(index, 1)
      await assertPinnedDirectory(directory)
      await rm(pinnedChildPath(directory, name!), { force: true })
      await rm(pinnedChildPath(directory, `${name!}.sha256`), { force: true })
      count += 1
      if (pruned.length < 1_000) pruned.push(name!)
    }
    await assertPinnedDirectory(directory)
    return { names: pruned, count }
  }

  private async record(directory: PinnedDirectory, result: BackupResult): Promise<void> {
    try {
      await assertPinnedDirectory(directory)
      const ledger = await openPinnedAppendFile(directory, BACKUP_LEDGER_FILE)
      try { await ledger.writeFile(`${JSON.stringify(result)}\n`, { encoding: 'utf8' }) } finally { await ledger.close() }
      await assertPinnedDirectory(directory)
    } catch (error) {
      this.log('warn', `storage-postgres backup ledger write failed (${error instanceof Error ? error.message : String(error)})`)
    }
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason instanceof Error ? signal.reason : new Error('Operação cancelada.')
}

/**
 * Verify a backup file against its sidecar digest.
 *
 * STREAMED, and bounded. Reading the whole file into a Buffer meant a 2 GiB
 * backup — exactly the size the worker is allowed to write — became 2 GiB of
 * live memory in whatever process asked the question, and anything at or above
 * Node's own 2 GiB `readFile` ceiling could not be verified at all. Here the
 * bytes go through the digest as they arrive, so memory stays flat whatever the
 * file weighs, and a file over `maxBytes` is refused instead of being read.
 */
export async function verifyBackupFile(
  file: string,
  options: { maxBytes?: number } = {},
): Promise<{ file: string; bytes: number; sha256: string; matches: boolean }> {
  const maxBytes = options.maxBytes ?? BACKUP_MAX_BYTES_DEFAULT
  const hash = createHash('sha256')
  let bytes = 0
  const parent = await pinParent(file)
  const noFollow = constants.O_NOFOLLOW ?? 0
  try {
    const data = await open(pinnedChildPath(parent.directory, parent.name), constants.O_RDONLY | noFollow)
    try {
      const dataStats = await data.stat({ bigint: true })
      if (!dataStats.isFile()) throw new Error(`backup file '${file}' is not a regular file`)
      const stream = data.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 })
      try {
        for await (const chunk of stream) {
          const buffer = chunk as Buffer
          bytes += buffer.byteLength
          if (bytes > maxBytes) throw new Error(`backup file '${file}' exceeds the ${String(maxBytes)} byte limit`)
          hash.update(buffer)
        }
      } finally {
        stream.destroy()
      }
    } finally {
      await data.close().catch(() => undefined)
    }
    await assertPinnedDirectory(parent.directory)
    const digest = hash.digest('hex')
    const sidecarFile = await open(pinnedChildPath(parent.directory, `${parent.name}.sha256`), constants.O_RDONLY | noFollow)
    try {
      const stats = await sidecarFile.stat({ bigint: true })
      if (!stats.isFile() || stats.size > 1024n) throw new Error(`backup sidecar for '${file}' is invalid`)
      const sidecar = (await sidecarFile.readFile('utf8')).trim().split(/\s+/u)[0]
      await assertPinnedDirectory(parent.directory)
      return { file, bytes, sha256: digest, matches: sidecar === digest }
    } finally {
      await sidecarFile.close().catch(() => undefined)
    }
  } finally {
    await parent.directory.handle.close().catch(() => undefined)
  }
}
