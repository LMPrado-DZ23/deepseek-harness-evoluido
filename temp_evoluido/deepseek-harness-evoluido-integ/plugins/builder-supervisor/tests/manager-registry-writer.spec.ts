import { createHash } from 'node:crypto'
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { posix } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MANAGER_REGISTRY_WRITER_TEST_ONLY, activateBuilderRuntimeSlot } from '../src/manager-registry-writer.js'
import { builderRuntimeRegistryPath, loadBuilderRuntimeRegistry } from '../src/manager-registry.js'
import { deriveBuilderRuntimeScopeId } from '../src/runtime-scope.js'
import { computeBuilderSupervisorConfigEnvelopeV2Sha256, type BuilderSupervisorRootPolicy } from '../src/supervisor-config.js'
import { canonicalTemplateStoreManifestBytes, computeTemplateTreeSha256 } from '../src/store-security.js'

const linux = process.platform === 'linux' ? describe : describe.skip
const cleanup: string[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

linux('durable runtime registry writer', () => {
  it('activates once, keeps schema v1 physical-only, and is idempotent', async () => {
    const fixture = await createFixture('tenant-a', 'instance-a')
    const first = await activateBuilderRuntimeSlot(fixture.request)
    const second = await activateBuilderRuntimeSlot(fixture.request)
    expect(first).toMatchObject({ state: 'ACTIVATED', generation: 1, scopeId: fixture.scopeId })
    expect(second).toEqual({ ...first, state: 'UNCHANGED' })
    const raw = await readFile(builderRuntimeRegistryPath(fixture.roots), 'utf8')
    expect(raw).not.toMatch(/tenant-a|instance-a|"tenant_id"|"instance_id"|token|secret/iu)
    expect(JSON.parse(raw)).toEqual({ version: 1, installation_id: fixture.installationId, generation: 1, slots: [{ scope_id: fixture.scopeId, config_ref: fixture.configReference, config_sha256: fixture.configSha256, state: 'active' }] })
    expect((await lstat(builderRuntimeRegistryPath(fixture.roots))).mode & 0o777).toBe(0o600)
  })

  it('serializes concurrent activation without lost updates and generates monotonic generations server-side', async () => {
    const first = await createFixture('tenant-a', 'instance-a')
    const second = await addScope(first, 'tenant-b', 'instance-b')
    const results = await Promise.all([activateBuilderRuntimeSlot(first.request), activateBuilderRuntimeSlot(second.request)])
    expect(results.map(result => result.generation).sort((a, b) => a - b)).toEqual([1, 2])
    const registry = await loadBuilderRuntimeRegistry(results[0]!.registryReference, first.roots)
    expect(registry.generation).toBe(2)
    expect(registry.slots.map(slot => slot.scopeId).sort()).toEqual([first.scopeId, second.scopeId].sort())
  })

  it('fails closed on mutated config hash/reference, divergent installation and registry corruption', async () => {
    const fixture = await createFixture('tenant-a', 'instance-a')
    await expect(activateBuilderRuntimeSlot({ ...fixture.request, configSha256: 'bad' })).rejects.toMatchObject({ code: 'INVALID_RUNTIME_ACTIVATION' })
    await expect(activateBuilderRuntimeSlot({ ...fixture.request, configSha256: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'INVALID_RUNTIME_ACTIVATION' })
    await expect(activateBuilderRuntimeSlot({ ...fixture.request, configReference: `file:${fixture.roots.configRoot}/instances/${fixture.scopeId}/other.json` })).rejects.toMatchObject({ code: 'INVALID_RUNTIME_ACTIVATION' })
    await activateBuilderRuntimeSlot(fixture.request)
    const other = await addScope(fixture, 'tenant-b', 'instance-b')
    await expect(activateBuilderRuntimeSlot({ ...other.request, installationId: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'RUNTIME_REGISTRY_CONFLICT' })
    await writeFile(builderRuntimeRegistryPath(fixture.roots), '{broken\n', { mode: 0o600 })
    await expect(activateBuilderRuntimeSlot(other.request)).rejects.toMatchObject({ code: 'INVALID_RUNTIME_ACTIVATION' })
  })

  it('recovers before-rename and after-rename failures without generation gaps', async () => {
    const before = await createFixture('tenant-a', 'instance-a')
    await expect(activateBuilderRuntimeSlot(before.request, { beforeRegistryRename: async () => { throw new Error('CRASH') } })).rejects.toMatchObject({ code: 'INVALID_RUNTIME_ACTIVATION' })
    expect(await exists(builderRuntimeRegistryPath(before.roots))).toBe(false)
    await expect(activateBuilderRuntimeSlot(before.request)).resolves.toMatchObject({ state: 'UNCHANGED', generation: 1 })

    const after = await addScope(before, 'tenant-b', 'instance-b')
    await expect(activateBuilderRuntimeSlot(after.request, { afterRegistryRename: async () => { throw new Error('CRASH') } })).rejects.toMatchObject({ code: 'INVALID_RUNTIME_ACTIVATION' })
    await expect(activateBuilderRuntimeSlot(after.request)).resolves.toMatchObject({ state: 'UNCHANGED', generation: 2 })
  })

  it('rejects changed scope authority, full registries, and damaged permanent guards', async () => {
    const fixture = await createFixture('tenant-a', 'instance-a')
    await activateBuilderRuntimeSlot(fixture.request)
    const originalRegistry = await readFile(builderRuntimeRegistryPath(fixture.roots))
    const rolledBack = Buffer.from(`${JSON.stringify({ ...JSON.parse(originalRegistry.toString('utf8')), generation: 0 })}\n`)
    await writeFile(builderRuntimeRegistryPath(fixture.roots), rolledBack, { mode: 0o600 })
    await expect(activateBuilderRuntimeSlot(fixture.request)).rejects.toMatchObject({ code: 'RUNTIME_REGISTRY_CONFLICT' })
    await writeFile(builderRuntimeRegistryPath(fixture.roots), originalRegistry, { mode: 0o600 })
    await expect(activateBuilderRuntimeSlot({ ...fixture.request, configSha256: 'e'.repeat(64) })).rejects.toMatchObject({ code: 'INVALID_RUNTIME_ACTIVATION' })
    const registryPath = builderRuntimeRegistryPath(fixture.roots)
    const slots = Array.from({ length: 512 }, (_, index) => {
      const scope = `s_${index.toString(16).padStart(48, '0')}`
      return { scope_id: scope, config_ref: `file:${fixture.roots.configRoot}/instances/${scope}/supervisor.json`, config_sha256: 'b'.repeat(64), state: 'active' }
    })
    const fullRegistry = Buffer.from(`${JSON.stringify({ version: 1, installation_id: fixture.installationId, generation: 512, slots })}\n`)
    const fullHash = createHash('sha256').update(fullRegistry).digest('hex')
    await writeFile(registryPath, fullRegistry, { mode: 0o600 })
    await writeFile(posix.join(fixture.roots.stateRoot, 'manager', 'runtime-registry-authority.json'), MANAGER_REGISTRY_WRITER_TEST_ONLY.authorityBytes({ installationId: fixture.installationId, phase: 'committed', generation: 512, registrySha256: fullHash, registryBytes: fullRegistry }), { mode: 0o600 })
    const additional = await addScope(fixture, 'tenant-c', 'instance-c')
    await expect(activateBuilderRuntimeSlot(additional.request)).rejects.toMatchObject({ code: 'RUNTIME_REGISTRY_FULL' })
    const guard = posix.join(fixture.roots.stateRoot, 'manager', 'runtime-registry.guard')
    await chmod(guard, 0o660)
    await expect(activateBuilderRuntimeSlot(fixture.request)).rejects.toMatchObject({ code: 'RUNTIME_REGISTRY_RECOVERY_FAILED' })
  })

  it('rejects divergent installation, duplicated slots, and unsafe authority files without changing the registry', async () => {
    const fixture = await createFixture('tenant-a', 'instance-a')
    await activateBuilderRuntimeSlot(fixture.request)
    const registryPath = builderRuntimeRegistryPath(fixture.roots)
    const authorityPath = posix.join(fixture.roots.stateRoot, 'manager', 'runtime-registry-authority.json')
    const original = await readFile(registryPath)
    const originalValue = JSON.parse(original.toString('utf8')) as Record<string, unknown>
    const divergent = Buffer.from(`${JSON.stringify({ ...originalValue, installation_id: 'f'.repeat(64) })}\n`)
    const divergentHash = createHash('sha256').update(divergent).digest('hex')
    await writeFile(registryPath, divergent, { mode: 0o600 })
    await writeFile(authorityPath, MANAGER_REGISTRY_WRITER_TEST_ONLY.authorityBytes({ installationId: 'f'.repeat(64), phase: 'committed', generation: 1, registrySha256: divergentHash, registryBytes: divergent }), { mode: 0o600 })
    await expect(activateBuilderRuntimeSlot(fixture.request)).rejects.toMatchObject({ code: 'RUNTIME_REGISTRY_CONFLICT' })

    const duplicated = Buffer.from(`${JSON.stringify({ ...originalValue, slots: [...originalValue.slots as unknown[], ...(originalValue.slots as unknown[])] })}\n`)
    const duplicatedHash = createHash('sha256').update(duplicated).digest('hex')
    await writeFile(registryPath, duplicated, { mode: 0o600 })
    await writeFile(authorityPath, MANAGER_REGISTRY_WRITER_TEST_ONLY.authorityBytes({ installationId: fixture.installationId, phase: 'committed', generation: 1, registrySha256: duplicatedHash, registryBytes: duplicated }), { mode: 0o600 })
    await expect(activateBuilderRuntimeSlot(fixture.request)).rejects.toMatchObject({ code: 'INVALID_RUNTIME_ACTIVATION' })

    await writeFile(registryPath, original, { mode: 0o600 })
    const originalHash = createHash('sha256').update(original).digest('hex')
    await writeFile(authorityPath, MANAGER_REGISTRY_WRITER_TEST_ONLY.authorityBytes({ installationId: fixture.installationId, phase: 'committed', generation: 1, registrySha256: originalHash, registryBytes: original }), { mode: 0o600 })
    const alias = `${authorityPath}.alias`; await link(authorityPath, alias)
    await expect(activateBuilderRuntimeSlot(fixture.request)).rejects.toMatchObject({ code: 'RUNTIME_REGISTRY_RECOVERY_FAILED' })
    await unlink(alias); await chmod(authorityPath, 0o660)
    await expect(activateBuilderRuntimeSlot(fixture.request)).rejects.toMatchObject({ code: 'RUNTIME_REGISTRY_RECOVERY_FAILED' })
    expect(await readFile(registryPath)).toEqual(original)
  })

  it('rejects every malformed authority encoding before trusting its embedded registry', async () => {
    const fixture = await createFixture('tenant-a', 'instance-a')
    await activateBuilderRuntimeSlot(fixture.request)
    const registryPath = builderRuntimeRegistryPath(fixture.roots)
    const authorityPath = authorityFile(fixture)
    const registry = await readFile(registryPath)
    const registrySha = shaBuffer(registry)
    const canonical = JSON.parse(await readFile(authorityPath, 'utf8')) as Record<string, unknown>
    const malformedRegistry = Buffer.from('{}\n')
    const noncanonicalRegistry = Buffer.from(`${JSON.stringify(JSON.parse(registry.toString('utf8')), null, 2)}\n`)
    const cases: readonly (Buffer | Record<string, unknown>)[] = [
      Buffer.from([0x7b, 0x00, 0x7d]),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('{broken\n'),
      Buffer.from('[]\n'),
      { ...canonical, version: 2 },
      { ...canonical, registry_base64: '***' },
      { ...canonical, registry_base64: String(canonical.registry_base64).slice(0, -1) },
      { ...canonical, registry_base64: malformedRegistry.toString('base64'), registry_sha256: shaBuffer(malformedRegistry) },
      { ...canonical, registry_base64: noncanonicalRegistry.toString('base64'), registry_sha256: shaBuffer(noncanonicalRegistry) },
      { ...canonical, installation_id: 'f'.repeat(64) },
      { ...canonical, previous_registry_sha256: registrySha },
    ]
    for (const value of cases) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(`${JSON.stringify(value)}\n`)
      await writeFile(authorityPath, bytes, { mode: 0o600 })
      await expect(activateBuilderRuntimeSlot(fixture.request)).rejects.toMatchObject({ code: 'RUNTIME_REGISTRY_RECOVERY_FAILED' })
    }
    await rm(authorityPath)
    await symlink(registryPath, authorityPath)
    await expect(activateBuilderRuntimeSlot(fixture.request)).rejects.toMatchObject({ code: 'INVALID_RUNTIME_ACTIVATION' })
  })

  it('rejects orphan registries and every divergent pending/committed authority relation', async () => {
    const orphan = await createFixture('tenant-a', 'instance-a')
    await activateBuilderRuntimeSlot(orphan.request)
    await rm(authorityFile(orphan))
    await expect(activateBuilderRuntimeSlot(orphan.request)).rejects.toMatchObject({ code: 'RUNTIME_REGISTRY_RECOVERY_FAILED' })

    const divergent = await createFixture('tenant-a', 'instance-a')
    await activateBuilderRuntimeSlot(divergent.request)
    const currentBytes = await readFile(builderRuntimeRegistryPath(divergent.roots))
    const otherBytes = MANAGER_REGISTRY_WRITER_TEST_ONLY.canonicalRegistryBytes('f'.repeat(64), 1, [])
    await writeFile(authorityFile(divergent), MANAGER_REGISTRY_WRITER_TEST_ONLY.authorityBytes({ installationId: 'f'.repeat(64), phase: 'committed', generation: 1, registrySha256: shaBuffer(otherBytes), registryBytes: otherBytes }), { mode: 0o600 })
    await expect(activateBuilderRuntimeSlot(divergent.request)).rejects.toMatchObject({ code: 'RUNTIME_REGISTRY_CONFLICT' })

    const pending = await createFixture('tenant-a', 'instance-a')
    await activateBuilderRuntimeSlot(pending.request)
    const nextBytes = MANAGER_REGISTRY_WRITER_TEST_ONLY.canonicalRegistryBytes(pending.installationId, 2, [])
    await writeFile(authorityFile(pending), MANAGER_REGISTRY_WRITER_TEST_ONLY.authorityBytes({ installationId: pending.installationId, phase: 'pending', generation: 2, registrySha256: shaBuffer(nextBytes), previousRegistrySha256: 'f'.repeat(64), registryBytes: nextBytes }), { mode: 0o600 })
    await expect(activateBuilderRuntimeSlot(pending.request)).rejects.toMatchObject({ code: 'RUNTIME_REGISTRY_CONFLICT' })

    const parsed = await loadBuilderRuntimeRegistry(`file:${builderRuntimeRegistryPath(pending.roots)}`, pending.roots)
    await expect(MANAGER_REGISTRY_WRITER_TEST_ONLY.reconcileAuthority({ version: 1, installationId: pending.installationId, phase: 'pending', generation: parsed.generation + 1, registrySha256: parsed.sha256, registryBytes: currentBytes }, parsed, authorityFile(pending), builderRuntimeRegistryPath(pending.roots), `file:${builderRuntimeRegistryPath(pending.roots)}`, posix.dirname(authorityFile(pending)), posix.dirname(builderRuntimeRegistryPath(pending.roots)), pending.roots)).rejects.toMatchObject({ code: 'RUNTIME_REGISTRY_RECOVERY_FAILED' })
  })

  it('rejects changed active slots, exhausted generations, and failed post-publication verification', async () => {
    const changed = await createFixture('tenant-a', 'instance-a')
    await activateBuilderRuntimeSlot(changed.request)
    const original = await loadBuilderRuntimeRegistry(`file:${builderRuntimeRegistryPath(changed.roots)}`, changed.roots)
    await installCommittedRegistry(changed, 1, [{ ...original.slots[0]!, configSha256: 'e'.repeat(64) }])
    await expect(activateBuilderRuntimeSlot(changed.request)).rejects.toMatchObject({ code: 'RUNTIME_REGISTRY_CONFLICT' })

    const exhausted = await createFixture('tenant-a', 'instance-a')
    const existing = await addScope(exhausted, 'tenant-b', 'instance-b')
    await installCommittedRegistry(exhausted, Number.MAX_SAFE_INTEGER, [{ scopeId: exhausted.scopeId, configReference: exhausted.configReference, configSha256: exhausted.configSha256, state: 'active' }])
    await expect(activateBuilderRuntimeSlot(existing.request)).rejects.toMatchObject({ code: 'RUNTIME_REGISTRY_FULL' })

    for (const preserveLength of [false, true]) {
      const fixture = await createFixture(`tenant-${String(preserveLength)}`, `instance-${String(preserveLength)}`)
      const registryPath = builderRuntimeRegistryPath(fixture.roots)
      await expect(activateBuilderRuntimeSlot(fixture.request, { afterAuthorityCommitted: async () => {
        const wrongScope = `s_${'f'.repeat(48)}` as const
        const slots = preserveLength ? [{ scopeId: wrongScope, configReference: `file:${fixture.roots.configRoot}/instances/${wrongScope}/supervisor.json` as const, configSha256: 'f'.repeat(64), state: 'active' as const }] : []
        await writeFile(registryPath, MANAGER_REGISTRY_WRITER_TEST_ONLY.canonicalRegistryBytes(fixture.installationId, 1, slots), { mode: 0o600 })
      } })).rejects.toMatchObject({ code: 'RUNTIME_REGISTRY_RECOVERY_FAILED' })
    }
  })

  it('cleans valid crash temporaries and rejects malformed or unsafe temporary authority', async () => {
    const valid = await createFixture('tenant-a', 'instance-a')
    const validConfigManager = posix.join(valid.roots.configRoot, 'manager')
    const validStateManager = posix.join(valid.roots.stateRoot, 'manager')
    await mkdir(validConfigManager, { mode: 0o700 }); await mkdir(validStateManager, { mode: 0o700 })
    await writeFile(posix.join(validStateManager, 'runtime-registry.guard'), '', { mode: 0o600 })
    const registryTemp = posix.join(validConfigManager, `.runtime-registry.${'a'.repeat(32)}.tmp`)
    const authorityTemp = posix.join(validStateManager, `.runtime-registry-authority.${'b'.repeat(32)}.tmp`)
    await writeFile(registryTemp, 'stale', { mode: 0o600 }); await writeFile(authorityTemp, 'stale', { mode: 0o600 })
    await expect(activateBuilderRuntimeSlot(valid.request)).resolves.toMatchObject({ state: 'ACTIVATED' })
    expect(await exists(registryTemp)).toBe(false); expect(await exists(authorityTemp)).toBe(false)

    const malformed = await createFixture('tenant-b', 'instance-b')
    const malformedConfigManager = posix.join(malformed.roots.configRoot, 'manager')
    const malformedStateManager = posix.join(malformed.roots.stateRoot, 'manager')
    await mkdir(malformedConfigManager, { mode: 0o700 }); await mkdir(malformedStateManager, { mode: 0o700 })
    await writeFile(posix.join(malformedStateManager, 'runtime-registry.guard'), '', { mode: 0o600 })
    await writeFile(posix.join(malformedConfigManager, '.runtime-registry.bad.tmp'), 'bad', { mode: 0o600 })
    await expect(activateBuilderRuntimeSlot(malformed.request)).rejects.toMatchObject({ code: 'RUNTIME_REGISTRY_RECOVERY_FAILED' })

    const unsafe = await createFixture('tenant-c', 'instance-c')
    const unsafeConfigManager = posix.join(unsafe.roots.configRoot, 'manager')
    const unsafeStateManager = posix.join(unsafe.roots.stateRoot, 'manager')
    await mkdir(unsafeConfigManager, { mode: 0o700 }); await mkdir(unsafeStateManager, { mode: 0o700 })
    await writeFile(posix.join(unsafeStateManager, 'runtime-registry.guard'), '', { mode: 0o600 })
    await writeFile(posix.join(unsafeConfigManager, `.runtime-registry.${'c'.repeat(32)}.tmp`), 'bad', { mode: 0o660 })
    await expect(activateBuilderRuntimeSlot(unsafe.request)).rejects.toMatchObject({ code: 'RUNTIME_REGISTRY_RECOVERY_FAILED' })

    const badAuthorityName = await createFixture('tenant-d', 'instance-d')
    const badAuthorityState = posix.join(badAuthorityName.roots.stateRoot, 'manager')
    await mkdir(posix.join(badAuthorityName.roots.configRoot, 'manager'), { mode: 0o700 }); await mkdir(badAuthorityState, { mode: 0o700 })
    await writeFile(posix.join(badAuthorityState, 'runtime-registry.guard'), '', { mode: 0o600 })
    await writeFile(posix.join(badAuthorityState, '.runtime-registry-authority.bad.tmp'), 'bad', { mode: 0o600 })
    await expect(activateBuilderRuntimeSlot(badAuthorityName.request)).rejects.toMatchObject({ code: 'RUNTIME_REGISTRY_RECOVERY_FAILED' })

    const unsafeAuthority = await createFixture('tenant-e', 'instance-e')
    const unsafeAuthorityState = posix.join(unsafeAuthority.roots.stateRoot, 'manager')
    await mkdir(posix.join(unsafeAuthority.roots.configRoot, 'manager'), { mode: 0o700 }); await mkdir(unsafeAuthorityState, { mode: 0o700 })
    await writeFile(posix.join(unsafeAuthorityState, 'runtime-registry.guard'), '', { mode: 0o600 })
    await writeFile(posix.join(unsafeAuthorityState, `.runtime-registry-authority.${'d'.repeat(32)}.tmp`), 'bad', { mode: 0o660 })
    await expect(activateBuilderRuntimeSlot(unsafeAuthority.request)).rejects.toMatchObject({ code: 'RUNTIME_REGISTRY_RECOVERY_FAILED' })
  })

  it('fails closed for unsafe hosts, manager paths, guard races and every flock outcome', async () => {
    expect(() => MANAGER_REGISTRY_WRITER_TEST_ONLY.assertRegistryHost('/mnt/c/unsafe', 0xef53)).toThrow('RUNTIME_REGISTRY_RECOVERY_FAILED')
    expect(() => MANAGER_REGISTRY_WRITER_TEST_ONLY.assertRegistryHost('/safe', 0x58465342)).not.toThrow()
    expect(() => MANAGER_REGISTRY_WRITER_TEST_ONLY.assertRegistryHost('/safe', 0x1234)).toThrow('RUNTIME_REGISTRY_RECOVERY_FAILED')

    const root = await mkdtemp(posix.join(tmpdir(), 'drw-guard-')); cleanup.push(root)
    await expect(MANAGER_REGISTRY_WRITER_TEST_ONLY.ensurePrivateDirectory(posix.join(root, 'missing', 'child'))).rejects.toThrow()
    const nonDirectory = posix.join(root, 'not-directory'); await writeFile(nonDirectory, '')
    await expect(MANAGER_REGISTRY_WRITER_TEST_ONLY.ensurePrivateDirectory(nonDirectory)).rejects.toThrow('RUNTIME_REGISTRY_RECOVERY_FAILED')

    const strayDirectory = posix.join(root, 'stray'); await mkdir(strayDirectory, { mode: 0o700 }); await writeFile(posix.join(strayDirectory, 'stray'), '')
    await expect(MANAGER_REGISTRY_WRITER_TEST_ONLY.openPermanentGuard(posix.join(strayDirectory, 'guard'), strayDirectory)).rejects.toThrow('RUNTIME_REGISTRY_RECOVERY_FAILED')
    const raceDirectory = posix.join(root, 'race'); await mkdir(raceDirectory, { mode: 0o700 }); const raceGuard = posix.join(raceDirectory, 'guard')
    const raced = await MANAGER_REGISTRY_WRITER_TEST_ONLY.openPermanentGuard(raceGuard, raceDirectory, { beforeCreate: async () => { await writeFile(raceGuard, '', { mode: 0o600 }) } }); await raced.handle.close()
    const observedDirectory = posix.join(root, 'observed'); await mkdir(observedDirectory, { mode: 0o700 }); const observedGuard = posix.join(observedDirectory, 'guard')
    const observed = await MANAGER_REGISTRY_WRITER_TEST_ONLY.openPermanentGuard(observedGuard, observedDirectory, { afterOpenMissing: async () => { await writeFile(observedGuard, '', { mode: 0o600 }) } }); await observed.handle.close()
    const vanishedDirectory = posix.join(root, 'vanished'); await mkdir(vanishedDirectory, { mode: 0o700 })
    await expect(MANAGER_REGISTRY_WRITER_TEST_ONLY.openPermanentGuard(posix.join(vanishedDirectory, 'guard'), vanishedDirectory, { beforeCreate: async () => { await rm(vanishedDirectory, { recursive: true }) } })).rejects.toThrow()
    const interruptedDirectory = posix.join(root, 'interrupted'); await mkdir(interruptedDirectory, { mode: 0o700 })
    await expect(MANAGER_REGISTRY_WRITER_TEST_ONLY.openPermanentGuard(posix.join(interruptedDirectory, 'guard'), interruptedDirectory, { afterCreated: async () => { throw new Error('interrupt') } })).rejects.toThrow('interrupt')
    const linkedDirectory = posix.join(root, 'linked'); await mkdir(linkedDirectory, { mode: 0o700 }); const guardTarget = posix.join(root, 'guard-target'); await writeFile(guardTarget, '', { mode: 0o600 }); await symlink(guardTarget, posix.join(linkedDirectory, 'guard'))
    await expect(MANAGER_REGISTRY_WRITER_TEST_ONLY.openPermanentGuard(posix.join(linkedDirectory, 'guard'), linkedDirectory)).rejects.toThrow()

    const flockFile = posix.join(root, 'flock.guard'); await writeFile(flockFile, '', { mode: 0o600 }); const handle = await open(flockFile, 'r')
    try {
      const busy = posix.join(root, 'busy.sh'); await writeFile(busy, '#!/bin/sh\nexit 200\n', { mode: 0o700 })
      await expect(MANAGER_REGISTRY_WRITER_TEST_ONLY.acquireGuardWithProcess(handle, busy, 1_000)).rejects.toThrow('RUNTIME_REGISTRY_BUSY')
      await expect(MANAGER_REGISTRY_WRITER_TEST_ONLY.acquireGuardWithProcess(handle, posix.join(root, 'missing-flock'), 1_000)).rejects.toThrow('RUNTIME_REGISTRY_RECOVERY_FAILED')
      const slow = posix.join(root, 'slow.sh'); await writeFile(slow, '#!/bin/sh\nsleep 1\n', { mode: 0o700 })
      await expect(MANAGER_REGISTRY_WRITER_TEST_ONLY.acquireGuardWithProcess(handle, slow, 10)).rejects.toThrow('RUNTIME_REGISTRY_RECOVERY_FAILED')
    } finally { await handle.close() }
    expect(() => MANAGER_REGISTRY_WRITER_TEST_ONLY.assertMissing({ code: 'ENOENT' })).not.toThrow()
    expect(() => MANAGER_REGISTRY_WRITER_TEST_ONLY.assertMissing({ code: 'EACCES' })).toThrow()
  })
})

interface Fixture {
  readonly root: string
  readonly roots: BuilderSupervisorRootPolicy
  readonly installationId: string
  readonly scopeId: ReturnType<typeof deriveBuilderRuntimeScopeId>
  readonly configReference: `file:${string}`
  readonly configSha256: string
  readonly request: Parameters<typeof activateBuilderRuntimeSlot>[0]
}

async function createFixture(tenantId: string, instanceId: string): Promise<Fixture> {
  const root = await mkdtemp(posix.join(tmpdir(), 'drw-')); cleanup.push(root)
  const managed = posix.join(root, 'managed')
  const roots = policy(managed)
  for (const path of [roots.configRoot, roots.secretRoot, roots.socketRoot, roots.artifactRoot, roots.exportRoot, roots.stateRoot]) await mkdir(path, { recursive: true, mode: 0o700 })
  return addScope({ root, roots, installationId: 'a'.repeat(64) } as Fixture, tenantId, instanceId)
}

async function addScope(base: Pick<Fixture, 'root' | 'roots' | 'installationId'>, tenantId: string, instanceId: string): Promise<Fixture> {
  const scopeId = deriveBuilderRuntimeScopeId({ installationId: base.installationId, tenantId, instanceId })
  const configDir = posix.join(base.roots.configRoot, 'instances', scopeId)
  const secretDir = posix.join(base.roots.secretRoot, 'instances', scopeId)
  await mkdir(configDir, { recursive: true, mode: 0o700 }); await mkdir(secretDir, { recursive: true, mode: 0o700 })
  const entries = [{ path: 'app', type: 'directory' as const }]
  const tree = computeTemplateTreeSha256('v1', entries)
  const manifest = canonicalTemplateStoreManifestBytes({ version: 1, template_store_version: 'v1', tree_sha256: tree, entries })
  const token = Buffer.from(`token_${'T'.repeat(48)}\n`)
  const image = Buffer.from(`sha256:${'b'.repeat(64)}\n`)
  const store = Buffer.from(`${tree}\n`)
  const policyBytes = Buffer.from(`${'c'.repeat(64)}\n`)
  const tokenPath = posix.join(secretDir, 'token'); const imagePath = posix.join(configDir, 'builder-image.sha256'); const storePath = posix.join(configDir, 'template-store.sha256'); const manifestPath = posix.join(configDir, 'template-store.manifest.json'); const policyPath = posix.join(configDir, 'policy.sha256')
  await writeFile(tokenPath, token, { mode: 0o400 }); await writeFile(imagePath, image, { mode: 0o600 }); await writeFile(storePath, store, { mode: 0o600 }); await writeFile(manifestPath, manifest, { mode: 0o600 }); await writeFile(policyPath, policyBytes, { mode: 0o600 })
  const config = Buffer.from(`${JSON.stringify({ version: 2, installation_id: base.installationId, tenant_id: tenantId, instance_id: instanceId, socket_path: posix.join(base.roots.socketRoot, 'instances', scopeId, 'rpc.sock'), artifact_root: posix.join(base.roots.artifactRoot, 'instances', scopeId), export_root: posix.join(base.roots.exportRoot, 'instances', scopeId), journal_root: posix.join(base.roots.stateRoot, 'instances', scopeId, 'journal'), replay_root: posix.join(base.roots.stateRoot, 'instances', scopeId, 'rpc-replay'), docker_socket_path: base.roots.dockerSocketPath, bearer_token_ref: `file:${tokenPath}`, image_digest_ref: `file:${imagePath}`, template_store_version: 'v1', template_store_sha256_ref: `file:${storePath}`, template_store_manifest_ref: `file:${manifestPath}`, policy_sha256_ref: `file:${policyPath}` })}\n`)
  const configPath = posix.join(configDir, 'supervisor.json'); await writeFile(configPath, config, { mode: 0o600 })
  const configSha256 = computeBuilderSupervisorConfigEnvelopeV2Sha256({ configBytes: config, imageDigestBytes: image, templateStoreSha256Bytes: store, templateStoreManifestBytes: manifest, policySha256Bytes: policyBytes })
  const configReference = `file:${configPath}` as const
  return { root: base.root, roots: base.roots, installationId: base.installationId, scopeId, configReference, configSha256, request: { installationId: base.installationId, scopeId, configReference, configSha256, roots: base.roots } }
}

function policy(root: string): BuilderSupervisorRootPolicy { return { configRoot: posix.join(root, 'config'), secretRoot: posix.join(root, 'secret'), socketRoot: posix.join(root, 'socket'), artifactRoot: posix.join(root, 'artifact'), exportRoot: posix.join(root, 'export'), stateRoot: posix.join(root, 'state'), dockerSocketPath: posix.join(root, 'docker.sock') } }
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }
function authorityFile(fixture: Fixture): string { return posix.join(fixture.roots.stateRoot, 'manager', 'runtime-registry-authority.json') }
function shaBuffer(value: Buffer): string { return createHash('sha256').update(value).digest('hex') }
async function installCommittedRegistry(fixture: Fixture, generation: number, slots: Parameters<typeof MANAGER_REGISTRY_WRITER_TEST_ONLY.canonicalRegistryBytes>[2]): Promise<void> {
  const bytes = MANAGER_REGISTRY_WRITER_TEST_ONLY.canonicalRegistryBytes(fixture.installationId, generation, slots)
  const hash = shaBuffer(bytes)
  const registryPath = builderRuntimeRegistryPath(fixture.roots)
  await mkdir(posix.dirname(registryPath), { recursive: true, mode: 0o700 })
  await mkdir(posix.dirname(authorityFile(fixture)), { recursive: true, mode: 0o700 })
  if (!await exists(posix.join(posix.dirname(authorityFile(fixture)), 'runtime-registry.guard'))) await writeFile(posix.join(posix.dirname(authorityFile(fixture)), 'runtime-registry.guard'), '', { mode: 0o600 })
  await writeFile(registryPath, bytes, { mode: 0o600 })
  await writeFile(authorityFile(fixture), MANAGER_REGISTRY_WRITER_TEST_ONLY.authorityBytes({ installationId: fixture.installationId, phase: 'committed', generation, registrySha256: hash, registryBytes: bytes }), { mode: 0o600 })
}
