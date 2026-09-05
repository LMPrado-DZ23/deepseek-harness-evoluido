import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { posix } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { loadBuilderSupervisorConfig, type BuilderSupervisorRootPolicy } from '../src/supervisor-config.js'
import { BuilderProvisionError, provisionBuilderSupervisor, type BuilderProvisionRequest } from '../src/store-provision.js'
import { TEMPLATE_ENTRY_MAX_BYTES, TEMPLATE_MANIFEST_MAX_BYTES, computeTemplateTreeSha256, type TemplateManifestEntry } from '../src/store-security.js'

const run = promisify(execFile)
const linux = process.platform === 'linux' ? describe : describe.skip
const roots: string[] = []
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
      state: 'CREATED', tenant_id: 'tenant-one', instance_id: 'instance-one',
      template_store_version: 'v1.0.0', template_store_sha256: fixture.treeSha, manifest_sha256: fixture.manifestSha,
    }))
    const config = await loadBuilderSupervisorConfig(result.config_reference, fixture.policy)
    expect(config).toEqual(expect.objectContaining({ tenantId: 'tenant-one', instanceId: 'instance-one', templateStoreVersion: 'v1.0.0', templateStoreSha256: fixture.treeSha }))
    const configDirectory = posix.join(fixture.policy.configRoot, 'tenant-one', 'instance-one')
    const secretDirectory = posix.join(fixture.policy.secretRoot, 'tenant-one', 'instance-one')
    const storeRoot = posix.join(fixture.policy.stateRoot, 'tenant-one', 'instance-one', 'template-store', 'v1.0.0')
    const storeTree = posix.join(storeRoot, 'tree')
    expect((await lstat(storeRoot)).mode & 0o777).toBe(0o555)
    expect((await lstat(posix.join(storeRoot, '.complete'))).mode & 0o777).toBe(0o444)
    expect((await lstat(posix.join(storeTree, 'app'))).mode & 0o777).toBe(0o555)
    expect((await lstat(posix.join(storeTree, 'app', 'package.json'))).mode & 0o777).toBe(0o444)
    expect(await readFile(posix.join(storeTree, 'app', 'package.json'), 'utf8')).toBe(fixture.files['app/package.json'])
    expect((await lstat(posix.join(secretDirectory, 'token'))).mode & 0o777).toBe(0o400)
    for (const name of ['supervisor.json', 'builder-image.sha256', 'template-store.sha256', 'template-manifest.sha256', 'policy.sha256']) {
      expect((await lstat(posix.join(configDirectory, name))).mode & 0o777).toBe(0o600)
    }
    const token = (await readFile(posix.join(secretDirectory, 'token'), 'utf8')).trim()
    expect(JSON.stringify(result)).not.toContain(token)
    expect(await readFile(posix.join(configDirectory, 'template-manifest.sha256'), 'utf8')).toBe(`${fixture.manifestSha}\n`)
  })

  it('rejects reprovisioning and never overwrites an existing authority set', async () => {
    const fixture = await createFixture()
    await provisionBuilderSupervisor(fixture.request)
    const tokenPath = posix.join(fixture.policy.secretRoot, 'tenant-one', 'instance-one', 'token')
    const configPath = posix.join(fixture.policy.configRoot, 'tenant-one', 'instance-one', 'supervisor.json')
    const before = await readFile(tokenPath, 'utf8')
    const interruptedLink = posix.join(posix.dirname(configPath), '.staging-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    await link(configPath, interruptedLink)
    await expect(provisionBuilderSupervisor(fixture.request)).rejects.toMatchObject({ code: 'ALREADY_PROVISIONED' })
    expect(await readFile(tokenPath, 'utf8')).toBe(before)
    expect((await lstat(configPath)).nlink).toBe(1)
    expect(await pathExists(interruptedLink)).toBe(false)
  })

  it('rejects a mutated published store instead of overwriting or repairing it', async () => {
    const fixture = await createFixture()
    await provisionBuilderSupervisor(fixture.request)
    const file = posix.join(fixture.policy.stateRoot, 'tenant-one', 'instance-one', 'template-store', 'v1.0.0', 'tree', 'README.md')
    await chmod(file, 0o644)
    await expect(provisionBuilderSupervisor(fixture.request)).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
  })

  it('rejects content drift in a sealed store even when permissions are restored', async () => {
    const fixture = await createFixture()
    await provisionBuilderSupervisor(fixture.request)
    const file = posix.join(fixture.policy.stateRoot, 'tenant-one', 'instance-one', 'template-store', 'v1.0.0', 'tree', 'README.md')
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
    expect(await pathExists(posix.join(fixture.policy.configRoot, 'tenant-one', 'instance-one', 'supervisor.json'))).toBe(false)
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
    expect(await pathExists(posix.join(fixture.policy.configRoot, 'Tenant-One'))).toBe(false)
  })

  it('serializes concurrent provisioners with a live process-identity lock', async () => {
    const fixture = await createFixture()
    const instanceRoot = posix.join(fixture.policy.stateRoot, 'tenant-one', 'instance-one')
    await mkdir(instanceRoot, { recursive: true, mode: 0o700 })
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
    const instanceRoot = posix.join(fixture.policy.stateRoot, 'tenant-one', 'instance-one')
    await mkdir(instanceRoot, { recursive: true, mode: 0o700 })
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
    const instanceRoot = posix.join(fixture.policy.stateRoot, 'tenant-one', 'instance-one')
    await mkdir(instanceRoot, { recursive: true, mode: 0o700 })
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
    expect(await pathExists(staleClaimPath)).toBe(false)
    expect((await readdir(instanceRoot)).some(name => name.startsWith('.takeover-'))).toBe(false)
  })

  it('never replaces a version directory created by a competing same-uid process', async () => {
    const fixture = await createFixture()
    const target = posix.join(fixture.policy.stateRoot, 'tenant-one', 'instance-one', 'template-store', 'v1.0.0')
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
    const target = posix.join(fixture.policy.stateRoot, 'tenant-one', 'instance-one', 'template-store', 'v1.0.0')
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
    const instanceRoot = posix.join(fixture.policy.stateRoot, 'tenant-one', 'instance-one')
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
    const configDirectory = posix.join(fixture.policy.configRoot, 'tenant-one', 'instance-one')
    const secretDirectory = posix.join(fixture.policy.secretRoot, 'tenant-one', 'instance-one')
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
    const instanceRoot = posix.join(fixture.policy.stateRoot, 'tenant-one', 'instance-one')
    const target = posix.join(instanceRoot, 'template-store', 'v1.0.0')
    await chmod(target, 0o700)
    const claim = '.claim-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    const claimPath = posix.join(instanceRoot, claim)
    const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
    await writeFile(claimPath, `${JSON.stringify({ pid: 2_147_483_647, boot_id: bootId, start_ticks: '1', claim })}\n`, { mode: 0o400 })
    await link(claimPath, posix.join(instanceRoot, '.provision.lock'))
    await expect(provisionBuilderSupervisor(fixture.request)).rejects.toMatchObject({ code: 'ALREADY_PROVISIONED' })
    expect((await lstat(target)).mode & 0o777).toBe(0o555)
    expect(await pathExists(claimPath)).toBe(false)
  })

  it('preserves a corrupt completion marker even after proving the previous lock owner stale', async () => {
    const fixture = await createFixture()
    await provisionBuilderSupervisor(fixture.request)
    const instanceRoot = posix.join(fixture.policy.stateRoot, 'tenant-one', 'instance-one')
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
    const missingTarget = posix.join(missing.policy.stateRoot, 'tenant-one', 'instance-one', 'template-store', 'v1.0.0')
    const missingTree = posix.join(missingTarget, 'tree')
    await chmod(missingTarget, 0o700); await chmod(missingTree, 0o700)
    await rm(posix.join(missingTree, 'README.md'))
    await chmod(missingTree, 0o555); await chmod(missingTarget, 0o555)
    await expect(provisionBuilderSupervisor(missing.request)).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })

    const changedType = await createFixture()
    await provisionBuilderSupervisor(changedType.request)
    const typeTarget = posix.join(changedType.policy.stateRoot, 'tenant-one', 'instance-one', 'template-store', 'v1.0.0')
    const typeTree = posix.join(typeTarget, 'tree')
    await chmod(typeTarget, 0o700); await chmod(typeTree, 0o700)
    await rm(posix.join(typeTree, 'README.md'))
    await mkdir(posix.join(typeTree, 'README.md'), { mode: 0o555 })
    await chmod(typeTree, 0o555); await chmod(typeTarget, 0o555)
    await expect(provisionBuilderSupervisor(changedType.request)).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })

    const extraEnvelopeEntry = await createFixture()
    await provisionBuilderSupervisor(extraEnvelopeEntry.request)
    const extraTarget = posix.join(extraEnvelopeEntry.policy.stateRoot, 'tenant-one', 'instance-one', 'template-store', 'v1.0.0')
    await chmod(extraTarget, 0o700); await writeFile(posix.join(extraTarget, 'unexpected'), 'x', { mode: 0o444 }); await chmod(extraTarget, 0o555)
    await expect(provisionBuilderSupervisor(extraEnvelopeEntry.request)).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
  })

  it('fails closed on malformed recovery entries and insecure managed roots', async () => {
    const fixture = await createFixture()
    const storeParent = posix.join(fixture.policy.stateRoot, 'tenant-one', 'instance-one', 'template-store')
    await mkdir(storeParent, { recursive: true, mode: 0o700 })
    await mkdir(posix.join(storeParent, '.staging-not-safe'), { mode: 0o700 })
    await expect(provisionBuilderSupervisor(fixture.request)).rejects.toMatchObject({ code: 'PROVISION_RECOVERY_FAILED' })
    const other = await createFixture()
    await chmod(other.policy.configRoot, 0o777)
    await expect(provisionBuilderSupervisor(other.request)).rejects.toMatchObject({ code: 'INVALID_PROVISION_REQUEST' })
  })

  it('fails closed when interrupted staging or partial authority contains links', async () => {
    const stagingFixture = await createFixture()
    const storeParent = posix.join(stagingFixture.policy.stateRoot, 'tenant-one', 'instance-one', 'template-store')
    const staging = posix.join(storeParent, '.staging-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    await mkdir(staging, { recursive: true, mode: 0o700 })
    await symlink(stagingFixture.sourceRoot, posix.join(staging, 'escape'))
    await expect(provisionBuilderSupervisor(stagingFixture.request)).rejects.toMatchObject({ code: 'PROVISION_RECOVERY_FAILED' })

    const rootLinkFixture = await createFixture()
    const linkedParent = posix.join(rootLinkFixture.policy.stateRoot, 'tenant-one', 'instance-one', 'template-store')
    await mkdir(linkedParent, { recursive: true, mode: 0o700 })
    await symlink(rootLinkFixture.sourceRoot, posix.join(linkedParent, '.staging-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'))
    await expect(provisionBuilderSupervisor(rootLinkFixture.request)).rejects.toMatchObject({ code: 'PROVISION_RECOVERY_FAILED' })

    const authorityFixture = await createFixture()
    const configDirectory = posix.join(authorityFixture.policy.configRoot, 'tenant-one', 'instance-one')
    await mkdir(configDirectory, { recursive: true, mode: 0o700 })
    await symlink(authorityFixture.manifestPath, posix.join(configDirectory, 'policy.sha256'))
    await expect(provisionBuilderSupervisor(authorityFixture.request)).rejects.toMatchObject({ code: 'PROVISION_RECOVERY_FAILED' })
  })
})

