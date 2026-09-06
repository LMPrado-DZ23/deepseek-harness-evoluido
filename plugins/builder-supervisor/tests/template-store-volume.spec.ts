import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DockerEnginePort } from '../src/docker-engine.js'
import { deriveBuilderRuntimeScopeId } from '../src/runtime-scope.js'
import { TEMPLATE_ENTRY_MAX_BYTES, computeTemplateTreeSha256, type TemplateManifestEntry, type TemplateStoreManifest } from '../src/store-security.js'
import {
  TEMPLATE_STORE_CLAIM_TTL_MS,
  TEMPLATE_STORE_VERIFICATION_CLEANUP_BUDGET_MS,
  TEMPLATE_STORE_VERIFICATION_TIMEOUT_MS,
  TemplateStoreVolumeError,
  ensureTemplateStoreVolume,
  templateStoreTransporterBody,
  templateStoreUstarEntryPath,
  templateStoreVolumeLabels,
  templateStoreVolumeName,
  streamTemplateStoreFile,
  validateTemplateStoreArchive,
  validateTemplateStoreEntryCount,
  verifyTemplateStoreVolume,
  writeTemplateStoreBytes,
} from '../src/template-store-volume.js'

const installationId = 'a'.repeat(64)
const scopeId = deriveBuilderRuntimeScopeId({ installationId, tenantId: 'tenant-one', instanceId: 'instance-one' })
const otherScope = deriveBuilderRuntimeScopeId({ installationId, tenantId: 'tenant-two', instanceId: 'instance-one' })
const image = `sha256:${'b'.repeat(64)}` as const
const roots: string[] = []
const execFileAsync = promisify(execFile)

afterEach(async () => { await Promise.all(roots.splice(0).map(async root => { await makeRemovable(root); await rm(root, { recursive: true, force: true }) })) })

