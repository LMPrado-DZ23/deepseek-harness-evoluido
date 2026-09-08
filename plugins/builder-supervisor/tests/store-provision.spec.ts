import { RUNNING_AS_ROOT } from './privilege.ts'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { posix } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { computeBuilderSupervisorConfigEnvelopeV2Sha256, loadBuilderSupervisorConfig, type BuilderSupervisorRootPolicy } from '../src/supervisor-config.js'
import { BUILDER_UNIX_SOCKET_MAX_BYTES, deriveBuilderRuntimeScopeId } from '../src/runtime-scope.js'
import { BuilderProvisionError, STORE_PROVISION_GUARD_TEST_ONLY, provisionBuilderSupervisor, type BuilderProvisionRequest } from '../src/store-provision.js'
import { TEMPLATE_ENTRY_MAX_BYTES, TEMPLATE_MANIFEST_MAX_BYTES, canonicalTemplateStoreManifestBytes, computeTemplateTreeSha256, type TemplateManifestEntry } from '../src/store-security.js'

const run = promisify(execFile)
const require = createRequire(import.meta.url)
const linux = process.platform === 'linux' ? describe : describe.skip
const roots: string[] = []
/**
 * Todo processo filho iniciado por um teste, para nenhum sobreviver a ele.
 *
 * Vários testes aqui deixam o filho PARADO de propósito, esperando um arquivo
 * de portão. Quando o teste falha antes de abrir o portão, esse filho fica
 * vivo para sempre - e cada um é uma inicialização inteira do `tsx`. Com
 * dezenas deles a máquina fica sem memória e a suíte SEGUINTE trava sem motivo
 * aparente: foi exatamente isso que aconteceu aqui, com mais de 250 processos
 * órfãos. Um teste que falha precisa limpar a própria bagunça.
 */
const startedChildren: { kill(): void }[] = []

afterEach(() => {
  for (const child of startedChildren.splice(0)) child.kill()
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => {
    await makeWritable(root)
    await rm(root, { recursive: true, force: true })
  }))
})

