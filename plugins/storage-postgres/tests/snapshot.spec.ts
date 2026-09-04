import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { descriptorOf } from '@deepseek-ai/dsh-storage-domain'
import { PostgresStorageBackend } from '../src/backend.ts'
import { bundleRecordCount, canonicalJson, sha256, validateBundle } from '../src/bundle.ts'
import { writeBackupBundle } from '../src/backup-worker.ts'
import { snapshotPostgresStorage } from '../src/snapshot.ts'
import { importStorage } from '../../../scripts/storage-migration.ts'
import { STUDIO_DOMAIN_SPECS } from '../../../scripts/studio-domain-specs.ts'

const dsn = process.env.DZ23_POSTGRES_TEST_DSN
const describePostgres = dsn === undefined ? describe.skip : describe
const schemas: string[] = []

function schemaName(prefix: string): string {
  const schema = `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`
  schemas.push(schema)
  return schema
}

function backend(schema: string): PostgresStorageBackend {
  return new PostgresStorageBackend({ connectionString: dsn!, schema, ssl: false, poolMax: 4, heartbeatMs: 100 })
}

const hello = descriptorOf(STUDIO_DOMAIN_SPECS[0]!)
const withGlobal = { name: 'snap_global', version: 3, tables: ['items', 'empty'], hasGlobal: true }

