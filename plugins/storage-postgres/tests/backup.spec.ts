import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BACKUP_LEDGER_FILE, BACKUP_MIN_INTERVAL_MS, StorageBackupScheduler, verifyBackupFile } from '../src/backup.ts'
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

describe('StorageBackupScheduler', () => {
  it('writes a verifiable bundle, a sidecar digest and a ledger line with private permissions', async () => {
    const target = await directory()
    let tick = 0
    const now = () => new Date(Date.UTC(2026, 8, 3, 12, 0, tick++))
    const scheduler = new StorageBackupScheduler({ snapshot: async () => bundle('first'), directory: target, intervalMs: BACKUP_MIN_INTERVAL_MS, keep: 3, now })
    const result = await scheduler.runOnce()
    expect(result).toMatchObject({ status: 'created', records: 1, domains: 1, pruned: [], error: null })
    expect(result.file).toBe(join(target, 'studio-backup-20260903T120000Z.json'))
    expect((await stat(target)).mode & 0o777).toBe(0o700)
    expect((await stat(result.file!)).mode & 0o777).toBe(0o600)
    const verified = await verifyBackupFile(result.file!)
    expect(verified).toMatchObject({ matches: true, sha256: result.sha256, bytes: result.bytes })
    validateBundle(JSON.parse(await readFile(result.file!, 'utf8')) as StorageExportBundle)
    const ledger = (await readFile(join(target, BACKUP_LEDGER_FILE), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { status: string })
    expect(ledger).toEqual([expect.objectContaining({ status: 'created' })])
    expect(scheduler.lastResult).toEqual(result)
  })

  it('prunes only its own oldest bundles beyond keep and never touches foreign files', async () => {
    const target = await directory()
    let second = 0
    const now = () => new Date(Date.UTC(2026, 8, 3, 12, 0, second++))
    const scheduler = new StorageBackupScheduler({ snapshot: async () => bundle(`run-${String(second)}`), directory: target, intervalMs: BACKUP_MIN_INTERVAL_MS, keep: 2, now })
    await scheduler.runOnce()
    await writeFile(join(target, 'notes.txt'), 'keep me', 'utf8')
    await scheduler.runOnce()
    const third = await scheduler.runOnce()
    expect(third.pruned).toEqual(['studio-backup-20260903T120000Z.json'])
    const names = (await readdir(target)).sort()
    expect(names).toEqual([
      BACKUP_LEDGER_FILE, 'notes.txt',
      'studio-backup-20260903T120002Z.json', 'studio-backup-20260903T120002Z.json.sha256',
      'studio-backup-20260903T120004Z.json', 'studio-backup-20260903T120004Z.json.sha256',
    ])
  })

  it('records a failed snapshot without throwing and keeps serving the next run', async () => {
    const target = await directory()
    const log: string[] = []
    let calls = 0
    const scheduler = new StorageBackupScheduler({
      snapshot: async () => { if (calls++ === 0) throw new Error('connection refused'); return bundle('recovered') },
      directory: target, intervalMs: BACKUP_MIN_INTERVAL_MS, keep: 5, log: line => log.push(line),
      now: () => new Date(Date.UTC(2026, 8, 3, 12, 0, calls)),
    })
    const failed = await scheduler.runOnce()
    expect(failed).toMatchObject({ status: 'failed', file: null, error: 'connection refused' })
    expect(log[0]).toContain('backup failed')
    const recovered = await scheduler.runOnce()
    expect(recovered.status).toBe('created')
    const ledger = (await readFile(join(target, BACKUP_LEDGER_FILE), 'utf8')).trim().split('\n')
    expect(ledger).toHaveLength(2)
  })

  it('serializes overlapping runs so two snapshots never race on the same stamp', async () => {
    const target = await directory()
    const order: string[] = []
    let stamp = 0
    const scheduler = new StorageBackupScheduler({
      snapshot: async () => { order.push('start'); await new Promise(resolve => setTimeout(resolve, 5)); order.push('end'); return bundle('x') },
      directory: target, intervalMs: BACKUP_MIN_INTERVAL_MS, keep: 5, now: () => new Date(Date.UTC(2026, 8, 3, 12, 0, stamp++)),
    })
    const [first, second] = await Promise.all([scheduler.runOnce(), scheduler.runOnce()])
    expect(order).toEqual(['start', 'end', 'start', 'end'])
    expect(first.file).not.toBe(second.file)
    expect(first.status).toBe('created')
    expect(second.status).toBe('created')
  })

  it('runs on its interval after start and stops cleanly', async () => {
    vi.useFakeTimers()
    const target = await directory()
    let runs = 0
    const scheduler = new StorageBackupScheduler({
      snapshot: async () => { runs++; return bundle('tick') }, directory: target, intervalMs: BACKUP_MIN_INTERVAL_MS, keep: 5,
      now: () => new Date(Date.UTC(2026, 8, 3, 12, 0, runs)),
    })
    scheduler.start()
    scheduler.start()
    await vi.advanceTimersByTimeAsync(BACKUP_MIN_INTERVAL_MS * 2 + 10)
    await scheduler.stop()
    expect(runs).toBe(2)
    await vi.advanceTimersByTimeAsync(BACKUP_MIN_INTERVAL_MS * 2)
    expect(runs).toBe(2)
    await scheduler.stop()
  })

  it('refuses an interval under five minutes or a non-positive keep', () => {
    const options = { snapshot: async () => bundle('x'), directory: '/nowhere' }
    expect(() => new StorageBackupScheduler({ ...options, intervalMs: 60_000, keep: 1 })).toThrow('at least 5 minutes')
    expect(() => new StorageBackupScheduler({ ...options, intervalMs: BACKUP_MIN_INTERVAL_MS, keep: 0 })).toThrow('positive integer')
  })

  it('reports a ledger write failure through the log instead of failing the backup', async () => {
    const target = await directory()
    const log: string[] = []
    const scheduler = new StorageBackupScheduler({ snapshot: async () => bundle('x'), directory: target, intervalMs: BACKUP_MIN_INTERVAL_MS, keep: 5, log: line => log.push(line) })
    await mkdir(join(target, BACKUP_LEDGER_FILE), { recursive: true })
    const result = await scheduler.runOnce()
    expect(result.status).toBe('created')
    expect(log.some(line => line.includes('ledger write failed'))).toBe(true)
  })

  it('flags a tampered backup through its sidecar digest', async () => {
    const target = await directory()
    const scheduler = new StorageBackupScheduler({ snapshot: async () => bundle('x'), directory: target, intervalMs: BACKUP_MIN_INTERVAL_MS, keep: 5 })
    const result = await scheduler.runOnce()
    await writeFile(result.file!, '{"tampered":true}\n', 'utf8')
    expect((await verifyBackupFile(result.file!)).matches).toBe(false)
  })
})
