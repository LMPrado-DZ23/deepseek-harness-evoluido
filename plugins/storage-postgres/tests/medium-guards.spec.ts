/**
 * Guards that stand between a tampered or foreign medium and a copy of somebody's
 * data. Each one runs against REAL PostgreSQL: the schema is created by the product
 * itself, then edited the way a hand at a psql prompt would edit it, and the guard
 * is asked to notice.
 */
import { randomUUID } from 'node:crypto'
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Client } from 'pg'
import { descriptorOf } from '@deepseek-ai/dsh-storage-domain'
import { PostgresStorageBackend } from '../src/backend.ts'
import { writeBackupBundle } from '../src/backup-worker.ts'
import { snapshotPostgresStorage } from '../src/snapshot.ts'
import { validateBundle } from '../src/bundle.ts'
import { quoteIdentifier, unitsTable, STORAGE_POSTGRES_LAYOUT_VERSION } from '../src/schema.ts'
import { apply } from '../src/index.ts'
import { STUDIO_DOMAIN_SPECS } from '../../../scripts/studio-domain-specs.ts'

const dsn = process.env.DZ23_POSTGRES_TEST_DSN
const describePostgres = dsn === undefined ? describe.skip : describe
const schemas: string[] = []
const scratch: string[] = []
const hello = descriptorOf(STUDIO_DOMAIN_SPECS[0]!)

function schemaName(prefix: string): string {
  const schema = `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`
  schemas.push(schema)
  return schema
}

/** A real schema with one real record in it, written by the product's own backend. */
async function populated(prefix: string): Promise<string> {
  const schema = schemaName(prefix)
  const backend = new PostgresStorageBackend({ connectionString: dsn!, schema, ssl: false, poolMax: 2, heartbeatMs: 100 })
  const unit = await backend.kv!.open(hello)
  await unit.putRecord('records', 'one', { tenant_id: 'workspace-a', created_at: '2026-09-04T00:00:00.000Z', note: 'um' })
  await backend.close()
  return schema
}

async function onSchema<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: dsn! })
  await client.connect()
  try { return await run(client) } finally { await client.end() }
}

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  scratch.push(path)
  return path
}

describePostgres('a storage schema this build cannot read', () => {
  it('the backup process refuses a layout version that is not this build\'s, and leaves no file behind', async () => {
    const schema = await populated('worker_layout')
    // Exactly what a schema written by a NEWER Studio looks like to this one.
    await onSchema(client => client.query(`UPDATE ${quoteIdentifier(schema)}."storage_meta" SET value = $1 WHERE key = 'layout_version'`, [STORAGE_POSTGRES_LAYOUT_VERSION + 1]))
    const out = join(await directory('dz23-layout-worker-'), 'bundle.json')
    await expect(writeBackupBundle({ dsnRef: 'unused', schema, ssl: 'off', out, maxBytes: 10 * 1024 * 1024 }, dsn!))
      .rejects.toThrow(`postgres storage schema '${schema}' has layout version ${String(STORAGE_POSTGRES_LAYOUT_VERSION + 1)}, incompatible with this build (${String(STORAGE_POSTGRES_LAYOUT_VERSION)})`)
    // A refused run must not leave a half-written bundle for the next restore to find.
    await expect(access(out)).rejects.toThrow()
  })

  it('the backup process refuses a schema with no Studio storage layout at all', async () => {
    const schema = await populated('worker_nolayout')
    await onSchema(client => client.query(`DELETE FROM ${quoteIdentifier(schema)}."storage_meta" WHERE key = 'layout_version'`))
    const out = join(await directory('dz23-nolayout-worker-'), 'bundle.json')
    await expect(writeBackupBundle({ dsnRef: 'unused', schema, ssl: 'off', out, maxBytes: 10 * 1024 * 1024 }, dsn!))
      .rejects.toThrow(`postgres schema '${schema}' has no Studio storage layout`)
    await expect(access(out)).rejects.toThrow()
  })

  it('the in-process snapshot refuses the same schema, as a version-mismatch', async () => {
    const schema = await populated('snap_layout')
    await onSchema(client => client.query(`UPDATE ${quoteIdentifier(schema)}."storage_meta" SET value = $1 WHERE key = 'layout_version'`, [STORAGE_POSTGRES_LAYOUT_VERSION + 1]))
    await expect(snapshotPostgresStorage({ connectionString: dsn!, ssl: false, schema }))
      .rejects.toMatchObject({ code: 'version-mismatch', message: expect.stringContaining(`has layout version ${String(STORAGE_POSTGRES_LAYOUT_VERSION + 1)}`) as unknown as string })
  })
})

