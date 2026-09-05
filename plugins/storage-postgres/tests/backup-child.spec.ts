/**
 * The seams around the separate backup process: how a child that dies is
 * reported, what report the parent will accept from it, and how the worker
 * reads its own command line. Every child here is a REAL `node` process
 * started by the production runner; failures are simulated by making the
 * process behave badly (hang, exit non-zero, print rubbish), never by
 * stubbing the module under test.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BACKUP_LEDGER_FILE, StorageBackupScheduler, childProcessBackupRunner, type BackupResult } from '../src/backup.ts'
import { parseWorkerArgs } from '../src/backup-worker.ts'
import { assertTlsPolicy, TLS_POLICIES } from '../src/dsn.ts'
import { OPERATOR_BUNDLE_MAX_BYTES } from '../src/operator-limits.ts'

const scratch: string[] = []
afterEach(async () => { for (const directory of scratch.splice(0)) await rm(directory, { recursive: true, force: true }) })

/** Writes a stand-in worker and returns its path. It is a real ES module run by a real node. */
async function fakeWorker(body: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dz23-fake-worker-'))
  scratch.push(directory)
  const path = join(directory, 'worker.mjs')
  await writeFile(path, `${body}\n`, 'utf8')
  return path
}

function runner(workerPath: string, timeoutMs = 30_000): ReturnType<typeof childProcessBackupRunner> {
  return childProcessBackupRunner({ dsnRef: 'DZ23_STORAGE_BACKUP_DSN', schema: 'dz23_storage', ssl: 'off', workerPath, timeoutMs })
}

