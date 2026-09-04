import { mkdir, mkdtemp, readdir, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BACKUP_FILE_PATTERN, BACKUP_LEDGER_FILE, BACKUP_MAX_BYTES_DEFAULT, BACKUP_MIN_INTERVAL_MS, StorageBackupScheduler, inProcessBackupRunner, verifyBackupFile, type BackupLogLevel } from '../src/backup.ts'
import { exportedDomain, sealBundle, validateBundle, type StorageExportBundle } from '../src/bundle.ts'

const scratch: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const directory of scratch.splice(0)) await rm(directory, { recursive: true, force: true })
})

function bundle(note: string): StorageExportBundle {
  const descriptor = { name: 'studio_hello', version: 1, tables: ['records'], hasGlobal: false }
  return sealBundle({ kind: 'postgres', sha256: 'a'.repeat(64) }, [
    exportedDomain(descriptor, { tables: { records: { one: { tenant_id: 't', note } } }, global: null }),
  ], '2026-09-03T12:00:00.000Z')
}

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dz23-backup-'))
  scratch.push(path)
  return join(path, 'backups')
}

function clock(): () => Date {
  let second = 0
  return () => new Date(Date.UTC(2026, 8, 3, 12, 0, second++))
}

const fixedSuffix = () => 'abc123'

