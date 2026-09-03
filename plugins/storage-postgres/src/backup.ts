import { randomBytes } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { bundleRecordCount, sha256, type StorageExportBundle } from './bundle.js'

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
  error: string | null
}

export type BackupLogLevel = 'info' | 'warn'

export interface BackupSchedulerOptions {
  snapshot: () => Promise<StorageExportBundle>
  directory: string
  /** Backup family, normally the PostgreSQL schema: it names the files and bounds pruning to this family only. */
  label: string
  intervalMs: number
  keep: number
  now?: () => Date
  log?: (level: BackupLogLevel, line: string) => void
  /** Test seam for the per-file suffix; defaults to 6 random hex characters. */
  suffix?: () => string
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
  private last: BackupResult | undefined
  private readonly now: () => Date
  private readonly log: (level: BackupLogLevel, line: string) => void
  private readonly suffix: () => string

  constructor(private readonly options: BackupSchedulerOptions) {
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

  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    await this.inFlight?.catch(() => undefined)
  }

  /** Serialized: a run that overlaps a running one waits for it and then starts. */
  runOnce(): Promise<BackupResult> {
    const previous = this.inFlight ?? Promise.resolve(undefined)
    const run = previous.then(() => this.execute(), () => this.execute())
    this.inFlight = run
    run.finally(() => { if (this.inFlight === run) this.inFlight = undefined }).catch(() => undefined)
    return run
  }

  private async execute(): Promise<BackupResult> {
    const startedAt = this.now().toISOString()
    const stamp = startedAt.replace(/[-:.]/gu, '')
    const fileName = `studio-backup-${this.options.label}-${stamp}-${this.suffix()}.json`
    const target = resolve(this.options.directory, fileName)
    let result: BackupResult
    try {
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
      const bundle = await this.options.snapshot()
      const serialized = `${JSON.stringify(bundle)}\n`
      const digest = sha256(serialized)
      await writeFile(target, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await writeFile(`${target}.sha256`, `${digest}  ${fileName}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      const pruned = await this.prune(fileName)
      result = {
        status: 'created', file: target, sha256: digest, bytes: Buffer.byteLength(serialized),
        records: bundleRecordCount(bundle), domains: bundle.domains.length,
        startedAt, finishedAt: this.now().toISOString(), pruned, error: null,
      }
    } catch (error) {
      result = {
        status: 'failed', file: null, sha256: null, bytes: 0, records: 0, domains: 0,
        startedAt, finishedAt: this.now().toISOString(), pruned: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
    this.last = result
    await this.record(result)
    this.log(result.status === 'created' ? 'info' : 'warn', `storage-postgres backup ${result.status}${result.file === null ? '' : ` ${result.file}`}${result.error === null ? '' : ` (${result.error})`}`)
    return result
  }

  private async prune(current: string): Promise<string[]> {
    const names = (await readdir(this.options.directory)).filter(name => BACKUP_FILE_PATTERN.exec(name)?.[1] === this.options.label).sort()
    const excess = names.filter(name => name !== current).slice(0, Math.max(0, names.length - this.options.keep))
    for (const name of excess) {
      await rm(resolve(this.options.directory, name), { force: true })
      await rm(resolve(this.options.directory, `${name}.sha256`), { force: true })
    }
    return excess
  }

  private async record(result: BackupResult): Promise<void> {
    try {
      const ledger = resolve(this.options.directory, BACKUP_LEDGER_FILE)
      await appendFile(ledger, `${JSON.stringify(result)}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      this.log('warn', `storage-postgres backup ledger write failed (${error instanceof Error ? error.message : String(error)})`)
    }
  }
}

/** Verify a backup file against its sidecar digest without loading it as JSON. */
export async function verifyBackupFile(file: string): Promise<{ file: string; bytes: number; sha256: string; matches: boolean }> {
  const content = await readFile(file)
  const digest = sha256(content)
  const sidecar = (await readFile(`${file}.sha256`, 'utf8')).trim().split(/\s+/u)[0]
  return { file, bytes: (await stat(file)).size, sha256: digest, matches: sidecar === digest }
}