describe('childProcessBackupRunner: what the Studio is told when the backup process dies', () => {
  it('names the time limit when the child is killed by it, even though the child left an unrelated line on stderr', async () => {
    // A worker that says something harmless and then never finishes: exactly the stuck
    // backup the timeout exists for. The stderr line must not be able to pass itself off
    // as the reason the run failed — that sentence goes into backups.jsonl forever.
    const worker = await fakeWorker(`process.stderr.write('a note from the worker\\n')\nsetInterval(() => {}, 1000)`)
    await expect(runner(worker, 800).run(join(tmpdir(), 'never-written.json')))
      .rejects.toThrow(/exceeded the 800 ms time limit and was killed \(a note from the worker\)/u)
  })

  it('names the time limit when the killed child left nothing behind at all', async () => {
    const worker = await fakeWorker('setInterval(() => {}, 1000)')
    let failure = ''
    await runner(worker, 800).run(join(tmpdir(), 'never-written.json')).catch((error: unknown) => { failure = (error as Error).message })
    expect(failure).toBe('backup process exceeded the 800 ms time limit and was killed')
    // The bare execFile message used to be surfaced instead: the whole command line, and no reason.
    expect(failure).not.toContain('Command failed')
  })

  it('surfaces the child\'s own error line when it fails for a reason of its own', async () => {
    const worker = await fakeWorker(`process.stderr.write('some warning\\nError: backup exceeds the 1 byte limit\\n')\nprocess.exit(1)`)
    await expect(runner(worker).run(join(tmpdir(), 'never-written.json')))
      .rejects.toThrow('Error: backup exceeds the 1 byte limit')
  })

  it('reports the message the worker threw, not the source line node echoes above it', async () => {
    // A real uncaught throw: node prints the offending SOURCE line first, template literal
    // and all. That line is not the reason, and it is what the ledger used to keep forever.
    const worker = await fakeWorker('const args = { maxBytes: 1 }\nthrow new Error(`backup exceeds the ${String(args.maxBytes)} byte limit`)')
    let failure = ''
    await runner(worker).run(join(tmpdir(), 'never-written.json')).catch((error: unknown) => { failure = (error as Error).message })
    expect(failure).toBe('Error: backup exceeds the 1 byte limit')
    expect(failure).not.toContain('throw new Error')
    expect(failure).not.toContain('${String(')
  })

  it('still reports a child that died without a javascript exception at all', async () => {
    // The heap limit kills the process from below the language: there is no `Error:` line.
    const worker = await fakeWorker(`process.stderr.write('<--- Last few GCs --->\\nFATAL ERROR: Reached heap limit Allocation failed\\n 1: 0xdeadbeef node::Abort()\\n')\nprocess.exit(134)`)
    await expect(runner(worker).run(join(tmpdir(), 'never-written.json'))).rejects.toThrow('FATAL ERROR: Reached heap limit Allocation failed')
  })

  it('falls back to the last stderr line when nothing in it looks like an error', async () => {
    const worker = await fakeWorker(`process.stderr.write('first\\nlast word\\n')\nprocess.exit(3)`)
    let failure = ''
    await runner(worker).run(join(tmpdir(), 'never-written.json')).catch((error: unknown) => { failure = (error as Error).message })
    // Exactly that line, and nothing else: without the fallback the Studio would be handed
    // execFile's own `Command failed: <the whole command line>` instead of what the child said.
    expect(failure).toBe('last word')
  })

  it('refuses a report that does not say how much was copied instead of recording a backup of unknown size', async () => {
    // sha256 and bytes alone used to be accepted, and the ledger line then simply had no
    // `records`/`domains` at all: a run recorded as created that claims nothing it did.
    const worker = await fakeWorker(`process.stdout.write(JSON.stringify({ sha256: 'a'.repeat(64), bytes: 10 }) + '\\n')`)
    await expect(runner(worker).run(join(tmpdir(), 'never-written.json'))).rejects.toThrow('backup worker report is malformed')
  })

  it('refuses a digest that is not a sha256 and counts that are not whole and positive', async () => {
    const full = (extra: string): string => `process.stdout.write(JSON.stringify({ sha256: 'a'.repeat(64), bytes: 1, records: 1, domains: 1, ${extra} }) + '\\n')`
    for (const bad of [`sha256: 'not-a-digest'`, 'bytes: -1', 'records: 1.5', 'domains: null']) {
      const worker = await fakeWorker(full(bad))
      await expect(runner(worker).run(join(tmpdir(), 'never-written.json'))).rejects.toThrow('backup worker report is malformed')
    }
  })

  it('refuses stdout that is not a report at all', async () => {
    const worker = await fakeWorker(`process.stdout.write('not json\\n')`)
    await expect(runner(worker).run(join(tmpdir(), 'never-written.json'))).rejects.toThrow(/JSON/u)
  })

  it('accepts a complete report, reading only the last line the child printed', async () => {
    const worker = await fakeWorker(`process.stdout.write('chatter the worker printed first\\n')\nprocess.stdout.write(JSON.stringify({ sha256: 'b'.repeat(64), bytes: 42, records: 7, domains: 2 }) + '\\n')`)
    await expect(runner(worker).run(join(tmpdir(), 'never-written.json'))).resolves.toEqual({ sha256: 'b'.repeat(64), bytes: 42, records: 7, domains: 2 })
  })

  it('hands the child the schema, the target and the DSN by reference only', async () => {
    // The DSN itself must never reach argv: a command line is readable by every user on the machine.
    const worker = await fakeWorker(`process.stdout.write(JSON.stringify({ sha256: 'c'.repeat(64), bytes: process.argv.slice(2).join(' ').length, records: 0, domains: 0 }) + '\\n')\nprocess.stderr.write(process.argv.slice(2).join(' '))`)
    const report = await childProcessBackupRunner({ dsnRef: 'DZ23_STORAGE_BACKUP_DSN', schema: 'dz23_storage', ssl: 'verify-full', workerPath: worker, maxBytes: 1024 }).run('/tmp/target.json')
    expect(report.bytes).toBe('--dsn-ref DZ23_STORAGE_BACKUP_DSN --schema dz23_storage --ssl verify-full --out /tmp/target.json --max-bytes 1024'.length)
  })
})

describe('parseWorkerArgs: the worker reading its own command line', () => {
  it('defaults fail closed: full TLS verification and the bounded operator ceiling', () => {
    expect(parseWorkerArgs(['--dsn-ref', 'DZ23_STORAGE_BACKUP_DSN', '--schema', 'dz23_storage', '--out', '/tmp/b.json']))
      .toEqual({ dsnRef: 'DZ23_STORAGE_BACKUP_DSN', schema: 'dz23_storage', ssl: 'verify-full', out: '/tmp/b.json', maxBytes: OPERATOR_BUNDLE_MAX_BYTES })
  })

  it('reads every flag the runner passes', () => {
    expect(parseWorkerArgs(['--dsn-ref', 'REF', '--schema', 's', '--ssl', 'require', '--out', '/o.json', '--max-bytes', '4096']))
      .toEqual({ dsnRef: 'REF', schema: 's', ssl: 'require', out: '/o.json', maxBytes: 4096 })
    expect(parseWorkerArgs(['--dsn-ref', 'REF', '--schema', 's', '--ssl', 'off', '--out', '/o.json']).ssl).toBe('off')
  })

  it('refuses a TLS mode it does not know rather than guessing one', () => {
    for (const bad of ['disable', 'prefer', 'VERIFY-FULL', '']) {
      expect(() => parseWorkerArgs(['--dsn-ref', 'R', '--schema', 's', '--out', '/o', '--ssl', bad]))
        .toThrow('--ssl must be off, require or verify-full')
    }
  })

  it('refuses a ceiling that is not a whole positive number of bytes', () => {
    for (const bad of ['0', '-1', 'lots', '1.5', 'Infinity', '']) {
      expect(() => parseWorkerArgs(['--dsn-ref', 'R', '--schema', 's', '--out', '/o', '--max-bytes', bad]))
        .toThrow(`--max-bytes must be an integer between 1 and ${String(OPERATOR_BUNDLE_MAX_BYTES)}`)
    }
  })

  it('refuses to run without the three flags that have no safe default', () => {
    expect(() => parseWorkerArgs(['--schema', 's', '--out', '/o'])).toThrow('Missing --dsn-ref')
    expect(() => parseWorkerArgs(['--dsn-ref', 'R', '--out', '/o'])).toThrow('Missing --schema')
    expect(() => parseWorkerArgs(['--dsn-ref', 'R', '--schema', 's'])).toThrow('Missing --out')
    // A flag written with no value after it is a missing flag, not an empty one.
    expect(() => parseWorkerArgs(['--dsn-ref', 'R', '--schema', 's', '--out'])).toThrow('Missing --out')
  })
})

