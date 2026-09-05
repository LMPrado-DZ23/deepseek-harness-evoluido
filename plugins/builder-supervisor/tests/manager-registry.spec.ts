import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { chmod, link, lstat, mkdir, mkdtemp, open, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { posix } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { builderRuntimeRegistryPath, loadBuilderRuntimeRegistry, type BuilderRuntimeRegistrySlot, type ManagerSecureFileRuntime } from '../src/manager-registry.js'
import type { BuilderRuntimeScopeId } from '../src/runtime-scope.js'
import type { BuilderSupervisorRootPolicy } from '../src/supervisor-config.js'

const paths: string[] = []
const linux = process.platform === 'linux' ? describe : describe.skip
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const scope = (digit: string): BuilderRuntimeScopeId => `s_${digit.repeat(48)}`

linux('authoritative runtime registry', () => {
  it('loads one exact strict registry and hashes raw canonical bytes', async () => {
    const fixture = await createFixture()
    const loaded = await loadBuilderRuntimeRegistry(`file:${fixture.registryPath}`, fixture.roots)
    expect(loaded).toEqual({ version: 1, installationId: 'a'.repeat(64), generation: 7, slots: fixture.slots, sha256: createHash('sha256').update(fixture.raw).digest('hex') })
  })

  it('rejects extra fields, duplicate scopes/configs, traversal, wrong location, and oversized slot sets', async () => {
    const fixture = await createFixture()
    await rewrite(fixture, { ...fixture.value, extra: true }); await expectInvalid(fixture)
    await rewrite(fixture, { ...fixture.value, slots: [fixture.rawSlots[0], fixture.rawSlots[0]] }); await expectInvalid(fixture)
    await rewrite(fixture, { ...fixture.value, slots: [{ ...fixture.rawSlots[0], scope_id: scope('2') }, fixture.rawSlots[0]] }); await expectInvalid(fixture)
    await rewrite(fixture, { ...fixture.value, slots: [{ ...fixture.rawSlots[0], config_ref: `file:${fixture.roots.configRoot}/instances/${scope('1')}/../secret` }] }); await expectInvalid(fixture)
    await expect(loadBuilderRuntimeRegistry(`file:${fixture.registryPath}.other`, fixture.roots)).rejects.toThrow('INVALID_RUNTIME_REGISTRY')
    await expect(loadBuilderRuntimeRegistry(undefined as unknown as string, fixture.roots)).rejects.toThrow('INVALID_RUNTIME_REGISTRY')
    await rewrite(fixture, { ...fixture.value, slots: Array.from({ length: 513 }, (_, index) => ({ ...fixture.rawSlots[0], scope_id: `s_${index.toString(16).padStart(48, '0')}`, config_ref: `file:${fixture.roots.configRoot}/instances/s_${index.toString(16).padStart(48, '0')}/supervisor.json` })) }); await expectInvalid(fixture)
  })

  it('rejects malformed generations, states, hashes, ids, JSON, and non-record roots', async () => {
    const fixture = await createFixture()
    for (const patch of [{ generation: -1 }, { generation: 1.5 }, { installation_id: 'tenant' }, { version: 2 }, { slots: [{ ...fixture.rawSlots[0], state: 'ready' }] }, { slots: [{ ...fixture.rawSlots[0], config_sha256: 'secret' }] }]) {
      await rewrite(fixture, { ...fixture.value, ...patch }); await expectInvalid(fixture)
    }
    await writeFile(fixture.registryPath, '{broken', { mode: 0o600 }); await expectInvalid(fixture)
    await writeFile(fixture.registryPath, '[]', { mode: 0o600 }); await expectInvalid(fixture)
  })

  it('rejects symlinks, hardlinks, writable files, inode swaps, NUL, and malformed UTF-8', async () => {
    const fixture = await createFixture()
    await chmod(fixture.registryPath, 0o666); await expectInvalid(fixture); await chmod(fixture.registryPath, 0o600)
    await chmod(fixture.registryPath, 0o440); await expectInvalid(fixture); await chmod(fixture.registryPath, 0o600)
    const sibling = `${fixture.registryPath}.link`; await link(fixture.registryPath, sibling); await expectInvalid(fixture); await unlink(sibling)
    const target = `${fixture.registryPath}.target`; await writeFile(target, fixture.raw, { mode: 0o600 }); await unlink(fixture.registryPath); await symlink(target, fixture.registryPath); await expectInvalid(fixture)
    await unlink(fixture.registryPath); await writeFile(fixture.registryPath, Buffer.from([0xff, 0xfe]), { mode: 0o600 }); await expectInvalid(fixture)
    await writeFile(fixture.registryPath, Buffer.from([0x7b, 0x00, 0x7d]), { mode: 0o600 }); await expectInvalid(fixture)
  })

  it('rejects unsupported runtime identity, inode drift, realpath drift, and unsafe config roots', async () => {
    const fixture = await createFixture(); const stat = await lstat(fixture.registryPath)
    await expect(loadBuilderRuntimeRegistry(`file:${fixture.registryPath}`, fixture.roots, secureRuntime({ platform: 'win32' }))).rejects.toThrow('INVALID_RUNTIME_REGISTRY')
    await expect(loadBuilderRuntimeRegistry(`file:${fixture.registryPath}`, fixture.roots, secureRuntime({ uid: undefined }))).rejects.toThrow('INVALID_RUNTIME_REGISTRY')
    await expect(loadBuilderRuntimeRegistry(`file:${fixture.registryPath}`, fixture.roots, secureRuntime({ uid: stat.uid + 1 }))).rejects.toThrow('INVALID_RUNTIME_REGISTRY')
    await expect(loadBuilderRuntimeRegistry(`file:${fixture.registryPath}`, fixture.roots, secureRuntime({ lstat: async path => path === fixture.registryPath ? statWith(stat, { ino: stat.ino + 1 }) : lstat(path) }))).rejects.toThrow('INVALID_RUNTIME_REGISTRY')
    await expect(loadBuilderRuntimeRegistry(`file:${fixture.registryPath}`, fixture.roots, secureRuntime({ realpath: async path => path === fixture.registryPath ? `${path}.moved` : realpath(path) }))).rejects.toThrow('INVALID_RUNTIME_REGISTRY')
    expect(() => builderRuntimeRegistryPath({ ...fixture.roots, configRoot: '/config/../unsafe' })).toThrow('INVALID_RUNTIME_REGISTRY')
  })

})

interface Fixture { readonly roots: BuilderSupervisorRootPolicy; readonly registryPath: string; readonly slots: readonly BuilderRuntimeRegistrySlot[]; readonly rawSlots: readonly Record<string, unknown>[]; readonly value: Record<string, unknown>; readonly raw: Buffer }
async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(posix.join(tmpdir(), 'manager-registry-')); paths.push(root)
  const roots = { configRoot: posix.join(root, 'config'), secretRoot: posix.join(root, 'secrets'), socketRoot: posix.join(root, 'run'), artifactRoot: posix.join(root, 'artifacts'), exportRoot: posix.join(root, 'exports'), stateRoot: posix.join(root, 'state'), dockerSocketPath: posix.join(root, 'docker.sock') }
  const registryPath = builderRuntimeRegistryPath(roots); await mkdir(posix.dirname(registryPath), { recursive: true, mode: 0o700 })
  const rawSlots = [{ scope_id: scope('1'), config_ref: `file:${roots.configRoot}/instances/${scope('1')}/supervisor.json`, config_sha256: 'b'.repeat(64), state: 'active' }]
  const value = { version: 1, installation_id: 'a'.repeat(64), generation: 7, slots: rawSlots }
  const raw = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'); await writeFile(registryPath, raw, { mode: 0o600 })
  const slots = [{ scopeId: scope('1'), configReference: rawSlots[0]!.config_ref as `file:${string}`, configSha256: 'b'.repeat(64), state: 'active' as const }]
  return { roots, registryPath, slots, rawSlots, value, raw }
}
async function rewrite(fixture: Fixture, value: unknown): Promise<void> { await writeFile(fixture.registryPath, `${JSON.stringify(value)}\n`, { mode: 0o600 }) }
async function expectInvalid(fixture: Fixture): Promise<void> { await expect(loadBuilderRuntimeRegistry(`file:${fixture.registryPath}`, fixture.roots)).rejects.toThrow('INVALID_RUNTIME_REGISTRY') }

function secureRuntime(overrides: Partial<ManagerSecureFileRuntime> = {}): ManagerSecureFileRuntime {
  return { platform: 'linux', uid: process.getuid?.(), noFollowFlag: constants.O_NOFOLLOW, open, lstat, realpath, ...overrides }
}

function statWith(stat: Stats, values: Partial<Pick<Stats, 'ino'>>): Stats {
  return new Proxy(stat, { get(target, property) { return property in values ? values[property as keyof typeof values] : Reflect.get(target, property, target) } })
}
