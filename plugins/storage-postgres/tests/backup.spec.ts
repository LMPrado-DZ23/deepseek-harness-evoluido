import { link, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BACKUP_FILE_PATTERN, BACKUP_LEDGER_FILE, BACKUP_MAX_BYTES_DEFAULT, BACKUP_MIN_INTERVAL_MS, StorageBackupScheduler, childProcessBackupRunner, inProcessBackupRunner, verifyBackupFile, type BackupLogLevel } from '../src/backup.ts'
import { exportedDomain, sealBundle, sha256, validateBundle, type StorageExportBundle } from '../src/bundle.ts'

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
  it('runs the worker out of process without putting the DSN in argv or leaking it from stderr', async () => {
    const root = await directory()
    await mkdir(root, { recursive: true })
    const worker = join(root, 'worker.mjs')
    const secret = 'postgres://operator:p%40ssword@database/studio'
    await writeFile(worker, `
if (process.argv.join(' ').includes(process.env.TEST_DSN)) process.exit(9)
process.stdout.write(JSON.stringify({ sha256: 'a'.repeat(64), bytes: 12, records: 2, domains: 1 }) + '\\n')
`)
    const runner = childProcessBackupRunner({
      dsnRef: 'TEST_DSN', schema: 'dz23_storage', ssl: 'off', workerPath: worker,
      env: { ...process.env, TEST_DSN: secret }, timeoutMs: 5_000, maxBytes: 1024,
    })
    await expect(runner.run(join(root, 'unused'))).resolves.toEqual({ sha256: 'a'.repeat(64), bytes: 12, records: 2, domains: 1 })

    await writeFile(worker, `process.stderr.write('error: ${secret} p@ssword\\n'); process.exit(2)\n`)
    const errorRunner = childProcessBackupRunner({
      dsnRef: 'TEST_DSN', schema: 'dz23_storage', ssl: 'off', workerPath: worker,
      env: { ...process.env, TEST_DSN: secret }, timeoutMs: 5_000, maxBytes: 1024,
    })
    const failure = await errorRunner.run(join(root, 'unused')).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).not.toContain(secret)
    expect((failure as Error).message).not.toContain('p@ssword')
    expect((failure as Error).message).toContain('[redacted]')
  })

  it('rejects a malformed worker report and honours cancellation', async () => {
    const root = await directory()
    await mkdir(root, { recursive: true })
    const worker = join(root, 'worker.mjs')
    const options = { dsnRef: 'TEST_DSN', schema: 'dz23_storage', ssl: 'off' as const, workerPath: worker, env: { ...process.env, TEST_DSN: 'postgres://database/studio' }, timeoutMs: 5_000, maxBytes: 1024 }
    await writeFile(worker, `process.stdout.write('not-json\\n')\n`)
    await expect(childProcessBackupRunner(options).run(join(root, 'unused'))).rejects.toThrow()
    await writeFile(worker, `setTimeout(() => process.stdout.write('{}\\n'), 10_000)\n`)
    const controller = new AbortController()
    const running = childProcessBackupRunner(options).run(join(root, 'unused'), controller.signal)
    controller.abort(new Error('cancelled-worker'))
    await expect(running).rejects.toThrow()
  })

  it('writes a verifiable bundle, a sidecar digest and a ledger line with private permissions', async () => {
    const target = await directory()
    const scheduler = new StorageBackupScheduler({ snapshot: async () => bundle('first'), directory: target, label: 'dz23_storage', intervalMs: BACKUP_MIN_INTERVAL_MS, keep: 3, now: clock(), suffix: fixedSuffix })
    const result = await scheduler.runOnce()
    expect(result).toMatchObject({ status: 'created', records: 1, domains: 1, pruned: [], error: null })
    expect(result.file).toBe(join(target, 'studio-backup-dz23_storage-20260903T120000000Z-abc123.json'))
    expect(BACKUP_FILE_PATTERN.test('studio-backup-dz23_storage-20260903T120000000Z-abc123.json')).toBe(true)
    if (process.platform !== 'win32') {
      expect((await stat(target)).mode & 0o777).toBe(0o700)
      expect((await stat(result.file!)).mode & 0o777).toBe(0o600)
    }
    const verified = await verifyBackupFile(result.file!)
    expect(verified).toMatchObject({ matches: true, sha256: result.sha256, bytes: result.bytes })
    validateBundle(JSON.parse(await readFile(result.file!, 'utf8')) as StorageExportBundle)
    const ledger = (await readFile(join(target, BACKUP_LEDGER_FILE), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { status: string })
    expect(ledger).toEqual([expect.objectContaining({ status: 'created' })])
    expect(scheduler.lastResult).toEqual(result)
  })

  it('publishes marker-last and never deletes newly durable data when marker publication fails', async () => {
    const target = await directory()
    await mkdir(target, { recursive: true })
    const fileName = 'studio-backup-dz23_storage-20260903T120000000Z-abc123.json'
    await writeFile(join(target, `${fileName}.sha256`), 'foreign-marker\n', { mode: 0o600 })
    const scheduler = new StorageBackupScheduler({
      snapshot: async () => bundle('durable'), directory: target, label: 'dz23_storage',
      intervalMs: BACKUP_MIN_INTERVAL_MS, keep: 1, now: clock(), suffix: fixedSuffix,
    })
    const result = await scheduler.runOnce()
    expect(result.status).toBe('failed')
    expect(await readFile(join(target, fileName), 'utf8')).toContain('durable')
    expect(await readFile(join(target, `${fileName}.sha256`), 'utf8')).toBe('foreign-marker\n')
    expect((await readdir(target)).some(name => name.includes('.partial'))).toBe(false)
  })

  it('rehashes the private runner output before publishing any digest marker', async () => {
    const target = await directory()
    const scheduler = new StorageBackupScheduler({
      directory: target, label: 'dz23_storage', intervalMs: BACKUP_MIN_INTERVAL_MS, keep: 2,
      now: clock(), suffix: fixedSuffix,
      runner: {
        run: async partial => {
          await writeFile(partial, 'actual-bytes', { flag: 'wx', mode: 0o600 })
          return { sha256: sha256('different-bytes'), bytes: 12, records: 0, domains: 0 }
        },
      },
    })
    const result = await scheduler.runOnce()
    expect(result.status).toBe('failed')
    expect(result.error).toContain('does not match its digest')
    expect((await readdir(target)).filter(name => name.endsWith('.json') || name.endsWith('.sha256'))).toEqual([])
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

  it('does not let markerless crash remnants consume retention or evict a valid pair', async () => {
    const target = await directory()
    const scheduler = new StorageBackupScheduler({ snapshot: async () => bundle('run'), directory: target, label: 'dz23_storage', intervalMs: BACKUP_MIN_INTERVAL_MS, keep: 2, now: clock(), suffix: fixedSuffix })
    await scheduler.runOnce()
    await scheduler.runOnce()
    const markerless = 'studio-backup-dz23_storage-20260903T120003000Z-deadbe.json'
    await writeFile(join(target, markerless), JSON.stringify(bundle('crash-cut')), { mode: 0o600 })
    const third = await scheduler.runOnce()
    expect(third.pruned).toEqual(['studio-backup-dz23_storage-20260903T120000000Z-abc123.json'])
    const names = await readdir(target)
    expect(names).toContain(markerless)
    expect(names).toContain('studio-backup-dz23_storage-20260903T120002000Z-abc123.json')
    expect(names).toContain('studio-backup-dz23_storage-20260903T120004000Z-abc123.json')
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

  it('refuses a backup directory reached through a symlink before invoking the runner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-backup-link-'))
    scratch.push(root)
    const outside = join(root, 'outside')
    const linked = join(root, 'linked')
    await mkdir(outside)
    try {
      await symlink(outside, linked, 'junction')
    } catch (error) {
      if ((error as { code?: string }).code === 'EPERM') return
      throw error
    }
    let invoked = false
    const scheduler = new StorageBackupScheduler({
      directory: join(linked, 'backups'), label: 'safe_path', intervalMs: BACKUP_MIN_INTERVAL_MS, keep: 2,
      runner: { run: async () => { invoked = true; return { sha256: 'a'.repeat(64), bytes: 0, records: 0, domains: 0 } } },
    })
    const result = await scheduler.runOnce()
    expect(result.status).toBe('failed')
    expect(result.error).toContain('not a real directory')
    expect(invoked).toBe(false)
    expect(await readdir(outside)).toEqual([])
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

  it('refuses hard-linked backup data and sidecars instead of trusting mutable aliases', async () => {
    const target = await directory()
    const scheduler = new StorageBackupScheduler({ snapshot: async () => bundle('x'), directory: target, label: 'dz23_storage', intervalMs: BACKUP_MIN_INTERVAL_MS, keep: 5 })
    const result = await scheduler.runOnce()
    const dataAlias = `${result.file!}.alias`
    await link(result.file!, dataAlias)
    await expect(verifyBackupFile(result.file!)).rejects.toThrow('private regular file')
    await rm(dataAlias)
    const sidecarAlias = `${result.file!}.sha256.alias`
    await link(`${result.file!}.sha256`, sidecarAlias)
    await expect(verifyBackupFile(result.file!)).rejects.toThrow('sidecar')
  })

  it('fails early above the proved JSON ceiling and streams a file within it', async () => {
    const target = await directory()
    await mkdir(target, { recursive: true })
    const file = join(target, 'huge.json')
    const bytes = BACKUP_MAX_BYTES_DEFAULT + 1
    await writeFile(file, '', { flag: 'wx', mode: 0o600 })
    // Sparse: it costs no disk, and every byte still has to go through the digest.
    await truncate(file, bytes)
    await writeFile(`${file}.sha256`, `${'0'.repeat(64)}  huge.json\n`, { encoding: 'utf8', mode: 0o600 })

    // The sparse file is refused from fstat before its contents are read.
    await expect(verifyBackupFile(file, { maxBytes: 4 * 1024 * 1024 })).rejects.toThrow('byte limit')
    await expect(verifyBackupFile(file)).rejects.toThrow(`${String(BACKUP_MAX_BYTES_DEFAULT)} byte limit`)
    await truncate(file, 2 * 1024 * 1024)
    const verified = await verifyBackupFile(file, { maxBytes: 2 * 1024 * 1024 })
    expect(verified.bytes).toBe(2 * 1024 * 1024)
    expect(verified.sha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(verified.matches).toBe(false)
  })

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
        run: async target => {
          runs += 1
          running += 1
          peak = Math.max(peak, running)
          await new Promise(resolvePromise => setTimeout(resolvePromise, 40))
          await writeFile(target, 'x', { flag: 'wx', mode: 0o600 })
          running -= 1
          return { sha256: sha256('x'), bytes: 1, records: 0, domains: 0 }
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