describePostgres('a hand-edited declaration on the medium', () => {
  it('refuses a units row whose declared table list is not a list of strings, instead of copying a shape nobody declared', async () => {
    for (const tampered of ['"records"', '{"records": true}', '["records", 7]', '17']) {
      const schema = await populated('snap_tables')
      await onSchema(client => client.query(`UPDATE ${unitsTable(schema)} SET tables = $1::jsonb WHERE name = $2`, [tampered, hello.name]))
      await expect(snapshotPostgresStorage({ connectionString: dsn!, ssl: false, schema }))
        .rejects.toMatchObject({ code: 'malformed-medium', message: `kv unit '${hello.name}' has a malformed declared table list on the medium` })
    }
  }, 30_000)

  it('still refuses a well-formed list that does not match the fingerprint stamped beside it', async () => {
    const schema = await populated('snap_finger')
    await onSchema(client => client.query(`UPDATE ${unitsTable(schema)} SET tables = $1::jsonb WHERE name = $2`, ['["records", "smuggled"]', hello.name]))
    await expect(snapshotPostgresStorage({ connectionString: dsn!, ssl: false, schema }))
      .rejects.toMatchObject({ code: 'malformed-medium', message: `kv unit '${hello.name}' has a declared shape that does not match its stored fingerprint` })
  })
})

describePostgres('a units row written by a build that predates the declared shape', () => {
  it('degrades to pure inference instead of failing, so an older schema still backs up', async () => {
    const schema = await populated('snap_legacy')
    // Exactly the row an older build left behind: the three columns did not exist yet.
    await onSchema(client => client.query(`UPDATE ${unitsTable(schema)} SET tables = NULL, has_global = NULL, descriptor_sha256 = NULL WHERE name = $1`, [hello.name]))
    const bundle = await snapshotPostgresStorage({ connectionString: dsn!, ssl: false, schema, now: () => new Date('2026-09-04T00:00:00.000Z') })
    // The shape comes from the rows that exist, and nothing is refused and nothing is lost.
    expect(bundle.domains.map(domain => domain.descriptor)).toEqual([{ name: hello.name, version: hello.version, tables: ['records'], hasGlobal: false }])
    expect(Object.keys(bundle.domains[0]!.snapshot.tables['records'] ?? {})).toEqual(['one'])
  })
})

describePostgres('a schema written before the additive metadata columns existed', () => {
  async function downgrade(schema: string): Promise<void> {
    await onSchema(async client => {
      await client.query(`ALTER TABLE ${unitsTable(schema)} DROP COLUMN "tables", DROP COLUMN "has_global", DROP COLUMN "descriptor_sha256"`)
      await client.query(`ALTER TABLE ${quoteIdentifier(schema)}."storage_meta" DROP COLUMN "text_value"`)
    })
  }

  it('the diagnostic snapshot reads the old schema using typed NULL projections', async () => {
    const schema = await populated('old_snap')
    await downgrade(schema)
    const bundle = await snapshotPostgresStorage({ connectionString: dsn!, ssl: false, schema })
    expect(bundle.installation).toBeUndefined()
    expect(bundle.domains[0]!.descriptor).toEqual({ name: hello.name, version: hello.version, tables: ['records'], hasGlobal: false })
    expect(() => validateBundle(bundle)).not.toThrow()
  }, 60_000)

  it('the streaming worker writes a valid identity-less bundle from the old schema', async () => {
    const schema = await populated('old_worker')
    await downgrade(schema)
    const out = join(await directory('dz23-old-worker-'), 'bundle.json')
    const report = await writeBackupBundle({ dsnRef: 'unused', schema, ssl: 'off', out, maxBytes: 64 * 1024 * 1024 }, dsn!)
    expect(report).toMatchObject({ domains: 1, records: 1 })
    const bundle = JSON.parse(await readFile(out, 'utf8')) as unknown
    expect(() => validateBundle(bundle)).not.toThrow()
    expect((bundle as { installation?: string }).installation).toBeUndefined()
  }, 60_000)
})

