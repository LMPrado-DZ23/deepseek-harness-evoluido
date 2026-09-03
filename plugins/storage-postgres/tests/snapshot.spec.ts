import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { descriptorOf } from '@deepseek-ai/dsh-storage-domain'
import { PostgresStorageBackend } from '../src/backend.ts'
import { bundleRecordCount, canonicalJson, sha256, validateBundle } from '../src/bundle.ts'
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
