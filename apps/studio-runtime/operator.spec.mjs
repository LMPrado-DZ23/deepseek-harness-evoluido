import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { main, parseOperatorCommand, runOperator, sanitizeOperatorError } from './operator.mjs'
import { runStorageRestoreStopped } from '../../scripts/run-storage-operator.mjs'

describe('internal storage operator', () => {
  it('is included in the runtime package and asserted by the production image', async () => {
    const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
    const dockerfile = await readFile(new URL('../../deploy/studio/Dockerfile', import.meta.url), 'utf8')
    const compose = await readFile(new URL('../../docker-compose.yml', import.meta.url), 'utf8')
    expect(manifest.bin['dz23-studio-operator']).toBe('./operator.mjs')
    expect(manifest.files).toContain('operator.mjs')
    expect(dockerfile).toContain('test -f /opt/runtime/operator.mjs')
    expect(compose).toContain('  operator:')
    expect(compose).toContain('entrypoint: ["node", "operator.mjs"]')
    expect(compose).toContain('profiles: ["operator"]')
    expect(dockerfile).toContain('command -v pg_dump')
  })
  it('accepts only environment references, never a DSN on argv', () => {
    expect(() => parseOperatorCommand(['status', '--dsn', 'postgres://user:secret@host/db'])).toThrow('Opção desconhecida')
    expect(() => parseOperatorCommand(['status', '--dsn-ref', 'postgres://user:secret@host/db'])).toThrow('nome de uma variável')
    expect(() => parseOperatorCommand(['status', '--dsn-ref', 'DZ23_POSTGRES_DSN', '--write'])).toThrow('não pertencem')
    expect(parseOperatorCommand(['status', '--dsn-ref', 'DZ23_POSTGRES_DSN'])).toMatchObject({ command: 'status', dsnRef: 'DZ23_POSTGRES_DSN' })
  })

  it('fails closed on malformed, repeated, missing and cross-command options', () => {
    expect(() => parseOperatorCommand([])).toThrow('Comando inválido')
    expect(() => parseOperatorCommand(['status', '--dsn-ref'])).toThrow('Falta o valor')
    expect(() => parseOperatorCommand(['status', '--dsn-ref', 'A', '--dsn-ref', 'B'])).toThrow('Opção repetida')
    expect(() => parseOperatorCommand(['restore', '--dsn-ref', 'A', '--input', 'x', '--attempt-id', 'attempt-1', '--write', '--write'])).toThrow('Opção repetida')
    expect(() => parseOperatorCommand(['verify-backup', '--input', 'x', '--max-bytes', '0'])).toThrow('inteiro positivo')
    expect(() => parseOperatorCommand(['verify-backup', '--input', 'x', '--max-bytes', String(64 * 1024 * 1024 + 1)])).toThrow('não pode exceder')
    expect(() => parseOperatorCommand(['verify-backup', '--input', 'x', '--schema', 'x'])).toThrow('não pertence')
    expect(() => parseOperatorCommand(['backup', '--dsn-ref', 'A'])).toThrow('Falta --out')
    expect(() => parseOperatorCommand(['restore', '--dsn-ref', 'A', '--input', 'x', '--attempt-id', 'attempt-1', '--write'])).toThrow('Falta --backup')
    expect(parseOperatorCommand(['restore', '--dsn-ref', 'A', '--input', 'x', '--attempt-id', 'attempt-1'])).toMatchObject({ command: 'restore', write: false, backup: '' })
  })

  it('runs write restore with Harness stopped and reopens it only after operator success', async () => {
    const calls = []
    const executor = async (_program, args, options) => {
      calls.push(args)
      return { stdout: options?.capture === true ? 'harness\n' : '', stderr: '' }
    }
    await expect(runStorageRestoreStopped(['restore', '--write', '--input', '/backup.json'], { executor }))
      .resolves.toEqual({ restored: true, harnessRestarted: true })
    expect(calls).toEqual([
      ['compose', 'ps', '--status', 'running', '--services', 'harness'],
      ['compose', 'stop', 'harness'],
      ['compose', 'up', '-d', '--wait', 'postgres'],
      ['compose', '--profile', 'operator', 'run', '--rm', '--no-deps', 'operator', 'restore', '--write', '--input', '/backup.json'],
      ['compose', 'up', '-d', '--no-deps', '--wait', 'harness'],
    ])
  })

  it('leaves Harness stopped after restore failure and never accepts a non-write command', async () => {
    const calls = []
    const executor = async (_program, args, options) => {
      calls.push(args)
      if (args.includes('operator')) throw new Error('restore refused')
      return { stdout: options?.capture === true ? 'harness\n' : '', stderr: '' }
    }
    await expect(runStorageRestoreStopped(['backup'], { executor })).rejects.toThrow('somente restore --write')
    await expect(runStorageRestoreStopped(['restore', '--write'], { executor })).rejects.toThrow('continuará parado')
    expect(calls.at(-1)).toContain('operator')
    expect(calls.filter(args => args.includes('harness') && args.includes('up'))).toEqual([])
  })

  it('threads cancellation through every Docker child and never reopens Harness after an abort', async () => {
    const controller = new AbortController()
    const calls = []
    const executor = async (_program, args, options) => {
      calls.push({ args, signal: options?.signal })
      if (args.includes('operator')) controller.abort(new Error('cancelled-by-supervisor'))
      return { stdout: options?.capture === true ? 'harness\n' : '', stderr: '' }
    }
    await expect(runStorageRestoreStopped(['restore', '--write'], { executor, signal: controller.signal })).rejects.toThrow('continuará parado')
    expect(calls.every(call => call.signal === controller.signal)).toBe(true)
    expect(calls.filter(call => call.args.includes('harness') && call.args.includes('up'))).toEqual([])

    const already = new AbortController()
    already.abort(new Error('already-cancelled'))
    await expect(runStorageRestoreStopped(['restore', '--write'], { executor, signal: already.signal })).rejects.toThrow('already-cancelled')
  })

  it('executes backup and emits only a sanitized bounded report', async () => {
    class Scheduler {
      async runOnce() {
        return { status: 'created', file: '/safe/backup.json', sha256: 'a'.repeat(64), bytes: 42, records: 2, domains: 1, prunedCount: 0 }
      }
    }
    const command = parseOperatorCommand(['backup', '--dsn-ref', 'DZ23_POSTGRES_DSN', '--out', '/safe'])
    const result = await runOperator(command, { environment: { DZ23_POSTGRES_DSN: 'postgres://user:secret@host/db' }, StorageBackupScheduler: Scheduler, backupRunner: {} })
    expect(result).toEqual({ command: 'backup', status: 'created', file: '/safe/backup.json', sha256: 'a'.repeat(64), bytes: 42, records: 2, domains: 1, prunedCount: 0 })
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('builds the default backup runner without putting the DSN in its report', async () => {
    let writerOptions
    let writerDsn
    class Scheduler {
      constructor(options) { this.options = options }
      async runOnce() { return this.options.runner.run('/safe/backup.json') }
    }
    const result = await runOperator(parseOperatorCommand(['backup', '--dsn-ref', 'DSN', '--out', '/safe']), {
      environment: { DSN: 'postgres://user:secret@host/db' }, StorageBackupScheduler: Scheduler,
      writeBackupBundle: async (options, dsn) => {
        writerOptions = options
        writerDsn = dsn
        return { status: 'created', file: options.out, sha256: 'a'.repeat(64), bytes: 1, records: 1, domains: 1, prunedCount: 0 }
      },
    })
    expect(writerOptions).toMatchObject({ dsnRef: 'DSN', schema: 'dz23_storage', out: '/safe/backup.json' })
    expect(writerDsn).toContain('secret')
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('refuses restore before opening the database when verification fails', async () => {
    let restored = false
    const command = parseOperatorCommand(['restore', '--dsn-ref', 'DZ23_POSTGRES_DSN', '--input', 'bad.json', '--attempt-id', 'attempt-bad1', '--backup', 'safety.dump', '--write'])
    await expect(runOperator(command, {
      environment: { DZ23_POSTGRES_DSN: 'postgres://user:secret@host/db', DZ23_OPERATOR_STATE_DIR: '/private/operator' },
      readVerifiedStorageBundleFile: async () => { throw new Error('A cópia não corresponde ao arquivo de verificação.') },
      restorePostgresStorage: async () => { restored = true },
    })).rejects.toThrow('não corresponde')
    expect(restored).toBe(false)
  })

  it('verifies both the sidecar and the semantic bundle', async () => {
    const command = parseOperatorCommand(['verify-backup', '--input', 'ok.json'])
    const result = await runOperator(command, {
      readVerifiedStorageBundleFile: async () => ({ file: 'ok.json', bytes: 10, inputSha256: 'c'.repeat(64), bundle: { domains: [{}, {}] } }),
    })
    expect(result).toMatchObject({ command: 'verify-backup', status: 'valid', domains: 2 })
  })

  it('reports readiness without echoing its connection', async () => {
    const command = parseOperatorCommand(['status', '--dsn-ref', 'DZ23_POSTGRES_DSN'])
    const result = await runOperator(command, {
      environment: { DZ23_POSTGRES_DSN: 'postgres://user:secret@host/db' },
      postgresStorageStatus: async () => ({ reachable: true, ready: true, schema: 'dz23_storage', schemaExists: true, serverVersion: '16', layoutVersion: 1, domains: 4 }),
    })
    expect(result).toMatchObject({ command: 'status', ready: true, domains: 4 })
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('passes write intent to the fail-closed restore core and reports readiness', async () => {
    let received
    const command = parseOperatorCommand(['restore', '--dsn-ref', 'DZ23_POSTGRES_DSN', '--input', 'ok.json', '--attempt-id', 'attempt-good1', '--backup', 'safety.dump', '--write', '--force', '--confirm', 'REPLACE_DZ23_STORAGE'])
    const result = await runOperator(command, {
      environment: { DZ23_POSTGRES_DSN: 'postgres://user:secret@host/db', DZ23_OPERATOR_STATE_DIR: '/private/operator' },
      readVerifiedStorageBundleFile: async () => ({ file: 'ok.json', bytes: 1, inputSha256: 'a'.repeat(64), bundle: { domains: [{}] } }),
      restorePostgresStorage: async value => { received = value; return { mode: 'write', domains: 1, safetyBackup: 'safety.dump', safetyBackupStatus: 'created', replacedDomains: [], droppedDomains: [], reapedStaging: [], readyToStart: true } },
    })
    expect(received).toMatchObject({ write: true, force: true, confirmation: 'REPLACE_DZ23_STORAGE', safetyBackup: 'safety.dump', attemptId: 'attempt-good1', stateDirectory: '/private/operator' })
    expect(result.readyToStart).toBe(true)
  })

  it('requires the instance-scoped operator state directory before write restore', async () => {
    const command = parseOperatorCommand(['restore', '--dsn-ref', 'DSN', '--input', 'ok.json', '--attempt-id', 'attempt-state', '--backup', 'safety.dump', '--write'])
    await expect(runOperator(command, {
      environment: { DSN: 'postgres://database/studio' },
      readVerifiedStorageBundleFile: async () => ({ file: 'ok.json', bytes: 1, inputSha256: 'a'.repeat(64), bundle: { domains: [{}] } }),
      restorePostgresStorage: async () => { throw new Error('must not reach restore') },
    })).rejects.toThrow('DZ23_OPERATOR_STATE_DIR')
  })

  it('redacts DSN material from failure text', () => {
    const dsn = 'postgres://operator:very-secret@database/studio'
    const result = sanitizeOperatorError(new Error(`failed ${dsn}`), [dsn])
    expect(result).not.toContain('very-secret')
    expect(result).toContain('[redacted]')
    expect(sanitizeOperatorError('plain failure')).toBe('plain failure')
  })

  it('refuses absent credentials and non-created scheduler results', async () => {
    await expect(runOperator(parseOperatorCommand(['status', '--dsn-ref', 'MISSING']), { environment: {} })).rejects.toThrow('não configurada')
    class Scheduler { async runOnce() { return { status: 'skipped' } } }
    await expect(runOperator(parseOperatorCommand(['backup', '--dsn-ref', 'DSN', '--out', '/safe']), {
      environment: { DSN: 'postgres://host/db' }, StorageBackupScheduler: Scheduler,
    })).rejects.toThrow('Não foi possível criar')
  })

  it.each([
    ['verify-backup', ['verify-backup', '--input', 'ok.json']],
    ['status', ['status', '--dsn-ref', 'DZ23_POSTGRES_DSN']],
    ['backup', ['backup', '--dsn-ref', 'DZ23_POSTGRES_DSN', '--out', '/safe']],
  ])('honours cancellation before %s touches its dependency', async (_name, argv) => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled-before-dispatch'))
    let calls = 0
    class Scheduler { constructor() { calls += 1 } }
    await expect(runOperator(parseOperatorCommand(argv), {
      signal: controller.signal,
      environment: { DZ23_POSTGRES_DSN: 'postgres://user:secret@host/db' },
      readVerifiedStorageBundleFile: async () => { calls += 1 },
      postgresStorageStatus: async () => { calls += 1 },
      StorageBackupScheduler: Scheduler,
    })).rejects.toThrow('cancelled-before-dispatch')
    expect(calls).toBe(0)
  })

  it('passes one cancellation signal through verify, status, backup and restore boundaries', async () => {
    const controller = new AbortController()
    const seen = []
    const verified = { file: 'ok.json', bytes: 1, inputSha256: 'a'.repeat(64), bundle: { domains: [{}] } }
    await runOperator(parseOperatorCommand(['verify-backup', '--input', 'ok.json']), {
      signal: controller.signal,
      readVerifiedStorageBundleFile: async (_file, _limits, signal) => { seen.push(signal); return verified },
    })
    await runOperator(parseOperatorCommand(['status', '--dsn-ref', 'DZ23_POSTGRES_DSN']), {
      signal: controller.signal,
      environment: { DZ23_POSTGRES_DSN: 'postgres://database/studio' },
      postgresStorageStatus: async options => { seen.push(options.signal); return { reachable: true, ready: true, schema: 'dz23_storage', schemaExists: true, serverVersion: '16', layoutVersion: 1, domains: 1, condition: 'ready' } },
    })
    class Scheduler {
      constructor(options) { seen.push(options.signal) }
      async runOnce() { return { status: 'created', file: '/safe/backup.json', sha256: 'a'.repeat(64), bytes: 1, records: 1, domains: 1, prunedCount: 0 } }
    }
    await runOperator(parseOperatorCommand(['backup', '--dsn-ref', 'DZ23_POSTGRES_DSN', '--out', '/safe']), {
      signal: controller.signal, environment: { DZ23_POSTGRES_DSN: 'postgres://database/studio' }, StorageBackupScheduler: Scheduler, backupRunner: {},
    })
    await runOperator(parseOperatorCommand(['restore', '--dsn-ref', 'DZ23_POSTGRES_DSN', '--input', 'ok.json', '--attempt-id', 'attempt-signal']), {
      signal: controller.signal,
      environment: { DZ23_POSTGRES_DSN: 'postgres://database/studio' },
      readVerifiedStorageBundleFile: async (_file, _limits, signal) => { seen.push(signal); return verified },
      restorePostgresStorage: async options => { seen.push(options.signal); return { mode: 'dry-run', domains: 1, existingUnits: 0, targetDomains: [], wouldBeLost: [], targetSchemaExists: false, targetHasContent: false } },
    })
    expect(seen).toHaveLength(5)
    expect(seen.every(signal => signal === controller.signal)).toBe(true)
  })

  it('runs the CLI boundary, removes signal listeners and never emits a credential on failure', async () => {
    const listeners = new Map()
    const signals = {
      once: (name, listener) => listeners.set(name, listener),
      off: (name, listener) => { if (listeners.get(name) === listener) listeners.delete(name) },
    }
    const out = []
    const err = []
    const ok = await main({
      argv: ['verify-backup', '--input', 'ok.json'], signals,
      stdout: { write: value => out.push(value) }, stderr: { write: value => err.push(value) },
      dependencies: { readVerifiedStorageBundleFile: async () => ({ file: 'ok.json', bytes: 1, inputSha256: 'a'.repeat(64), bundle: { domains: [{}] } }) },
    })
    expect(ok).toBe(0)
    expect(JSON.parse(out[0])).toMatchObject({ command: 'verify-backup', status: 'valid' })
    expect(err).toEqual([])
    expect(listeners.size).toBe(0)

    const secret = 'postgres://operator:super-secret@database/studio'
    const failed = await main({
      argv: ['status', '--dsn-ref', 'DSN'], environment: { DSN: secret }, signals,
      stdout: { write: value => out.push(value) }, stderr: { write: value => err.push(value) },
      dependencies: { postgresStorageStatus: async () => { throw new Error(`cannot connect ${secret}`) } },
    })
    expect(failed).toBe(1)
    expect(err.at(-1)).not.toContain('super-secret')
    expect(err.at(-1)).toContain('[redacted]')
    expect(listeners.size).toBe(0)

    const opaqueSecret = 'not-a-url-secret'
    const opaque = await main({
      argv: ['status', '--dsn-ref', 'DSN'], environment: { DSN: opaqueSecret }, signals,
      stdout: { write: value => out.push(value) }, stderr: { write: value => err.push(value) },
      dependencies: { postgresStorageStatus: async () => { throw new Error(`cannot connect ${opaqueSecret}`) } },
    })
    expect(opaque).toBe(1)
    expect(err.at(-1)).not.toContain(opaqueSecret)
  })

  it('cancels main through its registered signal before a dependency can report success', async () => {
    const listeners = new Map()
    const signals = {
      once: (name, listener) => listeners.set(name, listener),
      off: (name, listener) => { if (listeners.get(name) === listener) listeners.delete(name) },
    }
    const err = []
    const code = await main({
      argv: ['verify-backup', '--input', 'ok.json'], signals,
      stdout: { write: () => undefined }, stderr: { write: value => err.push(value) },
      dependencies: { readVerifiedStorageBundleFile: async (_file, _limits, signal) => {
        listeners.get('SIGTERM')()
        expect(signal.aborted).toBe(true)
        return { file: 'ok.json', bytes: 1, inputSha256: 'a'.repeat(64), bundle: { domains: [{}] } }
      } },
    })
    expect(code).toBe(1)
    expect(err.join('')).toContain('cancelada')
    expect(listeners.size).toBe(0)
  })
})