describePostgres('a declaration whose fingerprint was removed', () => {
  it('is refused while the all-NULL legacy row still degrades to inference', async () => {
    const tampered = await populated('finger_null')
    await onSchema(client => client.query(
      `UPDATE ${unitsTable(tampered)} SET tables = $1::jsonb, descriptor_sha256 = NULL WHERE name = $2`,
      ['["records", "smuggled"]', hello.name],
    ))
    await expect(snapshotPostgresStorage({ connectionString: dsn!, ssl: false, schema: tampered }))
      .rejects.toMatchObject({ code: 'malformed-medium', message: expect.stringContaining('no fingerprint') as unknown as string })

    const legacy = await populated('finger_legacy')
    await onSchema(client => client.query(`UPDATE ${unitsTable(legacy)} SET tables = NULL, has_global = NULL, descriptor_sha256 = NULL WHERE name = $1`, [hello.name]))
    const bundle = await snapshotPostgresStorage({ connectionString: dsn!, ssl: false, schema: legacy })
    expect(bundle.domains[0]!.descriptor.tables).toEqual(['records'])
  }, 60_000)
})

describePostgres('the scheduled backup as the plugin wires it', () => {
  it('records a refused copy as a warning, with the plugin\'s own interval and retention defaults', async () => {
    const backups = join(await directory('dz23-plugin-warn-'), 'backups')
    const disposers: Array<() => void | Promise<void>> = []
    const provided = vi.fn()
    const info: string[] = []
    const warn: string[] = []
    const context = {
      credentials: { resolve: vi.fn(() => Promise.resolve({ value: dsn!, source: 'env' })) },
      storage: { backend: { register: vi.fn(() => vi.fn()) } },
      provide: provided,
      effect: (factory: () => () => void | Promise<void>) => { disposers.push(factory()) },
      logger: { info: (line: string) => info.push(line), warn: (line: string) => warn.push(line) },
    }
    try {
      // backupIntervalMinutes and backupKeep are LEFT OUT on purpose: the plugin's own
      // defaults (60 minutes, 48 kept) must be enough to build a valid scheduler.
      // A one-byte ceiling makes the real child process refuse for a real reason.
      await apply(context as never, {
        dsnRef: 'DZ23_POSTGRES_TEST_DSN', schema: schemaName('plugin_warn'), ssl: 'off', poolMax: 2,
        backupDirectory: backups, backupMaxBytes: 1, backupTimeoutMinutes: 1, backupHeapMb: 256,
      })
      const service = provided.mock.calls.find(call => call[0] === 'studioStorageBackup')?.[1] as { runOnce(): Promise<{ status: string; file: string | null; error: string | null }> }
      const result = await service.runOnce()
      expect(result.status).toBe('failed')
      expect(result.file).toBeNull()
      expect(result.error).toContain('1 byte limit')
      // A failed run is a warning, never an info line, and never a thrown error.
      expect(warn.some(line => line.includes('backup failed') && line.includes('1 byte limit'))).toBe(true)
      expect(info.some(line => line.includes('backup created'))).toBe(false)
      // It is written to the ledger all the same: a refusal is recorded, not swallowed.
      const ledger = (await readFile(join(backups, 'backups.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { status: string })
      expect(ledger.every(entry => entry.status === 'failed')).toBe(true)
      expect((await stat(backups)).mode & 0o777).toBe(0o700)
    } finally {
      await Promise.all(disposers.map(dispose => dispose()))
    }
  }, 60_000)
})

afterAll(async () => {
  for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true })
  if (dsn === undefined) return
  const client = new Client({ connectionString: dsn })
  await client.connect()
  for (const schema of schemas) await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await client.end()
})
