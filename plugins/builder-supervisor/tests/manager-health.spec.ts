import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { posix } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileBuilderRuntimeHealthStore, runtimeHealth, sanitizeRuntimeHealthCode, type BuilderRuntimeHealth } from '../src/manager-health.js'
import type { BuilderRuntimeScopeId } from '../src/runtime-scope.js'

const paths: string[] = []
const linux = process.platform === 'linux' ? describe : describe.skip
const scope = `s_${'1'.repeat(48)}` as BuilderRuntimeScopeId
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('runtime health records', () => {
  it('preserves since only while state is unchanged and sanitizes errors', () => {
    const first = runtimeHealth(scope, 'STARTING', undefined, 'NONE', new Date('2026-01-01T00:00:00.000Z'))
    const same = runtimeHealth(scope, 'STARTING', first, 'NONE', new Date('2026-01-01T00:00:01.000Z'))
    const healthy = runtimeHealth(scope, 'HEALTHY', same, 'NONE', new Date('2026-01-01T00:00:02.000Z'))
    expect(same.since).toBe(first.since); expect(healthy.since).toBe(healthy.updated_at)
    expect(sanitizeRuntimeHealthCode(Object.assign(new Error('secret-value'), { code: 'BLOCKED_EXTERNAL' }))).toEqual({ state: 'BLOCKED_EXTERNAL', code: 'EXTERNAL_DEPENDENCY' })
    expect(sanitizeRuntimeHealthCode({ code: 'INVALID_SUPERVISOR_CONFIGURATION' })).toEqual({ state: 'DEGRADED', code: 'CONFIG_INVALID' })
    expect(sanitizeRuntimeHealthCode(new Error('secret-value'))).toEqual({ state: 'DEGRADED', code: 'START_FAILED' })
  })
})

linux('persistent runtime health', () => {
  it('atomically persists a strict record and replaces it durably', async () => {
    const root = await mkdtemp(posix.join(tmpdir(), 'manager-health-')); paths.push(root); await chmod(root, 0o700)
    const store = new FileBuilderRuntimeHealthStore(root)
    const first = runtimeHealth(scope, 'STARTING', undefined, 'NONE', new Date('2026-01-01T00:00:00.000Z'))
    const second = runtimeHealth(scope, 'HEALTHY', first, 'NONE', new Date('2026-01-01T00:00:01.000Z'))
    await store.write(first); await store.write(second)
    expect(JSON.parse(await readFile(posix.join(root, scope, 'health.json'), 'utf8'))).toEqual(second)
  })

  it('rejects unsafe roots, linked targets, and malformed records', async () => {
    const root = await mkdtemp(posix.join(tmpdir(), 'manager-health-')); paths.push(root); await chmod(root, 0o700)
    const store = new FileBuilderRuntimeHealthStore(root)
    const valid = runtimeHealth(scope, 'HEALTHY', undefined)
    await store.write(valid)
    const target = posix.join(root, scope, 'other.json'); await import('node:fs/promises').then(fs => fs.writeFile(target, '{}', { mode: 0o600 }))
    await rm(posix.join(root, scope, 'health.json')); await symlink(target, posix.join(root, scope, 'health.json'))
    await expect(store.write(valid)).rejects.toThrow('INVALID_HEALTH_STORE')
    await rm(posix.join(root, scope, 'health.json')); await link(target, posix.join(root, scope, 'health.json'))
    await expect(store.write(valid)).rejects.toThrow('INVALID_HEALTH_STORE')
    await expect(store.write({ ...valid, updated_at: 'not-a-date' } as BuilderRuntimeHealth)).rejects.toThrow('INVALID_HEALTH_RECORD')
    await mkdir(posix.join(root, 'weak'), { mode: 0o777 }); await chmod(posix.join(root, 'weak'), 0o777)
    await expect(new FileBuilderRuntimeHealthStore(posix.join(root, 'weak')).write(valid)).rejects.toThrow('INVALID_HEALTH_STORE')
  })

  it('rejects every malformed record class before parsing dates or touching unsafe paths', async () => {
    const root = await mkdtemp(posix.join(tmpdir(), 'manager-health-')); paths.push(root); await chmod(root, 0o700)
    const valid = runtimeHealth(scope, 'HEALTHY', undefined)
    const malformed: unknown[] = [
      { ...valid, extra: true },
      { ...valid, version: 2 },
      { ...valid, state: 1 },
      { ...valid, state: 'UNKNOWN' },
      { ...valid, code: 1 },
      { ...valid, code: 'SECRET_DETAIL' },
      { ...valid, since: 1 },
      { ...valid, updated_at: 1 },
      { ...valid, since: '2026-01-01' },
    ]
    for (const value of malformed) {
      await expect(new FileBuilderRuntimeHealthStore(root).write(value as BuilderRuntimeHealth)).rejects.toThrow('INVALID_HEALTH_RECORD')
    }
    await expect(new FileBuilderRuntimeHealthStore(root).write({ ...valid, scope_id: 'tenant-visible' as BuilderRuntimeScopeId })).rejects.toThrow('INVALID_HEALTH_STORE')
    await expect(new FileBuilderRuntimeHealthStore('relative').write(valid)).rejects.toThrow('INVALID_HEALTH_STORE')
    await expect(new FileBuilderRuntimeHealthStore('/').write(valid)).rejects.toThrow('INVALID_HEALTH_STORE')
  })

  it('fails closed for non-directory path components and races creating the private scope directory', async () => {
    const root = await mkdtemp(posix.join(tmpdir(), 'manager-health-')); paths.push(root); await chmod(root, 0o700)
    const blocked = posix.join(root, 'blocked')
    await writeFile(blocked, 'not-a-directory', { mode: 0o600 })
    await expect(new FileBuilderRuntimeHealthStore(posix.join(blocked, 'child')).write(runtimeHealth(scope, 'HEALTHY', undefined))).rejects.toThrow('INVALID_HEALTH_STORE')

    const concurrentRoot = posix.join(root, 'concurrent')
    const records = Array.from({ length: 16 }, (_, index) => runtimeHealth(`s_${index.toString(16).repeat(48).slice(0, 48)}` as BuilderRuntimeScopeId, index % 2 === 0 ? 'STARTING' : 'HEALTHY', undefined, 'NONE', new Date(1_700_000_000_000 + index)))
    await Promise.all(records.map(record => new FileBuilderRuntimeHealthStore(concurrentRoot).write(record)))
    for (const record of records) expect(JSON.parse(await readFile(posix.join(concurrentRoot, record.scope_id, 'health.json'), 'utf8'))).toEqual(record)
  })

  it('maps directory creation failures and rejects a non-private but non-writable directory', async () => {
    const root = await mkdtemp(posix.join(tmpdir(), 'manager-health-')); paths.push(root); await chmod(root, 0o700)
    const valid = runtimeHealth(scope, 'HEALTHY', undefined)
    const failedMkdir = new FileBuilderRuntimeHealthStore(root, process.getuid?.(), async () => { throw Object.assign(new Error('private-path-detail'), { code: 'EACCES' }) })
    await expect(failedMkdir.write(valid)).rejects.toThrow('INVALID_HEALTH_STORE')

    const visible = posix.join(root, 'visible')
    await mkdir(visible, { mode: 0o744 }); await chmod(visible, 0o744)
    await expect(new FileBuilderRuntimeHealthStore(visible).write(valid)).rejects.toThrow('INVALID_HEALTH_STORE')
  })
})
