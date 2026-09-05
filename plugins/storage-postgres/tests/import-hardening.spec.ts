import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { PostgresStorageBackend } from '../src/backend.ts'
import { quoteIdentifier } from '../src/schema.ts'
import { exportStorage } from '../../../scripts/storage-migration.ts'
import { STUDIO_DOMAIN_SPECS } from '../../../scripts/studio-domain-specs.ts'
import { descriptorOf } from '@deepseek-ai/dsh-storage-domain'

const dsn = process.env.DZ23_POSTGRES_TEST_DSN
const describePostgres = dsn === undefined ? describe.skip : describe
const run = promisify(execFile)
const schemas: string[] = []

function schemaName(prefix: string): string {
  const schema = `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  schemas.push(schema)
  return schema
}

function backend(schema: string): PostgresStorageBackend {
  return new PostgresStorageBackend({ connectionString: dsn!, schema, ssl: false, poolMax: 2, heartbeatMs: 100 })
}

const hello = descriptorOf(STUDIO_DOMAIN_SPECS[0]!)

/** A bundle carrying every declared Studio domain, so `--allow-domain-loss` is never needed. */
async function writeBundleFile(directory: string): Promise<string> {
  const bundle = await exportStorage(backend(schemaName('src')), STUDIO_DOMAIN_SPECS, 'd'.repeat(64), '2026-09-04T00:00:00.000Z')
  const input = join(directory, 'input.json')
  await writeFile(input, JSON.stringify(bundle), { flag: 'wx', mode: 0o600 })
  return input
}

function invoke(input: string, schema: string, backup: string, extra: string[] = [], environment: NodeJS.ProcessEnv = {}) {
  return run(process.execPath, [
    '--import', 'tsx', resolve('scripts/import-postgres-storage.ts'),
    '--input', input, '--dsn-ref', 'DZ23_IMPORT_TEST_DSN', '--schema', schema,
    '--ssl', 'off', '--write', '--backup', backup, ...extra,
  ], { env: { ...process.env, DZ23_IMPORT_TEST_DSN: dsn!, ...environment } })
}

describePostgres('restore CLI hardening', () => {
  it('treats a schema holding only a TEXT SEARCH CONFIGURATION as content, so it is never dropped without --force', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dz23-ts-probe-'))
    const client = new Client({ connectionString: dsn!, ssl: false })
    await client.connect()
    const textSearch = schemaName('ts_victim')
    const conversion = schemaName('conv_victim')
    try {
      // Neither of these puts a single row in pg_class, pg_proc, pg_type, pg_operator or
      // pg_collation — the catalogues the probe used to enumerate by hand. Both schemas
      // therefore looked EMPTY, which skipped the layout check and the spoken confirmation
      // and went straight into DROP SCHEMA CASCADE.
      await client.query(`CREATE SCHEMA ${quoteIdentifier(textSearch)}`)
      await client.query(`CREATE TEXT SEARCH CONFIGURATION ${quoteIdentifier(textSearch)}."busca" (COPY = pg_catalog.simple)`)
      await client.query(`CREATE SCHEMA ${quoteIdentifier(conversion)}`)
      await client.query(`CREATE CONVERSION ${quoteIdentifier(conversion)}."conv" FOR 'LATIN1' TO 'UTF8' FROM pg_catalog.iso8859_1_to_utf8`)
      const input = await writeBundleFile(directory)

      for (const victim of [textSearch, conversion]) {
        // Seen as content, so the layout check runs and refuses — with no flags at all,
        // and again with the loudest flags a person can type.
        await expect(invoke(input, victim, join(directory, `${victim}.dump`))).rejects.toThrow('não tem a estrutura do DZ23 STUDIO')
        await expect(invoke(input, victim, join(directory, `${victim}.dump`), ['--force', '--confirm', 'REPLACE_DZ23_STORAGE', '--allow-domain-loss']))
          .rejects.toThrow('não tem a estrutura do DZ23 STUDIO')
      }
      // Both survived, with their contents.
      const survived = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_catalog.pg_ts_config c JOIN pg_catalog.pg_namespace n ON n.oid = c.cfgnamespace WHERE n.nspname = $1`,
        [textSearch],
      )
      expect(survived.rows[0]!.n).toBe(1)
      const conversions = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_catalog.pg_conversion c JOIN pg_catalog.pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = $1`,
        [conversion],
      )
      expect(conversions.rows[0]!.n).toBe(1)
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(textSearch)} CASCADE`).catch(() => undefined)
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(conversion)} CASCADE`).catch(() => undefined)
      await client.end()
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000)

  it('reaps only its OWN staging schemas: a similarly named foreign schema and an unmarked look-alike both survive', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dz23-staging-sweep-'))
    const client = new Client({ connectionString: dsn!, ssl: false })
    await client.connect()
    const target = schemaName('sweep')
    // `LIKE '<target>_staging_%'` never escaped the `_`, so it is a wildcard: this
    // foreign schema, which belongs to somebody else, matched and was dropped CASCADE.
    const lookAlike = `${target}xstaging_alheio`
    // Right shape, no ownership marker: not ours, so not ours to drop either.
    const unmarked = `${target}_staging_alheio`
    // Right shape AND our marker: a real orphan from a run killed with SIGKILL. This one MUST go —
    // a sweep that reaps nothing would pass the two checks above and still leave copies of the data behind.
    const orphan = `${target}_staging_deadbeef`
    schemas.push(lookAlike, unmarked, orphan)
    try {
      const source = backend(target)
      const unit = await source.kv!.open(hello)
      await unit.putRecord('records', 'old', { tenant_id: 'workspace-old' })
      await unit.close()
      await source.close()
      for (const victim of [lookAlike, unmarked]) {
        await client.query(`CREATE SCHEMA ${quoteIdentifier(victim)}`)
        await client.query(`CREATE TABLE ${quoteIdentifier(victim)}."importante" (id int)`)
        await client.query(`INSERT INTO ${quoteIdentifier(victim)}."importante" VALUES (1)`)
      }
      await client.query(`CREATE SCHEMA ${quoteIdentifier(orphan)}`)
      await client.query(`CREATE TABLE ${quoteIdentifier(orphan)}."dz23_import_staging" (tool TEXT NOT NULL, target_schema TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL)`)
      await client.query(`INSERT INTO ${quoteIdentifier(orphan)}."dz23_import_staging" (tool, target_schema, created_at) VALUES ('dz23-studio/import-postgres-storage', $1, now())`, [target])

      const input = await writeBundleFile(directory)
      const result = JSON.parse((await invoke(input, target, join(directory, 'backup.dump'), ['--force', '--confirm', 'REPLACE_DZ23_STORAGE'])).stdout) as { reapedStaging: string[] }
      expect(result.reapedStaging).toEqual([orphan])

      const still = async (schema: string): Promise<number> => (await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM pg_catalog.pg_namespace WHERE nspname = $1', [schema],
      )).rows[0]!.n
      expect(await still(lookAlike)).toBe(1)
      expect(await still(unmarked)).toBe(1)
      expect(await still(orphan)).toBe(0)
      for (const victim of [lookAlike, unmarked]) {
        expect((await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${quoteIdentifier(victim)}."importante"`)).rows[0]!.n).toBe(1)
      }
    } finally {
      await client.end()
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000)

  it('never puts the password or the TLS policy on the pg_dump command line', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dz23-argv-'))
    try {
      const target = schemaName('argv')
      const source = backend(target)
      const unit = await source.kv!.open(hello)
      await unit.putRecord('records', 'old', { tenant_id: 'workspace-old' })
      await unit.close()
      await source.close()

      // A pg_dump of our own that records exactly what the operating system would show
      // to anyone running `ps -ef`, plus the environment only this process can read.
      const binaries = join(directory, 'bin')
      await mkdir(binaries)
      const recorded = join(directory, 'argv.json')
      const fake = join(binaries, 'pg_dump')
      await writeFile(fake, [
        '#!/usr/bin/env node',
        `const { writeFileSync } = require('node:fs')`,
        `writeFileSync(${JSON.stringify(recorded)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }))`,
        `process.stdout.write('PGDMP-fake\\n')`,
        '',
      ].join('\n'))
      await chmod(fake, 0o700)

      const input = await writeBundleFile(directory)
      await invoke(input, target, join(directory, 'backup.dump'), ['--force', '--confirm', 'REPLACE_DZ23_STORAGE'], {
        PATH: `${binaries}${delimiter}${process.env.PATH ?? ''}`,
      })

      const seen = JSON.parse(await readFile(recorded, 'utf8')) as { argv: string[]; env: Record<string, string> }
      const password = new URL(dsn!).password
      expect(password).not.toBe('')
      expect(seen.argv.join(' ')).not.toContain(password)
      expect(seen.argv.join(' ')).not.toContain('postgres://')
      expect(seen.argv.join(' ')).not.toContain('postgresql://')
      expect(seen.argv.some(argument => /ssl/iu.test(argument))).toBe(false)
      expect(seen.env.PGPASSWORD).toBe(password)
      expect(seen.env.PGSSLMODE).toBe('disable')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000)
})

afterAll(async () => {
  if (dsn === undefined) return
  const client = new Client({ connectionString: dsn })
  await client.connect()
  for (const schema of schemas) await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await client.end()
})