interface Fixture {
  readonly root: string
  readonly policy: BuilderSupervisorRootPolicy
  readonly sourceRoot: string
  readonly manifestPath: string
  readonly manifestSha: string
  readonly treeSha: string
  readonly files: Readonly<Record<string, string>>
  readonly request: BuilderProvisionRequest
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(posix.join(tmpdir(), 'dz23-store-provision-')); roots.push(root)
  const managed = posix.join(root, 'managed')
  const policy: BuilderSupervisorRootPolicy = {
    configRoot: posix.join(managed, 'config'), secretRoot: posix.join(managed, 'secrets'), socketRoot: posix.join(managed, 'run'),
    artifactRoot: posix.join(managed, 'artifacts'), exportRoot: posix.join(managed, 'exports'), stateRoot: posix.join(managed, 'state'),
    dockerSocketPath: posix.join(managed, 'docker.sock'),
  }
  for (const path of [policy.configRoot, policy.secretRoot, policy.socketRoot, policy.artifactRoot, policy.exportRoot, policy.stateRoot]) await mkdir(path, { recursive: true, mode: 0o700 })
  const sourceRoot = posix.join(root, 'source'); await mkdir(posix.join(sourceRoot, 'app'), { recursive: true, mode: 0o700 })
  const files = { 'README.md': 'DZ23 template\n', 'app/package.json': '{"private":true}\n' }
  await writeFile(posix.join(sourceRoot, 'README.md'), files['README.md'], { mode: 0o600 })
  await writeFile(posix.join(sourceRoot, 'app', 'package.json'), files['app/package.json'], { mode: 0o600 })
  const entries: TemplateManifestEntry[] = [
    { path: 'README.md', type: 'file', bytes: Buffer.byteLength(files['README.md']), sha256: sha(files['README.md']) },
    { path: 'app', type: 'directory' },
    { path: 'app/package.json', type: 'file', bytes: Buffer.byteLength(files['app/package.json']), sha256: sha(files['app/package.json']) },
  ]
  const treeSha = computeTemplateTreeSha256('v1.0.0', entries)
  const manifestRaw = `${JSON.stringify({ version: 1, template_store_version: 'v1.0.0', tree_sha256: treeSha, entries })}\n`
  const manifestPath = posix.join(root, 'template-store.manifest.json'); await writeFile(manifestPath, manifestRaw, { mode: 0o600 })
  const manifestSha = sha(manifestRaw)
  return { root, policy, sourceRoot, manifestPath, manifestSha, treeSha, files, request: {
    tenantId: 'tenant-one', instanceId: 'instance-one', sourceRoot, manifestReference: `file:${manifestPath}`,
    manifestSha256: manifestSha, imageDigest: `sha256:${'a'.repeat(64)}`, policySha256: 'b'.repeat(64), roots: policy,
  } }
}

function sha(value: string): string { return createHash('sha256').update(value).digest('hex') }
async function pathExists(path: string): Promise<boolean> { try { await lstat(path); return true } catch { return false } }
async function makeWritable(root: string): Promise<void> {
  if (!await pathExists(root)) return
  const stat = await lstat(root)
  if (stat.isSymbolicLink()) return
  if (stat.isFile()) { await chmod(root, 0o600); return }
  if (!stat.isDirectory()) return
  await chmod(root, 0o700)
  for (const name of await readdir(root)) await makeWritable(posix.join(root, name))
}
