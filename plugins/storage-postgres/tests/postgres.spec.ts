import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Client } from 'pg'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import { runKvBackendContract } from '../../../third_party/deepseek-harness/packages/storage/storage/tests/contract.ts'
import { PostgresStorageBackend } from '../src/backend.ts'
import { PostgresCapacityGovernor } from '../src/capacity.ts'
import { StudioStorageError } from '../src/errors.ts'
import { quoteIdentifier, STORAGE_POSTGRES_LAYOUT_VERSION, storageMaintenanceLockName, storageUnitLockName } from '../src/schema.ts'
import { StudioTenancyService, type TenancyRepository } from '../../tenancy/src/service.ts'
import type { Invitation, Membership, Organization, Workspace } from '../../tenancy/src/model.ts'
import { descriptorOf } from '@deepseek-ai/dsh-storage-domain'
import { exportStorage, importStorage, validateBundle, type StorageExportBundle } from '../../../scripts/storage-migration.ts'
import { STUDIO_DOMAIN_SPECS } from '../../../scripts/studio-domain-specs.ts'
import { apply } from '../src/index.ts'

const dsn = process.env.DZ23_POSTGRES_TEST_DSN
const postgresContainer = process.env.DZ23_POSTGRES_TEST_CONTAINER
const describePostgres = dsn === undefined ? describe.skip : describe
const schemas: string[] = []
const run = promisify(execFile)

function schemaName(prefix = 'p31'): string {
  const schema = `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`
  schemas.push(schema)
  return schema
}

function backend(schema: string, heartbeatMs = 100): PostgresStorageBackend {
  return new PostgresStorageBackend({
    connectionString: dsn!,
    schema,
    ssl: false,
    poolMax: 4,
    heartbeatMs,
  })
}