linux('immutable builder template-store provisioning', () => {
  it('pins, copies, seals and publishes the store before server-side authority and config', async () => {
    const fixture = await createFixture()
    const result = await provisionBuilderSupervisor(fixture.request)
    expect(result).toEqual(expect.objectContaining({
      state: 'CREATED', scope_id: fixture.scopeId,
      template_store_version: 'v1.0.0', template_store_sha256: fixture.treeSha, manifest_sha256: fixture.manifestSha,
    }))
    expect(result).not.toHaveProperty('tenant_id')
    expect(result).not.toHaveProperty('instance_id')
    const config = await loadBuilderSupervisorConfig(result.config_reference, fixture.policy)
    expect(config).toEqual(expect.objectContaining({ installationId: fixture.request.installationId, tenantId: 'tenant-one', instanceId: 'instance-one', scopeId: fixture.scopeId, templateStoreVersion: 'v1.0.0', templateStoreSha256: fixture.treeSha }))
    const configDirectory = scopePath(fixture, fixture.policy.configRoot)
    const secretDirectory = scopePath(fixture, fixture.policy.secretRoot)
    const rawConfig = JSON.parse(await readFile(posix.join(configDirectory, 'supervisor.json'), 'utf8')) as Record<string, unknown>
    expect(Object.keys(rawConfig).sort()).toEqual([
      'artifact_root', 'bearer_token_ref', 'docker_socket_path', 'export_root', 'image_digest_ref',
      'installation_id', 'instance_id', 'journal_root', 'policy_sha256_ref', 'replay_root', 'socket_path',
      'template_store_manifest_ref', 'template_store_sha256_ref', 'template_store_version', 'tenant_id', 'version',
    ].sort())
    expect(rawConfig).toEqual(expect.objectContaining({
      installation_id: fixture.request.installationId,
      tenant_id: fixture.request.tenantId,
      instance_id: fixture.request.instanceId,
      socket_path: posix.join(scopePath(fixture, fixture.policy.socketRoot), 'rpc.sock'),
      artifact_root: scopePath(fixture, fixture.policy.artifactRoot),
      export_root: scopePath(fixture, fixture.policy.exportRoot),
      journal_root: posix.join(scopePath(fixture, fixture.policy.stateRoot), 'journal'),
      replay_root: posix.join(scopePath(fixture, fixture.policy.stateRoot), 'rpc-replay'),
    }))
    expect(Buffer.byteLength(String(rawConfig.socket_path), 'utf8')).toBeLessThanOrEqual(BUILDER_UNIX_SOCKET_MAX_BYTES)
    const storeRoot = posix.join(scopePath(fixture, fixture.policy.stateRoot), 'template-store', 'v1.0.0')
    const storeTree = posix.join(storeRoot, 'tree')
    expect((await lstat(storeRoot)).mode & 0o777).toBe(0o555)
    expect((await lstat(posix.join(storeRoot, '.complete'))).mode & 0o777).toBe(0o444)
    expect((await lstat(posix.join(storeTree, 'app'))).mode & 0o777).toBe(0o555)
    expect((await lstat(posix.join(storeTree, 'app', 'package.json'))).mode & 0o777).toBe(0o444)
    expect(await readFile(posix.join(storeTree, 'app', 'package.json'), 'utf8')).toBe(fixture.files['app/package.json'])
    expect((await lstat(posix.join(secretDirectory, 'token'))).mode & 0o777).toBe(0o400)
    for (const name of ['supervisor.json', 'builder-image.sha256', 'template-store.sha256', 'template-manifest.sha256', 'template-store.manifest.json', 'policy.sha256']) {
      expect((await lstat(posix.join(configDirectory, name))).mode & 0o777).toBe(0o600)
    }
    const token = (await readFile(posix.join(secretDirectory, 'token'), 'utf8')).trim()
    expect(JSON.stringify(result)).not.toContain(token)
    expect(await readFile(posix.join(configDirectory, 'template-manifest.sha256'), 'utf8')).toBe(`${fixture.manifestSha}\n`)
    expect(await readFile(posix.join(configDirectory, 'template-store.manifest.json'))).toEqual(canonicalTemplateStoreManifestBytes(fixture.manifest))
    expect(result.config_sha256).toBe(computeBuilderSupervisorConfigEnvelopeV2Sha256({
      configBytes: await readFile(posix.join(configDirectory, 'supervisor.json')),
      imageDigestBytes: await readFile(posix.join(configDirectory, 'builder-image.sha256')),
      templateStoreSha256Bytes: await readFile(posix.join(configDirectory, 'template-store.sha256')),
      templateStoreManifestBytes: await readFile(posix.join(configDirectory, 'template-store.manifest.json')),
      policySha256Bytes: await readFile(posix.join(configDirectory, 'policy.sha256')),
    }))
    const instanceRoot = scopePath(fixture, fixture.policy.stateRoot)
    expect(await pathExists(posix.join(instanceRoot, 'journal'))).toBe(true)
    expect(await pathExists(posix.join(instanceRoot, 'rpc-replay'))).toBe(true)
    expect(await pathExists(posix.join(fixture.policy.configRoot, 'tenant-one'))).toBe(false)
    expect(await pathExists(posix.join(fixture.policy.stateRoot, 'tenant-one'))).toBe(false)
    const guard = await lstat(posix.join(instanceRoot, '.provision.guard'))
    expect({ regular: guard.isFile(), links: guard.nlink, mode: guard.mode & 0o777 }).toEqual({ regular: true, links: 1, mode: 0o600 })
    expect(await pathExists(posix.join(instanceRoot, '3'))).toBe(false)
    expect(await pathExists(posix.join(process.cwd(), '3'))).toBe(false)
  })

  it.skipIf(RUNNING_AS_ROOT)('recusa um flock que não é o do sistema', async () => {
    const fixture = await createFixture()
    const fakeFlock = posix.join(fixture.root, 'fake-flock')
    await writeFile(fakeFlock, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await expect(STORE_PROVISION_GUARD_TEST_ONLY.assertTrustedFlockBinary(fakeFlock)).rejects.toMatchObject({ code: 'PROVISION_RECOVERY_FAILED' })
  })

  it('rejects an invalid flock binary, unsupported filesystems and every non-success guard outcome', async () => {
    const fixture = await createFixture()
    await expect(STORE_PROVISION_GUARD_TEST_ONLY.assertTrustedFlockBinary(posix.join(fixture.root, 'missing-flock'))).rejects.toMatchObject({ code: 'PROVISION_RECOVERY_FAILED' })
    await expect(STORE_PROVISION_GUARD_TEST_ONLY.assertTrustedFlockBinary('/usr/bin/flock')).resolves.toBeUndefined()
    await expect(STORE_PROVISION_GUARD_TEST_ONLY.assertProvisionGuardFilesystem('/mnt/c')).rejects.toMatchObject({ code: 'PROVISION_RECOVERY_FAILED' })
    expect(() => STORE_PROVISION_GUARD_TEST_ONLY.classifyProvisionFlockOutcome({ code: 0, signal: null, failed: false })).not.toThrow()
    expect(() => STORE_PROVISION_GUARD_TEST_ONLY.classifyProvisionFlockOutcome({ code: 200, signal: null, failed: false })).toThrow(expect.objectContaining({ code: 'PROVISION_BUSY' }))
    for (const outcome of [
      { code: 1, signal: null, failed: false },
      { code: null, signal: 'SIGKILL' as const, failed: false },
      { code: 0, signal: null, failed: true },
    ]) expect(() => STORE_PROVISION_GUARD_TEST_ONLY.classifyProvisionFlockOutcome(outcome)).toThrow(expect.objectContaining({ code: 'PROVISION_RECOVERY_FAILED' }))
    let killed = 0
    expect(STORE_PROVISION_GUARD_TEST_ONLY.consumeProvisionFlockStderr(0, Buffer.from('small'), () => { killed += 1 })).toBe(5)
    STORE_PROVISION_GUARD_TEST_ONLY.consumeProvisionFlockStderr(0, Buffer.alloc(1024 * 1024), () => { killed += 1 })
    expect(killed).toBe(1)
  })

  it('fails closed when the permanent guard mode, inode type or link count diverges', async () => {
    const modeFixture = await createFixture()
    await provisionBuilderSupervisor(modeFixture.request)
    const modeGuard = posix.join(scopePath(modeFixture, modeFixture.policy.stateRoot), '.provision.guard')
    await chmod(modeGuard, 0o660)
    await expect(provisionBuilderSupervisor(modeFixture.request)).rejects.toMatchObject({ code: 'PROVISION_RECOVERY_FAILED' })

    const linkedFixture = await createFixture()
    await provisionBuilderSupervisor(linkedFixture.request)
    const linkedGuard = posix.join(scopePath(linkedFixture, linkedFixture.policy.stateRoot), '.provision.guard')
    await link(linkedGuard, posix.join(linkedFixture.root, 'guard-alias'))
    await expect(provisionBuilderSupervisor(linkedFixture.request)).rejects.toMatchObject({ code: 'PROVISION_RECOVERY_FAILED' })

    const symlinkFixture = await createFixture()
    const instanceRoot = scopePath(symlinkFixture, symlinkFixture.policy.stateRoot)
    await mkdir(instanceRoot, { recursive: true, mode: 0o700 })
    const target = posix.join(symlinkFixture.root, 'guard-target')
    await writeFile(target, '', { mode: 0o600 })
    await symlink(target, posix.join(instanceRoot, '.provision.guard'))
    await expect(provisionBuilderSupervisor(symlinkFixture.request)).rejects.toMatchObject({ code: 'PROVISION_RECOVERY_FAILED' })

    const missingFixture = await createFixture()
    await provisionBuilderSupervisor(missingFixture.request)
    const missingGuard = posix.join(scopePath(missingFixture, missingFixture.policy.stateRoot), '.provision.guard')
    await unlink(missingGuard)
    await expect(provisionBuilderSupervisor(missingFixture.request)).rejects.toMatchObject({ code: 'PROVISION_RECOVERY_FAILED' })
  })

  it('releases every guard descriptor and keeps the event loop responsive', async () => {
    const descriptorsBefore = (await readdir('/proc/self/fd')).length
    let ticks = 0
    const timer = setInterval(() => { ticks += 1 }, 1)
    try {
      for (let index = 0; index < 8; index += 1) {
        const fixture = await createFixture()
        await provisionBuilderSupervisor(fixture.request, {
          afterProvisionCoordinatorAcquired: async () => { await new Promise(resolve => setTimeout(resolve, 5)) },
        })
      }
    } finally { clearInterval(timer) }
    await new Promise(resolve => setTimeout(resolve, 25))
    const descriptorsAfter = (await readdir('/proc/self/fd')).length
    expect(ticks).toBeGreaterThan(8)
    expect(descriptorsAfter).toBeLessThanOrEqual(descriptorsBefore + 1)
  })

  it('reprovisions idempotently and never overwrites an existing authority set', async () => {
    const fixture = await createFixture()
    await provisionBuilderSupervisor(fixture.request)
    const tokenPath = posix.join(scopePath(fixture, fixture.policy.secretRoot), 'token')
    const configPath = posix.join(scopePath(fixture, fixture.policy.configRoot), 'supervisor.json')
    const before = await readFile(tokenPath, 'utf8')
    const interruptedLink = posix.join(posix.dirname(configPath), '.staging-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    await link(configPath, interruptedLink)
    const repeated = await provisionBuilderSupervisor(fixture.request)
    expect(repeated).toMatchObject({ state: 'CREATED', scope_id: fixture.scopeId })
    expect(await readFile(tokenPath, 'utf8')).toBe(before)
    expect((await lstat(configPath)).nlink).toBe(1)
    expect(await pathExists(interruptedLink)).toBe(false)
  })

  it('persists one canonical manifest independent of source JSON formatting and entry order', async () => {
    const fixture = await createFixture()
    const first = await provisionBuilderSupervisor(fixture.request)
    const configDirectory = scopePath(fixture, fixture.policy.configRoot)
    const manifestPath = posix.join(configDirectory, 'template-store.manifest.json')
    const persisted = await readFile(manifestPath)
    const canonicalManifestSha256 = createHash('sha256').update(persisted).digest('hex')
    const reformatted = `${JSON.stringify({ entries: [...fixture.manifest.entries].reverse(), tree_sha256: fixture.treeSha, template_store_version: 'v1.0.0', version: 1 }, null, 2)}\n`
    await writeFile(fixture.manifestPath, reformatted, { mode: 0o600 })
    const repeated = await provisionBuilderSupervisor({ ...fixture.request, manifestSha256: sha(reformatted) })
    expect(repeated.config_sha256).toBe(first.config_sha256)
    expect(first.manifest_sha256).toBe(canonicalManifestSha256)
    expect(repeated.manifest_sha256).toBe(canonicalManifestSha256)
    expect(repeated.manifest_sha256).not.toBe(sha(reformatted))
    expect(await readFile(posix.join(configDirectory, 'template-manifest.sha256'), 'utf8')).toBe(`${canonicalManifestSha256}\n`)
    expect(await readFile(manifestPath)).toEqual(persisted)
    expect(persisted).toEqual(canonicalTemplateStoreManifestBytes(fixture.manifest))
  })

  it('validates existing authority before materializing a newly requested store version', async () => {
    const fixture = await createFixture()
    await provisionBuilderSupervisor(fixture.request)
    const stateRoot = scopePath(fixture, fixture.policy.stateRoot)
    const storeParent = posix.join(stateRoot, 'template-store')
    const configPath = posix.join(scopePath(fixture, fixture.policy.configRoot), 'supervisor.json')
    const tokenPath = posix.join(scopePath(fixture, fixture.policy.secretRoot), 'token')
    const before = {
      stores: await readdir(storeParent),
      config: await readFile(configPath),
      token: await readFile(tokenPath),
    }
    const version = 'v2.0.0'
    const treeSha = computeTemplateTreeSha256(version, fixture.manifest.entries)
    const changedManifest = {
      version: 1 as const,
      template_store_version: version,
      tree_sha256: treeSha,
      entries: fixture.manifest.entries,
    }
    const changedRaw = `${JSON.stringify(changedManifest)}\n`
    await writeFile(fixture.manifestPath, changedRaw, { mode: 0o600 })

    await expect(provisionBuilderSupervisor({ ...fixture.request, manifestSha256: sha(changedRaw) }))
      .rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
    expect(await pathExists(posix.join(storeParent, version))).toBe(false)
    expect(await readdir(storeParent)).toEqual(before.stores)
    expect(await readFile(configPath)).toEqual(before.config)
    expect(await readFile(tokenPath)).toEqual(before.token)
  })

  it('rejects a missing published store parent without recreating or changing any durable path', async () => {
    const fixture = await createFixture()
    await provisionBuilderSupervisor(fixture.request)
    const managedRoot = posix.join(fixture.root, 'managed')
    const storeParent = posix.join(scopePath(fixture, fixture.policy.stateRoot), 'template-store')
    await makeWritable(storeParent)
    await rm(storeParent, { recursive: true })
    const before = await snapshotTree(managedRoot)

    await expect(provisionBuilderSupervisor(fixture.request)).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
    expect(await pathExists(storeParent)).toBe(false)
    expect(await snapshotTree(managedRoot)).toEqual(before)
  })

  it('rejects a missing version inside an existing store parent without changing durable state', async () => {
    const fixture = await createFixture()
    await provisionBuilderSupervisor(fixture.request)
    const managedRoot = posix.join(fixture.root, 'managed')
    const storeParent = posix.join(scopePath(fixture, fixture.policy.stateRoot), 'template-store')
    const store = posix.join(storeParent, fixture.manifest.template_store_version)
    await makeWritable(store)
    await rm(store, { recursive: true })
    const before = await snapshotTree(managedRoot)
    await expect(provisionBuilderSupervisor(fixture.request)).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
    expect(await snapshotTree(managedRoot)).toEqual(before)
  })

  it('fails closed on malformed existing config and canonical-manifest hash authority', async () => {
    const malformed = await createFixture()
    await provisionBuilderSupervisor(malformed.request)
    const malformedConfig = posix.join(scopePath(malformed, malformed.policy.configRoot), 'supervisor.json')
    await writeFile(malformedConfig, '{broken\n', { mode: 0o600 })
    await expect(provisionBuilderSupervisor(malformed.request)).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })

    const hash = await createFixture()
    await provisionBuilderSupervisor(hash.request)
    const manifestHash = posix.join(scopePath(hash, hash.policy.configRoot), 'template-manifest.sha256')
    await writeFile(manifestHash, `${'f'.repeat(64)}\n`, { mode: 0o600 })
    await expect(provisionBuilderSupervisor(hash.request)).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
  })

  it('rejects a mutated published store instead of overwriting or repairing it', async () => {
    const fixture = await createFixture()
    await provisionBuilderSupervisor(fixture.request)
    const file = posix.join(scopePath(fixture, fixture.policy.stateRoot), 'template-store', 'v1.0.0', 'tree', 'README.md')
    await chmod(file, 0o644)
    await expect(provisionBuilderSupervisor(fixture.request)).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
  })

  it('rejects content drift in a sealed store even when permissions are restored', async () => {
    const fixture = await createFixture()
    await provisionBuilderSupervisor(fixture.request)
    const file = posix.join(scopePath(fixture, fixture.policy.stateRoot), 'template-store', 'v1.0.0', 'tree', 'README.md')
    await chmod(file, 0o600); await writeFile(file, 'mutated template\n'); await chmod(file, 0o444)
    await expect(provisionBuilderSupervisor(fixture.request)).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
  })

  it.each(['symlink', 'hardlink', 'fifo'] as const)('rejects unsafe %s entries without publishing config', async kind => {
    const fixture = await createFixture()
    const unsafe = posix.join(fixture.sourceRoot, 'unsafe')
    if (kind === 'symlink') await symlink(posix.join(fixture.sourceRoot, 'README.md'), unsafe)
    else if (kind === 'hardlink') await link(posix.join(fixture.sourceRoot, 'README.md'), unsafe)
    else await run('mkfifo', [unsafe])
    await expect(provisionBuilderSupervisor(fixture.request)).rejects.toMatchObject({ code: 'SOURCE_UNSAFE' })
    expect(await pathExists(posix.join(scopePath(fixture, fixture.policy.configRoot), 'supervisor.json'))).toBe(false)
  })

  it('rejects a manifest path that cannot be encoded as strict USTAR before creating scope state', async () => {
    const fixture = await createFixture()
    const first = 'a'.repeat(90); const second = 'b'.repeat(70); const file = 'c'.repeat(101)
    await mkdir(posix.join(fixture.sourceRoot, first, second), { recursive: true, mode: 0o700 })
    await writeFile(posix.join(fixture.sourceRoot, first, second, file), 'x', { mode: 0o600 })
    const entries: TemplateManifestEntry[] = [...fixture.manifest.entries,
      { path: first, type: 'directory' },
      { path: `${first}/${second}`, type: 'directory' },
      { path: `${first}/${second}/${file}`, type: 'file', bytes: 1, sha256: sha('x') },
    ]
    const tree = computeTemplateTreeSha256('v1.0.0', entries)
    const raw = `${JSON.stringify({ version: 1, template_store_version: 'v1.0.0', tree_sha256: tree, entries })}\n`
    await writeFile(fixture.manifestPath, raw, { mode: 0o600 })
    await expect(provisionBuilderSupervisor({ ...fixture.request, manifestSha256: sha(raw) })).rejects.toMatchObject({ code: 'INVALID_PROVISION_REQUEST' })
    expect(await pathExists(scopePath(fixture, fixture.policy.stateRoot))).toBe(false)
  })

  it('rejects manifest substitution, dishonest tree declarations and source paths inside managed roots', async () => {
    const fixture = await createFixture()
    await writeFile(fixture.manifestPath, '{}\n', { mode: 0o600 })
    await expect(provisionBuilderSupervisor(fixture.request)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' })
    const dishonestSha = createHash('sha256').update('{}\n').digest('hex')
    await expect(provisionBuilderSupervisor({ ...fixture.request, manifestSha256: dishonestSha })).rejects.toMatchObject({ code: 'SOURCE_UNSAFE' })
    await expect(provisionBuilderSupervisor({ ...fixture.request, sourceRoot: fixture.policy.stateRoot })).rejects.toMatchObject({ code: 'INVALID_PROVISION_REQUEST' })
    const oversized = await createFixture()
    const oversizedManifest = Buffer.alloc(TEMPLATE_MANIFEST_MAX_BYTES + 1, 0x20)
    await writeFile(oversized.manifestPath, oversizedManifest, { mode: 0o600 })
    await expect(provisionBuilderSupervisor({ ...oversized.request, manifestSha256: createHash('sha256').update(oversizedManifest).digest('hex') })).rejects.toMatchObject({ code: 'SOURCE_UNSAFE' })
    const writableSource = await createFixture()
    await chmod(writableSource.sourceRoot, 0o777)
    await expect(provisionBuilderSupervisor(writableSource.request)).rejects.toMatchObject({ code: 'SOURCE_UNSAFE' })
  })

  it('rejects case-fold and Unicode source ambiguity plus ordinary unmanifested files', async () => {
    const caseFixture = await createFixture()
    await mkdir(posix.join(caseFixture.sourceRoot, 'APP'), { mode: 0o700 })
    await expect(provisionBuilderSupervisor(caseFixture.request)).rejects.toMatchObject({ code: 'SOURCE_UNSAFE' })
    const unicodeFixture = await createFixture()
    await writeFile(posix.join(unicodeFixture.sourceRoot, 'café.txt'), 'x', { mode: 0o600 })
    await expect(provisionBuilderSupervisor(unicodeFixture.request)).rejects.toMatchObject({ code: 'SOURCE_UNSAFE' })
    const extraFixture = await createFixture()
    await writeFile(posix.join(extraFixture.sourceRoot, 'extra.txt'), 'x', { mode: 0o600 })
    await expect(provisionBuilderSupervisor(extraFixture.request)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' })
  })

  it('maps invalid typed input to the closed public error without creating tenant paths', async () => {
    const fixture = await createFixture()
    await expect(provisionBuilderSupervisor({ ...fixture.request, tenantId: 'Tenant-One' })).rejects.toMatchObject({ code: 'INVALID_PROVISION_REQUEST' })
    await expect(provisionBuilderSupervisor({ ...fixture.request, installationId: 'not-an-installation-id' })).rejects.toMatchObject({ code: 'INVALID_PROVISION_REQUEST' })
    expect(await pathExists(posix.join(fixture.policy.configRoot, 'Tenant-One'))).toBe(false)
    expect(await pathExists(posix.join(fixture.policy.configRoot, 'instances'))).toBe(false)
  })

  it('rejects an overlong canonical socket before publishing config or secret authority', async () => {
    const fixture = await createFixture()
    const sourceBefore = await Promise.all(Object.keys(fixture.files).sort().map(path => readFile(posix.join(fixture.sourceRoot, path), 'utf8')))
    const socketRoot = posix.join(fixture.root, 's'.repeat(96))
    await mkdir(socketRoot, { mode: 0o700 })
    const rootsWithLongSocket = { ...fixture.policy, socketRoot }
    await expect(provisionBuilderSupervisor({ ...fixture.request, roots: rootsWithLongSocket })).rejects.toMatchObject({ code: 'INVALID_PROVISION_REQUEST' })
    for (const root of [rootsWithLongSocket.configRoot, rootsWithLongSocket.secretRoot, rootsWithLongSocket.socketRoot, rootsWithLongSocket.artifactRoot, rootsWithLongSocket.exportRoot, rootsWithLongSocket.stateRoot]) {
      expect(await pathExists(posix.join(root, 'instances'))).toBe(false)
    }
    expect(await Promise.all(Object.keys(fixture.files).sort().map(path => readFile(posix.join(fixture.sourceRoot, path), 'utf8')))).toEqual(sourceBefore)
  })

  it('derives a different opaque scope for every logical or installation identity and rejects config identity or layout mutation', async () => {
    const identities = [
      { installationId: 'e'.repeat(64) },
      { tenantId: 'tenant-two' },
      { instanceId: 'instance-two' },
    ] as const
    for (const change of identities) {
      const fixture = await createFixture()
      const request = { ...fixture.request, ...change }
      const result = await provisionBuilderSupervisor(request)
      expect(result.scope_id).toBe(deriveBuilderRuntimeScopeId({
        installationId: request.installationId,
        tenantId: request.tenantId,
        instanceId: request.instanceId,
      }))
      expect(result.scope_id).not.toBe(fixture.scopeId)
      expect(await pathExists(posix.join(fixture.policy.configRoot, request.tenantId))).toBe(false)
    }

    const installationMutation = await createFixture()
    const installationResult = await provisionBuilderSupervisor(installationMutation.request)
    const installationConfigPath = installationResult.config_reference.slice('file:'.length)
    const installationConfig = JSON.parse(await readFile(installationConfigPath, 'utf8')) as Record<string, unknown>
    installationConfig.installation_id = 'f'.repeat(64)
    await writeFile(installationConfigPath, `${JSON.stringify(installationConfig)}\n`)
    await expect(loadBuilderSupervisorConfig(installationResult.config_reference, installationMutation.policy)).rejects.toMatchObject({ code: 'INVALID_SUPERVISOR_CONFIGURATION' })

    const layoutMutation = await createFixture()
    const layoutResult = await provisionBuilderSupervisor(layoutMutation.request)
    const layoutConfigPath = layoutResult.config_reference.slice('file:'.length)
    const layoutConfig = JSON.parse(await readFile(layoutConfigPath, 'utf8')) as Record<string, unknown>
    layoutConfig.socket_path = posix.join(layoutMutation.policy.socketRoot, 'tenant-one', 'instance-one', 'builder.sock')
    await writeFile(layoutConfigPath, `${JSON.stringify(layoutConfig)}\n`)
    await expect(loadBuilderSupervisorConfig(layoutResult.config_reference, layoutMutation.policy)).rejects.toMatchObject({ code: 'INVALID_SUPERVISOR_CONFIGURATION' })
  })

  it('serializes concurrent provisioners with a live process-identity lock', async () => {
    const fixture = await createFixture()
    const instanceRoot = scopePath(fixture, fixture.policy.stateRoot)
    await mkdir(instanceRoot, { recursive: true, mode: 0o700 })
    await installProvisionGuard(instanceRoot)
    const claim = '.claim-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const claimPath = posix.join(instanceRoot, claim)
    const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
    const statLine = await readFile(`/proc/${process.pid}/stat`, 'utf8')
    const fields = statLine.slice(statLine.lastIndexOf(') ') + 2).trim().split(/\s+/u)
    await writeFile(claimPath, `${JSON.stringify({ pid: process.pid, boot_id: bootId, start_ticks: fields[19], claim })}\n`, { mode: 0o400 })
    await link(claimPath, posix.join(instanceRoot, '.provision.lock'))
    await expect(provisionBuilderSupervisor(fixture.request)).rejects.toMatchObject({ code: 'PROVISION_BUSY' })
    expect((await readdir(instanceRoot)).filter(name => name.startsWith('.claim-'))).toEqual([claim])
  })

  it('preserves a live L1 substituted between stale L0 proof and reclaim', async () => {
    const fixture = await createFixture()
    const instanceRoot = scopePath(fixture, fixture.policy.stateRoot)
    await mkdir(instanceRoot, { recursive: true, mode: 0o700 })
    await installProvisionGuard(instanceRoot)
    const lockPath = posix.join(instanceRoot, '.provision.lock')
    const staleClaim = '.claim-11111111111111111111111111111111'
    const staleClaimPath = posix.join(instanceRoot, staleClaim)
    const liveClaim = '.claim-22222222222222222222222222222222'
    const liveClaimPath = posix.join(instanceRoot, liveClaim)
    const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
    await writeFile(staleClaimPath, `${JSON.stringify({ pid: 2_147_483_647, boot_id: bootId, start_ticks: '1', claim: staleClaim })}\n`, { mode: 0o400 })
    await link(staleClaimPath, lockPath)
    const statLine = await readFile(`/proc/${process.pid}/stat`, 'utf8')
    const fields = statLine.slice(statLine.lastIndexOf(') ') + 2).trim().split(/\s+/u)
    let replaced = false
    await expect(provisionBuilderSupervisor(fixture.request, { afterStaleLockProof: async provenPath => {
      expect(provenPath).toBe(lockPath)
      expect(replaced).toBe(false)
      replaced = true
      await unlink(lockPath); await unlink(staleClaimPath)
      await writeFile(liveClaimPath, `${JSON.stringify({ pid: process.pid, boot_id: bootId, start_ticks: fields[19], claim: liveClaim })}\n`, { mode: 0o400 })
      await link(liveClaimPath, lockPath)
    } })).rejects.toMatchObject({ code: 'PROVISION_BUSY' })
    const [lock, claim] = await Promise.all([lstat(lockPath), lstat(liveClaimPath)])
    expect({ same: lock.dev === claim.dev && lock.ino === claim.ino, links: lock.nlink }).toEqual({ same: true, links: 2 })
    expect(await readFile(lockPath, 'utf8')).toContain(`"claim":"${liveClaim}"`)
  })

  it('arbitrates a takeover immediately before unlink and never touches L1 installed afterward', async () => {
    const fixture = await createFixture()
    const instanceRoot = scopePath(fixture, fixture.policy.stateRoot)
    await mkdir(instanceRoot, { recursive: true, mode: 0o700 })
    await installProvisionGuard(instanceRoot)
    const lockPath = posix.join(instanceRoot, '.provision.lock')
    const staleClaim = '.claim-33333333333333333333333333333333'
    const staleClaimPath = posix.join(instanceRoot, staleClaim)
    const competingTakeover = posix.join(instanceRoot, '.takeover-44444444444444444444444444444444')
    const liveClaim = '.claim-55555555555555555555555555555555'
    const liveClaimPath = posix.join(instanceRoot, liveClaim)
    const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
    const statLine = await readFile(`/proc/${process.pid}/stat`, 'utf8')
    const fields = statLine.slice(statLine.lastIndexOf(') ') + 2).trim().split(/\s+/u)
    await writeFile(staleClaimPath, `${JSON.stringify({ pid: 2_147_483_647, boot_id: bootId, start_ticks: '1', claim: staleClaim })}\n`, { mode: 0o400 })
    await link(staleClaimPath, lockPath)
    let before = 0; let after = 0
    await expect(provisionBuilderSupervisor(fixture.request, {
      beforeStaleLockPathUnlink: async provenPath => {
        before += 1; expect(provenPath).toBe(lockPath)
        await link(lockPath, competingTakeover)
        expect((await lstat(lockPath)).nlink).toBe(4)
        await unlink(competingTakeover)
      },
      afterStaleLockPathUnlink: async removedPath => {
        after += 1; expect(removedPath).toBe(lockPath); expect(await pathExists(lockPath)).toBe(false)
        await writeFile(liveClaimPath, `${JSON.stringify({ pid: process.pid, boot_id: bootId, start_ticks: fields[19], claim: liveClaim })}\n`, { mode: 0o400 })
        await link(liveClaimPath, lockPath)
      },
    })).rejects.toMatchObject({ code: 'PROVISION_BUSY' })
    expect({ before, after }).toEqual({ before: 1, after: 1 })
    const [lock, claim] = await Promise.all([lstat(lockPath), lstat(liveClaimPath)])
    expect({ same: lock.dev === claim.dev && lock.ino === claim.ino, links: lock.nlink }).toEqual({ same: true, links: 2 })
    expect(await pathExists(staleClaimPath)).toBe(true)
    expect((await readdir(instanceRoot)).filter(name => name.startsWith('.takeover-'))).toHaveLength(1)
  })

  it('treats a vanished stale lock and claim as lost arbitration, then retries without deleting another owner', async () => {
    const fixture = await createFixture()
    const { instanceRoot, claimPath, lockPath } = await createStaleLock(fixture, '.claim-66666666666666666666666666666666')
    let proofs = 0
    await expect(provisionBuilderSupervisor(fixture.request, {
      afterStaleLockProof: async provenPath => {
        proofs += 1
        expect(provenPath).toBe(lockPath)
        await unlink(lockPath)
        await unlink(claimPath)
      },
    })).resolves.toMatchObject({ state: 'CREATED' })
    expect(proofs).toBe(1)
    expect((await readdir(instanceRoot)).filter(name => name.startsWith('.claim-') || name.startsWith('.takeover-'))).toEqual([])
  })

  it('cleans its takeover link and preserves the proven stale lock when the pre-unlink hook fails', async () => {
    const fixture = await createFixture()
    const { instanceRoot, claimPath, lockPath } = await createStaleLock(fixture, '.claim-77777777777777777777777777777777')
    await expect(provisionBuilderSupervisor(fixture.request, {
      beforeStaleLockPathUnlink: async () => { throw new Error('injected pre-unlink crash') },
    })).rejects.toMatchObject({ code: 'PROVISION_RECOVERY_FAILED' })
    const [lock, claim] = await Promise.all([lstat(lockPath), lstat(claimPath)])
    expect({ same: lock.dev === claim.dev && lock.ino === claim.ino, links: lock.nlink }).toEqual({ same: true, links: 2 })
    expect((await readdir(instanceRoot)).some(name => name.startsWith('.takeover-'))).toBe(false)
    await expect(provisionBuilderSupervisor(fixture.request)).resolves.toMatchObject({ state: 'CREATED' })
    expect(await pathExists(claimPath)).toBe(false)
  })

  it('refuses a fourth hard-link competitor and removes only its own takeover link', async () => {
    const fixture = await createFixture()
    const { instanceRoot, claimPath, lockPath } = await createStaleLock(fixture, '.claim-88888888888888888888888888888888')
    const competitor = posix.join(instanceRoot, '.competitor-lock-link')
    await expect(provisionBuilderSupervisor(fixture.request, {
      beforeStaleLockPathUnlink: async () => { await link(lockPath, competitor) },
    })).rejects.toMatchObject({ code: 'PROVISION_RECOVERY_FAILED' })
    const [lock, claim, competing] = await Promise.all([lstat(lockPath), lstat(claimPath), lstat(competitor)])
    expect({
      sameClaim: lock.dev === claim.dev && lock.ino === claim.ino,
      sameCompetitor: lock.dev === competing.dev && lock.ino === competing.ino,
      links: lock.nlink,
    }).toEqual({ sameClaim: true, sameCompetitor: true, links: 4 })
    expect((await readdir(instanceRoot)).filter(name => name.startsWith('.takeover-'))).toHaveLength(1)
  })

  it('fails closed without unlinking a foreign inode substituted at its takeover path', async () => {
    const fixture = await createFixture()
    const { instanceRoot, claimPath, lockPath } = await createStaleLock(fixture, '.claim-99999999999999999999999999999999')
    let foreignTakeover: string | undefined
    await expect(provisionBuilderSupervisor(fixture.request, {
      beforeStaleLockPathUnlink: async () => {
        const names = await readdir(instanceRoot)
        foreignTakeover = names.find(name => name.startsWith('.takeover-'))
        expect(foreignTakeover).toBeDefined()
        const takeoverPath = posix.join(instanceRoot, foreignTakeover!)
        await unlink(takeoverPath)
        await writeFile(takeoverPath, 'foreign evidence\n', { mode: 0o400 })
      },
    })).rejects.toMatchObject({ code: 'PROVISION_RECOVERY_FAILED' })
    expect(await readFile(posix.join(instanceRoot, foreignTakeover!), 'utf8')).toBe('foreign evidence\n')
    const [lock, claim] = await Promise.all([lstat(lockPath), lstat(claimPath)])
    expect({ same: lock.dev === claim.dev && lock.ino === claim.ino, links: lock.nlink }).toEqual({ same: true, links: 2 })
  })

  it('preserves stale-lock evidence whose mode diverges after proof', async () => {
    const fixture = await createFixture()
    const { claimPath, lockPath } = await createStaleLock(fixture, '.claim-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab')
    await expect(provisionBuilderSupervisor(fixture.request, {
      afterStaleLockProof: async () => { await chmod(lockPath, 0o600) },
    })).rejects.toMatchObject({ code: 'PROVISION_RECOVERY_FAILED' })
    const [lock, claim] = await Promise.all([lstat(lockPath), lstat(claimPath)])
    expect({ same: lock.dev === claim.dev && lock.ino === claim.ino, links: lock.nlink, mode: lock.mode & 0o777 }).toEqual({ same: true, links: 2, mode: 0o600 })
  })

  it('recognizes a lock from another boot as stale without probing its pid', async () => {
    const fixture = await createFixture()
    const claim = '.claim-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const { claimPath } = await createStaleLock(fixture, claim)
    await chmod(claimPath, 0o600)
    await writeFile(claimPath, `${JSON.stringify({ pid: process.pid, boot_id: '00000000-0000-0000-0000-000000000000', start_ticks: '1', claim })}\n`)
    await chmod(claimPath, 0o400)
    await expect(provisionBuilderSupervisor(fixture.request)).resolves.toMatchObject({ state: 'CREATED' })
    expect(await pathExists(claimPath)).toBe(false)
  })

  it('does not mistake a retired witness from another boot for a live local pid', async () => {
    const fixture = await createFixture()
    const claim = '.claim-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01'
    const { claimPath } = await createStaleLock(fixture, claim)
    const statLine = await readFile(`/proc/${process.pid}/stat`, 'utf8')
    const fields = statLine.slice(statLine.lastIndexOf(') ') + 2).trim().split(/\s+/u)
    await chmod(claimPath, 0o600)
    await writeFile(claimPath, `${JSON.stringify({ pid: process.pid, boot_id: '00000000-0000-0000-0000-000000000000', start_ticks: fields[19], claim })}\n`)
    await chmod(claimPath, 0o400)
    await expect(provisionBuilderSupervisor(fixture.request)).resolves.toMatchObject({ state: 'CREATED' })
    expect(await pathExists(claimPath)).toBe(false)
  })

  it('cleans a graceful partial-store failure and retries without stale-owner authority', async () => {
    const fixture = await createFixture()
    let injected = false
    await expect(provisionBuilderSupervisor(fixture.request, {
      afterTemplateStoreEntryCopied: async () => {
        if (!injected) { injected = true; throw new Error('graceful injected copy failure') }
      },
    })).rejects.toMatchObject({ code: 'INVALID_PROVISION_REQUEST' })
    const instanceRoot = scopePath(fixture, fixture.policy.stateRoot)
    expect(await lockArtifacts(instanceRoot)).toEqual([])
    expect(await readdir(posix.join(instanceRoot, 'template-store'))).toEqual([])
    await expect(provisionBuilderSupervisor(fixture.request)).resolves.toMatchObject({ state: 'CREATED' })
  })

  it('recovers automatically after a real SIGKILL with the takeover linked but L0 still present', async () => {
    const fixture = await createFixture()
    const { instanceRoot, claimPath, lockPath } = await createStaleLock(fixture, '.claim-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba')
    const child = await startProvisionChild(fixture, 'crash-before-unlink')
    expect(wasKilled(await child.completed)).toBe(true)
    const [lock, claim] = await Promise.all([lstat(lockPath), lstat(claimPath)])
    expect({ same: lock.dev === claim.dev && lock.ino === claim.ino, links: lock.nlink }).toEqual({ same: true, links: 3 })
    expect((await readdir(instanceRoot)).filter(name => name.startsWith('.takeover-'))).toHaveLength(1)
    await expect(provisionBuilderSupervisor(fixture.request)).resolves.toMatchObject({ state: 'CREATED' })
    expect(await lockArtifacts(instanceRoot)).toEqual([])
  })

  it('recovers a partial target after a real SIGKILL between L0 unlink and witness cleanup', async () => {
    const fixture = await createFixture()
    const { instanceRoot, claimPath, lockPath } = await createStaleLock(fixture, '.claim-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbab')
    const interruptedTarget = posix.join(instanceRoot, 'template-store', 'v1.0.0')
    await mkdir(posix.join(interruptedTarget, 'tree'), { recursive: true, mode: 0o700 })
    await writeFile(posix.join(interruptedTarget, 'tree', 'partial'), 'interrupted\n', { mode: 0o600 })
    const child = await startProvisionChild(fixture, 'crash-after-unlink')
    expect(wasKilled(await child.completed)).toBe(true)
    expect(await pathExists(lockPath)).toBe(false)
    const claim = await lstat(claimPath)
    expect(claim.nlink).toBe(2)
    await expect(provisionBuilderSupervisor(fixture.request)).resolves.toMatchObject({ state: 'CREATED' })
    expect(await lockArtifacts(instanceRoot)).toEqual([])
    expect(await readFile(posix.join(interruptedTarget, 'tree', 'README.md'), 'utf8')).toBe(fixture.files['README.md'])
  })

  it('recovers automatically after a real SIGKILL during long template-store I/O', async () => {
    const fixture = await createFixture()
    const instanceRoot = scopePath(fixture, fixture.policy.stateRoot)
    const child = await startProvisionChild(fixture, 'crash-during-store')
    expect(wasKilled(await child.completed)).toBe(true)
    expect(await pathExists(posix.join(instanceRoot, '.provision.guard'))).toBe(true)
    expect(await pathExists(posix.join(instanceRoot, '.provision.lock'))).toBe(true)
    expect((await readdir(posix.join(instanceRoot, 'template-store'))).some(name => name.startsWith('.staging-'))).toBe(true)
    await expect(provisionBuilderSupervisor(fixture.request)).resolves.toMatchObject({ state: 'CREATED' })
    expect(await lockArtifacts(instanceRoot)).toEqual([])
    expect((await readdir(posix.join(instanceRoot, 'template-store'))).some(name => name.startsWith('.staging-'))).toBe(false)
  })

  it('elects exactly one of two simultaneous restart processes after a pre-unlink crash', async () => {
    const fixture = await createFixture()
    const { instanceRoot } = await createStaleLock(fixture, '.claim-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbac')
    const crashed = await startProvisionChild(fixture, 'crash-before-unlink')
    expect(wasKilled(await crashed.completed)).toBe(true)
    const ready = posix.join(fixture.root, 'restart-a.ready')
    const gate = posix.join(fixture.root, 'restart-a.go')
    const firstResult = posix.join(fixture.root, 'restart-a.json')
    const secondResult = posix.join(fixture.root, 'restart-b.json')
    const first = await startProvisionChild(fixture, 'pause-acquire', ready, gate, firstResult)
    await waitForPath(ready)
    const second = await startProvisionChild(fixture, 'run', undefined, undefined, secondResult)
    await expect(second.completed).resolves.toMatchObject({ code: 0, signal: null })
    expect(JSON.parse(await readFile(secondResult, 'utf8'))).toEqual({ error: 'PROVISION_BUSY' })
    await writeFile(gate, 'go\n', { mode: 0o600 })
    await expect(first.completed).resolves.toMatchObject({ code: 0, signal: null })
    expect(JSON.parse(await readFile(firstResult, 'utf8'))).toEqual(expect.objectContaining({ state: 'CREATED' }))
    expect(await lockArtifacts(instanceRoot)).toEqual([])
  }, 15_000)

  it('holds the same kernel guard against fifty simultaneous provision processes', async () => {
    const fixture = await createFixture()
    const instanceRoot = scopePath(fixture, fixture.policy.stateRoot)
    const ready = posix.join(fixture.root, 'stress-owner.ready')
    const gate = posix.join(fixture.root, 'stress-owner.go')
    const ownerResult = posix.join(fixture.root, 'stress-owner.json')
    const owner = await startProvisionChild(fixture, 'pause-acquire', ready, gate, ownerResult)
    await waitForPath(ready)
    const resultPaths = Array.from({ length: 50 }, (_, index) => posix.join(fixture.root, `stress-${index}.json`))
    const contenders = await Promise.all(resultPaths.map(path => startProvisionChild(fixture, 'run', undefined, undefined, path)))
    await Promise.all(contenders.map(child => expect(child.completed).resolves.toMatchObject({ code: 0, signal: null })))
    const results = await Promise.all(resultPaths.map(path => readFile(path, 'utf8').then(value => JSON.parse(value) as unknown)))
    expect(results).toEqual(Array.from({ length: 50 }, () => ({ error: 'PROVISION_BUSY' })))
    expect(await pathExists(posix.join(instanceRoot, '3'))).toBe(false)
    await writeFile(gate, 'go\n', { mode: 0o600 })
    await expect(owner.completed).resolves.toMatchObject({ code: 0, signal: null })
    expect(JSON.parse(await readFile(ownerResult, 'utf8'))).toEqual(expect.objectContaining({ state: 'CREATED' }))
    expect(await lockArtifacts(instanceRoot)).toEqual([])
  }, 60_000)

  it('bootstraps one permanent guard after fifty processes observe the same empty root', async () => {
    const fixture = await createFixture()
    const instanceRoot = scopePath(fixture, fixture.policy.stateRoot)
    const gate = posix.join(fixture.root, 'bootstrap-race.go')
    const readyPaths = Array.from({ length: 50 }, (_, index) => posix.join(fixture.root, `bootstrap-race-${index}.ready`))
    const resultPaths = Array.from({ length: 50 }, (_, index) => posix.join(fixture.root, `bootstrap-race-${index}.json`))
    const children = await Promise.all(resultPaths.map((resultPath, index) =>
      startProvisionChild(fixture, 'pause-guard-missing', readyPaths[index], gate, resultPath)))
    let results: Record<string, unknown>[]
    try {
      // Cinquenta processos `tsx` levam o tempo que a máquina permitir. A
      // garantia aqui é sobre CONCORRÊNCIA, não sobre velocidade: apertar o
      // prazo só transforma máquina lenta em falha que não diz nada.
      await Promise.all(readyPaths.map(path => waitForPath(path, 120_000)))
      expect(await readdir(instanceRoot)).toEqual([])
      await writeFile(gate, 'go\n', { mode: 0o600 })
      await Promise.all(children.map(child => expect(child.completed).resolves.toMatchObject({ code: 0, signal: null })))
      results = await Promise.all(resultPaths.map(path => readFile(path, 'utf8').then(value => JSON.parse(value) as Record<string, unknown>)))
    } finally {
      for (const child of children) child.kill()
    }
    expect(results.filter(result => result.state === 'CREATED')).toHaveLength(1)
    const errors = results.filter(result => result.error !== undefined).map(result => result.error)
    expect(errors).toHaveLength(49)
    expect(errors.every(error => error === 'PROVISION_BUSY' || error === 'ALREADY_PROVISIONED')).toBe(true)
    expect(errors).not.toContain('PROVISION_RECOVERY_FAILED')
    const guard = await lstat(posix.join(instanceRoot, '.provision.guard'))
    expect({ file: guard.isFile(), links: guard.nlink, mode: guard.mode & 0o777 }).toEqual({ file: true, links: 1, mode: 0o600 })
    expect(await lockArtifacts(instanceRoot)).toEqual([])
    expect(await pathExists(posix.join(instanceRoot, '3'))).toBe(false)
  }, 300_000)

  it('serializes release against a competing reclaim process under the same crash-releasing mutex', async () => {
    const fixture = await createFixture()
    const instanceRoot = scopePath(fixture, fixture.policy.stateRoot)
    const ready = posix.join(fixture.root, 'release.ready')
    const gate = posix.join(fixture.root, 'release.go')
    const ownerResult = posix.join(fixture.root, 'release-owner.json')
    const contenderResult = posix.join(fixture.root, 'release-contender.json')
    const owner = await startProvisionChild(fixture, 'pause-release', ready, gate, ownerResult)
    await waitForPath(ready)
    const contender = await startProvisionChild(fixture, 'run', undefined, undefined, contenderResult)
    await expect(contender.completed).resolves.toMatchObject({ code: 0, signal: null })
    expect(JSON.parse(await readFile(contenderResult, 'utf8'))).toEqual({ error: 'PROVISION_BUSY' })
    expect((await lstat(posix.join(instanceRoot, '.provision.lock'))).nlink).toBe(2)
    await writeFile(gate, 'go\n', { mode: 0o600 })
    await expect(owner.completed).resolves.toMatchObject({ code: 0, signal: null })
    expect(JSON.parse(await readFile(ownerResult, 'utf8'))).toEqual(expect.objectContaining({ state: 'CREATED' }))
    expect(await lockArtifacts(instanceRoot)).toEqual([])
  }, 15_000)

  it('preserves divergent lock and claim inodes substituted after stale-owner proof', async () => {
    const fixture = await createFixture()
    const claim = '.claim-cccccccccccccccccccccccccccccccc'
    const { claimPath, lockPath } = await createStaleLock(fixture, claim)
    await expect(provisionBuilderSupervisor(fixture.request, {
      afterStaleLockProof: async () => {
        await unlink(claimPath)
        await writeFile(claimPath, `${JSON.stringify({ pid: 2_147_483_647, boot_id: '00000000-0000-0000-0000-000000000000', start_ticks: '1', claim })}\n`, { mode: 0o400 })
      },
    })).rejects.toMatchObject({ code: 'PROVISION_RECOVERY_FAILED' })
    const [lock, replacementClaim] = await Promise.all([lstat(lockPath), lstat(claimPath)])
    expect({ same: lock.dev === replacementClaim.dev && lock.ino === replacementClaim.ino, lockLinks: lock.nlink, claimLinks: replacementClaim.nlink })
      .toEqual({ same: false, lockLinks: 1, claimLinks: 1 })
  })

  it('recovers a vanished claim after lock unlink and cleans the singleton takeover after success', async () => {
    const fixture = await createFixture()
    const { instanceRoot, claimPath, lockPath } = await createStaleLock(fixture, '.claim-dddddddddddddddddddddddddddddddd')
    await expect(provisionBuilderSupervisor(fixture.request, {
      afterStaleLockPathUnlink: async () => { await unlink(claimPath) },
    })).resolves.toMatchObject({ state: 'CREATED' })
    expect(await pathExists(lockPath)).toBe(false)
    expect(await pathExists(claimPath)).toBe(false)
    expect((await readdir(instanceRoot)).some(name => name.startsWith('.takeover-'))).toBe(false)
  })

  it('detects a foreign takeover after lock unlink and removes only the still-proven claim link', async () => {
    const fixture = await createFixture()
    const { instanceRoot, claimPath, lockPath } = await createStaleLock(fixture, '.claim-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeef')
    const survivor = posix.join(instanceRoot, '.stale-lock-survivor')
    let takeoverPath: string | undefined
    await expect(provisionBuilderSupervisor(fixture.request, {
      afterStaleLockPathUnlink: async () => {
        const takeover = (await readdir(instanceRoot)).find(name => name.startsWith('.takeover-'))
        expect(takeover).toBeDefined()
        takeoverPath = posix.join(instanceRoot, takeover!)
        await unlink(takeoverPath)
        await link(claimPath, survivor)
        await writeFile(takeoverPath, 'foreign post-unlink evidence\n', { mode: 0o400 })
      },
    })).rejects.toMatchObject({ code: 'PROVISION_RECOVERY_FAILED' })
    expect(await pathExists(lockPath)).toBe(false)
    expect(await pathExists(claimPath)).toBe(true)
    expect(await readFile(takeoverPath!, 'utf8')).toBe('foreign post-unlink evidence\n')
    expect((await lstat(survivor)).nlink).toBe(2)
  })

  it('never replaces a version directory created by a competing same-uid process', async () => {
    const fixture = await createFixture()
    const instanceRoot = scopePath(fixture, fixture.policy.stateRoot)
    await installProvisionGuard(instanceRoot)
    const target = posix.join(scopePath(fixture, fixture.policy.stateRoot), 'template-store', 'v1.0.0')
    await mkdir(target, { recursive: true, mode: 0o700 })
    const foreign = posix.join(target, 'foreign-owner')
    await writeFile(foreign, 'must survive\n', { mode: 0o600 })
    await expect(provisionBuilderSupervisor(fixture.request)).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
    expect(await readFile(foreign, 'utf8')).toBe('must survive\n')
    expect(await pathExists(posix.join(target, 'tree'))).toBe(false)
  })

  it('rejects an oversized sparse published entry before attempting to hash its contents', async () => {
    const fixture = await createFixture()
    await provisionBuilderSupervisor(fixture.request)
    const target = posix.join(scopePath(fixture, fixture.policy.stateRoot), 'template-store', 'v1.0.0')
    const tree = posix.join(target, 'tree')
    const file = posix.join(tree, 'README.md')
    await chmod(target, 0o700); await chmod(tree, 0o700); await chmod(file, 0o600)
    await run('truncate', ['-s', String(TEMPLATE_ENTRY_MAX_BYTES + 1), file])
    await chmod(file, 0o444); await chmod(tree, 0o555); await chmod(target, 0o555)
    const started = Date.now()
    await expect(provisionBuilderSupervisor(fixture.request)).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('recovers stale locks, sealed staging and partial authority from an interrupted provision', async () => {
    const fixture = await createFixture()
    const instanceRoot = scopePath(fixture, fixture.policy.stateRoot)
    await installProvisionGuard(instanceRoot)
    const storeParent = posix.join(instanceRoot, 'template-store')
    await mkdir(storeParent, { recursive: true, mode: 0o700 })
    const claim = '.claim-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const claimPath = posix.join(instanceRoot, claim)
    const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
    await writeFile(claimPath, `${JSON.stringify({ pid: 2_147_483_647, boot_id: bootId, start_ticks: '1', claim })}\n`, { mode: 0o400 })
    await link(claimPath, posix.join(instanceRoot, '.provision.lock'))
    const staging = posix.join(storeParent, '.staging-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    await mkdir(staging, { mode: 0o700 }); await writeFile(posix.join(staging, 'partial'), 'x', { mode: 0o444 }); await chmod(staging, 0o555)
    const interruptedTarget = posix.join(storeParent, 'v1.0.0')
    await mkdir(posix.join(interruptedTarget, 'tree'), { recursive: true, mode: 0o700 })
    await writeFile(posix.join(interruptedTarget, 'tree', 'partial'), 'x', { mode: 0o600 })
    const configDirectory = scopePath(fixture, fixture.policy.configRoot)
    const secretDirectory = scopePath(fixture, fixture.policy.secretRoot)
    await mkdir(configDirectory, { recursive: true, mode: 0o700 }); await mkdir(secretDirectory, { recursive: true, mode: 0o700 })
    await writeFile(posix.join(configDirectory, 'policy.sha256'), 'partial\n', { mode: 0o600 })
    const linkedStaging = posix.join(configDirectory, '.staging-cccccccccccccccccccccccccccccccc')
    await link(posix.join(configDirectory, 'policy.sha256'), linkedStaging)
    await writeFile(posix.join(configDirectory, '.staging-dddddddddddddddddddddddddddddddd'), 'unlinked\n', { mode: 0o600 })
    await writeFile(posix.join(secretDirectory, 'token'), 'partial\n', { mode: 0o400 })
    await expect(provisionBuilderSupervisor(fixture.request)).resolves.toMatchObject({ state: 'CREATED' })
    expect(await pathExists(staging)).toBe(false)
    expect(await pathExists(claimPath)).toBe(false)
    expect(await loadBuilderSupervisorConfig(`file:${posix.join(configDirectory, 'supervisor.json')}`, fixture.policy)).toMatchObject({ templateStoreSha256: fixture.treeSha })
  })

  it('durably completes a valid envelope left after marker sync when its owner is proven stale', async () => {
    const fixture = await createFixture()
    await provisionBuilderSupervisor(fixture.request)
    const instanceRoot = scopePath(fixture, fixture.policy.stateRoot)
    const target = posix.join(instanceRoot, 'template-store', 'v1.0.0')
    await chmod(target, 0o700)
    const claim = '.claim-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    const claimPath = posix.join(instanceRoot, claim)
    const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
    await writeFile(claimPath, `${JSON.stringify({ pid: 2_147_483_647, boot_id: bootId, start_ticks: '1', claim })}\n`, { mode: 0o400 })
    await link(claimPath, posix.join(instanceRoot, '.provision.lock'))
    await expect(provisionBuilderSupervisor(fixture.request)).resolves.toMatchObject({ state: 'CREATED', scope_id: fixture.scopeId })
    expect((await lstat(target)).mode & 0o777).toBe(0o555)
    expect(await pathExists(claimPath)).toBe(false)
  })

  it('preserves a corrupt completion marker even after proving the previous lock owner stale', async () => {
    const fixture = await createFixture()
    await provisionBuilderSupervisor(fixture.request)
    const instanceRoot = scopePath(fixture, fixture.policy.stateRoot)
    const target = posix.join(instanceRoot, 'template-store', 'v1.0.0')
    const marker = posix.join(target, '.complete')
    await chmod(target, 0o700); await chmod(marker, 0o600); await writeFile(marker, `${'f'.repeat(64)}\n`); await chmod(marker, 0o444)
    const claim = '.claim-ffffffffffffffffffffffffffffffff'
    const claimPath = posix.join(instanceRoot, claim)
    const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
    await writeFile(claimPath, `${JSON.stringify({ pid: 2_147_483_647, boot_id: bootId, start_ticks: '1', claim })}\n`, { mode: 0o400 })
    await link(claimPath, posix.join(instanceRoot, '.provision.lock'))
    await expect(provisionBuilderSupervisor(fixture.request)).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
    expect(await readFile(marker, 'utf8')).toBe(`${'f'.repeat(64)}\n`)
    expect((await lstat(target)).mode & 0o777).toBe(0o700)
  })

  it('rejects missing entries and file/directory type substitution in a published envelope', async () => {
    const missing = await createFixture()
    await provisionBuilderSupervisor(missing.request)
    const missingTarget = posix.join(scopePath(missing, missing.policy.stateRoot), 'template-store', 'v1.0.0')
    const missingTree = posix.join(missingTarget, 'tree')
    await chmod(missingTarget, 0o700); await chmod(missingTree, 0o700)
    await rm(posix.join(missingTree, 'README.md'))
    await chmod(missingTree, 0o555); await chmod(missingTarget, 0o555)
    await expect(provisionBuilderSupervisor(missing.request)).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })

    const changedType = await createFixture()
    await provisionBuilderSupervisor(changedType.request)
    const typeTarget = posix.join(scopePath(changedType, changedType.policy.stateRoot), 'template-store', 'v1.0.0')
    const typeTree = posix.join(typeTarget, 'tree')
    await chmod(typeTarget, 0o700); await chmod(typeTree, 0o700)
    await rm(posix.join(typeTree, 'README.md'))
    await mkdir(posix.join(typeTree, 'README.md'), { mode: 0o555 })
    await chmod(typeTree, 0o555); await chmod(typeTarget, 0o555)
    await expect(provisionBuilderSupervisor(changedType.request)).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })

    const extraEnvelopeEntry = await createFixture()
    await provisionBuilderSupervisor(extraEnvelopeEntry.request)
    const extraTarget = posix.join(scopePath(extraEnvelopeEntry, extraEnvelopeEntry.policy.stateRoot), 'template-store', 'v1.0.0')
    await chmod(extraTarget, 0o700); await writeFile(posix.join(extraTarget, 'unexpected'), 'x', { mode: 0o444 }); await chmod(extraTarget, 0o555)
    await expect(provisionBuilderSupervisor(extraEnvelopeEntry.request)).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
  })

  it('fails closed on malformed recovery entries and insecure managed roots', async () => {
    const fixture = await createFixture()
    const instanceRoot = scopePath(fixture, fixture.policy.stateRoot)
    await installProvisionGuard(instanceRoot)
    const storeParent = posix.join(instanceRoot, 'template-store')
    await mkdir(storeParent, { recursive: true, mode: 0o700 })
    await mkdir(posix.join(storeParent, '.staging-not-safe'), { mode: 0o700 })
    await expect(provisionBuilderSupervisor(fixture.request)).rejects.toMatchObject({ code: 'PROVISION_RECOVERY_FAILED' })
    const other = await createFixture()
    await chmod(other.policy.configRoot, 0o777)
    await expect(provisionBuilderSupervisor(other.request)).rejects.toMatchObject({ code: 'INVALID_PROVISION_REQUEST' })
  })

  it('fails closed when interrupted staging or partial authority contains links', async () => {
    const stagingFixture = await createFixture()
    const stagingInstanceRoot = scopePath(stagingFixture, stagingFixture.policy.stateRoot)
    await installProvisionGuard(stagingInstanceRoot)
    const storeParent = posix.join(stagingInstanceRoot, 'template-store')
    const staging = posix.join(storeParent, '.staging-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    await mkdir(staging, { recursive: true, mode: 0o700 })
    await symlink(stagingFixture.sourceRoot, posix.join(staging, 'escape'))
    await expect(provisionBuilderSupervisor(stagingFixture.request)).rejects.toMatchObject({ code: 'PROVISION_RECOVERY_FAILED' })

    const rootLinkFixture = await createFixture()
    const linkedInstanceRoot = scopePath(rootLinkFixture, rootLinkFixture.policy.stateRoot)
    await installProvisionGuard(linkedInstanceRoot)
    const linkedParent = posix.join(linkedInstanceRoot, 'template-store')
    await mkdir(linkedParent, { recursive: true, mode: 0o700 })
    await symlink(rootLinkFixture.sourceRoot, posix.join(linkedParent, '.staging-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'))
    await expect(provisionBuilderSupervisor(rootLinkFixture.request)).rejects.toMatchObject({ code: 'PROVISION_RECOVERY_FAILED' })

    const authorityFixture = await createFixture()
    const configDirectory = scopePath(authorityFixture, authorityFixture.policy.configRoot)
    await mkdir(configDirectory, { recursive: true, mode: 0o700 })
    await symlink(authorityFixture.manifestPath, posix.join(configDirectory, 'policy.sha256'))
    await expect(provisionBuilderSupervisor(authorityFixture.request)).rejects.toMatchObject({ code: 'PROVISION_RECOVERY_FAILED' })
  })

  it('rejects malformed authority recovery objects, excess links and links to unknown targets', async () => {
    const directoryFixture = await createFixture()
    const directoryConfig = scopePath(directoryFixture, directoryFixture.policy.configRoot)
    await mkdir(posix.join(directoryConfig, '.staging-11111111111111111111111111111111'), { recursive: true, mode: 0o700 })
    await expect(provisionBuilderSupervisor(directoryFixture.request)).rejects.toMatchObject({ code: 'PROVISION_RECOVERY_FAILED' })

    const excessLinksFixture = await createFixture()
    const excessConfig = scopePath(excessLinksFixture, excessLinksFixture.policy.configRoot)
    await mkdir(excessConfig, { recursive: true, mode: 0o700 })
    const allowedTarget = posix.join(excessConfig, 'policy.sha256')
    const excessStaging = posix.join(excessConfig, '.staging-22222222222222222222222222222222')
    await writeFile(allowedTarget, 'partial\n', { mode: 0o600 })
    await link(allowedTarget, excessStaging)
    await link(allowedTarget, posix.join(excessConfig, 'third-link'))
    await expect(provisionBuilderSupervisor(excessLinksFixture.request)).rejects.toMatchObject({ code: 'PROVISION_RECOVERY_FAILED' })

    const unknownTargetFixture = await createFixture()
    const unknownConfig = scopePath(unknownTargetFixture, unknownTargetFixture.policy.configRoot)
    await mkdir(unknownConfig, { recursive: true, mode: 0o700 })
    const unknownTarget = posix.join(unknownConfig, 'unknown-target')
    await writeFile(unknownTarget, 'partial\n', { mode: 0o600 })
    await link(unknownTarget, posix.join(unknownConfig, '.staging-33333333333333333333333333333333'))
    await expect(provisionBuilderSupervisor(unknownTargetFixture.request)).rejects.toMatchObject({ code: 'PROVISION_RECOVERY_FAILED' })
  })

  it('rejects a source filename containing a backslash before publication', async () => {
    const fixture = await createFixture()
    await writeFile(posix.join(fixture.sourceRoot, 'bad\\name'), 'unsafe\n', { mode: 0o600 })
    await expect(provisionBuilderSupervisor(fixture.request)).rejects.toMatchObject({ code: 'SOURCE_UNSAFE' })
  })
})

interface Fixture {
  readonly root: string
  readonly policy: BuilderSupervisorRootPolicy
  readonly sourceRoot: string
  readonly manifestPath: string
  readonly manifestSha: string
  readonly treeSha: string
  readonly scopeId: ReturnType<typeof deriveBuilderRuntimeScopeId>
  readonly files: Readonly<Record<string, string>>
  readonly manifest: { readonly version: 1; readonly template_store_version: string; readonly tree_sha256: string; readonly entries: readonly TemplateManifestEntry[] }
  readonly request: BuilderProvisionRequest
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(posix.join(tmpdir(), 'dsp-')); roots.push(root)
  const managed = posix.join(root, 'managed')
  const policy: BuilderSupervisorRootPolicy = {
    configRoot: posix.join(managed, 'config'), secretRoot: posix.join(managed, 'secrets'), socketRoot: posix.join(managed, 'run'),
    artifactRoot: posix.join(managed, 'artifacts'), exportRoot: posix.join(managed, 'exports'), stateRoot: posix.join(managed, 'state'),
    dockerSocketPath: posix.join(managed, 'docker.sock'),
  }
  for (const path of [policy.configRoot, policy.secretRoot, policy.socketRoot, policy.artifactRoot, policy.exportRoot, policy.stateRoot]) await mkdir(path, { recursive: true, mode: 0o700 })
  const sourceRoot = posix.join(root, 'source'); await mkdir(posix.join(sourceRoot, 'app', 'config'), { recursive: true, mode: 0o700 })
  const files = { 'README.md': 'DZ23 template\n', 'app/package.json': '{"private":true}\n', 'app/config/runtime.json': '{"network":"none"}\n' }
  await writeFile(posix.join(sourceRoot, 'README.md'), files['README.md'], { mode: 0o600 })
  await writeFile(posix.join(sourceRoot, 'app', 'package.json'), files['app/package.json'], { mode: 0o600 })
  await writeFile(posix.join(sourceRoot, 'app', 'config', 'runtime.json'), files['app/config/runtime.json'], { mode: 0o600 })
  const entries: TemplateManifestEntry[] = [
    { path: 'README.md', type: 'file', bytes: Buffer.byteLength(files['README.md']), sha256: sha(files['README.md']) },
    { path: 'app', type: 'directory' },
    { path: 'app/config', type: 'directory' },
    { path: 'app/config/runtime.json', type: 'file', bytes: Buffer.byteLength(files['app/config/runtime.json']), sha256: sha(files['app/config/runtime.json']) },
    { path: 'app/package.json', type: 'file', bytes: Buffer.byteLength(files['app/package.json']), sha256: sha(files['app/package.json']) },
  ]
  const treeSha = computeTemplateTreeSha256('v1.0.0', entries)
  const manifest = { version: 1 as const, template_store_version: 'v1.0.0', tree_sha256: treeSha, entries }
  const manifestRaw = `${JSON.stringify(manifest)}\n`
  const manifestPath = posix.join(root, 'template-store.manifest.json'); await writeFile(manifestPath, manifestRaw, { mode: 0o600 })
  const manifestSha = sha(manifestRaw)
  const installationId = 'd'.repeat(64)
  const scopeId = deriveBuilderRuntimeScopeId({ installationId, tenantId: 'tenant-one', instanceId: 'instance-one' })
  return { root, policy, sourceRoot, manifestPath, manifestSha, treeSha, scopeId, files, manifest, request: {
    installationId, tenantId: 'tenant-one', instanceId: 'instance-one', sourceRoot, manifestReference: `file:${manifestPath}`,
    manifestSha256: manifestSha, imageDigest: `sha256:${'a'.repeat(64)}`, policySha256: 'b'.repeat(64), roots: policy,
  } }
}

function scopePath(fixture: Fixture, root: string): string {
  return posix.join(root, 'instances', fixture.scopeId)
}

async function createStaleLock(fixture: Fixture, claim: string): Promise<{
  readonly instanceRoot: string
  readonly claimPath: string
  readonly lockPath: string
}> {
  const instanceRoot = scopePath(fixture, fixture.policy.stateRoot)
  await mkdir(instanceRoot, { recursive: true, mode: 0o700 })
  await installProvisionGuard(instanceRoot)
  const claimPath = posix.join(instanceRoot, claim)
  const lockPath = posix.join(instanceRoot, '.provision.lock')
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
  await writeFile(claimPath, `${JSON.stringify({ pid: 2_147_483_647, boot_id: bootId, start_ticks: '1', claim })}\n`, { mode: 0o400 })
  await link(claimPath, lockPath)
  return { instanceRoot, claimPath, lockPath }
}

async function installProvisionGuard(instanceRoot: string): Promise<void> {
  await mkdir(instanceRoot, { recursive: true, mode: 0o700 })
  await writeFile(posix.join(instanceRoot, '.provision.guard'), '', { mode: 0o600, flag: 'wx' })
}

let provisionChildSequence = 0
async function startProvisionChild(
  fixture: Fixture,
  mode: 'run' | 'crash-before-unlink' | 'crash-after-unlink' | 'crash-during-store' | 'pause-acquire' | 'pause-guard-missing' | 'pause-release',
  readyPath?: string,
  gatePath?: string,
  resultPath?: string,
): Promise<{ completed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; kill(): void }> {
  provisionChildSequence += 1
  const requestPath = posix.join(fixture.root, `child-${provisionChildSequence}.request.json`)
  await writeFile(requestPath, `${JSON.stringify(fixture.request)}\n`, { mode: 0o600 })
  const childScript = fileURLToPath(new URL('fixtures/store-provision-child.ts', import.meta.url))
  const tsx = require.resolve('tsx/cli')
  const child = spawn(process.execPath, [tsx, childScript, requestPath, mode, readyPath ?? '-', gatePath ?? '-', resultPath ?? '-'], {
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  return trackProvisionChild({
    completed: new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal }))
    }),
    // Sem isto, um teste que estoura o prazo deixa os filhos vivos. Com
    // cinquenta deles, a suíte INTEIRA seguinte trava: foi o que aconteceu -
    // 126 processos órfãos de `store-provision-child` envenenando as execuções
    // posteriores. A garantia do teste não muda; o que muda é ele limpar a
    // própria bagunça quando falha.
    kill: () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') },
  })
}

