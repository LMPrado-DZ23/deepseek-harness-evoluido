import { execFile } from 'node:child_process'
import { constants, existsSync } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { link, lstat, open, opendir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { bundleRecordCount, sha256, type StorageExportBundle } from './bundle.js'
import { assertPinnedDirectory, childPath, openNewPinnedFile, openPinnedAppendFile, pinnedChildPath, pinDirectory, pinParent, syncPinnedDirectory, type PinnedDirectory } from './safe-path.js'
import { OPERATOR_BUNDLE_MAX_BYTES, assertOperatorBundleLimit } from './operator-limits.js'

/** Ceiling shared by the worker, the operator CLI and the verifier: one number, one behaviour. */
export const BACKUP_MAX_BYTES_DEFAULT = OPERATOR_BUNDLE_MAX_BYTES

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
  const maxBytes = assertOperatorBundleLimit(options.maxBytes ?? BACKUP_MAX_BYTES_DEFAULT, 'backup maxBytes')
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
        await file.sync()
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
  const maxBytes = assertOperatorBundleLimit(options.maxBytes ?? BACKUP_MAX_BYTES_DEFAULT, 'backup maxBytes')
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
              const rawDetail = lines.find(line => /error/iu.test(line)) ?? lines.at(-1) ?? ''
              const detail = sanitizeChildDetail(rawDetail, options.env?.[options.dsnRef] ?? process.env[options.dsnRef]).slice(0, 300)
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

function sanitizeChildDetail(detail: string, dsn: string | undefined): string {
  let safe = detail
  if (dsn !== undefined && dsn !== '') {
    safe = safe.replaceAll(dsn, '[redacted]')
    try {
      const parsed = new URL(dsn)
      for (const value of [parsed.password, decodeURIComponent(parsed.password)]) if (value !== '') safe = safe.replaceAll(value, '[redacted]')
    } catch { /* malformed DSN is still replaced as a whole above */ }
  }
  return safe.replaceAll(/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s/]+@/giu, '$1[redacted]@')
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
    const partialName = `.${fileName}.partial-${randomBytes(8).toString('hex')}`
    const partialSidecar = `${partialName}.sha256`
    let directory: PinnedDirectory | undefined
    let target = ''
    let result: BackupResult
    try {
      directory = await pinDirectory(this.options.directory, true)
      target = childPath(directory, fileName)
      const partialTarget = childPath(directory, partialName)
      const written = await this.runner.run(partialTarget, this.options.signal)
      throwIfAborted(this.options.signal)
      await assertPinnedDirectory(directory)
      if (!/^[a-f0-9]{64}$/u.test(written.sha256) || !Number.isSafeInteger(written.bytes) || written.bytes < 1) {
        throw new Error('backup runner returned invalid publication metadata')
      }
      const partialFile = await open(pinnedChildPath(directory, partialName), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      let verifiedStats: BigIntStats
      try {
        const before = await partialFile.stat({ bigint: true })
        if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(written.bytes)) {
          throw new Error('backup runner did not produce the private file it reported')
        }
        const hash = createHash('sha256')
        const block = Buffer.allocUnsafe(1024 * 1024)
        let offset = 0
        for (;;) {
          throwIfAborted(this.options.signal)
          const chunk = await partialFile.read(block, 0, block.byteLength, offset)
          if (chunk.bytesRead === 0) break
          offset += chunk.bytesRead
          if (offset > BACKUP_MAX_BYTES_DEFAULT) throw new Error(`backup exceeds the ${String(BACKUP_MAX_BYTES_DEFAULT)} byte limit`)
          hash.update(block.subarray(0, chunk.bytesRead))
        }
        const after = await partialFile.stat({ bigint: true })
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs || hash.digest('hex') !== written.sha256) {
          throw new Error('backup runner output changed or does not match its digest')
        }
        verifiedStats = after
      } finally { await partialFile.close() }
      const sidecar = await openNewPinnedFile(directory, partialSidecar)
      try {
        await sidecar.writeFile(`${written.sha256}  ${fileName}\n`, { encoding: 'utf8' })
        await sidecar.sync()
      } finally { await sidecar.close() }
      const partialPath = pinnedChildPath(directory, partialName)
      const beforePublish = await lstat(partialPath, { bigint: true })
      if (beforePublish.dev !== verifiedStats.dev || beforePublish.ino !== verifiedStats.ino || beforePublish.size !== verifiedStats.size || beforePublish.mtimeNs !== verifiedStats.mtimeNs || beforePublish.nlink !== 1n) {
        throw new Error('backup runner output changed before publication')
      }
      await link(partialPath, pinnedChildPath(directory, fileName))
      const published = await lstat(pinnedChildPath(directory, fileName), { bigint: true })
      if (published.dev !== verifiedStats.dev || published.ino !== verifiedStats.ino || published.size !== verifiedStats.size || published.mtimeNs !== verifiedStats.mtimeNs) {
        throw new Error('backup publication did not preserve the verified file')
      }
      await rm(pinnedChildPath(directory, partialName))
      await syncPinnedDirectory(directory)
      await link(pinnedChildPath(directory, partialSidecar), pinnedChildPath(directory, `${fileName}.sha256`))
      await rm(pinnedChildPath(directory, partialSidecar))
      await syncPinnedDirectory(directory)
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
          // Only unpublished temporary names belong to this failed attempt. A
          // final data file may already be durable while its marker failed;
          // deleting it here would turn a publication error into data loss.
          await rm(pinnedChildPath(directory!, partialName), { force: true }).catch(() => undefined)
          await rm(pinnedChildPath(directory!, partialSidecar), { force: true }).catch(() => undefined)
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
      if (!await isCommittedBackupEntry(directory, entry.name)) continue
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

async function isCommittedBackupEntry(directory: PinnedDirectory, name: string): Promise<boolean> {
  try {
    const [data, marker] = await Promise.all([
      lstat(pinnedChildPath(directory, name), { bigint: true }),
      lstat(pinnedChildPath(directory, `${name}.sha256`), { bigint: true }),
    ])
    if (!data.isFile() || data.isSymbolicLink() || data.nlink !== 1n || !marker.isFile() || marker.isSymbolicLink() || marker.nlink !== 1n || marker.size > 1024n) return false
    const file = await open(pinnedChildPath(directory, `${name}.sha256`), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const contents = (await file.readFile('utf8')).trim()
      const after = await file.stat({ bigint: true })
      return after.isFile() && after.nlink === 1n && after.dev === marker.dev && after.ino === marker.ino && after.size === marker.size && after.mtimeNs === marker.mtimeNs &&
        new RegExp(`^[a-f0-9]{64}\\s+${escapeRegExp(name)}$`, 'u').test(contents)
    } finally { await file.close().catch(() => undefined) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason instanceof Error ? signal.reason : new Error('Operação cancelada.')
}

/**
 * Verify a backup file against its sidecar digest.
 *
 * STREAMED, and bounded. Reading the whole file into a Buffer meant a large
 * backup also became a large live allocation in the verifier. Here the
 * bytes go through the digest as they arrive, so memory stays flat whatever the
 * file weighs, and a file over `maxBytes` is refused instead of being read.
 */
export async function verifyBackupFile(
  file: string,
  options: { maxBytes?: number } = {},
): Promise<{ file: string; bytes: number; sha256: string; matches: boolean }> {
  const maxBytes = assertOperatorBundleLimit(options.maxBytes ?? BACKUP_MAX_BYTES_DEFAULT, 'backup maxBytes')
  const hash = createHash('sha256')
  let bytes = 0
  const parent = await pinParent(file)
  const noFollow = constants.O_NOFOLLOW ?? 0
  try {
    const dataPath = pinnedChildPath(parent.directory, parent.name)
    const inspected = await lstat(dataPath, { bigint: true })
    if (!inspected.isFile() || inspected.isSymbolicLink() || inspected.nlink !== 1n || inspected.size > BigInt(maxBytes)) {
      throw new Error(`backup file '${file}' is not a private regular file within the ${String(maxBytes)} byte limit`)
    }
    const data = await open(dataPath, constants.O_RDONLY | noFollow)
    try {
      const dataStats = await data.stat({ bigint: true })
      if (!dataStats.isFile() || dataStats.nlink !== 1n || dataStats.dev !== inspected.dev || dataStats.ino !== inspected.ino || dataStats.size !== inspected.size || dataStats.mtimeNs !== inspected.mtimeNs) {
        throw new Error(`backup file '${file}' changed while it was being opened`)
      }
      const block = Buffer.allocUnsafe(1024 * 1024)
      for (;;) {
        const chunk = await data.read(block, 0, block.byteLength, bytes)
        if (chunk.bytesRead === 0) break
        bytes += chunk.bytesRead
        if (bytes > maxBytes) throw new Error(`backup file '${file}' exceeds the ${String(maxBytes)} byte limit`)
        hash.update(block.subarray(0, chunk.bytesRead))
      }
      const after = await data.stat({ bigint: true })
      if (after.dev !== dataStats.dev || after.ino !== dataStats.ino || after.size !== dataStats.size || after.mtimeNs !== dataStats.mtimeNs) {
        throw new Error(`backup file '${file}' changed while it was being verified`)
      }
    } finally {
      await data.close().catch(() => undefined)
    }
    await assertPinnedDirectory(parent.directory)
    const digest = hash.digest('hex')
    const sidecarPath = pinnedChildPath(parent.directory, `${parent.name}.sha256`)
    const inspectedSidecar = await lstat(sidecarPath, { bigint: true })
    if (!inspectedSidecar.isFile() || inspectedSidecar.isSymbolicLink() || inspectedSidecar.nlink !== 1n || inspectedSidecar.size > 1024n) {
      throw new Error(`backup sidecar for '${file}' is invalid`)
    }
    const sidecarFile = await open(sidecarPath, constants.O_RDONLY | noFollow)
    try {
      const stats = await sidecarFile.stat({ bigint: true })
      if (!stats.isFile() || stats.nlink !== 1n || stats.dev !== inspectedSidecar.dev || stats.ino !== inspectedSidecar.ino || stats.size !== inspectedSidecar.size || stats.mtimeNs !== inspectedSidecar.mtimeNs) {
        throw new Error(`backup sidecar for '${file}' changed while it was being opened`)
      }
      const sidecar = (await sidecarFile.readFile('utf8')).trim().split(/\s+/u)[0]
      const after = await sidecarFile.stat({ bigint: true })
      if (after.dev !== stats.dev || after.ino !== stats.ino || after.size !== stats.size || after.mtimeNs !== stats.mtimeNs) {
        throw new Error(`backup sidecar for '${file}' changed while it was being verified`)
      }
      await assertPinnedDirectory(parent.directory)
      return { file, bytes, sha256: digest, matches: sidecar === digest }
    } finally {
      await sidecarFile.close().catch(() => undefined)
    }
  } finally {
    await parent.directory.handle.close().catch(() => undefined)
  }
}
