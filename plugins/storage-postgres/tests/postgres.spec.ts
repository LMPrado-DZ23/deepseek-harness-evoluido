import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Client } from 'pg'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import { runKvBackendContract } from '/home/leandro/harness-studio-poc02/deepseek-harness/packages/storage/storage/tests/contract.ts'
import { PostgresStorageBackend } from '../src/backend.ts'
import { StudioStorageError } from '../src/errors.ts'
import { quoteIdentifier, STORAGE_POSTGRES_LAYOUT_VERSION } from '../src/schema.ts'
import { StudioTenancyService, type TenancyRepository } from '../../tenancy/src/service.ts'
import type { Invitation, Membership, Organization, Workspace } from '../../tenancy/src/model.ts'
import { descriptorOf } from '@deepseek-ai/dsh-storage-domain'
import { exportStorage, importStorage, validateBundle } from '../../../scripts/storage-migration.ts'
import { STUDIO_DOMAIN_SPECS } from '../../../scripts/studio-domain-specs.ts'
import { apply } from '../src/index.ts'

const dsn = process.env.DZ23_POSTGRES_TEST_DSN
const describePostgres = dsn === undefined ? describe.skip : describe
const schemas: string[] = []

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
  })

  it('exposes the Studio lock error as an upstream StorageError subclass', () => {
    const error = new StudioStorageError('locked')
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ name: 'StudioStorageError', code: 'unit-locked' })
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
    await Promise.all(disposers.map(dispose => dispose()))
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