describePostgres('hot snapshot of a PostgreSQL storage schema', () => {
  it('captures every stamped unit while a writer holds its lease, and restores byte-identical', async () => {
    const schema = schemaName('snap')
    const source = backend(schema)
    const helloUnit = await source.kv!.open(hello)
    await helloUnit.putRecord('records', 'one', { tenant_id: 'workspace-a', created_at: '2026-09-03T00:00:00.000Z', note: 'one' })
    const globalUnit = await source.kv!.open(withGlobal)
    await globalUnit.putRecord('items', 'x', { value: 1 })
    await globalUnit.setGlobal({ counter: 7 })
    // Both units stay OPEN (writer lease held) while the snapshot runs: it must not block or fail.
    const bundle = await snapshotPostgresStorage({ connectionString: dsn!, ssl: false, schema, now: () => new Date('2026-09-03T12:00:00.000Z') })
    validateBundle(bundle)
    expect(bundle.source.kind).toBe('postgres')
    expect(bundle.createdAt).toBe('2026-09-03T12:00:00.000Z')
    expect(bundle.domains.map(domain => domain.descriptor.name)).toEqual(['snap_global', 'studio_hello'])
    expect(bundleRecordCount(bundle)).toBe(2)
    const helloDomain = bundle.domains.find(domain => domain.descriptor.name === 'studio_hello')!
    expect(helloDomain.snapshot).toEqual(await helloUnit.loadAll())
    const globalDomain = bundle.domains.find(domain => domain.descriptor.name === 'snap_global')!
    expect(globalDomain.descriptor).toEqual({ name: 'snap_global', version: 3, tables: ['items'], hasGlobal: true })
    expect(globalDomain.snapshot.global).toEqual({ counter: 7 })
    // The writer is still alive after the snapshot.
    await helloUnit.putRecord('records', 'two', { tenant_id: 'workspace-a', created_at: '2026-09-03T00:00:01.000Z', note: 'two' })
    await source.close()

    const target = backend(schemaName('snap_restore'))
    await importStorage(target, bundle)
    const restored = backend(schemas.at(-1)!)
    const restoredUnit = await restored.kv!.open(hello)
    expect(sha256(canonicalJson({ descriptor: hello, snapshot: await restoredUnit.loadAll() }))).toBe(helloDomain.sha256)
    await restored.close()
  })

  it('the backup process writes, out of process and one domain at a time, exactly the bundle the in-process snapshot seals', async () => {
    const schema = schemaName('worker')
    const source = backend(schema)
    const helloUnit = await source.kv!.open(hello)
    await helloUnit.putRecord('records', 'one', { tenant_id: 'workspace-a', created_at: '2026-09-03T00:00:00.000Z', note: 'um' })
    await helloUnit.putRecord('records', 'dois', { tenant_id: 'workspace-a', created_at: '2026-09-03T00:00:01.000Z', note: 'acentuação e Ç' })
    const globalUnit = await source.kv!.open(withGlobal)
    await globalUnit.putRecord('items', 'x', { value: 1 })
    await globalUnit.setGlobal({ counter: 7 })

    const directory = await mkdtemp(join(tmpdir(), 'dz23-backup-worker-'))
    const out = join(directory, 'bundle.json')
    const now = () => new Date('2026-09-03T12:00:00.000Z')
    try {
      // Written straight to the file by the worker code, with both digests computed as the bytes go by.
      const report = await writeBackupBundle({ dsnRef: 'unused', schema, ssl: 'off', out, maxBytes: 50 * 1024 * 1024, now }, dsn!)
      const written = JSON.parse(await readFile(out, 'utf8')) as ReturnType<typeof JSON.parse>
      validateBundle(written)
      expect(report).toMatchObject({ domains: 2, records: 3 })
      expect(sha256(await readFile(out))).toBe(report.sha256)
      // Same content as the in-process snapshot: same domains, same per-domain digests.
      const inProcess = await snapshotPostgresStorage({ connectionString: dsn!, ssl: false, schema, now })
      expect(written.domains.map((domain: { sha256: string }) => domain.sha256)).toEqual(inProcess.domains.map(domain => domain.sha256))
      expect(written.domains.map((domain: { descriptor: { name: string } }) => domain.descriptor.name)).toEqual(['snap_global', 'studio_hello'])
      // The file is 0600 and, over the limit, nothing is left behind.
      expect((await stat(out)).mode & 0o777).toBe(0o600)
      const tiny = join(directory, 'tiny.json')
      await expect(writeBackupBundle({ dsnRef: 'unused', schema, ssl: 'off', out: tiny, maxBytes: 32, now }, dsn!)).rejects.toThrow('limit')
      await expect(stat(tiny)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await source.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('streams more rows than one cursor batch, with keys whose database order is NOT code-point order, and still seals the same bytes', async () => {
    const schema = schemaName('cursor')
    const source = backend(schema)
    const unit = await source.kv!.open({ name: 'snap_big', version: 1, tables: ['items'], hasGlobal: false })
    // 1200 rows: more than two cursor batches (500 each), so the streaming path is really exercised.
    for (let index = 0; index < 1200; index += 1) await unit.putRecord('items', `k-${String(index).padStart(5, '0')}`, { index })
    // Keys where a locale collation (en_US) and code-point order disagree: accents, case and punctuation.
    for (const key of ['Zebra', 'ábaco', 'abacate', 'Ábaco', '_sublinhado', 'ñandu', 'nadar', 'Ñ', 'z-final']) {
      await unit.putRecord('items', key, { key })
    }
    const directory = await mkdtemp(join(tmpdir(), 'dz23-backup-cursor-'))
    const out = join(directory, 'bundle.json')
    const now = () => new Date('2026-09-04T00:00:00.000Z')
    try {
      const report = await writeBackupBundle({ dsnRef: 'unused', schema, ssl: 'off', out, maxBytes: 50 * 1024 * 1024, now }, dsn!)
      expect(report.records).toBe(1209)
      const written = JSON.parse(await readFile(out, 'utf8')) as { domains: Array<{ sha256: string; snapshot: { tables: { items: Record<string, unknown> } } }> }
      // Self-validating: the payload digest and every domain digest are recomputed from the file.
      validateBundle(written as never)
      const inProcess = await snapshotPostgresStorage({ connectionString: dsn!, ssl: false, schema, now })
      // The proof that `COLLATE "C"` and the JS canonical sort agree: identical sealed digests.
      expect(written.domains[0]!.sha256).toBe(inProcess.domains[0]!.sha256)
      expect(Object.keys(written.domains[0]!.snapshot.tables.items)).toHaveLength(1209)
    } finally {
      await source.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('proves the `COLLATE "C"` in the streaming reader is load-bearing, whatever the database locale', async () => {
    // This test database happens to be C.UTF-8, so simply dropping the COLLATE would not fail the
    // test above — that would be a vacuous guard. Here the claim is checked directly: a locale
    // collation orders these keys differently from byte order, and byte order is what the canonical
    // form (a code-point sort in JavaScript) requires.
    const client = new Client({ connectionString: dsn!, ssl: false })
    await client.connect()
    try {
      const keys = ['Zebra', 'ábaco', 'abacate', '_sublinhado', 'ñandu', 'nadar']
      const ordered = async (collation: string): Promise<string[]> => (await client.query<{ v: string }>(
        `SELECT v FROM unnest($1::text[]) AS t(v) ORDER BY v COLLATE "${collation}"`, [keys],
      )).rows.map(row => row.v)
      const byteOrder = await ordered('C')
      const localeOrder = await ordered('pt-BR-x-icu')
      expect(byteOrder).not.toEqual(localeOrder) // the two really disagree
      expect(byteOrder).toEqual([...keys].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)))
      expect(JSON.parse(canonicalJson(Object.fromEntries(keys.map(key => [key, 1]))) ) && Object.keys(JSON.parse(canonicalJson(Object.fromEntries(keys.map(key => [key, 1])))))).toEqual(byteOrder)
    } finally {
      await client.end()
    }
  })

  it('version-checks declared descriptors and exports never-opened declared units as empty', async () => {
    const schema = schemaName('snap_decl')
    const source = backend(schema)
    const unit = await source.kv!.open(hello)
    await unit.putRecord('records', 'k', { tenant_id: 'w', created_at: '2026-09-03T00:00:00.000Z', note: 'k' })
    await source.close()
    const declared = STUDIO_DOMAIN_SPECS.map(spec => descriptorOf(spec))
    const bundle = await snapshotPostgresStorage({ connectionString: dsn!, ssl: false, schema, descriptors: declared })
    expect(bundle.domains).toHaveLength(declared.length)
    expect(bundleRecordCount(bundle)).toBe(1)
    const stale = declared.map(descriptor => descriptor.name === hello.name ? { ...descriptor, version: hello.version + 1 } : descriptor)
    await expect(snapshotPostgresStorage({ connectionString: dsn!, ssl: false, schema, descriptors: stale })).rejects.toMatchObject({ code: 'version-mismatch' })
    const narrowed = [{ ...hello, tables: [] }]
    await expect(snapshotPostgresStorage({ connectionString: dsn!, ssl: false, schema, descriptors: narrowed })).rejects.toMatchObject({ code: 'malformed-medium' })
  })

  it('refuses a schema without the Studio layout and an invalid schema name', async () => {
    await expect(snapshotPostgresStorage({ connectionString: dsn!, ssl: false, schema: schemaName('nolayout') })).rejects.toThrow()
    await expect(snapshotPostgresStorage({ connectionString: dsn!, ssl: false, schema: 'bad-name' })).rejects.toThrow('violates')
  })
})

afterAll(async () => {
  if (dsn === undefined) return
  const client = new Client({ connectionString: dsn })
  await client.connect()
  for (const schema of schemas) await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await client.end()
})