describePostgres('postgres backend against PostgreSQL 16', () => {
  runKvBackendContract('postgres', async () => {
    const schema = schemaName('contract')
    return {
      backend: backend(schema),
      reopen: () => Promise.resolve(backend(schema)),
    }
  })

  it('rejects invalid descriptors before touching PostgreSQL', async () => {
    const instance = backend(schemaName())
    expect(() => quoteIdentifier('a'.repeat(64))).toThrow('63 character limit')
    expect(() => storageUnitLockName('valid_schema', 'bad-unit')).toThrow('kv unit name')
    await expect(instance.kv!.open({ name: 'bad-name', version: 1, tables: [], hasGlobal: false })).rejects.toThrow('violates')
    await expect(instance.kv!.open({ name: 'valid', version: -1, tables: [], hasGlobal: false })).rejects.toThrow('non-negative')
    await expect(instance.kv!.open({ name: 'valid', version: 1, tables: ['bad-name'], hasGlobal: false })).rejects.toThrow('violates')
    await instance.close()
    await expect(instance.kv!.open({ name: 'valid', version: 1, tables: [], hasGlobal: false })).rejects.toMatchObject({ code: 'closed' })
    expect(() => quoteIdentifier('bad-name')).toThrow('violates')
  })

  it('uses the production heartbeat default when none is supplied', async () => {
    const schema = schemaName('defaults')
    const instance = new PostgresStorageBackend({ connectionString: dsn!, schema, ssl: false, poolMax: 1 })
    const unit = await instance.kv!.open({ name: 'default_heartbeat', version: 1, tables: [], hasGlobal: false })
    await unit.close()
    await instance.close()
  })

  it('guards double-open, undeclared tables, absent global and non-JSON values', async () => {
    const instance = backend(schemaName())
    const descriptor = { name: 'guards', version: 1, tables: ['records'], hasGlobal: false } as const
    const unit = await instance.kv!.open(descriptor)
    await expect(instance.kv!.open(descriptor)).rejects.toThrow('already open')
    await expect(unit.putRecord('missing', 'key', {})).rejects.toThrow('declared no table')
    await expect(unit.deleteRecord('missing', 'key')).rejects.toThrow('declared no table')
    await expect(unit.setGlobal({})).rejects.toThrow('declared no global')
    await expect(unit.putRecord('records', 'key', undefined)).rejects.toThrow('JSON-serializable')
    const circular: { self?: unknown } = {}
    circular.self = circular
    await expect(unit.putRecord('records', 'key', circular)).rejects.toThrow()
    await instance.close()
  })

  it('allows only one writer process and releases the lock after abrupt death', async () => {
    const schema = schemaName('multiprocess')
    const unitName = 'shared_unit'
    const fixture = fileURLToPath(new URL('./fixtures/lease-holder.ts', import.meta.url))
    const child = spawn(process.execPath, ['--import', 'tsx', fixture], {
      env: {
        ...process.env,
        DZ23_POSTGRES_TEST_DSN: dsn!,
        DZ23_POSTGRES_TEST_SCHEMA: schema,
        DZ23_POSTGRES_TEST_UNIT: unitName,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.stdout!.on('data', chunk => {
        if (String(chunk).includes('READY')) resolve()
      })
      child.stderr!.on('data', chunk => reject(new Error(String(chunk))))
    })
    const contender = backend(schema)
    const descriptor = { name: unitName, version: 1, tables: ['records'], hasGlobal: false } as const
    await expect(contender.kv!.open(descriptor)).rejects.toMatchObject({
      name: 'StudioStorageError',
      code: 'unit-locked',
    })
    child.kill('SIGKILL')
    await new Promise<void>(resolve => child.once('exit', () => resolve()))
    const winner = backend(schema)
    await expect(retryOpen(winner, descriptor)).resolves.toBeDefined()
    await Promise.all([contender.close(), winner.close()])
  }, 15_000)

  it('fails closed after PostgreSQL terminates the lock connection', async () => {
    const schema = schemaName('lockloss')
    const instance = backend(schema)
    const unit = await instance.kv!.open({ name: 'lock_unit', version: 1, tables: ['records'], hasGlobal: false })
    const killer = new Client({ connectionString: dsn })
    await killer.connect()
    await killer.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'dz23-storage:lock_unit'")
    await killer.end()
    await new Promise(resolve => setTimeout(resolve, 200))
    await expect(unit.putRecord('records', 'key', { value: 1 })).rejects.toMatchObject({ code: 'unit-locked' })
    await instance.close()
  })

  it('rejects an incompatible physical layout stamp', async () => {
    const schema = schemaName('layout')
    const first = backend(schema)
    const unit = await first.kv!.open({ name: 'layout_unit', version: 1, tables: [], hasGlobal: false })
    await unit.close()
    await first.close()
    const client = new Client({ connectionString: dsn })
    await client.connect()
    await client.query(`UPDATE "${schema}"."storage_meta" SET value = $1 WHERE key = 'layout_version'`, [STORAGE_POSTGRES_LAYOUT_VERSION + 1])
    await client.end()
    const incompatible = backend(schema)
    await expect(incompatible.kv!.open({ name: 'another', version: 1, tables: [], hasGlobal: false })).rejects.toMatchObject({ code: 'version-mismatch' })
    await incompatible.close()
  })

  it('never rewrites an immutable descriptor when the version number is unchanged', async () => {
    const schema = schemaName('descriptor_immutable')
    const original = { name: 'immutable_unit', version: 7, tables: ['records'], hasGlobal: false } as const
    const first = backend(schema)
    const unit = await first.kv!.open(original)
    await unit.close()
    await first.close()

    for (const changed of [
      { ...original, tables: ['other'] },
      { ...original, hasGlobal: true },
    ]) {
      const stale = backend(schema)
      await expect(stale.kv!.open(changed)).rejects.toMatchObject({ code: 'malformed-medium' })
      await stale.close()
    }

    const client = new Client({ connectionString: dsn!, ssl: false })
    await client.connect()
    const persisted = await client.query<{ version: number; tables: string[]; has_global: boolean }>(
      `SELECT version, tables, has_global FROM "${schema}"."units" WHERE name = $1`,
      [original.name],
    )
    await client.end()
    expect(persisted.rows).toEqual([{ version: 7, tables: ['records'], has_global: false }])
  })

  it('initializes a fully legacy descriptor once but rejects partially stamped metadata', async () => {
    const schema = schemaName('descriptor_legacy')
    const original = { name: 'legacy_unit', version: 2, tables: ['records'], hasGlobal: false } as const
    const seed = backend(schema)
    const unit = await seed.kv!.open(original)
    await unit.close()
    await seed.close()
    const client = new Client({ connectionString: dsn!, ssl: false })
    await client.connect()
    await client.query(`UPDATE "${schema}"."units" SET tables = NULL, has_global = NULL, descriptor_sha256 = NULL WHERE name = $1`, [original.name])
    const migrated = backend(schema)
    await (await migrated.kv!.open(original)).close()
    await migrated.close()
    await client.query(`UPDATE "${schema}"."units" SET descriptor_sha256 = NULL WHERE name = $1`, [original.name])
    await client.end()
    const corrupt = backend(schema)
    await expect(corrupt.kv!.open(original)).rejects.toMatchObject({ code: 'malformed-medium' })
    await corrupt.close()
  })

  it('keeps two tenants in one database separated by the tenancy service', async () => {
    const schema = schemaName('tenants')
    const instance = backend(schema)
    const workspaceUnit = await instance.kv!.open({ name: 'studio_workspaces', version: 1, tables: ['workspaces'], hasGlobal: false })
    const membershipUnit = await instance.kv!.open({ name: 'studio_memberships', version: 1, tables: ['memberships', 'invitations'], hasGlobal: false })
    const now = '2026-09-02T00:00:00.000Z'
    await workspaceUnit.putRecord('workspaces', 'workspace-a', { workspace_id: 'workspace-a', org_id: 'org-a', name: 'A', created_by: 'user-a', created_at: now, archived_at: null })
    await workspaceUnit.putRecord('workspaces', 'workspace-b', { workspace_id: 'workspace-b', org_id: 'org-b', name: 'B', created_by: 'user-b', created_at: now, archived_at: null })
    await membershipUnit.putRecord('memberships', 'member-a', { membership_id: 'member-a', org_id: 'org-a', workspace_id: 'workspace-a', user_id: 'user-a', email: 'a@example.com', role: 'owner', created_at: now, updated_at: now })
    await membershipUnit.putRecord('memberships', 'member-b', { membership_id: 'member-b', org_id: 'org-b', workspace_id: 'workspace-b', user_id: 'user-b', email: 'b@example.com', role: 'owner', created_at: now, updated_at: now })
    const workspaceSnapshot = await workspaceUnit.loadAll()
    const membershipSnapshot = await membershipUnit.loadAll()
    const repository = readOnlyRepository(
      Object.values(workspaceSnapshot.tables['workspaces']!) as Workspace[],
      Object.values(membershipSnapshot.tables['memberships']!) as Membership[],
    )
    const service = new StudioTenancyService({
      repository,
      identity: {} as never,
      emailSender: { sendInvitation: () => Promise.resolve() },
    })
    expect(service.listWorkspaces({ userId: 'user-a', email: 'a@example.com', orgId: 'org-a', tenantId: 'workspace-a' }))
      .toEqual([expect.objectContaining({ workspace_id: 'workspace-a', org_id: 'org-a' })])
    expect(service.authorizationFor('user-a', 'org-b', 'workspace-b')).toBeUndefined()
    await instance.close()
  })

  it('exports SQLite to checksummed JSON semantics and imports into empty PostgreSQL', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'dz23-p31-migration-'))
    try {
      const source = new SqliteStorageBackend({ path: join(temporary, 'source.sqlite'), journalMode: 'delete' })
      const createdAt = '2026-09-02T00:00:00.000Z'
      const samples: Record<string, { table: string; key: string; value: unknown }> = {
        studio_hello: { table: 'records', key: 'hello-a', value: { tenant_id: 'workspace-a', created_at: createdAt, note: 'migrated' } },
        studio_identity_users: {
          table: 'users', key: 'user-a', value: {
            user_id: 'user-a', email: 'a@example.com', display_name: 'Pessoa A', bootstrap_owner: true,
            org_id: 'org-a', tenant_id: 'workspace-a', created_at: createdAt,
          },
        },
        studio_orgs: {
          table: 'orgs', key: 'org-a', value: { org_id: 'org-a', name: 'Organização A', owner_user_id: 'user-a', created_at: createdAt },
        },
        studio_workspaces: {
          table: 'workspaces', key: 'workspace-a', value: {
            workspace_id: 'workspace-a', org_id: 'org-a', name: 'Workspace A', created_by: 'user-a',
            created_at: createdAt, archived_at: null,
          },
        },
        studio_memberships: {
          table: 'memberships', key: 'membership-a', value: {
            membership_id: 'membership-a', org_id: 'org-a', workspace_id: 'workspace-a', user_id: 'user-a',
            email: 'a@example.com', role: 'owner', created_at: createdAt, updated_at: createdAt,
          },
        },
      }
      for (const spec of STUDIO_DOMAIN_SPECS) {
        const sourceUnit = await source.kv!.open(descriptorOf(spec))
        const sample = samples[spec.name]
        if (sample !== undefined) await sourceUnit.putRecord(sample.table, sample.key, sample.value)
        await sourceUnit.close()
      }
      const bundle = await exportStorage(source, STUDIO_DOMAIN_SPECS, 'a'.repeat(64), createdAt)
      expect(() => validateBundle(bundle)).not.toThrow()
      const tampered = structuredClone(bundle)
      tampered.domains[0]!.snapshot.tables['records']!['a'] = { changed: true }
      expect(() => validateBundle(tampered)).toThrow('payload checksum')

      const schema = schemaName('migration')
      await importStorage(backend(schema), bundle)
      const reopened = backend(schema)
      for (const domain of bundle.domains) {
        const target = await reopened.kv!.open(domain.descriptor)
        expect(await target.loadAll()).toEqual(domain.snapshot)
        await target.close()
      }
      await reopened.close()

      await expect(importStorage(backend(schema), bundle)).rejects.toThrow('not empty')
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }, 15_000)

  it('runs the write CLI for a new server, backs up replacements and refuses an active Studio', async () => {
    // pg_dump/pg_restore come from the test container when configured, otherwise from the local PostgreSQL client tools.
    const temporary = await mkdtemp(join(tmpdir(), 'dz23-p31-import-cli-'))
    try {
      const source = new SqliteStorageBackend({ path: join(temporary, 'source.sqlite'), journalMode: 'delete' })
      const helloDescriptor = descriptorOf(STUDIO_DOMAIN_SPECS[0]!)
      const sourceUnit = await source.kv!.open(helloDescriptor)
      await sourceUnit.putRecord('records', 'new', { tenant_id: 'workspace-new', created_at: '2026-09-02T00:00:00.000Z', note: 'new' })
      await sourceUnit.close()
      const bundle = await exportStorage(source, STUDIO_DOMAIN_SPECS, 'b'.repeat(64), '2026-09-02T00:00:00.000Z')
      const input = join(temporary, 'input.json')
      const serialized = JSON.stringify(bundle)
      await writeFile(input, serialized, { flag: 'wx', mode: 0o600 })
      await writeFile(`${input}.sha256`, `${createHash('sha256').update(serialized).digest('hex')}  input.json\n`, { flag: 'wx', mode: 0o600 })

      const toolDirectory = join(temporary, 'bin')
      await mkdir(toolDirectory)
      const pgDump = join(toolDirectory, 'pg_dump')
      const pgRestore = join(toolDirectory, 'pg_restore')
      // With a test container, pg_dump is bridged through docker exec; without one the local client tools are used as-is.
      // O identificador do contêiner é GRAVADO no atalho, não lido do ambiente:
      // o produto entrega às ferramentas cliente um ambiente reduzido a PATH,
      // LANG e LC_ALL - por isso um atalho que dependesse de
      // DZ23_POSTGRES_TEST_CONTAINER falharia por causa do endurecimento, e não
      // por causa do backup.
      await writeFile(pgDump, `#!/usr/bin/env bash
set -euo pipefail
container=${JSON.stringify(postgresContainer ?? '')}
filtered=()
for argument in "$@"; do
  case "$argument" in
    --dbname=*) ;;
    *) filtered+=("$argument") ;;
  esac
done
exec docker exec -i "$container" pg_dump --username dz23_test --dbname dz23_test "\${filtered[@]}"
`)
      await chmod(pgDump, 0o700)
      await writeFile(pgRestore, `#!/usr/bin/env bash
set -euo pipefail
file="\${@: -1}"
exec docker exec -i ${JSON.stringify(postgresContainer ?? '')} pg_restore --list < "$file"
`)
      await chmod(pgRestore, 0o700)
      const cliEnvironment = {
        ...process.env,
        PATH: postgresContainer === undefined ? (process.env.PATH ?? '') : `${toolDirectory}${delimiter}${process.env.PATH ?? ''}`,
        DZ23_IMPORT_TEST_DSN: dsn!,
      }
      const cli = resolve('scripts/import-postgres-storage.ts')
      const invoke = (schema: string, backup: string, extra: string[] = []) => run(process.execPath, [
        '--import', 'tsx', cli, '--input', input, '--dsn-ref', 'DZ23_IMPORT_TEST_DSN',
        '--schema', schema, '--ssl', 'off', '--write', '--attempt-id', `attempt-${schema}`, '--backup', backup, ...extra,
      ], { env: cliEnvironment })

      const freshSchema = schemaName('cli_fresh')
      const unusedBackup = join(temporary, 'fresh.dump')
      const fresh = JSON.parse((await invoke(freshSchema, unusedBackup)).stdout) as Record<string, unknown>
      expect(fresh).toMatchObject({ mode: 'write', safetyBackup: null, safetyBackupStatus: 'not-needed-empty-target' })
      await expect(access(unusedBackup)).rejects.toThrow()

      const targetSchema = schemaName('cli_replace')
      const oldBackend = backend(targetSchema)
      const oldUnit = await oldBackend.kv!.open(helloDescriptor)
      await oldUnit.putRecord('records', 'old', { tenant_id: 'workspace-old' })
      await oldUnit.close()
      await oldBackend.close()
      const backup = join(temporary, 'before-replace.dump')
      await expect(invoke(targetSchema, backup)).rejects.toThrow('já tem conteúdo')

      const activeBackend = backend(targetSchema)
      await activeBackend.kv!.open(helloDescriptor)
      await expect(invoke(targetSchema, backup, [
        '--force', '--allow-record-loss', '--confirm', 'REPLACE_DZ23_STORAGE',
      ]))
        .rejects.toThrow('ainda está em execução no servidor')
      await activeBackend.close()

      const replaced = JSON.parse((await invoke(targetSchema, backup, [
        '--force', '--allow-record-loss', '--confirm', 'REPLACE_DZ23_STORAGE',
      ])).stdout) as Record<string, unknown>
      expect(replaced).toMatchObject({ mode: 'write', safetyBackup: backup, safetyBackupStatus: 'created' })
      await access(backup)
      expect((await stat(backup)).mode & 0o777).toBe(0o600)
      const listed = postgresContainer === undefined
        ? await runWithInput('pg_restore', ['--list'], await readFile(backup))
        : await runWithInput('docker', ['exec', '-i', postgresContainer, 'pg_restore', '--list'], await readFile(backup))
      expect(listed).toContain(targetSchema)

      const restored = backend(targetSchema)
      const restoredUnit = await restored.kv!.open(helloDescriptor)
      expect(await restoredUnit.loadAll()).toEqual(bundle.domains[0]!.snapshot)
      await restored.close()
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }, 30_000)

  it('refuses to replace a schema that is not this Studio, even when a relation is named `units`', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'dz23-import-foreign-'))
    const client = new Client({ connectionString: dsn!, ssl: false })
    await client.connect()
    const foreign = schemaName('foreign_victim')
    const viewed = schemaName('view_victim')
    const typesOnly = schemaName('types_victim')
    try {
      // 1) Somebody else's schema. It has no `units` at all: the guard used to be gated on that very
      //    table, so nothing checked the layout and `DROP SCHEMA CASCADE` ran with no confirmation.
      await client.query(`CREATE SCHEMA ${quoteIdentifier(foreign)}`)
      await client.query(`CREATE TABLE ${quoteIdentifier(foreign)}."important" (id int)`)
      await client.query(`INSERT INTO ${quoteIdentifier(foreign)}."important" VALUES (1)`)
      // 2) A schema where `units` is a VIEW — `pg_tables` does not list views, so the old gate opened again.
      await client.query(`CREATE SCHEMA ${quoteIdentifier(viewed)}`)
      await client.query(`CREATE TABLE ${quoteIdentifier(viewed)}."units_real" (name text primary key, version int)`)
      await client.query(`CREATE VIEW ${quoteIdentifier(viewed)}."units" AS SELECT * FROM ${quoteIdentifier(viewed)}."units_real"`)

      const bundle = await exportStorage(backend(schemaName('foreign_source')), STUDIO_DOMAIN_SPECS, 'c'.repeat(64), '2026-09-04T00:00:00.000Z')
      const input = join(temporary, 'input.json')
      const serialized = JSON.stringify(bundle)
      await writeFile(input, serialized, { flag: 'wx', mode: 0o600 })
      await writeFile(`${input}.sha256`, `${createHash('sha256').update(serialized).digest('hex')}  input.json\n`, { flag: 'wx', mode: 0o600 })
      const cli = resolve('scripts/import-postgres-storage.ts')
      const attempt = (schema: string, extra: string[] = []) => run(process.execPath, [
        '--import', 'tsx', cli, '--input', input, '--dsn-ref', 'DZ23_IMPORT_TEST_DSN',
        '--schema', schema, '--ssl', 'off', '--write', '--attempt-id', `attempt-${schema}`, '--backup', join(temporary, `${schema}.dump`), ...extra,
      ], { env: { ...process.env, DZ23_IMPORT_TEST_DSN: dsn! } })

      // 3) A schema that holds NO relation at all — only a type, a domain and a function. `pg_class`
      //    does not list those, so it looked empty, skipped the layout check and the confirmation,
      //    and went straight into DROP SCHEMA CASCADE.
      await client.query(`CREATE SCHEMA ${quoteIdentifier(typesOnly)}`)
      await client.query(`CREATE TYPE ${quoteIdentifier(typesOnly)}."humor" AS ENUM ('bom', 'ruim')`)
      await client.query(`CREATE FUNCTION ${quoteIdentifier(typesOnly)}."regra"() RETURNS int LANGUAGE sql AS 'SELECT 1'`)

      // Refused even with the loudest flags a person can type.
      for (const schema of [foreign, viewed, typesOnly]) {
        await expect(attempt(schema, ['--force', '--confirm', 'REPLACE_DZ23_STORAGE', '--allow-domain-loss']))
          .rejects.toThrow('não tem a estrutura do DZ23 STUDIO')
      }
      // Nothing was touched, and no safety dump was even started.
      expect((await client.query(`SELECT count(*)::int AS n FROM ${quoteIdentifier(foreign)}."important"`)).rows[0].n).toBe(1)
      expect((await client.query('SELECT count(*)::int AS n FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1', [typesOnly])).rows[0].n).toBe(1)
      expect((await client.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1`, [viewed])).rows[0].n).toBeGreaterThan(0)
      await expect(access(join(temporary, `${foreign}.dump`))).rejects.toThrow()
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(foreign)} CASCADE`).catch(() => undefined)
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(viewed)} CASCADE`).catch(() => undefined)
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(typesOnly)} CASCADE`).catch(() => undefined)
      await client.end()
      await rm(temporary, { recursive: true, force: true })
    }
  }, 30_000)

  it('keeps the maintenance lock supervised: a killed session does not crash the Studio, stops new units and is taken again', async () => {
    const schema = schemaName('maint')
    const store = new PostgresStorageBackend({ connectionString: dsn!, schema, ssl: false, poolMax: 2, heartbeatMs: 100, maintenanceRetryMs: 200 })
    const admin = new Client({ connectionString: dsn!, ssl: false })
    await admin.connect()
    const uncaught: unknown[] = []
    const onUncaught = (error: unknown) => uncaught.push(error)
    process.on('uncaughtException', onUncaught)
    try {
      await store.waitUntilReady()
      expect(store.maintenanceLockHeld).toBe(true)
      // Kill the lock session the way a failover, an idle reaper or a DBA would.
      const killed = await admin.query<{ pid: number }>(
        `SELECT pg_terminate_backend(pid) AS ok, pid FROM pg_stat_activity WHERE application_name = $1`,
        [`dz23-storage:maintenance:${schema}`],
      )
      expect(killed.rowCount).toBeGreaterThan(0)
      // The guarantee is dropped immediately, and opening a unit is refused rather than running unprotected.
      await vi.waitFor(() => { expect(store.maintenanceLockHeld).toBe(false) }, { timeout: 5_000, interval: 25 })
      await expect(store.kv!.open({ name: 'maint_unit', version: 1, tables: ['records'], hasGlobal: false }))
        .rejects.toThrow('maintenance lock')
      // And it comes back on its own.
      await vi.waitFor(() => { expect(store.maintenanceLockHeld).toBe(true) }, { timeout: 10_000, interval: 50 })
      const unit = await store.kv!.open({ name: 'maint_unit', version: 1, tables: ['records'], hasGlobal: false })
      await unit.close()
      // The dead connection must never reach the process as an unhandled error.
      expect(uncaught).toEqual([])
    } finally {
      process.off('uncaughtException', onUncaught)
      await store.close()
      await admin.end()
    }
  }, 30_000)

  it('keeps a writer and a restore from ever overlapping: whoever takes the maintenance lock first wins', async () => {
    // The window this closes: `maintenanceHeld` was read, and only THEN was the unit lock
    // taken. Between the two, a restore could take the maintenance lock EXCLUSIVE, list the
    // units it knew about and DROP SCHEMA under a writer that had just walked in.
    const schema = schemaName('maint_race_writer')
    const store = new PostgresStorageBackend({ connectionString: dsn!, schema, ssl: false, poolMax: 2, heartbeatMs: 100, maintenanceRetryMs: 60_000 })
    const restore = new Client({ connectionString: dsn!, ssl: false })
    await restore.connect()
    const admin = new Client({ connectionString: dsn!, ssl: false })
    await admin.connect()
    const lockName = storageMaintenanceLockName(schema)
    const restoreTriesToTakeOver = async (): Promise<boolean> => (await restore.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [lockName],
    )).rows[0]!.acquired
    try {
      await store.waitUntilReady()
      const unit = await store.kv!.open({ name: 'race_unit', version: 1, tables: ['records'], hasGlobal: false })

      // 1) The writer is in. Even with the Studio's own supervising session gone — killed by a
      //    failover, an idle reaper or a DBA — the WRITER'S OWN session still holds the schema
      //    shared, so the restore cannot take it exclusive and cannot drop anything.
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1', [`dz23-storage:maintenance:${schema}`])
      await vi.waitFor(() => { expect(store.maintenanceLockHeld).toBe(false) }, { timeout: 5_000, interval: 25 })
      expect(await restoreTriesToTakeOver()).toBe(false)
      await unit.close()

      // 2) The restore is in. The flag still claims the guarantee — this IS the window — but the
      //    database is the authority, so opening a unit is refused instead of writing into a
      //    schema that is about to be replaced.
      await vi.waitFor(async () => { expect(await restoreTriesToTakeOver()).toBe(true) }, { timeout: 5_000, interval: 50 })
      ;(store as unknown as { maintenanceHeld: boolean }).maintenanceHeld = true
      await expect(store.kv!.open({ name: 'race_unit_two', version: 1, tables: ['records'], hasGlobal: false }))
        .rejects.toThrow('maintenance lock')
    } finally {
      await restore.query('SELECT pg_advisory_unlock_all()').catch(() => undefined)
      await restore.end()
      await admin.end()
      await store.close()
    }
  }, 30_000)

  it('leaves no orphan lock session when close() races the opening', async () => {
    const schema = schemaName('maint_race')
    const store = new PostgresStorageBackend({ connectionString: dsn!, schema, ssl: false, poolMax: 2 })
    // No `await waitUntilReady()`: close lands while the lock session is still being taken.
    await store.close()
    const admin = new Client({ connectionString: dsn!, ssl: false })
    await admin.connect()
    try {
      const sessions = await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1`,
        [`dz23-storage:maintenance:${schema}`],
      )
      expect(sessions.rows[0]!.n).toBe(0)
    } finally {
      await admin.end()
    }
  }, 20_000)

  it('exposes the Studio lock error as an upstream StorageError subclass', () => {
    const error = new StudioStorageError('locked')
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ name: 'StudioStorageError', code: 'unit-locked', studioCode: 'unit-locked' })
  })

  it('registers and disposes the postgres backend through the credential seam', async () => {
    const registered = vi.fn(() => vi.fn())
    const provided = vi.fn()
    const disposers: Array<() => void | Promise<void>> = []
    const context = {
      credentials: { resolve: vi.fn(() => Promise.resolve({ value: dsn!, source: 'env' })) },
      storage: { backend: { register: registered } },
      provide: provided,
      effect: (factory: () => () => void | Promise<void>) => { disposers.push(factory()) },
    }
    await apply(context as never, { dsnRef: 'DZ23_POSTGRES_TEST_DSN', schema: schemaName('plugin'), ssl: 'off', poolMax: 2 })
    expect(registered).toHaveBeenCalledWith('postgres', expect.any(PostgresStorageBackend))
    expect(provided).toHaveBeenCalledWith('storage.backend.postgres', expect.any(PostgresStorageBackend))
    expect(provided).toHaveBeenCalledWith('studioCapacity', expect.any(PostgresCapacityGovernor))
    const backupService = provided.mock.calls.find(call => call[0] === 'studioStorageBackup')?.[1] as { runOnce(): Promise<unknown>; lastResult(): unknown; snapshot(): Promise<{ domains: unknown[] }> }
    expect(backupService.lastResult()).toBeUndefined()
    await expect(backupService.runOnce()).rejects.toThrow('scheduled backup is not configured')
    expect((await backupService.snapshot()).domains).toEqual([])
    await Promise.all(disposers.map(dispose => dispose()))
  })

  it('schedules logical backups when configured and exposes the last result', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'dz23-p31-backup-plugin-'))
    const disposers: Array<() => void | Promise<void>> = []
    const provided = vi.fn()
    const logged: string[] = []
    const context = {
      credentials: { resolve: vi.fn(() => Promise.resolve({ value: dsn!, source: 'env' })) },
      storage: { backend: { register: vi.fn(() => vi.fn()) } },
      provide: provided,
      effect: (factory: () => () => void | Promise<void>) => { disposers.push(factory()) },
      logger: { info: (line: string) => logged.push(line), warn: (line: string) => logged.push(line) },
    }
    try {
      const schema = schemaName('plugin_backup')
      await apply(context as never, { dsnRef: 'DZ23_POSTGRES_TEST_DSN', schema, ssl: 'off', poolMax: 2, backupDirectory: join(temporary, 'backups'), backupIntervalMinutes: 5, backupKeep: 2 })
      const service = provided.mock.calls.find(call => call[0] === 'studioStorageBackup')?.[1] as { runOnce(): Promise<{ status: string; file: string | null }>; lastResult(): unknown }
      const result = await service.runOnce()
      expect(result).toMatchObject({ status: 'created', error: null })
      expect(service.lastResult()).toEqual(result)
      expect((await stat(result.file!)).mode & 0o777).toBe(0o600)
      expect(logged.some(line => line.includes('backup created'))).toBe(true)
      // The copy is made by a process of its own: the file exists, is complete and validates on its own.
      const bundle = JSON.parse(await readFile(result.file!, 'utf8')) as StorageExportBundle
      expect(() => validateBundle(bundle)).not.toThrow()
      expect(Array.isArray(bundle.domains)).toBe(true)
    } finally {
      await Promise.all(disposers.map(dispose => dispose()))
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('fails startup without a configured DSN or usable TLS', async () => {
    const base = {
      storage: { backend: { register: vi.fn() } },
      provide: vi.fn(),
      effect: vi.fn(),
    }
    await expect(apply({ ...base, credentials: { resolve: () => Promise.resolve(undefined) } } as never, {
      dsnRef: 'MISSING_DSN', schema: 'valid_schema', ssl: 'off', poolMax: 1,
    })).rejects.toThrow("credential reference 'MISSING_DSN' is not configured")
    await expect(apply({ ...base, credentials: { resolve: () => Promise.resolve({ value: dsn!, source: 'env' }) } } as never, {
      dsnRef: 'DZ23_POSTGRES_TEST_DSN', schema: 'bad-name', ssl: 'off', poolMax: 1,
    })).rejects.toThrow('violates')
    await expect(apply({ ...base, credentials: { resolve: () => Promise.resolve({ value: dsn!, source: 'env' }) } } as never, {
      dsnRef: 'DZ23_POSTGRES_TEST_DSN', schema: `schema_${'x'.repeat(40)}`, ssl: 'off', poolMax: 1,
    })).rejects.toThrow('40 character limit')
    await expect(apply({ ...base, credentials: { resolve: () => Promise.resolve({ value: dsn!, source: 'env' }) } } as never, {
      dsnRef: 'DZ23_POSTGRES_TEST_DSN', schema: schemaName('tls'), ssl: 'require', poolMax: 1,
    })).rejects.toThrow('PostgreSQL is unavailable or incompatible')
    await expect(apply({ ...base, credentials: { resolve: () => Promise.resolve({ value: dsn!, source: 'env' }) } } as never, {
      dsnRef: 'DZ23_POSTGRES_TEST_DSN', schema: schemaName('tlsverify'), ssl: 'verify-full', poolMax: 1,
    })).rejects.toThrow('PostgreSQL is unavailable or incompatible')
  })

  it('applies validated defaults for schema, TLS mode and pool size', async () => {
    const unreachable = 'postgresql://127.0.0.1:1/dz23_unreachable'
    await expect(apply({
      credentials: { resolve: () => Promise.resolve({ value: unreachable, source: 'env' }) },
      storage: { backend: { register: vi.fn() } },
      provide: vi.fn(),
      effect: vi.fn(),
    } as never, { dsnRef: 'DZ23_POSTGRES_TEST_DSN' })).rejects.toThrow('PostgreSQL is unavailable or incompatible')
  })
})

afterAll(async () => {
  if (dsn === undefined) return
  const client = new Client({ connectionString: dsn })
  await client.connect()
  for (const schema of schemas) await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await client.end()
})

async function retryOpen(
  instance: PostgresStorageBackend,
  descriptor: { name: string; version: number; tables: readonly string[]; hasGlobal: boolean },
) {
  let last: unknown
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      return await instance.kv!.open(descriptor)
    } catch (error) {
      last = error
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  throw last
}

function readOnlyRepository(workspaces: Workspace[], memberships: Membership[]): TenancyRepository {
  const readonlyError = () => Promise.reject(new Error('read only test repository'))
  return {
    organizations: () => [] as Organization[],
    putOrganization: readonlyError,
    workspaces: () => workspaces,
    putWorkspace: readonlyError,
    memberships: () => memberships,
    putMembership: readonlyError,
    invitations: () => [] as Invitation[],
    putInvitation: readonlyError,
  }
}

function runWithInput(command: string, args: string[], input: Buffer): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', code => code === 0
      ? resolvePromise(stdout)
      : reject(new Error(`${command} exited with code ${String(code)}: ${stderr}`)))
    child.stdin.end(input)
  })
}