describe('StorageBackupScheduler', () => {
  it('writes a verifiable bundle, a sidecar digest and a ledger line with private permissions', async () => {
    const target = await directory()
    const scheduler = new StorageBackupScheduler({ snapshot: async () => bundle('first'), directory: target, label: 'dz23_storage', intervalMs: BACKUP_MIN_INTERVAL_MS, keep: 3, now: clock(), suffix: fixedSuffix })
    const result = await scheduler.runOnce()
    expect(result).toMatchObject({ status: 'created', records: 1, domains: 1, pruned: [], error: null })
    expect(result.file).toBe(join(target, 'studio-backup-dz23_storage-20260903T120000000Z-abc123.json'))
    expect(BACKUP_FILE_PATTERN.test('studio-backup-dz23_storage-20260903T120000000Z-abc123.json')).toBe(true)
    expect((await stat(target)).mode & 0o777).toBe(0o700)
    expect((await stat(result.file!)).mode & 0o777).toBe(0o600)
    const verified = await verifyBackupFile(result.file!)
    expect(verified).toMatchObject({ matches: true, sha256: result.sha256, bytes: result.bytes })
    validateBundle(JSON.parse(await readFile(result.file!, 'utf8')) as StorageExportBundle)
    const ledger = (await readFile(join(target, BACKUP_LEDGER_FILE), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { status: string })
    expect(ledger).toEqual([expect.objectContaining({ status: 'created' })])
    expect(scheduler.lastResult).toEqual(result)
  })

  it('prunes only its own label beyond keep and never touches foreign or sibling-label files', async () => {
    const target = await directory()
    const now = clock()
    const scheduler = new StorageBackupScheduler({ snapshot: async () => bundle('run'), directory: target, label: 'dz23_storage', intervalMs: BACKUP_MIN_INTERVAL_MS, keep: 2, now, suffix: fixedSuffix })
    const sibling = new StorageBackupScheduler({ snapshot: async () => bundle('sibling'), directory: target, label: 'other_schema', intervalMs: BACKUP_MIN_INTERVAL_MS, keep: 1, now, suffix: fixedSuffix })
    await scheduler.runOnce()
    await sibling.runOnce()
    await writeFile(join(target, 'notes.txt'), 'keep me', 'utf8')
    await scheduler.runOnce()
    const third = await scheduler.runOnce()
    expect(third.pruned).toEqual(['studio-backup-dz23_storage-20260903T120000000Z-abc123.json'])
    const names = (await readdir(target)).sort()
    expect(names).toEqual([
      BACKUP_LEDGER_FILE, 'notes.txt',
      'studio-backup-dz23_storage-20260903T120004000Z-abc123.json', 'studio-backup-dz23_storage-20260903T120004000Z-abc123.json.sha256',
      'studio-backup-dz23_storage-20260903T120006000Z-abc123.json', 'studio-backup-dz23_storage-20260903T120006000Z-abc123.json.sha256',
      'studio-backup-other_schema-20260903T120002000Z-abc123.json', 'studio-backup-other_schema-20260903T120002000Z-abc123.json.sha256',
    ])
  })

  it('records a failed snapshot as a warning without throwing and keeps serving the next run', async () => {
    const target = await directory()
    const log: Array<[BackupLogLevel, string]> = []
    let calls = 0
    const scheduler = new StorageBackupScheduler({
      snapshot: async () => { if (calls++ === 0) throw new Error('connection refused'); return bundle('recovered') },
      directory: target, label: 'dz23_storage', intervalMs: BACKUP_MIN_INTERVAL_MS, keep: 5, log: (level, line) => log.push([level, line]),
      now: () => new Date(Date.UTC(2026, 8, 3, 12, 0, calls)),
    })
    const failed = await scheduler.runOnce()
    expect(failed).toMatchObject({ status: 'failed', file: null, error: 'connection refused' })
    expect(log[0]).toEqual(['warn', expect.stringContaining('backup failed')])
    const recovered = await scheduler.runOnce()
    expect(recovered.status).toBe('created')
    expect(log[1]).toEqual(['info', expect.stringContaining('backup created')])
    const ledger = (await readFile(join(target, BACKUP_LEDGER_FILE), 'utf8')).trim().split('\n')
    expect(ledger).toHaveLength(2)
  })

  it('serializes overlapping runs and never collides on the file name within one second', async () => {
    const target = await directory()
    const order: string[] = []
    const scheduler = new StorageBackupScheduler({
      snapshot: async () => { order.push('start'); await new Promise(resolve => setTimeout(resolve, 5)); order.push('end'); return bundle('x') },
      directory: target, label: 'dz23_storage', intervalMs: BACKUP_MIN_INTERVAL_MS, keep: 5, now: () => new Date(Date.UTC(2026, 8, 3, 12, 0, 0)),
    })
    const [first, second] = await Promise.all([scheduler.runOnce(), scheduler.runOnce()])
    expect(order).toEqual(['start', 'end', 'start', 'end'])
    expect(first.status).toBe('created')
    expect(second.status).toBe('created')
    expect(first.file).not.toBe(second.file)
  })

  it('backs up immediately on start, then on its interval, and stops cleanly', async () => {
    vi.useFakeTimers()
    const target = await directory()
    let runs = 0
    const scheduler = new StorageBackupScheduler({
      snapshot: async () => { runs++; return bundle('tick') }, directory: target, label: 'dz23_storage', intervalMs: BACKUP_MIN_INTERVAL_MS, keep: 5,
      now: () => new Date(Date.UTC(2026, 8, 3, 12, 0, runs)),
    })
    scheduler.start()
    scheduler.start()
    await vi.advanceTimersByTimeAsync(10)
    await scheduler.stop()
    expect(runs).toBe(1)
    scheduler.start()
    await vi.advanceTimersByTimeAsync(BACKUP_MIN_INTERVAL_MS * 2 + 10)
    await scheduler.stop()
    // Two ticks fired, and `stop()` drained whatever was still owed. The exact count depends on
    // whether a copy finished before the next tick — ticks that overlap COALESCE on purpose (own
    // test below), so the contract is "it kept backing up, bounded by one run per tick", not a
    // fixed number that would only hold if the disk were always fast enough.
    const afterTicks = runs
    expect(afterTicks).toBeGreaterThan(1)
    expect(afterTicks).toBeLessThanOrEqual(4)
    // Stopped means stopped: no further tick produces anything.
    await vi.advanceTimersByTimeAsync(BACKUP_MIN_INTERVAL_MS * 2)
    await scheduler.stop()
    expect(runs).toBe(afterTicks)
  })

  it('refuses an interval under five minutes, a non-positive keep and an unsafe label', () => {
    const options = { snapshot: async () => bundle('x'), directory: '/nowhere', label: 'dz23_storage' }
    expect(() => new StorageBackupScheduler({ ...options, intervalMs: 60_000, keep: 1 })).toThrow('at least 5 minutes')
    expect(() => new StorageBackupScheduler({ ...options, intervalMs: BACKUP_MIN_INTERVAL_MS, keep: 0 })).toThrow('positive integer')
    expect(() => new StorageBackupScheduler({ ...options, label: '../x', intervalMs: BACKUP_MIN_INTERVAL_MS, keep: 1 })).toThrow('backup label')
  })

  it('reports a ledger write failure as a warning instead of failing the backup', async () => {
    const target = await directory()
    const log: Array<[BackupLogLevel, string]> = []
    const scheduler = new StorageBackupScheduler({ snapshot: async () => bundle('x'), directory: target, label: 'dz23_storage', intervalMs: BACKUP_MIN_INTERVAL_MS, keep: 5, log: (level, line) => log.push([level, line]) })
    await mkdir(join(target, BACKUP_LEDGER_FILE), { recursive: true })
    const result = await scheduler.runOnce()
    expect(result.status).toBe('created')
    expect(log.some(([level, line]) => level === 'warn' && line.includes('ledger write failed'))).toBe(true)
  })

  it('flags a tampered backup through its sidecar digest', async () => {
    const target = await directory()
    const scheduler = new StorageBackupScheduler({ snapshot: async () => bundle('x'), directory: target, label: 'dz23_storage', intervalMs: BACKUP_MIN_INTERVAL_MS, keep: 5 })
    const result = await scheduler.runOnce()
    await writeFile(result.file!, '{"tampered":true}\n', 'utf8')
    expect((await verifyBackupFile(result.file!)).matches).toBe(false)
  })

  it('verifies a file larger than Node can read at once, streaming, and refuses one over the ceiling', async () => {
    // The verifier used to do `readFile(file)`: 2 GiB of backup became 2 GiB of live memory in
    // whichever process asked, and anything at or above Node's own whole-file ceiling could not
    // be verified AT ALL — the exact size the worker is allowed to write.
    const target = await directory()
    await mkdir(target, { recursive: true })
    const file = join(target, 'huge.json')
    const bytes = BACKUP_MAX_BYTES_DEFAULT + 1
    await writeFile(file, '', { flag: 'wx', mode: 0o600 })
    // Sparse: it costs no disk, and every byte still has to go through the digest.
    await truncate(file, bytes)
    await writeFile(`${file}.sha256`, `${'0'.repeat(64)}  huge.json\n`, { encoding: 'utf8', mode: 0o600 })

    // This is what the old implementation would hit, and why it could not answer at all.
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ERR_FS_FILE_TOO_LARGE' })
    // Bounded: over the ceiling it stops instead of reading on.
    await expect(verifyBackupFile(file, { maxBytes: 4 * 1024 * 1024 })).rejects.toThrow('byte limit')
    await expect(verifyBackupFile(file)).rejects.toThrow(`${String(BACKUP_MAX_BYTES_DEFAULT)} byte limit`)
    // And with room to work, it reads the whole thing without ever holding it.
    const verified = await verifyBackupFile(file, { maxBytes: bytes })
    expect(verified.bytes).toBe(bytes)
    expect(verified.sha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(verified.matches).toBe(false)
  }, 180_000)

  it('refuses an in-process backup over the ceiling instead of filling the disk', async () => {
    const target = await directory()
    const scheduler = new StorageBackupScheduler({
      runner: inProcessBackupRunner(async () => bundle('x'.repeat(4096)), { maxBytes: 512 }),
      directory: target, label: 'dz23_storage', intervalMs: BACKUP_MIN_INTERVAL_MS, keep: 5,
    })
    const result = await scheduler.runOnce()
    expect(result).toMatchObject({ status: 'failed', file: null })
    expect(result.error).toContain('512 byte limit')
    expect((await readdir(target)).filter(name => name.endsWith('.json'))).toEqual([])
  })

  it('coalesces overlapping ticks into one waiting run instead of growing a queue', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dz23-backup-coalesce-'))
    let running = 0
    let peak = 0
    let runs = 0
    const scheduler = new StorageBackupScheduler({
      directory, label: 'coalesce', intervalMs: BACKUP_MIN_INTERVAL_MS, keep: 5,
      runner: {
        run: async () => {
          runs += 1
          running += 1
          peak = Math.max(peak, running)
          await new Promise(resolvePromise => setTimeout(resolvePromise, 40))
          running -= 1
          return { sha256: 'a'.repeat(64), bytes: 1, records: 0, domains: 0 }
        },
      },
      suffix: () => String(runs).padStart(6, '0'),
    })
    try {
      // Ten ticks while one copy is running: one runs now, ONE waits, the other eight join it.
      const results = await Promise.all(Array.from({ length: 10 }, () => scheduler.runOnce()))
      expect(peak).toBe(1)
      expect(runs).toBe(2)
      expect(results.every(result => result.status === 'created')).toBe(true)
    } finally {
      await scheduler.stop()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