/** Registra o filho para o encerramento automático e devolve o mesmo objeto. */
function trackProvisionChild<T extends { kill(): void }>(child: T): T {
  startedChildren.push(child)
  return child
}

async function waitForPath(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!await pathExists(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${posix.basename(path)}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function lockArtifacts(instanceRoot: string): Promise<string[]> {
  return (await readdir(instanceRoot)).filter(name => name === '.provision.lock' || name.startsWith('.claim-') || name.startsWith('.takeover-')).sort()
}

function wasKilled(result: { code: number | null; signal: NodeJS.Signals | null }): boolean {
  return result.signal === 'SIGKILL' || (result.signal === null && result.code === 128 + 9)
}

function sha(value: string): string { return createHash('sha256').update(value).digest('hex') }
async function pathExists(path: string): Promise<boolean> { try { await lstat(path); return true } catch { return false } }
async function snapshotTree(root: string): Promise<readonly string[]> {
  const snapshot: string[] = []
  const visit = async (directory: string, relative: string): Promise<void> => {
    const names = (await readdir(directory)).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
    for (const name of names) {
      const path = posix.join(directory, name)
      const child = relative === '' ? name : posix.join(relative, name)
      const stat = await lstat(path)
      if (stat.isDirectory()) {
        snapshot.push(`d:${child}:${stat.mode & 0o7777}`)
        await visit(path, child)
      } else if (stat.isFile()) {
        snapshot.push(`f:${child}:${stat.mode & 0o7777}:${createHash('sha256').update(await readFile(path)).digest('hex')}`)
      } else snapshot.push(`x:${child}:${stat.mode & 0o7777}`)
    }
  }
  await visit(root, '')
  return snapshot
}
async function makeWritable(root: string): Promise<void> {
  if (!await pathExists(root)) return
  const stat = await lstat(root)
  if (stat.isSymbolicLink()) return
  if (stat.isFile()) { await chmod(root, 0o600); return }
  if (!stat.isDirectory()) return
  await chmod(root, 0o700)
  for (const name of await readdir(root)) await makeWritable(posix.join(root, name))
}
