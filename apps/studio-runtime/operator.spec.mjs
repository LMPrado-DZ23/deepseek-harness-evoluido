import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { parseOperatorCommand, runOperator, sanitizeOperatorError } from './operator.mjs'

describe('internal storage operator', () => {
  it('is included in the runtime package and asserted by the production image', async () => {
    const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
    const dockerfile = await readFile(new URL('../../deploy/studio/Dockerfile', import.meta.url), 'utf8')
    expect(manifest.bin['dz23-studio-operator']).toBe('./operator.mjs')
    expect(manifest.files).toContain('operator.mjs')
    expect(dockerfile).toContain('test -f /opt/runtime/operator.mjs')
    expect(dockerfile).toContain('command -v pg_dump')
  })
  it('accepts only environment references, never a DSN on argv', () => {
    expect(() => parseOperatorCommand(['status', '--dsn', 'postgres://user:secret@host/db'])).toThrow('Opção desconhecida')
    expect(() => parseOperatorCommand(['status', '--dsn-ref', 'postgres://user:secret@host/db'])).toThrow('nome de uma variável')
    expect(() => parseOperatorCommand(['status', '--dsn-ref', 'DZ23_POSTGRES_DSN', '--write'])).toThrow('não pertencem')
    expect(parseOperatorCommand(['status', '--dsn-ref', 'DZ23_POSTGRES_DSN'])).toMatchObject({ command: 'status', dsnRef: 'DZ23_POSTGRES_DSN' })
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

  it('refuses restore before opening the database when verification fails', async () => {
    let restored = false
    const command = parseOperatorCommand(['restore', '--dsn-ref', 'DZ23_POSTGRES_DSN', '--input', 'bad.json', '--backup', 'safety.dump', '--write'])
    await expect(runOperator(command, {
      environment: { DZ23_POSTGRES_DSN: 'postgres://user:secret@host/db' },
      verifyBackupFile: async () => ({ file: 'bad.json', bytes: 1, sha256: 'b'.repeat(64), matches: false }),
      restorePostgresStorage: async () => { restored = true },
    })).rejects.toThrow('não corresponde')
    expect(restored).toBe(false)
  })

  it('verifies both the sidecar and the semantic bundle', async () => {
    const command = parseOperatorCommand(['verify-backup', '--input', 'ok.json'])
    const result = await runOperator(command, {
      verifyBackupFile: async () => ({ file: 'ok.json', bytes: 10, sha256: 'c'.repeat(64), matches: true }),
      readStorageBundleFile: async () => ({ domains: [{}, {}] }),
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
    const command = parseOperatorCommand(['restore', '--dsn-ref', 'DZ23_POSTGRES_DSN', '--input', 'ok.json', '--backup', 'safety.dump', '--write', '--force', '--confirm', 'REPLACE_DZ23_STORAGE'])
    const result = await runOperator(command, {
      environment: { DZ23_POSTGRES_DSN: 'postgres://user:secret@host/db' },
      verifyBackupFile: async () => ({ file: 'ok.json', bytes: 1, sha256: 'a'.repeat(64), matches: true }),
      restorePostgresStorage: async value => { received = value; return { mode: 'write', domains: 1, safetyBackup: 'safety.dump', safetyBackupStatus: 'created', replacedDomains: [], droppedDomains: [], reapedStaging: [], readyToStart: true } },
    })
    expect(received).toMatchObject({ write: true, force: true, confirmation: 'REPLACE_DZ23_STORAGE', safetyBackup: 'safety.dump' })
    expect(result.readyToStart).toBe(true)
  })

  it('redacts DSN material from failure text', () => {
    const dsn = 'postgres://operator:very-secret@database/studio'
    const result = sanitizeOperatorError(new Error(`failed ${dsn}`), [dsn])
    expect(result).not.toContain('very-secret')
    expect(result).toContain('[redacted]')
  })
})