describe('assertTlsPolicy', () => {
  it('accepts exactly the three policies this product implements', () => {
    for (const policy of TLS_POLICIES) expect(assertTlsPolicy(policy)).toBe(policy)
  })

  it('refuses anything else instead of letting an unknown word decide the encryption', () => {
    for (const bad of ['disable', 'allow', 'prefer', 'verify-ca', 'Off', 'true', '1', '']) {
      expect(() => assertTlsPolicy(bad)).toThrow('--ssl must be off, require or verify-full')
    }
  })
})

describe('StorageBackupScheduler: when the ledger itself cannot be written', () => {
  it('says so as a warning instead of dropping the record of the run on the floor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dz23-ledger-'))
    scratch.push(directory)
    // A real filesystem refusal that not even root can talk its way out of: the ledger path
    // is a DIRECTORY, so appending to it fails with EISDIR.
    await mkdir(join(directory, BACKUP_LEDGER_FILE))
    const log: Array<[string, string]> = []
    const scheduler = new StorageBackupScheduler({
      runner: { run: async target => {
        const payload = 'x'
        await writeFile(target, payload, { flag: 'wx', mode: 0o600 })
        return { sha256: createHash('sha256').update(payload).digest('hex'), bytes: 1, records: 0, domains: 0 }
      } },
      directory, label: 'dz23_storage', intervalMs: 5 * 60 * 1000, keep: 2,
      suffix: () => 'abc123', now: () => new Date(Date.UTC(2026, 8, 3, 12, 0, 0)),
      log: (level, line) => log.push([level, line]),
    })
    const result = await scheduler.runOnce()
    // The run itself still succeeded and is still returned: a ledger that cannot be written
    // must not destroy the backup it was meant to record.
    expect(result.status).toBe('created')
    expect(log).toContainEqual(['warn', expect.stringContaining('backup ledger write failed') as unknown as string])
    await scheduler.stop()
  })
})

describe('StorageBackupScheduler.pending', () => {
  it('is false while nothing waits and true while a tick has joined the queued run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dz23-pending-'))
    scratch.push(directory)
    let release = (): void => undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const results: BackupResult[] = []
    const scheduler = new StorageBackupScheduler({
      runner: { run: async target => {
        await gate
        const payload = 'x'
        await writeFile(target, payload, { flag: 'wx', mode: 0o600 })
        return { sha256: createHash('sha256').update(payload).digest('hex'), bytes: 1, records: 0, domains: 0 }
      } },
      directory, label: 'dz23_storage', intervalMs: 5 * 60 * 1000, keep: 2,
      suffix: (() => { let n = 0; return () => String(n++).padStart(6, '0') })(),
      now: (() => { let n = 0; return () => new Date(Date.UTC(2026, 8, 3, 12, 0, n++)) })(),
    })
    expect(scheduler.pending).toBe(false)
    const first = scheduler.runOnce()
    expect(scheduler.pending).toBe(false)
    const second = scheduler.runOnce()
    const third = scheduler.runOnce()
    // Both later ticks joined ONE waiting run: a backup slower than the interval must not grow a queue.
    expect(scheduler.pending).toBe(true)
    expect(second).toBe(third)
    release()
    results.push(await first, await second)
    expect(results.map(result => result.status)).toEqual(['created', 'created'])
    expect(scheduler.pending).toBe(false)
    await scheduler.stop()
  })
})