describe('template store Docker volume materialization', () => {
  it('derives physical-only names/labels and a fixed hardened transporter body', () => {
    const fixture = manifestFixture()
    const name = templateStoreVolumeName(installationId, scopeId, fixture.manifest.template_store_version, fixture.manifest.tree_sha256)
    expect(name).toMatch(/^dz23-template-[a-f0-9]{32}$/u)
    expect(name).not.toContain('tenant')
    expect(templateStoreVolumeName(installationId, otherScope, fixture.manifest.template_store_version, fixture.manifest.tree_sha256)).not.toBe(name)
    const labels = templateStoreVolumeLabels(identity(fixture.manifest))
    expect(labels).toEqual({ 'dz23.managed': 'builder-template-store', 'com.dz23.studio.installation-id': installationId, 'com.dz23.studio.scope-id': scopeId, 'dz23.template_version': 'v1.0.0', 'dz23.template_sha256': fixture.manifest.tree_sha256 })
    expect(JSON.stringify(labels)).not.toMatch(/tenant|org|instance/u)
    const body = record(templateStoreTransporterBody(image, identity(fixture.manifest), name, false)); const host = record(body.HostConfig)
    expect(body).toMatchObject({ Image: image, Cmd: ['node', '-e', 'setTimeout(()=>process.exit(0),720000)'], WorkingDir: '/', User: '10001:10001', NetworkDisabled: true })
    expect(host).toMatchObject({ NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], AutoRemove: true, PublishAllPorts: false, PortBindings: {}, Mounts: [{ Type: 'volume', Source: name, Target: '/template-store', ReadOnly: false }] })
    expect(host).not.toHaveProperty('Binds'); expect(body).not.toHaveProperty('ExposedPorts')
  })

  it.runIf(process.platform === 'linux')('uploads the deterministic tree first, marker last, validates canonical content and cleans transporter', async () => {
    const fixture = await sealedFixture(); const engine = new FakeEngine()
    const result = await ensureTemplateStoreVolume(options(engine, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))
    expect(result).toMatchObject({ state: 'CREATED', treeSha256: fixture.manifest.tree_sha256 })
    expect(engine.puts).toHaveLength(2)
    expect(namesInTar(engine.puts[0]!.bytes)).toEqual(['tree', 'tree/pkg', 'tree/pkg/package.json'])
    expect(namesInTar(engine.puts[1]!.bytes)).toEqual(['.complete'])
    expect(engine.puts[1]!.bytes.includes(Buffer.from(`${fixture.manifest.tree_sha256}\n`))).toBe(true)
    expect(engine.downloads).toEqual(['/template-store', '/template-store'])
    expect(engine.containers.size).toBe(0)
    expect(engine.volumes.get(result.volumeName)?.Labels).toMatchObject(templateStoreVolumeLabels(identity(fixture.manifest)))
    expect(engine.createdBodies[0]?.body).toMatchObject({ Cmd: ['node', '-e', 'setTimeout(()=>process.exit(0),900000)'], NetworkDisabled: true, User: '10001:10001', HostConfig: { AutoRemove: false } })
    for (const created of engine.createdBodies) {
      const host = record(created.body.HostConfig)
      expect(host).toMatchObject({ NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], PublishAllPorts: false, PortBindings: {} })
      expect(host).not.toHaveProperty('Binds'); expect(created.body).not.toHaveProperty('ExposedPorts')
      expect(JSON.stringify(created.body.Labels)).not.toMatch(/tenant|org|instance/u)
    }
    const repeated = new FakeEngine()
    await expect(ensureTemplateStoreVolume(options(repeated, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).resolves.toMatchObject({ state: 'CREATED' })
    expect(repeated.puts.map(row => row.bytes)).toEqual(engine.puts.map(row => row.bytes))
  })

  it('auto-expires and removes an orphan transporter while preserving claim witnesses', async () => {
    const fixture = manifestFixture(); const engine = new FakeEngine(); const name = templateStoreVolumeName(installationId, scopeId, 'v1.0.0', fixture.manifest.tree_sha256)
    const transport = await engine.createContainer(`${name}-transport-${'a'.repeat(8)}`, templateStoreTransporterBody(image, identity(fixture.manifest), name, true), AbortSignal.timeout(1_000))
    await engine.startContainer(transport, AbortSignal.timeout(1_000)); engine.expireAutoRemoveTransporters()
    expect(engine.containers.has(transport)).toBe(false); expect(engine.autoRemovedContainerIds).toContain(transport)
    engine.seedClaim(name, fixture.manifest, 'e'.repeat(32), 'running', Date.now() + 60_000)
    engine.expireAutoRemoveTransporters()
    expect([...engine.containers.values()].some(row => row.name.endsWith('-claim'))).toBe(true)
  })

  it.runIf(process.platform === 'linux')('requires a root-only target volume before the first upload', async () => {
    const fixture = await sealedFixture(); const engine = new FakeEngine(); engine.currentPayload = dockerTar([dir('template-store/'), dir('template-store/tree/')]); engine.materializedPayload = fixture.archive
    await expect(ensureTemplateStoreVolume(options(engine, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_TARGET_MISMATCH' })
    expect(engine.puts).toHaveLength(0); expect(engine.volumes.size).toBe(0)
  })

  it.runIf(process.platform === 'linux')('keeps the claim until an uncertain post-create inspection can clean the owned volume', async () => {
    const fixture = await sealedFixture(); const engine = new FakeEngine(); engine.failPostCreateInspect = true
    await expect(ensureTemplateStoreVolume(options(engine, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).rejects.toThrow('post-create inspect failed')
    expect(engine.volumes.size).toBe(0); expect(engine.containers.size).toBe(0)
  })

  it.runIf(process.platform === 'linux')('reconciles create-then-throw and retains its witness when inspection is uncertain', async () => {
    const fixture = await sealedFixture()
    const committed = new FakeEngine(); committed.createVolumeThenThrow = true
    await expect(ensureTemplateStoreVolume(options(committed, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).rejects.toThrow('create failed after commit')
    expect(committed.volumes.size).toBe(0); expect(committed.containers.size).toBe(0)

    const uncertain = new FakeEngine(); uncertain.createVolumeThenThrow = true; uncertain.failPostCreateInspect = true
    await expect(ensureTemplateStoreVolume(options(uncertain, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_CLEANUP_INCOMPLETE' })
    expect(uncertain.volumes.size).toBe(1); expect([...uncertain.containers.values()].some(row => row.name.endsWith('-claim'))).toBe(true)
    await expect(ensureTemplateStoreVolume(options(uncertain, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_BUSY' })
    uncertain.createVolumeThenThrow = false; uncertain.failPostCreateInspect = false; uncertain.expireClaims(); uncertain.materializedPayload = fixture.archive
    await expect(ensureTemplateStoreVolume(options(uncertain, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).resolves.toMatchObject({ state: 'CREATED' })
  })

  it.runIf(process.platform === 'linux')('reuses a canonically valid volume without upload and rebuilds an incomplete same-identity volume', async () => {
    const fixture = await sealedFixture(); const name = templateStoreVolumeName(installationId, scopeId, 'v1.0.0', fixture.manifest.tree_sha256)
    const reused = new FakeEngine(); reused.volumes.set(name, { Name: name, Labels: { ...templateStoreVolumeLabels(identity(fixture.manifest)), 'dz23.materialization_nonce': 'a'.repeat(32) } }); reused.currentPayload = fixture.archive
    await expect(ensureTemplateStoreVolume(options(reused, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).resolves.toMatchObject({ state: 'REUSED' })
    expect(reused.puts).toHaveLength(0); expect(reused.removedVolumes).toHaveLength(0)
    const claimNonce = record(reused.createdBodies[0]?.body.Labels)['dz23.materialization_nonce']
    expect(record(reused.createdBodies[1]?.body.Labels)['dz23.materialization_nonce']).toBe(claimNonce)

    const retry = new FakeEngine(); const staleNonce = 'c'.repeat(32); retry.volumes.set(name, { Name: name, Labels: { ...templateStoreVolumeLabels(identity(fixture.manifest)), 'dz23.materialization_nonce': staleNonce } }); retry.currentPayload = dockerTar([dir('template-store/')]); retry.materializedPayload = fixture.archive
    retry.seedClaim(name, fixture.manifest, staleNonce, 'exited', Date.now() + 60_000)
    await expect(ensureTemplateStoreVolume(options(retry, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_BUSY' })
    expect(retry.removedVolumes).toHaveLength(0)
    retry.expireClaims()
    await expect(ensureTemplateStoreVolume(options(retry, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).resolves.toMatchObject({ state: 'CREATED' })
    expect(retry.removedVolumes).toContain(name); expect(retry.puts).toHaveLength(2)
  })

  it.runIf(process.platform === 'linux')('serializes two materializers and never steals a live unexpired claim', async () => {
    const fixture = await sealedFixture(); const engine = new FakeEngine(); engine.materializedPayload = fixture.archive
    let release!: () => void; engine.volumeGate = new Promise(resolve => { release = resolve })
    const first = ensureTemplateStoreVolume(options(engine, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))
    await vi.waitFor(() => expect([...engine.containers.values()].some(row => row.name.endsWith('-claim') && row.state === 'running')).toBe(true))
    await expect(ensureTemplateStoreVolume(options(engine, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_BUSY' })
    release(); await expect(first).resolves.toMatchObject({ state: 'CREATED' })
    expect(engine.removedVolumes).toHaveLength(0)
  })

  it('keeps a canonically valid volume ineligible while any materialization claim exists', async () => {
    const fixture = manifestFixture(); const engine = existingEngine(fixture.manifest, fixture.archive); const name = templateStoreVolumeName(installationId, scopeId, 'v1.0.0', fixture.manifest.tree_sha256)
    engine.seedClaim(name, fixture.manifest, 'e'.repeat(32), 'running', Date.now() + 60_000)
    await expect(verifyTemplateStoreVolume(verifyOptions(engine, fixture.manifest), AbortSignal.timeout(2_000))).resolves.toBe(false)
    expect(engine.downloads).toHaveLength(0)
  })

  it('recovers verifier crashes before and after transporter start through the shared expired claim', async () => {
    const fixture = manifestFixture(); const name = templateStoreVolumeName(installationId, scopeId, 'v1.0.0', fixture.manifest.tree_sha256)
    for (const state of ['created', 'running']) {
      const engine = existingEngine(fixture.manifest, fixture.archive); const nonce = state === 'created' ? '7'.repeat(32) : '8'.repeat(32)
      engine.seedClaim(name, fixture.manifest, nonce, 'exited', Date.now() - 1); engine.seedTransporter(name, fixture.manifest, nonce, state)
      await expect(verifyTemplateStoreVolume(verifyOptions(engine, fixture.manifest), AbortSignal.timeout(2_000))).resolves.toBe(true)
      expect(engine.removedContainerIds).toContain('c'.repeat(12)); expect(engine.removedVolumes).not.toContain(name); expect(engine.containers.size).toBe(0)
    }
  })

  it.runIf(process.platform === 'linux')('recovers a created-but-never-started claim only after its TTL', async () => {
    const fixture = await sealedFixture(); const engine = new FakeEngine(); engine.materializedPayload = fixture.archive
    const name = templateStoreVolumeName(installationId, scopeId, 'v1.0.0', fixture.manifest.tree_sha256); const nonce = 'e'.repeat(32)
    engine.seedClaim(name, fixture.manifest, nonce, 'created', Date.now() + 60_000)
    await expect(ensureTemplateStoreVolume(options(engine, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_BUSY' })
    engine.expireClaims('created')
    await expect(ensureTemplateStoreVolume(options(engine, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).resolves.toMatchObject({ state: 'CREATED' })
  })

  it.runIf(process.platform === 'linux')('returns BUSY when another recovery generation wins after stale cleanup', async () => {
    const fixture = await sealedFixture(); const engine = new FakeEngine(); const name = templateStoreVolumeName(installationId, scopeId, 'v1.0.0', fixture.manifest.tree_sha256)
    const staleNonce = 'e'.repeat(32); const winnerNonce = '9'.repeat(32)
    engine.seedClaim(name, fixture.manifest, staleNonce, 'dead', Date.now() - 1)
    engine.afterContainerRemoval = () => {
      engine.beforeClaimCreate = () => {
        engine.seedClaim(name, fixture.manifest, winnerNonce, 'running', Date.now() + TEMPLATE_STORE_CLAIM_TTL_MS)
        engine.volumes.set(name, { Name: name, Labels: { ...templateStoreVolumeLabels(identity(fixture.manifest)), 'dz23.materialization_nonce': winnerNonce } })
        engine.seedTransporter(name, fixture.manifest, winnerNonce)
      }
    }
    await expect(ensureTemplateStoreVolume(options(engine, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_BUSY' })
    expect(record(engine.claimRow()?.body.Labels)['dz23.materialization_nonce']).toBe(winnerNonce)
    expect(engine.volumes.get(name)?.Labels['dz23.materialization_nonce']).toBe(winnerNonce)
    expect([...engine.containers.values()].some(row => row.name.includes('-transport-') && record(row.body.Labels)['dz23.materialization_nonce'] === winnerNonce)).toBe(true)
  })

  it.runIf(process.platform === 'linux')('never steals active Docker states even after the claim TTL', async () => {
    const fixture = await sealedFixture(); const name = templateStoreVolumeName(installationId, scopeId, 'v1.0.0', fixture.manifest.tree_sha256)
    for (const state of ['running', 'restarting', 'paused', 'removing']) {
      const engine = new FakeEngine(); engine.seedClaim(name, fixture.manifest, 'a'.repeat(32), state, Date.now() - 1)
      await expect(ensureTemplateStoreVolume(options(engine, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_BUSY' })
      expect(engine.containers.size).toBe(1)
    }
  })

  it.runIf(process.platform === 'linux')('recovers a crashed transporter only through its expired claim witness', async () => {
    const fixture = await sealedFixture(); const engine = new FakeEngine(); engine.materializedPayload = fixture.archive
    const name = templateStoreVolumeName(installationId, scopeId, 'v1.0.0', fixture.manifest.tree_sha256); const nonce = 'c'.repeat(32)
    engine.seedClaim(name, fixture.manifest, nonce, 'exited', Date.now() - 1)
    engine.seedTransporter(name, fixture.manifest, nonce)
    engine.volumes.set(name, { Name: name, Labels: { ...templateStoreVolumeLabels(identity(fixture.manifest)), 'dz23.materialization_nonce': nonce } })
    await expect(ensureTemplateStoreVolume(options(engine, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).resolves.toMatchObject({ state: 'CREATED' })
    expect(engine.removedContainerIds).toContain('c'.repeat(12)); expect(engine.removedVolumes).toContain(name)
  })

  it.runIf(process.platform === 'linux')('preserves and revalidates a prior valid volume after a reuse probe crashes', async () => {
    const fixture = await sealedFixture(); const engine = existingEngine(fixture.manifest, fixture.archive); const name = templateStoreVolumeName(installationId, scopeId, 'v1.0.0', fixture.manifest.tree_sha256); const nonce = 'c'.repeat(32)
    engine.seedClaim(name, fixture.manifest, nonce, 'dead', Date.now() - 1); engine.seedTransporter(name, fixture.manifest, nonce)
    await expect(ensureTemplateStoreVolume(options(engine, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).resolves.toMatchObject({ state: 'REUSED' })
    expect(engine.removedVolumes).not.toContain(name); expect(engine.puts).toHaveLength(0)
  })

  it.runIf(process.platform === 'linux')('keeps the stale claim witness when recovery is interrupted after deleting the old volume', async () => {
    const fixture = await sealedFixture(); const engine = new FakeEngine(); engine.materializedPayload = fixture.archive
    const name = templateStoreVolumeName(installationId, scopeId, 'v1.0.0', fixture.manifest.tree_sha256); const nonce = 'c'.repeat(32); const claimId = 'f'.repeat(12)
    engine.seedClaim(name, fixture.manifest, nonce, 'exited', Date.now() - 1)
    engine.volumes.set(name, { Name: name, Labels: { ...templateStoreVolumeLabels(identity(fixture.manifest)), 'dz23.materialization_nonce': nonce } })
    engine.failRemoveIds.add(claimId)
    await expect(ensureTemplateStoreVolume(options(engine, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_CLEANUP_INCOMPLETE' })
    expect(engine.volumes.has(name)).toBe(false); expect(engine.containers.has(claimId)).toBe(true)
    engine.failRemoveIds.delete(claimId)
    await expect(ensureTemplateStoreVolume(options(engine, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).resolves.toMatchObject({ state: 'CREATED' })
  })

  it.runIf(process.platform === 'linux')('never deletes a forged transporter that lacks the expired claim identity proof', async () => {
    const fixture = await sealedFixture(); const engine = new FakeEngine(); const name = templateStoreVolumeName(installationId, scopeId, 'v1.0.0', fixture.manifest.tree_sha256); const nonce = 'c'.repeat(32)
    engine.seedClaim(name, fixture.manifest, nonce, 'dead', Date.now() - 1); engine.seedTransporter(name, fixture.manifest, nonce)
    const forged = engine.containers.get('c'.repeat(12))!; forged.name = `${name}-transport-hostile`
    await expect(ensureTemplateStoreVolume(options(engine, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_TARGET_MISMATCH' })
    expect(engine.removedContainerIds).not.toContain('c'.repeat(12)); expect(engine.containers.has('c'.repeat(12))).toBe(true)
  })

  it.runIf(process.platform === 'linux')('refuses a hostile preexisting name without deleting it', async () => {
    const fixture = await sealedFixture(); const engine = new FakeEngine(); const name = templateStoreVolumeName(installationId, scopeId, 'v1.0.0', fixture.manifest.tree_sha256)
    engine.volumes.set(name, { Name: name, Labels: { 'dz23.managed': 'attacker' } })
    await expect(ensureTemplateStoreVolume(options(engine, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_TARGET_MISMATCH' })
    expect(engine.removedVolumes).toHaveLength(0); expect(engine.volumes.has(name)).toBe(true)
    const orphan = new FakeEngine(); orphan.volumes.set(name, { Name: name, Labels: { ...templateStoreVolumeLabels(identity(fixture.manifest)) } })
    await expect(ensureTemplateStoreVolume(options(orphan, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_TARGET_MISMATCH' })
    expect(orphan.removedVolumes).toHaveLength(0)
    const logical = new FakeEngine(); logical.volumes.set(name, { Name: name, Labels: { ...templateStoreVolumeLabels(identity(fixture.manifest)), tenant_id: 'leak' } }); logical.currentPayload = fixture.archive
    await expect(ensureTemplateStoreVolume(options(logical, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_TARGET_MISMATCH' })
    expect(logical.removedVolumes).toHaveLength(0)
    const race = new FakeEngine(); race.foreignVolumeNonce = 'd'.repeat(32)
    await expect(ensureTemplateStoreVolume(options(race, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_BUSY' })
    expect(race.removedVolumes).toHaveLength(0); expect(race.volumes.has(name)).toBe(true)
  })

  it('rejects hostile Docker archives, truncation, marker drift and content drift on the host', async () => {
    const fixture = manifestFixture(); const base = [dir('template-store/'), dir('template-store/tree/'), dir('template-store/tree/pkg/'), file('template-store/tree/pkg/package.json', fixture.content), file('template-store/.complete', `${fixture.manifest.tree_sha256}\n`)]
    const hostile = [
      dockerTar([...base, file('template-store/tree/pkg/package.json', fixture.content)]),
      dockerTar([dir('template-store/'), dir('template-store/tree/'), file('template-store/tree/../escape', 'x')]),
      dockerTar([dir('template-store/'), dir('template-store/tree/'), special('template-store/tree/link', '2')]),
      dockerTar([dir('template-store/'), dir('template-store/tree/'), special('template-store/tree/hard', '1')]),
      dockerTar([dir('template-store/'), dir('template-store/tree/'), special('template-store/tree/fifo', '6')]),
      dockerTar([dir('template-store/'), dir('template-store/tree/'), special('template-store/tree/pax', 'x')]),
      mutateTarHeader(dockerTar(base), 512, header => writeTarOctal(header, 100, 8, 0o755)),
      mutateTarHeader(dockerTar(base), 512, header => writeTarOctal(header, 108, 8, 0)),
      mutateTarHeader(dockerTar(base), 512, header => writeTarOctal(header, 116, 8, 0)),
      mutateTarHeader(dockerTar(base), 3 * 512, header => writeTarOctal(header, 124, 12, TEMPLATE_ENTRY_MAX_BYTES + 1)),
      dockerTar([dir('tree/'), dir('template-store/'), dir('tree/pkg/'), file('tree/pkg/package.json', fixture.content), file('.complete', `${fixture.manifest.tree_sha256}\n`)]),
      corruptTarChecksum(dockerTar(base)),
      dockerTar(base).subarray(0, -512),
      dockerTar([...base.slice(0, -1), file('template-store/.complete', `${'f'.repeat(64)}\n`)]),
      dockerTar([...base.slice(0, 3), file('template-store/tree/pkg/package.json', 'drift'), base.at(-1)!]),
    ]
    for (const payload of hostile) {
      const engine = existingEngine(fixture.manifest, payload)
      await expect(verifyTemplateStoreVolume(verifyOptions(engine, fixture.manifest), AbortSignal.timeout(2_000))).resolves.toBe(false)
      expect(engine.containers.size).toBe(0)
    }

    const dockerManagedRoot = mutateTarHeader(dockerTar(base), 0, header => {
      writeTarOctal(header, 100, 8, 0o777); writeTarOctal(header, 108, 8, 0); writeTarOctal(header, 116, 8, 0)
    })
    await expect(validateTemplateStoreArchive(shortReader(dockerManagedRoot, 512) as Pick<FileHandle, 'read'>, dockerManagedRoot.byteLength, 'v1.0.0', fixture.manifest.tree_sha256, false, AbortSignal.timeout(2_000))).resolves.toBe(true)
  })

  it('accepts repeated short reads and rejects non-USTAR/GNU metadata', async () => {
    const fixture = manifestFixture(); const payload = fixture.archive; const reader = shortReader(payload, 7)
    await expect(validateTemplateStoreArchive(reader as Pick<FileHandle, 'read'>, payload.byteLength, 'v1.0.0', fixture.manifest.tree_sha256, false, AbortSignal.timeout(2_000))).resolves.toBe(true)
    const reordered = dockerTar([dir('template-store/'), dir('template-store/tree/'), file('template-store/tree/pkg/package.json', fixture.content), dir('template-store/tree/pkg/'), file('template-store/.complete', `${fixture.manifest.tree_sha256}\n`)])
    await expect(validateTemplateStoreArchive(shortReader(reordered, 512) as Pick<FileHandle, 'read'>, reordered.byteLength, 'v1.0.0', fixture.manifest.tree_sha256, false, AbortSignal.timeout(2_000))).resolves.toBe(true)
    const gnu = mutateTarHeader(payload, 0, header => header.write('ustar ', 257, 6, 'ascii'))
    await expect(validateTemplateStoreArchive(shortReader(gnu, 512) as Pick<FileHandle, 'read'>, gnu.byteLength, 'v1.0.0', fixture.manifest.tree_sha256, false, AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_INVALID' })
    const aborted = new AbortController(); aborted.abort()
    await expect(validateTemplateStoreArchive(shortReader(payload, 512) as Pick<FileHandle, 'read'>, payload.byteLength, 'v1.0.0', fixture.manifest.tree_sha256, false, aborted.signal)).rejects.toMatchObject({ code: 'TEMPLATE_STORE_ABORTED' })
  })

  it('enforces the downloaded archive entry-count limit before canonicalization', async () => {
    const fixture = manifestFixture()
    const tooMany = dockerTar([dir('template-store/'), dir('template-store/tree/'), ...Array.from({ length: 10_001 }, (_, index) => file(`template-store/tree/f${index}`, ''))])
    await expect(validateTemplateStoreArchive(shortReader(tooMany, 512) as Pick<FileHandle, 'read'>, tooMany.byteLength, 'v1.0.0', fixture.manifest.tree_sha256, false, AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_INVALID' })
  })

  it('fails closed on truncated source reads, zero-progress writes and invalid observed entry counts', async () => {
    const content = Buffer.from('streamed-content')
    const consumed: Buffer[] = []
    await expect(streamTemplateStoreFile(shortReader(content, 3) as Pick<FileHandle, 'read'>, content.byteLength, AbortSignal.timeout(2_000), async value => { consumed.push(value) })).resolves.toEqual({ bytes: content.byteLength, sha256: sha(content) })
    expect(Buffer.concat(consumed)).toEqual(content)
    await expect(streamTemplateStoreFile(shortReader(content.subarray(0, 2), 2) as Pick<FileHandle, 'read'>, content.byteLength, AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_TARGET_MISMATCH' })

    const written: Buffer[] = []
    const partialWriter = { async write(value: Buffer, offset: number, length: number) { const bytesWritten = Math.min(2, length); written.push(Buffer.from(value.subarray(offset, offset + bytesWritten))); return { bytesWritten, buffer: value } } }
    await expect(writeTemplateStoreBytes(partialWriter as Pick<FileHandle, 'write'>, content)).resolves.toBe(content.byteLength)
    expect(Buffer.concat(written)).toEqual(content)
    const stalledWriter = { async write(value: Buffer) { return { bytesWritten: 0, buffer: value } } }
    await expect(writeTemplateStoreBytes(stalledWriter as Pick<FileHandle, 'write'>, content)).rejects.toMatchObject({ code: 'TEMPLATE_STORE_INVALID' })
    expect(() => validateTemplateStoreEntryCount(10_001)).toThrow('TEMPLATE_STORE_INVALID')
  })

  it.runIf(process.platform === 'linux')('fails closed when a downloaded archive witness or host cleanup is inconsistent', async () => {
    const fixture = manifestFixture()

    const byteDrift = existingEngine(fixture.manifest, fixture.archive); byteDrift.reportedDownloadBytesDelta = 1
    await expect(verifyTemplateStoreVolume(verifyOptions(byteDrift, fixture.manifest), AbortSignal.timeout(2_000))).resolves.toBe(false)

    const closeFailure = existingEngine(fixture.manifest, fixture.archive); closeFailure.failDownloadHandleClose = true
    await expect(verifyTemplateStoreVolume(verifyOptions(closeFailure, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_CLEANUP_INCOMPLETE' })
    await closeFailure.restoreDownloadHandle?.()

    const removeFailure = existingEngine(fixture.manifest, fixture.archive); removeFailure.blockDownloadStageRemoval = true
    await expect(verifyTemplateStoreVolume(verifyOptions(removeFailure, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_CLEANUP_INCOMPLETE' })
    expect(removeFailure.downloadStage).toBeDefined()
    await chmod(removeFailure.downloadStage!, 0o700); await rm(removeFailure.downloadStage!, { recursive: true, force: true })

    await expect(validateTemplateStoreArchive(shortReader(fixture.archive, 512) as Pick<FileHandle, 'read'>, fixture.archive.byteLength, '../bad', fixture.manifest.tree_sha256, false, AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_INVALID' })
  })

  it('rejects cross-scope inventory and validates exact name filtering independently of labels', async () => {
    const fixture = manifestFixture(); const engine = existingEngine(fixture.manifest, fixture.archive)
    const crossName = templateStoreVolumeName(installationId, otherScope, 'v1.0.0', fixture.manifest.tree_sha256)
    engine.volumes.set(crossName, { Name: crossName, Labels: { ...templateStoreVolumeLabels({ ...identity(fixture.manifest), scopeId: otherScope }) } })
    await expect(verifyTemplateStoreVolume(verifyOptions(engine, fixture.manifest), AbortSignal.timeout(2_000))).resolves.toBe(true)
    expect(engine.autoRemovedContainerIds).toHaveLength(1); expect(engine.missingRemoveIds).toContain(engine.autoRemovedContainerIds[0]); expect(engine.containers.size).toBe(0)
    expect(engine.volumeFilters.every(filter => filter.name?.length === 1)).toBe(true)
    engine.injectExtraName = true
    await expect(verifyTemplateStoreVolume(verifyOptions(engine, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_TARGET_MISMATCH' })
  })

  it.runIf(process.platform === 'linux')('fails closed on abort and bounded cleanup failures, leaving no eligible incomplete volume', async () => {
    const fixture = await sealedFixture(); const aborted = new FakeEngine(); aborted.materializedPayload = fixture.archive; aborted.abortAfterTree = true
    await expect(ensureTemplateStoreVolume(options(aborted, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_ABORTED' })
    expect(aborted.volumes.size).toBe(0); expect(aborted.puts).toHaveLength(1)

    const cleanup = new FakeEngine(); cleanup.materializedPayload = fixture.archive; cleanup.failRemoveContainer = true
    await expect(ensureTemplateStoreVolume(options(cleanup, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_CLEANUP_INCOMPLETE' })
    expect([...cleanup.containers.values()].some(row => row.name.endsWith('-claim'))).toBe(true)
    cleanup.failRemoveContainer = false; cleanup.expireClaims()
    await expect(ensureTemplateStoreVolume(options(cleanup, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).resolves.toMatchObject({ state: 'CREATED' })

    const externalController = new AbortController(); const external = new FakeEngine(); external.abortOnStart = true; external.abortController = externalController
    await expect(ensureTemplateStoreVolume(options(external, fixture.root, fixture.manifest), externalController.signal)).rejects.toMatchObject({ code: 'TEMPLATE_STORE_ABORTED' })
  })

  it.runIf(process.platform === 'linux')('retains the claim when any cleanup proof operation fails', async () => {
    const fixture = await sealedFixture()
    const failures: ReadonlyArray<readonly [FaultOperation, number]> = [
      ['stopContainer', 1],
      ['removeContainer', 1],
      ['listContainers', 1],
      ['listContainers', 2],
      ['stopContainer', 2],
    ]
    for (const [operation, call] of failures) {
      const engine = new FakeEngine(); engine.materializedPayload = fixture.archive; engine.fail(operation, call)
      await expect(ensureTemplateStoreVolume(options(engine, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_CLEANUP_INCOMPLETE' })
      expect([...engine.containers.values()].some(row => row.name.endsWith('-claim'))).toBe(true)
    }
  })

  it.runIf(process.platform === 'linux')('keeps the claim across volume rollback inspection and deletion uncertainty', async () => {
    const fixture = await sealedFixture()
    for (const [operation, call] of [['listVolumes', 3], ['removeVolume', 1], ['listVolumes', 4]] as const) {
      const engine = new FakeEngine(); engine.materializedPayload = fixture.archive; engine.abortAfterTree = true; engine.fail(operation, call)
      await expect(ensureTemplateStoreVolume(options(engine, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_CLEANUP_INCOMPLETE' })
      expect([...engine.containers.values()].some(row => row.name.endsWith('-claim'))).toBe(true)
    }
  })

  it.runIf(process.platform === 'linux')('rebuilds only an incomplete volume bound to the newly acquired claim', async () => {
    const fixture = await sealedFixture(); const engine = new FakeEngine(); engine.attachVolumeToNewClaim = true; engine.materializedPayload = fixture.archive
    await expect(ensureTemplateStoreVolume(options(engine, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).resolves.toMatchObject({ state: 'CREATED' })
    expect(engine.removedVolumes).toHaveLength(1)
  })

  it.runIf(process.platform === 'linux')('retains the witness if an owned incomplete volume cannot be removed', async () => {
    const fixture = await sealedFixture(); const engine = new FakeEngine(); engine.attachVolumeToNewClaim = true; engine.keepVolume = true
    await expect(ensureTemplateStoreVolume(options(engine, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_CLEANUP_INCOMPLETE' })
    expect(engine.volumes.size).toBe(1); expect([...engine.containers.values()].some(row => row.name.endsWith('-claim'))).toBe(true)
  })

  it.runIf(process.platform === 'linux')('rejects an invalid completed upload and a create failure with no volume', async () => {
    const fixture = await sealedFixture()
    const invalidUpload = new FakeEngine(); invalidUpload.materializedPayload = dockerTar([dir('template-store/'), dir('template-store/tree/')])
    await expect(ensureTemplateStoreVolume(options(invalidUpload, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_INVALID' })
    expect(invalidUpload.volumes.size).toBe(0)

    const createFailure = new FakeEngine(); createFailure.fail('createVolume', 1)
    await expect(ensureTemplateStoreVolume(options(createFailure, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).rejects.toThrow('createVolume-fault')
    expect(createFailure.volumes.size).toBe(0); expect(createFailure.containers.size).toBe(0)
  })

  it.runIf(process.platform === 'linux')('distinguishes foreign rollback state from an owned identity mutation', async () => {
    const fixture = await sealedFixture()
    const foreign = new FakeEngine(); foreign.materializedPayload = fixture.archive; foreign.failAfterTree = 'foreign-nonce'
    await expect(ensureTemplateStoreVolume(options(foreign, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).rejects.toThrow('tree-upload-fault')
    expect(foreign.volumes.size).toBe(1); expect(foreign.containers.size).toBe(0)

    const mutated = new FakeEngine(); mutated.materializedPayload = fixture.archive; mutated.failAfterTree = 'identity-mismatch'
    await expect(ensureTemplateStoreVolume(options(mutated, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_CLEANUP_INCOMPLETE' })
    expect([...mutated.containers.values()].some(row => row.name.endsWith('-claim'))).toBe(true)
  })

  it.runIf(process.platform === 'linux')('fails closed when a transporter remains visible after cleanup', async () => {
    const fixture = await sealedFixture(); const engine = new FakeEngine(); engine.materializedPayload = fixture.archive; engine.keepTransporter = true
    await expect(ensureTemplateStoreVolume(options(engine, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_CLEANUP_INCOMPLETE' })
    expect([...engine.containers.values()].some(row => row.name.includes('-transport-'))).toBe(true)
  })

  it('rejects verifier target mismatch, acquisition faults, aborts and cleanup uncertainty', async () => {
    const fixture = manifestFixture(); const name = templateStoreVolumeName(installationId, scopeId, 'v1.0.0', fixture.manifest.tree_sha256)
    await expect(verifyTemplateStoreVolume({ ...verifyOptions(existingEngine(fixture.manifest, fixture.archive), fixture.manifest), volumeName: `${name}-wrong` }, AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_INVALID' })

    const acquisition = existingEngine(fixture.manifest, fixture.archive); acquisition.fail('startContainer', 1)
    await expect(verifyTemplateStoreVolume(verifyOptions(acquisition, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toThrow('startContainer-fault')

    const aborted = new AbortController(); const aborting = existingEngine(fixture.manifest, fixture.archive); aborting.abortOnStart = true
    const verification = verifyTemplateStoreVolume(verifyOptions(aborting, fixture.manifest), aborted.signal); aborting.abortController = aborted
    await expect(verification).rejects.toMatchObject({ code: 'TEMPLATE_STORE_ABORTED' })

    const cleanup = existingEngine(fixture.manifest, fixture.archive); cleanup.fail('stopContainer', 1)
    await expect(verifyTemplateStoreVolume(verifyOptions(cleanup, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_CLEANUP_INCOMPLETE' })

    const missing = new FakeEngine()
    await expect(verifyTemplateStoreVolume(verifyOptions(missing, fixture.manifest), AbortSignal.timeout(2_000))).resolves.toBe(false)

    const download = existingEngine(fixture.manifest, fixture.archive); download.fail('downloadArchive', 1)
    await expect(verifyTemplateStoreVolume(verifyOptions(download, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toThrow('downloadArchive-fault')

    const claimDrift = existingEngine(fixture.manifest, fixture.archive); claimDrift.corruptClaimOnList = true
    await expect(verifyTemplateStoreVolume(verifyOptions(claimDrift, fixture.manifest), AbortSignal.timeout(2_000))).resolves.toBe(false)

    const lingering = existingEngine(fixture.manifest, fixture.archive); lingering.keepTransporter = true
    await expect(verifyTemplateStoreVolume(verifyOptions(lingering, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_CLEANUP_INCOMPLETE' })
  })

  it('fails closed for every malformed stale claim field and ambiguous claim inventory', async () => {
    const fixture = manifestFixture(); const name = templateStoreVolumeName(installationId, scopeId, 'v1.0.0', fixture.manifest.tree_sha256)
    const malformed: Array<(row: NonNullable<ReturnType<FakeEngine['claimRow']>>) => void> = [
      row => { record(row.body.Labels)['dz23.materialization_nonce'] = 7 },
      row => { record(row.body.Labels)['dz23.materialization_nonce'] = 'bad' },
      row => { record(row.body.Labels)['dz23.materialization_expires_at'] = 7 },
      row => { record(row.body.Labels)['dz23.materialization_expires_at'] = '01' },
      row => { record(row.body.Labels)['com.dz23.studio.scope-id'] = otherScope },
    ]
    for (const mutate of malformed) {
      const engine = new FakeEngine(); engine.seedClaim(name, fixture.manifest, 'e'.repeat(32), 'dead', Date.now() - 1); mutate(engine.claimRow()!)
      await expect(verifyTemplateStoreVolume(verifyOptions(engine, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_TARGET_MISMATCH' })
      expect(engine.containers.size).toBe(1)
    }

    const hidden = new FakeEngine(); hidden.seedClaim(name, fixture.manifest, 'e'.repeat(32), 'dead', Date.now() - 1); hidden.hideClaimOnList = true
    await expect(verifyTemplateStoreVolume(verifyOptions(hidden, fixture.manifest), AbortSignal.timeout(2_000))).resolves.toBe(false)

    const withoutId = new FakeEngine(); withoutId.seedClaim(name, fixture.manifest, 'e'.repeat(32), 'dead', Date.now() - 1); withoutId.omitContainerId = true
    await expect(verifyTemplateStoreVolume(verifyOptions(withoutId, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_TARGET_MISMATCH' })

    for (const transform of [
      (rows: Array<Record<string, unknown>>) => [...rows, ...rows],
      (rows: Array<Record<string, unknown>>) => [...rows, { Id: 'a'.repeat(12), Names: ['/hostile'], State: 'dead', Labels: {} }],
      (_rows: Array<Record<string, unknown>>) => [[] as unknown as Record<string, unknown>],
    ]) {
      const engine = new FakeEngine(); engine.seedClaim(name, fixture.manifest, 'e'.repeat(32), 'dead', Date.now() - 1); engine.containerListTransform = transform
      await expect(verifyTemplateStoreVolume(verifyOptions(engine, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_TARGET_MISMATCH' })
    }
    const named = new FakeEngine(); named.seedClaim(name, fixture.manifest, 'e'.repeat(32), 'dead', Date.now() - 1); named.containerListTransform = rows => rows.map(row => { const { Id: _id, ...rest } = row; return { ...rest, Name: `/${name}-claim` } })
    await expect(verifyTemplateStoreVolume(verifyOptions(named, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_CLEANUP_INCOMPLETE' })
  })

  it('retains expired recovery witnesses until stale volumes, transporters and claims are proved absent', async () => {
    const fixture = manifestFixture(); const name = templateStoreVolumeName(installationId, scopeId, 'v1.0.0', fixture.manifest.tree_sha256); const nonce = 'e'.repeat(32)

    const hostileVolume = new FakeEngine(); hostileVolume.seedClaim(name, fixture.manifest, nonce, 'dead', Date.now() - 1); hostileVolume.volumes.set(name, { Name: name, Labels: { 'dz23.managed': 'hostile' } })
    await expect(verifyTemplateStoreVolume(verifyOptions(hostileVolume, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_TARGET_MISMATCH' })

    const persistentVolume = new FakeEngine(); persistentVolume.seedClaim(name, fixture.manifest, nonce, 'dead', Date.now() - 1); persistentVolume.volumes.set(name, { Name: name, Labels: { ...templateStoreVolumeLabels(identity(fixture.manifest)), 'dz23.materialization_nonce': nonce } }); persistentVolume.keepVolume = true
    await expect(verifyTemplateStoreVolume(verifyOptions(persistentVolume, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_CLEANUP_INCOMPLETE' })

    const persistentClaim = new FakeEngine(); persistentClaim.seedClaim(name, fixture.manifest, nonce, 'dead', Date.now() - 1); persistentClaim.keepClaim = true
    await expect(verifyTemplateStoreVolume(verifyOptions(persistentClaim, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_CLEANUP_INCOMPLETE' })

    const persistentTransporter = new FakeEngine(); persistentTransporter.seedClaim(name, fixture.manifest, nonce, 'dead', Date.now() - 1); persistentTransporter.seedTransporter(name, fixture.manifest, nonce); persistentTransporter.keepTransporter = true
    await expect(verifyTemplateStoreVolume(verifyOptions(persistentTransporter, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_CLEANUP_INCOMPLETE' })

    const releasePersistent = new FakeEngine(); releasePersistent.keepClaim = true
    await expect(verifyTemplateStoreVolume(verifyOptions(releasePersistent, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_CLEANUP_INCOMPLETE' })

    const forgedCleanup = existingEngine(fixture.manifest, fixture.archive); forgedCleanup.keepTransporter = true; forgedCleanup.corruptTransporterOnList = true
    await expect(verifyTemplateStoreVolume(verifyOptions(forgedCleanup, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_CLEANUP_INCOMPLETE' })

    const volumeGenerationDrift = existingEngine(fixture.manifest, fixture.archive)
    volumeGenerationDrift.afterEmptyDownload = async () => { volumeGenerationDrift.volumes.values().next().value!.Labels['dz23.materialization_nonce'] = 'b'.repeat(32) }
    await expect(verifyTemplateStoreVolume(verifyOptions(volumeGenerationDrift, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_CLEANUP_INCOMPLETE' })
    expect([...volumeGenerationDrift.containers.values()].some(row => row.name.endsWith('-claim'))).toBe(true)
  })

  it('refuses an ambiguous set of stale transporters without removing any witness', async () => {
    const fixture = manifestFixture(); const engine = new FakeEngine(); const name = templateStoreVolumeName(installationId, scopeId, 'v1.0.0', fixture.manifest.tree_sha256); const nonce = 'e'.repeat(32)
    engine.seedClaim(name, fixture.manifest, nonce, 'dead', Date.now() - 1); engine.seedTransporter(name, fixture.manifest, nonce)
    const first = engine.containers.get('c'.repeat(12))!
    engine.containers.set('d'.repeat(12), { ...first, name: `${name}-transport-${'e'.repeat(8)}`, body: { ...first.body, Labels: { ...record(first.body.Labels) } } })
    await expect(verifyTemplateStoreVolume(verifyOptions(engine, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_TARGET_MISMATCH' })
    expect(engine.containers.has('c'.repeat(12))).toBe(true); expect(engine.containers.has('d'.repeat(12))).toBe(true); expect(engine.claimRow()).toBeDefined()
  })

  it('normalizes aborted acquisition and verification failures without releasing an unproven claim', async () => {
    const fixture = manifestFixture()
    const acquisitionController = new AbortController(); const acquisition = new FakeEngine(); acquisition.abortOnStart = true; acquisition.abortController = acquisitionController; acquisition.startError = new Error('start-after-abort')
    await expect(verifyTemplateStoreVolume(verifyOptions(acquisition, fixture.manifest), acquisitionController.signal)).rejects.toMatchObject({ code: 'TEMPLATE_STORE_ABORTED' })

    const missingClaim = existingEngine(fixture.manifest, fixture.archive); missingClaim.hideClaimOnList = true
    await expect(verifyTemplateStoreVolume(verifyOptions(missingClaim, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_CLEANUP_INCOMPLETE' })
    expect([...missingClaim.containers.values()].some(row => row.name.endsWith('-claim'))).toBe(true)

    const internalCreate = existingEngine(fixture.manifest, fixture.archive); internalCreate.fail('createContainer', 2)
    await expect(verifyTemplateStoreVolume(verifyOptions(internalCreate, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toThrow('createContainer-fault')

    const committedCreate = existingEngine(fixture.manifest, fixture.archive); committedCreate.createTransporterThenThrow = true
    await expect(verifyTemplateStoreVolume(verifyOptions(committedCreate, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toThrow('create failed after commit')
    expect([...committedCreate.containers.values()].some(row => row.name.includes('-transport-'))).toBe(false)
    expect([...committedCreate.containers.values()].some(row => row.name.endsWith('-claim'))).toBe(false)

    const uncertainCommittedCreate = existingEngine(fixture.manifest, fixture.archive); uncertainCommittedCreate.createTransporterThenThrow = true; uncertainCommittedCreate.keepTransporter = true
    await expect(verifyTemplateStoreVolume(verifyOptions(uncertainCommittedCreate, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_CLEANUP_INCOMPLETE' })
    expect([...uncertainCommittedCreate.containers.values()].some(row => row.name.includes('-transport-'))).toBe(true)
    expect([...uncertainCommittedCreate.containers.values()].some(row => row.name.endsWith('-claim'))).toBe(true)

    for (const mutateTransporter of [
      (row: Record<string, unknown>) => { const { Id: _id, ...rest } = row; return rest },
      (row: Record<string, unknown>) => ({ ...row, Id: 'invalid-id' }),
      (row: Record<string, unknown>) => ({ ...row, Id: 'e'.repeat(12) }),
    ]) {
      const unproved = existingEngine(fixture.manifest, fixture.archive)
      unproved.containerListTransform = rows => rows.map(row => Array.isArray(row.Names) && row.Names.some(value => typeof value === 'string' && value.includes('-transport-')) ? mutateTransporter(row) : row)
      await expect(verifyTemplateStoreVolume(verifyOptions(unproved, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_CLEANUP_INCOMPLETE' })
      expect([...unproved.containers.values()].some(row => row.name.includes('-transport-'))).toBe(true)
      expect([...unproved.containers.values()].some(row => row.name.endsWith('-claim'))).toBe(true)
    }

    const acquisitionCreate = new FakeEngine(); acquisitionCreate.fail('createContainer', 1)
    await expect(verifyTemplateStoreVolume(verifyOptions(acquisitionCreate, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toThrow('createContainer-fault')

    const typed = existingEngine(fixture.manifest, fixture.archive); typed.startError = new TemplateStoreVolumeError('TEMPLATE_STORE_INVALID'); typed.startErrorAt = 2
    await expect(verifyTemplateStoreVolume(verifyOptions(typed, fixture.manifest), AbortSignal.timeout(2_000))).resolves.toBe(false)

    const primitive = existingEngine(fixture.manifest, fixture.archive); primitive.startError = 7; primitive.startErrorAt = 2
    await expect(verifyTemplateStoreVolume(verifyOptions(primitive, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_INVALID' })
  })

  it('bounds verification below the claim TTL and does not let a concurrent verifier steal its generation', async () => {
    expect(TEMPLATE_STORE_VERIFICATION_TIMEOUT_MS + TEMPLATE_STORE_VERIFICATION_CLEANUP_BUDGET_MS).toBeLessThan(TEMPLATE_STORE_CLAIM_TTL_MS)
    const fixture = manifestFixture(); const engine = existingEngine(fixture.manifest, fixture.archive); engine.blockDownloadUntilAbort = true
    const deadline = new AbortController(); const startedAt = 1_800_000_000_000
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementationOnce(milliseconds => {
      expect(milliseconds).toBe(TEMPLATE_STORE_VERIFICATION_TIMEOUT_MS)
      return deadline.signal
    })
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(startedAt)
    try {
      const first = verifyTemplateStoreVolume(verifyOptions(engine, fixture.manifest), new AbortController().signal)
      await vi.waitFor(() => expect(engine.downloads).toEqual(['/template-store']))
      nowSpy.mockReturnValue(startedAt + TEMPLATE_STORE_VERIFICATION_TIMEOUT_MS - 1)
      await expect(verifyTemplateStoreVolume(verifyOptions(engine, fixture.manifest), new AbortController().signal)).resolves.toBe(false)
      expect([...engine.containers.values()].filter(row => row.name.endsWith('-claim'))).toHaveLength(1)
      deadline.abort()
      await expect(first).rejects.toMatchObject({ code: 'TEMPLATE_STORE_ABORTED' })
      expect([...engine.containers.values()].some(row => row.name.includes('-transport-'))).toBe(false)
      expect([...engine.containers.values()].some(row => row.name.endsWith('-claim'))).toBe(false)
      expect(engine.volumes.size).toBe(1)
    } finally {
      nowSpy.mockRestore(); timeoutSpy.mockRestore()
    }
  })

  it.runIf(process.platform === 'linux')('cleans a staging directory when the sealed source changes after the empty-volume proof', async () => {
    const fixture = await sealedFixture(); const engine = new FakeEngine()
    engine.afterEmptyDownload = async () => { await chmod(join(fixture.root, 'tree', 'pkg', 'package.json'), 0o600) }
    await expect(ensureTemplateStoreVolume(options(engine, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).rejects.toThrow('INVALID_TEMPLATE_STORE')
    expect(engine.volumes.size).toBe(0); expect(engine.containers.size).toBe(0)
  })

  it.runIf(process.platform === 'linux')('writes deterministic padding boundaries and rejects same-size source drift before upload', async () => {
    const fixture = await sealedRootFilesFixture([{ path: 'a.bin', content: Buffer.alloc(512, 0x61) }, { path: 'b.txt', content: Buffer.from('b') }])
    const engine = new FakeEngine(); engine.materializedPayload = fixture.archive
    await expect(ensureTemplateStoreVolume(options(engine, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).resolves.toMatchObject({ state: 'CREATED' })

    const drift = new FakeEngine(); drift.afterEmptyDownload = async () => { const filePath = join(fixture.root, 'tree', 'a.bin'); await chmod(filePath, 0o600); await writeFile(filePath, Buffer.alloc(512, 0x62)); await chmod(filePath, 0o444) }
    await expect(ensureTemplateStoreVolume(options(drift, fixture.root, fixture.manifest), AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_TARGET_MISMATCH' })

    const sizeFixture = await sealedFixture(); const sizeDrift = new FakeEngine(); sizeDrift.afterEmptyDownload = async () => { const filePath = join(sizeFixture.root, 'tree', 'pkg', 'package.json'); await chmod(filePath, 0o600); await writeFile(filePath, 'short'); await chmod(filePath, 0o444) }
    await expect(ensureTemplateStoreVolume(options(sizeDrift, sizeFixture.root, sizeFixture.manifest), AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_TARGET_MISMATCH' })
  })

  it.runIf(process.platform === 'linux')('rejects unsafe sealed envelopes and detects source content changes before upload', async () => {
    const fixture = await sealedFixture()
    await expect(ensureTemplateStoreVolume(options(new FakeEngine(), `${fixture.root}-missing`, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_INVALID' })
    const controller = new AbortController(); const interrupted = ensureTemplateStoreVolume(options(new FakeEngine(), fixture.root, fixture.manifest), controller.signal); queueMicrotask(() => controller.abort())
    await expect(interrupted).rejects.toMatchObject({ code: 'TEMPLATE_STORE_ABORTED' })
    await chmod(join(fixture.root, '.complete'), 0o644)
    await expect(ensureTemplateStoreVolume(options(new FakeEngine(), fixture.root, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toBeInstanceOf(TemplateStoreVolumeError)
    await chmod(join(fixture.root, '.complete'), 0o444)
    await chmod(join(fixture.root, 'tree', 'pkg', 'package.json'), 0o644)
    await expect(ensureTemplateStoreVolume(options(new FakeEngine(), fixture.root, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toBeInstanceOf(TemplateStoreVolumeError)
  })

  it.runIf(process.platform === 'linux')('rejects aliased roots, structural drift, marker drift and special filesystem nodes', async () => {
    const fixture = await sealedFixture()
    const aliasParent = `${fixture.root}-parent`; await symlink(tmpdir(), aliasParent, 'dir'); roots.push(aliasParent); const alias = join(aliasParent, basename(fixture.root)).replaceAll('\\', '/')
    await expect(ensureTemplateStoreVolume(options(new FakeEngine(), alias, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_INVALID' })

    await chmod(fixture.root, 0o755); await writeFile(join(fixture.root, 'extra'), '', { mode: 0o444 }); await chmod(fixture.root, 0o555)
    await expect(ensureTemplateStoreVolume(options(new FakeEngine(), fixture.root, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_TARGET_MISMATCH' })
    await chmod(fixture.root, 0o755); await rm(join(fixture.root, 'extra')); await chmod(join(fixture.root, '.complete'), 0o600); await writeFile(join(fixture.root, '.complete'), 'short\n'); await chmod(join(fixture.root, '.complete'), 0o444); await chmod(fixture.root, 0o555)
    await expect(ensureTemplateStoreVolume(options(new FakeEngine(), fixture.root, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_TARGET_MISMATCH' })
    await chmod(fixture.root, 0o755); await chmod(join(fixture.root, '.complete'), 0o600); await writeFile(join(fixture.root, '.complete'), `${'f'.repeat(64)}\n`); await chmod(join(fixture.root, '.complete'), 0o444); await chmod(fixture.root, 0o555)
    await expect(ensureTemplateStoreVolume(options(new FakeEngine(), fixture.root, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_TARGET_MISMATCH' })

    await chmod(fixture.root, 0o755); await chmod(join(fixture.root, '.complete'), 0o600); await writeFile(join(fixture.root, '.complete'), `${fixture.manifest.tree_sha256}\n`); await chmod(join(fixture.root, '.complete'), 0o444)
    await chmod(join(fixture.root, 'tree'), 0o755); await execFileAsync('/usr/bin/mkfifo', [join(fixture.root, 'tree', 'pipe')]); await chmod(join(fixture.root, 'tree'), 0o555); await chmod(fixture.root, 0o555)
    await expect(ensureTemplateStoreVolume(options(new FakeEngine(), fixture.root, fixture.manifest), AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_INVALID' })

    const symlinkFixture = await sealedFixture(); await chmod(join(symlinkFixture.root, 'tree', 'pkg'), 0o755); await symlink(join(symlinkFixture.root, 'tree', 'pkg', 'package.json'), join(symlinkFixture.root, 'tree', 'pkg', 'alias')); await chmod(join(symlinkFixture.root, 'tree', 'pkg'), 0o555)
    await expect(ensureTemplateStoreVolume(options(new FakeEngine(), symlinkFixture.root, symlinkFixture.manifest), AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_INVALID' })

    const oversizedFixture = await sealedFixture(); const oversized = join(oversizedFixture.root, 'tree', 'oversized'); await chmod(join(oversizedFixture.root, 'tree'), 0o755); await writeFile(oversized, ''); await truncate(oversized, TEMPLATE_ENTRY_MAX_BYTES + 1); await chmod(oversized, 0o444); await chmod(join(oversizedFixture.root, 'tree'), 0o555)
    await expect(ensureTemplateStoreVolume(options(new FakeEngine(), oversizedFixture.root, oversizedFixture.manifest), AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_INVALID' })

    const extraFixture = await sealedFixture(); await chmod(join(extraFixture.root, 'tree'), 0o755); await writeFile(join(extraFixture.root, 'tree', 'extra'), 'x', { mode: 0o444 }); await chmod(join(extraFixture.root, 'tree', 'extra'), 0o444); await chmod(join(extraFixture.root, 'tree'), 0o555)
    await expect(ensureTemplateStoreVolume(options(new FakeEngine(), extraFixture.root, extraFixture.manifest), AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_TARGET_MISMATCH' })
  })

  it('validates identities, digests, source path and transporter volume binding', async () => {
    const fixture = manifestFixture(); const engine = new FakeEngine(); const good = options(engine, '/safe/store/v1', fixture.manifest)
    await expect(ensureTemplateStoreVolume({ ...good, installationId: 'bad' }, AbortSignal.timeout(1))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_INVALID' })
    await expect(ensureTemplateStoreVolume({ ...good, sourceEnvelope: '../bad' }, AbortSignal.timeout(1))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_INVALID' })
    expect(() => templateStoreTransporterBody(image, identity(fixture.manifest), 'wrong', false)).toThrow('TEMPLATE_STORE_INVALID')
  })

  it('rejects every non-canonical public identity, source and manifest binding before I/O', async () => {
    const fixture = manifestFixture(); const engine = new FakeEngine(); const good = options(engine, '/safe/store/v1', fixture.manifest)
    const invalidIdentities = [
      { ...identity(fixture.manifest), installationId: 'bad' },
      { ...identity(fixture.manifest), scopeId: 'bad' as typeof scopeId },
      { ...identity(fixture.manifest), version: '../v1' },
      { ...identity(fixture.manifest), treeSha256: 'g'.repeat(64) },
    ]
    for (const candidate of invalidIdentities) expect(() => templateStoreVolumeName(candidate.installationId, candidate.scopeId, candidate.version, candidate.treeSha256)).toThrow('TEMPLATE_STORE_INVALID')

    const invalidSources: unknown[] = [1, 'relative', '/', '/safe/../store', '/safe/store/', '/safe\\store', '/safe/\0store']
    for (const sourceEnvelope of invalidSources) {
      await expect(ensureTemplateStoreVolume({ ...good, sourceEnvelope: sourceEnvelope as string }, AbortSignal.timeout(1_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_INVALID' })
    }
    await expect(ensureTemplateStoreVolume({ ...good, imageDigest: 'sha256:bad' }, AbortSignal.timeout(1_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_INVALID' })
    await expect(ensureTemplateStoreVolume({ ...good, version: 'v2.0.0' }, AbortSignal.timeout(1_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_TARGET_MISMATCH' })
    await expect(ensureTemplateStoreVolume({ ...good, treeSha256: 'f'.repeat(64) }, AbortSignal.timeout(1_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_TARGET_MISMATCH' })
  })

  it('rejects malformed archive framing, root structure, names and inner ownership fields', async () => {
    const fixture = manifestFixture(); const payload = fixture.archive
    const invalidSizes = [Number.NaN, 511, 641 * 1024 * 1024, payload.byteLength - 1]
    for (const size of invalidSizes) await expectArchiveInvalid(payload, size)

    const variants: Buffer[] = []
    const mutate = (offset: number, callback: (header: Buffer) => void): void => { variants.push(mutateTarHeader(payload, offset, callback)) }
    mutate(0, header => header.write('xx', 263, 2, 'ascii'))
    mutate(0, header => header.write('link', 157, 4, 'ascii'))
    mutate(0, header => header[0] = 0xff)
    mutate(0, header => header.write('/absolute', 0, 100, 'utf8'))
    mutate(0, header => header.write('./', 0, 100, 'utf8'))
    mutate(0, header => header.write('a//b', 0, 100, 'utf8'))
    mutate(0, header => { header.fill(0, 124, 136); header.write('invalid', 124, 7, 'ascii') })
    mutate(0, header => { header[156] = '0'.charCodeAt(0) })
    mutate(512, header => writeTarOctal(header, 100, 8, 0o755))
    mutate(512, header => writeTarOctal(header, 108, 8, 0))
    mutate(512, header => writeTarOctal(header, 116, 8, 0))
    mutate(512, header => { header[156] = '0'.charCodeAt(0) })
    mutate(1024, header => writeTarOctal(header, 100, 8, 0o444))
    mutate(1024, header => writeTarOctal(header, 108, 8, 0))
    mutate(1024, header => writeTarOctal(header, 116, 8, 0))
    mutate(1536, header => writeTarOctal(header, 100, 8, 0o555))
    mutate(1536, header => writeTarOctal(header, 108, 8, 0))
    mutate(1536, header => writeTarOctal(header, 116, 8, 0))
    mutate(2560, header => writeTarOctal(header, 100, 8, 0o555))
    mutate(2560, header => writeTarOctal(header, 108, 8, 0))
    mutate(2560, header => writeTarOctal(header, 116, 8, 0))
    mutate(2560, header => writeTarOctal(header, 124, 12, 64))
    mutate(2560, header => { header[156] = '5'.charCodeAt(0) })
    variants.push(dockerTar([dir('template-store/'), dir('template-store/'), dir('template-store/tree/')]))
    variants.push(dockerTar([dir('template-store/'), dir('template-store/tree/'), dir('template-store/tree/')]))
    variants.push(dockerTar([dir('template-store/'), dir('template-store/tree/'), file('template-store/.complete', `${fixture.manifest.tree_sha256}\n`), file('template-store/.complete', `${fixture.manifest.tree_sha256}\n`)]))
    variants.push(dockerTar([dir('template-store/'), dir('tree/')]))
    const secondTerminatorCorrupt = Buffer.from(payload); secondTerminatorCorrupt[secondTerminatorCorrupt.byteLength - 512] = 1; variants.push(secondTerminatorCorrupt)
    const trailingCorrupt = Buffer.concat([payload, Buffer.alloc(512)]); trailingCorrupt[trailingCorrupt.byteLength - 1] = 1; variants.push(trailingCorrupt)
    for (const variant of variants) await expectArchiveInvalid(variant)

    const withTrailingZeros = Buffer.concat([payload, Buffer.alloc(1024)])
    await expect(validateTemplateStoreArchive(shortReader(withTrailingZeros, 512) as Pick<FileHandle, 'read'>, withTrailingZeros.byteLength, 'v1.0.0', fixture.manifest.tree_sha256, false, AbortSignal.timeout(2_000))).resolves.toBe(true)
    await expectArchiveInvalidWithReader(shortReader(payload.subarray(0, payload.byteLength - 512), 512), payload.byteLength)

    const nulType = mutateTarHeader(payload, 1536, header => { header[156] = 0 })
    await expect(validateTemplateStoreArchive(shortReader(nulType, 512) as Pick<FileHandle, 'read'>, nulType.byteLength, 'v1.0.0', fixture.manifest.tree_sha256, false, AbortSignal.timeout(2_000))).resolves.toBe(true)
    const exactName = 'x'.repeat(80); const exactContent = Buffer.from('x'); const exactEntries: TemplateManifestEntry[] = [{ path: exactName, type: 'file', bytes: 1, sha256: sha(exactContent) }]; const exactSha = computeTemplateTreeSha256('v1.0.0', exactEntries); const exactArchive = dockerTar([dir('template-store/'), dir('template-store/tree/'), { name: `template-store/tree/${exactName}`, type: '0', value: exactContent }, file('template-store/.complete', `${exactSha}\n`)])
    await expect(validateTemplateStoreArchive(shortReader(exactArchive, 512) as Pick<FileHandle, 'read'>, exactArchive.byteLength, 'v1.0.0', exactSha, false, AbortSignal.timeout(2_000))).resolves.toBe(true)
    const longDirectory = 'a'.repeat(90); const longPath = `${longDirectory}/${'b'.repeat(90)}`; const longContent = Buffer.from('long'); const longEntries: TemplateManifestEntry[] = [{ path: longDirectory, type: 'directory' }, { path: longPath, type: 'file', bytes: longContent.byteLength, sha256: sha(longContent) }]; const longSha = computeTemplateTreeSha256('v1.0.0', longEntries); const longArchive = dockerTar([dir('template-store/'), dir('template-store/tree/'), dir(`template-store/tree/${longDirectory}/`), { name: `template-store/tree/${longPath}`, type: '0', value: longContent }, file('template-store/.complete', `${longSha}\n`)])
    expect(templateStoreUstarEntryPath(longPath)).toHaveLength(181)
    await expect(validateTemplateStoreArchive(shortReader(longArchive, 512) as Pick<FileHandle, 'read'>, longArchive.byteLength, 'v1.0.0', longSha, false, AbortSignal.timeout(2_000))).resolves.toBe(true)

    await expectArchiveInvalidWithReader(shortReader(payload, 512), 3_072)
    const noTerminator = payload.subarray(0, payload.byteLength - 1024)
    await expectArchiveInvalid(noTerminator)
    await expectArchiveInvalid(Buffer.alloc(1024))
    const rootAndMarkerOnly = dockerTar([dir('template-store/'), file('template-store/.complete', `${fixture.manifest.tree_sha256}\n`)])
    await expectArchiveInvalid(rootAndMarkerOnly)
  })

  it('rejects common-manifest paths that cannot be represented by the strict USTAR writer', async () => {
    const path = 'a'.repeat(252); const entry: TemplateManifestEntry = { path, type: 'file', bytes: 0, sha256: sha(Buffer.alloc(0)) }
    const treeSha = computeTemplateTreeSha256('v1.0.0', [entry]); const manifest: TemplateStoreManifest = { version: 1, template_store_version: 'v1.0.0', tree_sha256: treeSha, entries: [entry] }
    expect(() => templateStoreUstarEntryPath(path)).toThrow('TEMPLATE_STORE_INVALID')
    await expect(ensureTemplateStoreVolume({ ...options(new FakeEngine(), '/safe/store/v1', manifest), treeSha256: treeSha }, AbortSignal.timeout(1_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_INVALID' })
  })
})

type FaultOperation = 'createVolume' | 'listVolumes' | 'removeVolume' | 'createContainer' | 'stopContainer' | 'removeContainer' | 'listContainers' | 'startContainer' | 'downloadArchive'

class FakeEngine implements DockerEnginePort {
  readonly volumes = new Map<string, { Name: string; Labels: Record<string, string> }>()
  readonly containers = new Map<string, { name: string; body: Record<string, unknown>; volume?: string; state: string }>()
  readonly createdBodies: Array<{ name: string; body: Record<string, unknown> }> = []
  readonly puts: Array<{ path: string; bytes: Buffer }> = []
  readonly downloads: string[] = []; readonly removedVolumes: string[] = []; readonly removedContainerIds: string[] = []; readonly autoRemovedContainerIds: string[] = []; readonly missingRemoveIds: string[] = []; readonly volumeFilters: Array<Readonly<Record<string, readonly string[]>>> = []
  currentPayload = dockerTar([dir('template-store/')]); materializedPayload?: Buffer; injectExtraName = false; abortAfterTree = false; failRemoveContainer = false; failPostCreateInspect = false; createVolumeThenThrow = false; foreignVolumeNonce?: string
  attachVolumeToNewClaim = false; keepTransporter = false; keepVolume = false; keepClaim = false; corruptClaimOnList = false; failAfterTree?: 'foreign-nonce' | 'identity-mismatch'; abortOnStart = false; abortController?: AbortController
  hideClaimOnList = false; omitContainerId = false; corruptTransporterOnList = false; createTransporterThenThrow = false; startError?: unknown; startErrorAt = 1; afterEmptyDownload?: () => Promise<void>
  reportedDownloadBytesDelta = 0; failDownloadHandleClose = false; blockDownloadStageRemoval = false; blockDownloadUntilAbort = false; downloadStage?: string; restoreDownloadHandle?: () => Promise<void>
  private startCalls = 0
  containerListTransform?: (rows: Array<Record<string, unknown>>) => Array<Record<string, unknown>>
  private throwNextVolumeList = false
  private readonly faultCalls = new Map<FaultOperation, Set<number>>()
  private readonly operationCalls = new Map<FaultOperation, number>()
  readonly failRemoveIds = new Set<string>()
  volumeGate?: Promise<void>
  afterContainerRemoval?: () => void
  beforeClaimCreate?: () => void
  async ping(): Promise<void> {}
  fail(operation: FaultOperation, call: number): void { const calls = this.faultCalls.get(operation) ?? new Set<number>(); calls.add(call); this.faultCalls.set(operation, calls) }
  private fault(operation: FaultOperation): void { const call = (this.operationCalls.get(operation) ?? 0) + 1; this.operationCalls.set(operation, call); if (this.faultCalls.get(operation)?.has(call) === true) throw new Error(`${operation}-fault`) }
  async inspectImage(digest: string): Promise<{ readonly Id: string }> { return { Id: digest } }
  async createVolume(name: string, labels: Readonly<Record<string, string>>): Promise<void> { this.fault('createVolume'); await this.volumeGate; if (!this.volumes.has(name)) this.volumes.set(name, { Name: name, Labels: { ...labels, ...(this.foreignVolumeNonce === undefined ? {} : { 'dz23.materialization_nonce': this.foreignVolumeNonce }) } }); if (this.failPostCreateInspect) this.throwNextVolumeList = true; if (this.createVolumeThenThrow) throw new Error('create failed after commit') }
  async removeVolume(name: string): Promise<void> { this.fault('removeVolume'); this.removedVolumes.push(name); if (!this.keepVolume) this.volumes.delete(name); this.currentPayload = dockerTar([dir('template-store/')]) }
  async listVolumes(filters: Readonly<Record<string, readonly string[]>>): Promise<readonly Record<string, unknown>[]> {
    this.fault('listVolumes')
    if (this.throwNextVolumeList) { this.throwNextVolumeList = false; throw new Error('post-create inspect failed') }
    this.volumeFilters.push(filters); const names = filters.name ?? []; const labels = filters.label ?? []
    const rows = [...this.volumes.values()].filter(row => (names.length === 0 || names.includes(row.Name)) && labels.every(item => { const [key, value] = item.split(/=(.*)/su); return row.Labels[key!] === value }))
    return this.injectExtraName && names.length > 0 ? [...rows, { Name: 'hostile', Labels: {} }] : rows
  }
  async createContainer(name: string, bodyValue: unknown, _signal: AbortSignal): Promise<string> { this.fault('createContainer'); if (name.endsWith('-claim') && this.beforeClaimCreate !== undefined) { const before = this.beforeClaimCreate; delete this.beforeClaimCreate; before() }; if ([...this.containers.values()].some(row => row.name === name)) throw new Error('DOCKER_STATUS_409'); const id = (this.containers.size + 1).toString(16).padStart(12, '0'); const body = record(bodyValue); const mount = (record(body.HostConfig).Mounts as Array<Record<string, unknown>>)[0]; this.createdBodies.push({ name, body }); this.containers.set(id, { name, body, ...(mount === undefined ? {} : { volume: String(mount.Source) }), state: 'created' }); if (this.attachVolumeToNewClaim && name.endsWith('-claim')) { const labels = record(body.Labels); const volume = name.slice(0, -6); this.volumes.set(volume, { Name: volume, Labels: { ...templateStoreVolumeLabels({ installationId: labels['com.dz23.studio.installation-id'], scopeId: labels['com.dz23.studio.scope-id'], version: labels['dz23.template_version'], treeSha256: labels['dz23.template_sha256'] }), 'dz23.materialization_nonce': labels['dz23.materialization_nonce'] } }) }; if (this.createTransporterThenThrow && name.includes('-transport-')) throw new Error('create failed after commit'); return id }
  async putArchive(_container: string, _destination: string, archivePath: string): Promise<void> { const bytes = await readFile(archivePath); this.puts.push({ path: archivePath, bytes }); if (this.puts.length === 1 && this.abortAfterTree) throw new DOMException('aborted', 'AbortError'); if (this.puts.length === 1 && this.failAfterTree !== undefined) { const volume = [...this.volumes.values()][0]; if (volume !== undefined) { if (this.failAfterTree === 'foreign-nonce') volume.Labels['dz23.materialization_nonce'] = 'f'.repeat(32); else volume.Labels['dz23.template_sha256'] = 'f'.repeat(64) }; throw new Error('tree-upload-fault') }; if (this.puts.length % 2 === 0) this.currentPayload = this.materializedPayload ?? dockerArchiveFromUploads(this.puts.slice(-2).map(row => row.bytes)) }
  async startContainer(id: string, _signal: AbortSignal): Promise<void> { this.fault('startContainer'); this.startCalls += 1; if (this.abortOnStart) this.abortController?.abort(); if (this.startError !== undefined && this.startCalls === this.startErrorAt) throw this.startError; const row = this.containers.get(id); if (row !== undefined) row.state = 'running' }
  async waitContainer(): Promise<{ readonly StatusCode: number }> { return { StatusCode: 0 } }
  async containerLogs(): Promise<{ readonly stdout: Buffer; readonly stderr: Buffer }> { return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) } }
  async downloadArchive(_container: string, source: string, destination: FileHandle, _maximumBytes: number, signal: AbortSignal): Promise<{ readonly bytes: number; readonly sha256: string }> {
    this.fault('downloadArchive'); this.downloads.push(source)
    if (this.blockDownloadUntilAbort) await new Promise<never>((_resolve, reject) => {
      if (signal.aborted) reject(new DOMException('aborted', 'AbortError'))
      else signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })
    await destination.writeFile(this.currentPayload); await destination.sync()
    if (this.failDownloadHandleClose) {
      const close = destination.close.bind(destination); let restored = false
      destination.close = async () => { if (!restored) throw new Error('download-close-fault'); await close() }
      this.restoreDownloadHandle = async () => { restored = true; await destination.close() }
    }
    if (this.blockDownloadStageRemoval) { const path = await realpath(`/proc/self/fd/${destination.fd}`); this.downloadStage = dirname(path); await chmod(this.downloadStage, 0o555) }
    if (this.downloads.length === 1) await this.afterEmptyDownload?.()
    return { bytes: this.currentPayload.byteLength + this.reportedDownloadBytesDelta, sha256: sha(this.currentPayload) }
  }
  async stopContainer(id: string): Promise<void> { this.fault('stopContainer'); const row = this.containers.get(id); if (row === undefined) return; if (record(row.body.HostConfig).AutoRemove === true && !this.keepTransporter) { this.autoRemovedContainerIds.push(id); this.containers.delete(id) } else row.state = 'exited' }
  async removeContainer(id: string): Promise<void> { this.fault('removeContainer'); if (!this.containers.has(id)) { this.missingRemoveIds.push(id); return } if (this.keepTransporter && this.containers.get(id)?.name.includes('-transport-') === true) return; if (this.keepClaim && this.containers.get(id)?.name.endsWith('-claim') === true) return; if (this.failRemoveContainer || this.failRemoveIds.has(id)) throw new Error('remove failed'); this.removedContainerIds.push(id); this.containers.delete(id); const after = this.afterContainerRemoval; delete this.afterContainerRemoval; after?.() }
  async listContainers(filters: Readonly<Record<string, readonly string[]>>): Promise<readonly Record<string, unknown>[]> { this.fault('listContainers'); const labels = filters.label ?? []; const names = filters.name ?? []; if (this.corruptClaimOnList && names.some(name => name.endsWith('-claim'))) { const claim = [...this.containers.values()].find(row => row.name.endsWith('-claim')); if (claim !== undefined) record(claim.body.Labels)['dz23.materialization_nonce'] = '0'.repeat(32) }; let rows: Array<Record<string, unknown>> = [...this.containers.entries()].filter(([, row]) => (names.length === 0 || names.includes(row.name)) && labels.every(item => { const [key, value] = item.split(/=(.*)/su); return record(row.body.Labels)[key!] === value })).map(([Id, row]) => ({ ...(this.omitContainerId ? {} : { Id }), Names: [`/${row.name}`], State: row.state, Labels: row.body.Labels })); if (this.hideClaimOnList && names.some(name => name.endsWith('-claim'))) rows = []; if (this.corruptTransporterOnList && names.some(name => name.includes('-transport-')) && rows[0] !== undefined) rows[0] = { ...rows[0], Labels: { ...record(rows[0].Labels), 'dz23.template_sha256': 'f'.repeat(64) } }; return this.containerListTransform?.(rows) ?? rows }
  seedClaim(volumeName: string, manifest: TemplateStoreManifest, nonce: string, state: string, expiresAt: number): void { const name = `${volumeName}-claim`; const id = 'f'.repeat(12); this.containers.set(id, { name, state, body: { Labels: { ...templateStoreVolumeLabels(identity(manifest)), 'dz23.managed': 'builder-template-claim', 'dz23.materialization_nonce': nonce, 'dz23.materialization_expires_at': String(expiresAt) }, HostConfig: { Mounts: [] } } }) }
  claimRow(): { name: string; body: Record<string, unknown>; volume?: string; state: string } | undefined { return [...this.containers.values()].find(row => row.name.endsWith('-claim')) }
  seedTransporter(volumeName: string, manifest: TemplateStoreManifest, nonce: string, state = 'running'): void { const name = `${volumeName}-transport-${'d'.repeat(8)}`; const id = 'c'.repeat(12); this.containers.set(id, { name, state, volume: volumeName, body: { Labels: { 'dz23.managed': 'builder-template-transporter', 'com.dz23.studio.installation-id': installationId, 'com.dz23.studio.scope-id': scopeId, 'dz23.template_version': manifest.template_store_version, 'dz23.template_sha256': manifest.tree_sha256, 'dz23.materialization_nonce': nonce }, HostConfig: { Mounts: [{ Type: 'volume', Source: volumeName, Target: '/template-store' }] } } }) }
  expireClaims(state = 'exited'): void { for (const row of this.containers.values()) if (row.name.endsWith('-claim')) { row.state = state; record(row.body.Labels)['dz23.materialization_expires_at'] = String(Date.now() - 1) } }
  expireAutoRemoveTransporters(): void { for (const [id, row] of [...this.containers]) if (record(row.body.HostConfig).AutoRemove === true && row.name.includes('-transport-')) { this.autoRemovedContainerIds.push(id); this.containers.delete(id) } }
}

function manifestFixture(): { readonly content: string; readonly manifest: TemplateStoreManifest; readonly archive: Buffer } {
  const content = '{"name":"fixture"}\n'; const entries: TemplateManifestEntry[] = [{ path: 'pkg', type: 'directory' }, { path: 'pkg/package.json', type: 'file', bytes: Buffer.byteLength(content), sha256: sha(Buffer.from(content)) }]
  const treeSha = computeTemplateTreeSha256('v1.0.0', entries); const manifest = { version: 1 as const, template_store_version: 'v1.0.0', tree_sha256: treeSha, entries }
  return { content, manifest, archive: dockerTar([dir('template-store/'), dir('template-store/tree/'), dir('template-store/tree/pkg/'), file('template-store/tree/pkg/package.json', content), file('template-store/.complete', `${treeSha}\n`)]) }
}

async function sealedFixture(): Promise<{ readonly root: string; readonly content: string; readonly manifest: TemplateStoreManifest; readonly archive: Buffer }> {
  const fixture = manifestFixture(); const root = await mkdtemp(join(tmpdir(), 'dz23-sealed-store-')); roots.push(root)
  await mkdir(join(root, 'tree', 'pkg'), { recursive: true, mode: 0o755 }); await writeFile(join(root, 'tree', 'pkg', 'package.json'), fixture.content, { mode: 0o444 }); await writeFile(join(root, '.complete'), `${fixture.manifest.tree_sha256}\n`, { mode: 0o444 })
  await chmod(join(root, 'tree', 'pkg', 'package.json'), 0o444); await chmod(join(root, 'tree', 'pkg'), 0o555); await chmod(join(root, 'tree'), 0o555); await chmod(join(root, '.complete'), 0o444); await chmod(root, 0o555)
  return { root: root.replaceAll('\\', '/'), ...fixture }
}

async function sealedRootFilesFixture(files: ReadonlyArray<{ readonly path: string; readonly content: Buffer }>): Promise<{ readonly root: string; readonly manifest: TemplateStoreManifest; readonly archive: Buffer }> {
  const entries: TemplateManifestEntry[] = files.map(fileValue => ({ path: fileValue.path, type: 'file', bytes: fileValue.content.byteLength, sha256: sha(fileValue.content) }))
  const treeSha = computeTemplateTreeSha256('v1.0.0', entries); const manifest: TemplateStoreManifest = { version: 1, template_store_version: 'v1.0.0', tree_sha256: treeSha, entries }
  const root = await mkdtemp(join(tmpdir(), 'dz23-sealed-root-files-')); roots.push(root); await mkdir(join(root, 'tree'), { mode: 0o755 })
  for (const fileValue of files) { await writeFile(join(root, 'tree', fileValue.path), fileValue.content, { mode: 0o444 }); await chmod(join(root, 'tree', fileValue.path), 0o444) }
  await writeFile(join(root, '.complete'), `${treeSha}\n`, { mode: 0o444 }); await chmod(join(root, '.complete'), 0o444); await chmod(join(root, 'tree'), 0o555); await chmod(root, 0o555)
  return { root: root.replaceAll('\\', '/'), manifest, archive: dockerTar([dir('template-store/'), dir('template-store/tree/'), ...files.map(fileValue => ({ name: `template-store/tree/${fileValue.path}`, type: '0', value: fileValue.content })), file('template-store/.complete', `${treeSha}\n`)]) }
}

function identity(manifest: TemplateStoreManifest) { return { installationId, scopeId, version: manifest.template_store_version, treeSha256: manifest.tree_sha256 } }
function options(engine: FakeEngine, sourceEnvelope: string, manifest: TemplateStoreManifest) { return { engine, imageDigest: image, sourceEnvelope, manifest, ...identity(manifest) } }
function verifyOptions(engine: FakeEngine, manifest: TemplateStoreManifest) { return { engine, imageDigest: image, ...identity(manifest) } }
function existingEngine(manifest: TemplateStoreManifest, payload: Buffer): FakeEngine { const engine = new FakeEngine(); const name = templateStoreVolumeName(installationId, scopeId, manifest.template_store_version, manifest.tree_sha256); engine.volumes.set(name, { Name: name, Labels: { ...templateStoreVolumeLabels(identity(manifest)), 'dz23.materialization_nonce': 'a'.repeat(32) } }); engine.currentPayload = payload; return engine }
function sha(value: Buffer): string { return createHash('sha256').update(value).digest('hex') }
function record(value: unknown): Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : {} }

interface TarEntry { readonly name: string; readonly type: string; readonly value: Buffer }
function dir(name: string): TarEntry { return { name, type: '5', value: Buffer.alloc(0) } }
function file(name: string, value: string): TarEntry { return { name, type: '0', value: Buffer.from(value) } }
function special(name: string, type: string): TarEntry { return { name, type, value: Buffer.alloc(0) } }
function dockerTar(entries: readonly TarEntry[]): Buffer { return Buffer.concat([...entries.map(tarEntry), Buffer.alloc(1024)]) }
function tarEntry(entry: TarEntry): Buffer {
  const header = Buffer.alloc(512); const path = entry.name.replace(/\/$/u, ''); let name = path; let prefix = ''
  if (Buffer.byteLength(path) > 100) { const at = path.lastIndexOf('/'); prefix = path.slice(0, at); name = path.slice(at + 1) }
  header.write(name, 0, 100, 'utf8'); header.write(prefix, 345, 155, 'utf8')
  writeTarOctal(header, 100, 8, entry.type === '5' ? 0o555 : 0o444); writeTarOctal(header, 108, 8, 10_001); writeTarOctal(header, 116, 8, 10_001); writeTarOctal(header, 124, 12, entry.value.byteLength); writeTarOctal(header, 136, 12, 0); header.fill(0x20, 148, 156); header[156] = entry.type.charCodeAt(0); header.write('ustar', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii'); writeTarOctal(header, 148, 8, header.reduce((sum, byte) => sum + byte, 0))
  return Buffer.concat([header, entry.value, Buffer.alloc((512 - entry.value.byteLength % 512) % 512)])
}
function writeTarOctal(header: Buffer, offset: number, length: number, value: number): void { header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii') }
function mutateTarHeader(payload: Buffer, headerOffset: number, mutate: (header: Buffer) => void): Buffer {
  const result = Buffer.from(payload); const header = result.subarray(headerOffset, headerOffset + 512); mutate(header); header.fill(0x20, 148, 156); writeTarOctal(header, 148, 8, header.reduce((sum, byte) => sum + byte, 0)); return result
}
function corruptTarChecksum(payload: Buffer): Buffer { const result = Buffer.from(payload); result[0] = result[0]! ^ 1; return result }
function namesInTar(value: Buffer): string[] { const names: string[] = []; let offset = 0; while (offset + 512 <= value.length) { const header = value.subarray(offset, offset + 512); if (header.every(byte => byte === 0)) break; const zero = header.indexOf(0); names.push(header.subarray(0, zero).toString('utf8').replace(/\/$/u, '')); const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/su, '').trim(), 8); offset += 512 + size + (512 - size % 512) % 512 } return names }
function dockerArchiveFromUploads(uploads: readonly Buffer[]): Buffer {
  const entries = uploads.flatMap(entriesInTar).map(entry => ({ ...entry, name: `template-store/${entry.name}` }))
  return dockerTar([dir('template-store/'), ...entries])
}
function entriesInTar(value: Buffer): TarEntry[] {
  const entries: TarEntry[] = []; let offset = 0
  while (offset + 512 <= value.length) {
    const header = value.subarray(offset, offset + 512); if (header.every(byte => byte === 0)) break
    const zero = header.indexOf(0); const name = header.subarray(0, zero).toString('utf8').replace(/\/$/u, ''); const type = String.fromCharCode(header[156] || 48); const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/su, '').trim(), 8); const start = offset + 512
    entries.push({ name, type, value: Buffer.from(value.subarray(start, start + size)) }); offset = start + size + (512 - size % 512) % 512
  }
  return entries
}
async function makeRemovable(path: string): Promise<void> { const stat = await lstat(path).catch(() => undefined); if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) return; await chmod(path, 0o700); for (const entry of await readdir(path, { withFileTypes: true })) { const child = join(path, entry.name); if (entry.isDirectory()) await makeRemovable(child); else await chmod(child, 0o600).catch(() => undefined) } }
function shortReader(source: Buffer, maximum: number): { read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number; buffer: Buffer }> } { return { async read(buffer, offset, length, position) { const bytesRead = Math.min(maximum, length, Math.max(0, source.byteLength - position)); if (bytesRead > 0) source.copy(buffer, offset, position, position + bytesRead); return { bytesRead, buffer } } } }
async function expectArchiveInvalid(payload: Buffer, size = payload.byteLength): Promise<void> { await expectArchiveInvalidWithReader(shortReader(payload, 512), size) }
async function expectArchiveInvalidWithReader(reader: ReturnType<typeof shortReader>, size: number): Promise<void> { await expect(validateTemplateStoreArchive(reader as Pick<FileHandle, 'read'>, size, 'v1.0.0', '0'.repeat(64), false, AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'TEMPLATE_STORE_INVALID' }) }
