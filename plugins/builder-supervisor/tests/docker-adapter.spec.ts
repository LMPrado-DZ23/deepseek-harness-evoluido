import { EXPORTACAO_PRONTA } from '../src/export-script.ts'
import { createHash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_BUILDER_LIMITS, DockerBuilderAdapter, STORE_REVERIFY_MS, builderPolicySha256 } from '../src/docker-adapter.js'
import type { DockerEnginePort } from '../src/docker-engine.js'
import { openManagedExportArchive } from '../src/export-artifact.js'
import { deriveBuilderRuntimeScopeId } from '../src/runtime-scope.js'
import { computeTemplateTreeSha256, type TemplateManifestEntry } from '../src/store-security.js'
import { templateStoreVolumeName } from '../src/template-store-volume.js'

const image = `sha256:${'a'.repeat(64)}` as const
const installationId = '1'.repeat(64)
const scopeId = deriveBuilderRuntimeScopeId({ installationId, tenantId: 'tenant-one', instanceId: 'test-instance' })
const templateVersion = 'nextjs-app@1'
const templateContent = 'offline-store'
const templateEntries: TemplateManifestEntry[] = [{ path: 'store.txt', type: 'file', bytes: Buffer.byteLength(templateContent), sha256: createHash('sha256').update(templateContent).digest('hex') }]
const templateStoreSha256 = computeTemplateTreeSha256(templateVersion, templateEntries)
const buildRef = `build_${'b'.repeat(32)}`
const artifact = { archivePath: '/tmp/dz23-input.tar', archiveBytes: 1_024, sha256: 'c'.repeat(64), files: 1, bytes: 1 }

describe('server-authoritative Docker builder adapter', () => {
  it('streams a claimed inode through the handle-only ingress path and fails closed without support', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-handle-')); const path = join(root, 'input.tar'); await writeFile(path, 'x')
    const handle = await open(path, 'r')
    try {
      const engine = new FakeEngine()
      await create(engine).prepare(buildRef, 'handle-run', { ...artifact, archivePath: path, archiveHandle: handle }, new AbortController().signal)
      expect(engine.handleArchives).toBe(1)
      const unsupported = new FakeEngine()
      Object.defineProperty(unsupported, 'putArchiveHandle', { value: undefined })
      await expect(create(unsupported).prepare(buildRef, 'unsupported', { ...artifact, archivePath: path, archiveHandle: handle }, new AbortController().signal)).rejects.toThrow('RECOVERY_FAILED')
    } finally { await handle.close(); await rm(root, { recursive: true, force: true }) }
  })
  it('os arquivos entram com a âncora RODANDO, senão somem debaixo do tmpfs da área de trabalho', async () => {
    const engine = new FakeEngine()
    await create(engine).prepare(buildRef, 'run-tmpfs', artifact, new AbortController().signal)
    expect(engine.archives.filter(row => row.destination === '/workspace')).toHaveLength(1)
    expect(engine.archivesLostUnderTmpfs).toBe(0)
  })

  it('mounts the validated volume root read-only and installs from its materialized tree', async () => {
    const engine = new FakeEngine()
    const adapter = create(engine)
    const signal = new AbortController().signal

    await expect(adapter.preflight(signal)).resolves.toMatchObject({ state: 'OK', protocol_version: 1, scope_id: scopeId, image_id: image, policy_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    await adapter.prepare(buildRef, 'run-1', { ...artifact, command: 'curl attacker', image: 'evil', mount: '/', env: ['SECRET'] } as never, signal)
    const result = await adapter.execute(buildRef, 'install', signal)

    expect(result).toEqual({ exit_code: 0, stdout: 'clean output', stderr: '', timed_out: false, termination_reason: null, output_limit_exceeded: false })
    expect(engine.inspected).toEqual([image])
    expect(engine.archives).toEqual([{ destination: '/workspace', bytes: 1_024 }])
    expect(engine.volumeOptions).toEqual([{ type: 'tmpfs', device: 'tmpfs', o: 'size=67108864,uid=10001,gid=10001,mode=0700' }])
    const stager = engine.created.find(row => labels(row.body)['dz23.role'] === 'anchor')?.body
    const step = engine.created.find(row => labels(row.body)['dz23.role'] === 'step')?.body
    const verifier = engine.created.find(row => labels(row.body)['dz23.managed'] === 'builder-template-transporter')?.body
    expect(stager).toMatchObject({ Image: image, Cmd: ['sleep', 'infinity'], User: '10001:10001', NetworkDisabled: true })
    expect(step).toMatchObject({
      Image: image,
      Cmd: ['pnpm', 'install', '--offline', '--frozen-store', '--frozen-lockfile', '--trust-lockfile', '--ignore-scripts', '--store-dir', '/template-store/tree'],
      WorkingDir: '/workspace', User: '10001:10001', NetworkDisabled: true,
      Env: ['CI=true', 'HOME=/tmp', 'XDG_CONFIG_HOME=/tmp/.config', 'NEXT_TELEMETRY_DISABLED=1'],
    })
    expect(JSON.stringify(engine.created)).not.toMatch(/curl attacker|SECRET|"evil"/u)
    assertTransportHardened(verifier); assertHardened(stager); assertHardened(step)
    expect(host(verifier).Mounts).toEqual([{ Type: 'volume', Source: templateVolume(), Target: '/template-store', ReadOnly: true }])
    expect(host(step).Mounts).toEqual([
      expect.objectContaining({ Type: 'volume', Target: '/workspace', ReadOnly: false }),
      { Type: 'volume', Source: templateVolume(), Target: '/template-store', ReadOnly: true },
    ])
    expect(await adapter.listManaged(signal)).toEqual([buildRef])
    expect(JSON.stringify(engine.created)).not.toContain('"Type":"bind"')
    await adapter.cleanup(buildRef, signal)
    expect(await adapter.listManaged(signal)).toEqual([])
  })

  it('uses only installation plus opaque scope in Docker labels, filters and names', async () => {
    const engine = new FakeEngine(); const signal = new AbortController().signal
    const otherScope = deriveBuilderRuntimeScopeId({ installationId, tenantId: 'tenant-two', instanceId: 'test-instance' })
    engine.containers.push({ Id: 'foreign', Labels: { 'dz23.managed': 'builder', ...physicalIdentityLabels(otherScope), 'dz23.build_ref': buildRef, 'dz23.build_id': 'foreign-run' } })
    const listContainers = vi.spyOn(engine, 'listContainers')
    const adapter = create(engine)

    await expect(adapter.reconcile([], signal)).resolves.toEqual([])
    expect(listContainers).toHaveBeenCalledWith({ label: [
      'dz23.managed=builder',
      `com.dz23.studio.installation-id=${installationId}`,
      `com.dz23.studio.scope-id=${scopeId}`,
    ] }, signal)
    await adapter.prepare(buildRef, 'owned-run', artifact, signal)
    const owned = engine.created.filter(row => labels(row.body)['com.dz23.studio.scope-id'] === scopeId)
    expect(owned.length).toBeGreaterThan(0)
    expect(owned.every(row => labels(row.body)['com.dz23.studio.installation-id'] === installationId)).toBe(true)
    expect(JSON.stringify(owned)).not.toMatch(/tenant-one|tenant-two|instance_id/u)
    expect(engine.containers.some(row => row.Id === 'foreign')).toBe(true)
  })

  it.each([
    ['build', ['pnpm', 'run', 'build']],
    ['test', ['pnpm', 'run', 'test']],
    ['e2e', ['pnpm', 'run', 'test:e2e']],
  ] as const)('maps %s to one fixed argv', async (stepName, command) => {
    const engine = new FakeEngine(); const adapter = create(engine); const signal = new AbortController().signal
    await adapter.prepare(buildRef, 'run', artifact, signal)
    await adapter.execute(buildRef, stepName, signal)
    expect(engine.created.at(-1)?.body).toMatchObject({ Cmd: command })
    expect(host(engine.created.at(-1)?.body).Mounts).toEqual([{ Type: 'volume', Source: expect.any(String), Target: '/workspace', ReadOnly: false }])
  })

  it('o preflight NÃO baixa o store inteiro a cada consulta: reconfere por tempo, por volume trocado, e uma vez só em paralelo', async () => {
    const engine = new FakeEngine()
    ;(engine.volumes[0] as Record<string, unknown>).CreatedAt = '2026-09-19T05:00:00Z'
    const downloads = vi.spyOn(engine, 'downloadArchive')
    let agora = 1_000_000
    const adapter = new DockerBuilderAdapter({ engine, imageDigest: image, installationId, scopeId, exportRoot: join(tmpdir(), 'dz23-builder-exports'), templateStoreVersion: templateVersion, templateStoreSha256, now: () => agora })
    const signal = new AbortController().signal
    const paralelas = await Promise.all([adapter.preflight(signal), adapter.preflight(signal)])
    expect(paralelas.map(r => r.state)).toEqual(['OK', 'OK'])
    const primeira = downloads.mock.calls.length
    expect(primeira).toBeGreaterThan(0)
    await expect(adapter.preflight(signal)).resolves.toMatchObject({ state: 'OK' })
    expect(downloads.mock.calls.length).toBe(primeira)
    // Passou a janela: a resposta é a última confirmada do MESMO volume, e a
    // conferência completa roda por trás (não bloqueia quem perguntou).
    agora += STORE_REVERIFY_MS
    await expect(adapter.preflight(signal)).resolves.toMatchObject({ state: 'OK' })
    await vi.waitFor(() => { expect(downloads.mock.calls.length).toBe(primeira * 2) })
    await new Promise(resolve => setTimeout(resolve, 10))
    // Volume recriado (outra data): conferência na hora, mesmo dentro da janela.
    ;(engine.volumes[0] as Record<string, unknown>).CreatedAt = '2026-09-19T06:00:00Z'
    await adapter.preflight(signal)
    expect(downloads.mock.calls.length).toBe(primeira * 3)
    // Adulterado e recriado: recusa, e a recusa NÃO fica guardada como aprovação.
    engine.templateDigest = 'e'.repeat(64); ;(engine.volumes[0] as Record<string, unknown>).CreatedAt = '2026-09-19T07:00:00Z'
    await expect(adapter.preflight(signal)).resolves.toMatchObject({ state: 'BLOCKED_EXTERNAL' })
    await expect(adapter.preflight(signal)).resolves.toMatchObject({ state: 'BLOCKED_EXTERNAL' })
    expect(downloads.mock.calls.length).toBe(primeira * 5)
  })

  it('quem desiste de esperar NÃO cancela a conferência; e uma reconferência que reprova derruba a próxima resposta', async () => {
    const engine = new FakeEngine()
    ;(engine.volumes[0] as Record<string, unknown>).CreatedAt = '2026-09-19T05:00:00Z'
    let agora = 1_000_000
    const adapter = new DockerBuilderAdapter({ engine, imageDigest: image, installationId, scopeId, exportRoot: join(tmpdir(), 'dz23-builder-exports'), templateStoreVersion: templateVersion, templateStoreSha256, now: () => agora })
    // Medido no WSL2 do titular: a tela de saúde (8 s) desistia, e o sinal dela
    // cancelava a conferência inteira — que nunca terminava.
    await expect(adapter.preflight(AbortSignal.abort())).resolves.toMatchObject({ state: 'BLOCKED_EXTERNAL' })
    await vi.waitFor(async () => { await expect(adapter.preflight(AbortSignal.abort())).resolves.toMatchObject({ state: 'OK' }) })
    // O conteúdo muda sem recriar o volume; passada a janela, a reconferência
    // por trás reprova, e a resposta seguinte já é recusa.
    engine.templateDigest = 'e'.repeat(64)
    agora += STORE_REVERIFY_MS
    await expect(adapter.preflight(new AbortController().signal)).resolves.toMatchObject({ state: 'OK' })
    await vi.waitFor(async () => { await expect(adapter.preflight(new AbortController().signal)).resolves.toMatchObject({ state: 'BLOCKED_EXTERNAL' }) })
  })

  it('returns BLOCKED_EXTERNAL for missing/mismatched images without accepting another image', async () => {
    const mismatch = new FakeEngine(); mismatch.imageId = `sha256:${'d'.repeat(64)}`
    await expect(create(mismatch).preflight(new AbortController().signal)).resolves.toMatchObject({ state: 'BLOCKED_EXTERNAL' })
    const down = new FakeEngine(); down.pingFailure = true
    await expect(create(down).preflight(new AbortController().signal)).resolves.toMatchObject({ state: 'BLOCKED_EXTERNAL' })
    const missingStore = new FakeEngine(); missingStore.volumes = []
    await expect(create(missingStore).preflight(new AbortController().signal)).resolves.toMatchObject({ state: 'BLOCKED_EXTERNAL' })
    const tamperedStore = new FakeEngine(); tamperedStore.templateDigest = 'e'.repeat(64)
    await expect(create(tamperedStore).preflight(new AbortController().signal)).resolves.toMatchObject({ state: 'BLOCKED_EXTERNAL' })
    const invalidId = new FakeEngine(); invalidId.imageId = 'not-a-digest' as never
    await expect(create(invalidId).preflight(new AbortController().signal)).resolves.toMatchObject({ state: 'BLOCKED_EXTERNAL', image_id: image })
    const verifierFailure = new FakeEngine(); vi.spyOn(verifierFailure, 'createContainer').mockRejectedValueOnce(new Error('verifier failed'))
    await expect(create(verifierFailure).preflight(new AbortController().signal)).resolves.toMatchObject({ state: 'BLOCKED_EXTERNAL' })
  })

  it('binds the attested policy hash to immutable limits and template identity', async () => {
    const engine = new FakeEngine(); const signal = new AbortController().signal
    const normal = await create(engine).preflight(signal)
    const changed = await new DockerBuilderAdapter({ engine, imageDigest: image, installationId, scopeId, exportRoot: join(tmpdir(), 'changed'), templateStoreVersion: templateVersion, templateStoreSha256, limits: limits({ memoryBytes: 512 * 1024 * 1024, nanoCpus: 1_000_000_000, pids: 64, timeoutMs: 1_000, workspaceBytes: 64 * 1024 * 1024, concurrentContainers: 2 }) }).preflight(signal)
    expect(changed.policy_sha256).not.toBe(normal.policy_sha256)
  })

  it('o instalador e o adaptador chegam ao MESMO hash de politica', async () => {
    /*
      A atestação compara o hash que o adaptador calcula com o que foi gravado
      na configuração provisionada, e reprova com BUILDER_ATTESTATION_FAILED
      quando divergem. O instalador grava o número de `builderPolicySha256`; o
      adaptador atesta o dele. Este caso prende os dois à MESMA conta — com os
      limites padrão, que são os que o instalador usa.
    */
    const semLimites = await new DockerBuilderAdapter({
      engine: new FakeEngine(), imageDigest: image, installationId, scopeId, exportRoot: join(tmpdir(), 'policy'),
      templateStoreVersion: templateVersion, templateStoreSha256,
    }).preflight(new AbortController().signal)
    expect(semLimites.policy_sha256).toBe(builderPolicySha256({
      imageDigest: image, scopeId, templateStoreVersion: templateVersion, templateStoreSha256,
    }))
    // E limites diferentes dão hash diferente pela função também: ela não
    // pode ignorar o que o adaptador amarra.
    expect(builderPolicySha256({ imageDigest: image, scopeId, templateStoreVersion: templateVersion, templateStoreSha256, limits: { ...DEFAULT_BUILDER_LIMITS, pids: 64 } }))
      .not.toBe(semLimites.policy_sha256)
  })

  it('rolls back volume and stager after staging failure', async () => {
    const engine = new FakeEngine(); engine.archiveFailure = true
    await expect(create(engine).prepare(buildRef, 'run', artifact, new AbortController().signal)).rejects.toThrow('archive failed')
    expect(engine.volumes).toHaveLength(1)
    expect(engine.containers).toHaveLength(0)
  })

  it('prioritizes incomplete rollback evidence over the original staging error', async () => {
    const engine = new FakeEngine(); engine.archiveFailure = true; engine.keepVolume = true
    await expect(create(engine).prepare(buildRef, 'run', artifact, new AbortController().signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
  })

  it('fails closed when rollback cannot prove both Engine inventories are empty', async () => {
    const engine = new FakeEngine(); engine.archiveFailure = true; engine.failRollbackInventory = true
    await expect(create(engine).prepare(buildRef, 'run', artifact, new AbortController().signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
  })

  it('enforces timeout, removes the container and reports no successful exit', async () => {
    const engine = new FakeEngine(); engine.waitForAbort = true
    const adapter = create(engine, 10); const signal = new AbortController().signal
    await adapter.prepare(buildRef, 'run', artifact, signal)
    await expect(adapter.execute(buildRef, 'build', signal)).resolves.toMatchObject({ exit_code: -1, timed_out: true, termination_reason: 'timeout', output_limit_exceeded: false })
    expect(engine.containers).toHaveLength(1)
  })

  it('bounds logs and marks output-limited results', async () => {
    const engine = new FakeEngine(); engine.logs = { stdout: Buffer.alloc(512 * 1024 + 1, 0x61), stderr: Buffer.alloc(0) }
    const adapter = create(engine); const signal = new AbortController().signal
    await adapter.prepare(buildRef, 'run', artifact, signal)
    const result = await adapter.execute(buildRef, 'test', signal)
    expect(result).toMatchObject({ exit_code: -1, termination_reason: 'output_limit', output_limit_exceeded: true })
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(512 * 1024)
  })

  it('fails closed when cleanup leaves a managed survivor', async () => {
    const engine = new FakeEngine(); const adapter = create(engine); const signal = new AbortController().signal
    await adapter.prepare(buildRef, 'run', artifact, signal)
    engine.keepVolume = true
    await expect(adapter.cleanup(buildRef, signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
  })

  it('cancels an active step and cleans all resources', async () => {
    const engine = new FakeEngine(); engine.waitForAbort = true
    const adapter = create(engine, 10_000); const signal = new AbortController().signal
    await adapter.prepare(buildRef, 'run', artifact, signal)
    const pending = adapter.execute(buildRef, 'e2e', signal)
    await vi.waitFor(() => expect(engine.started).toHaveLength(2))
    await adapter.cancel(buildRef, signal)
    await expect(pending).resolves.toMatchObject({ exit_code: 137 })
    await adapter.cleanup(buildRef, signal)
    expect(engine.containers).toHaveLength(0); expect(engine.volumes).toHaveLength(1)
  })

  it('validates immutable adapter configuration', () => {
    expect(() => new DockerBuilderAdapter({ engine: new FakeEngine(), imageDigest: 'sha256:no' as never, installationId, scopeId, exportRoot: tmpdir(), templateStoreVersion: templateVersion, templateStoreSha256 })).toThrow('INVALID_BUILDER_IMAGE')
    expect(() => new DockerBuilderAdapter({ engine: new FakeEngine(), imageDigest: image, installationId: 'bad', scopeId, exportRoot: tmpdir(), templateStoreVersion: templateVersion, templateStoreSha256 })).toThrow('INVALID_RUNTIME_SCOPE')
    expect(() => new DockerBuilderAdapter({ engine: new FakeEngine(), imageDigest: image, installationId, scopeId: 'tenant-one' as never, exportRoot: tmpdir(), templateStoreVersion: templateVersion, templateStoreSha256 })).toThrow('INVALID_RUNTIME_SCOPE')
    expect(() => new DockerBuilderAdapter({ engine: new FakeEngine(), imageDigest: image, installationId, scopeId, exportRoot: tmpdir(), templateStoreVersion: templateVersion, templateStoreSha256, limits: limits({ memoryBytes: 0, nanoCpus: 1, pids: 1, timeoutMs: 1, workspaceBytes: 1, concurrentContainers: 1 }) })).toThrow('INVALID_BUILDER_LIMIT')
    expect(() => new DockerBuilderAdapter({ engine: new FakeEngine(), imageDigest: image, installationId, scopeId, exportRoot: tmpdir(), templateStoreVersion: '../bad', templateStoreSha256 })).toThrow('INVALID_TEMPLATE_STORE')
    expect(() => new DockerBuilderAdapter({ engine: new FakeEngine(), imageDigest: image, installationId, scopeId, exportRoot: 'relative', templateStoreVersion: templateVersion, templateStoreSha256 })).toThrow('INVALID_EXPORT_ROOT')
    expect(() => new DockerBuilderAdapter({ engine: new FakeEngine(), imageDigest: image, installationId, scopeId, exportRoot: tmpdir(), templateStoreVersion: templateVersion, templateStoreSha256: 'bad' })).toThrow('INVALID_TEMPLATE_STORE')
    expect(() => new DockerBuilderAdapter({ engine: new FakeEngine(), imageDigest: image, installationId, scopeId, exportRoot: tmpdir(), templateStoreVersion: templateVersion, templateStoreSha256, limits: limits({ timeoutMs: Number.NaN }) })).toThrow('INVALID_BUILDER_LIMIT')
    expect(() => new DockerBuilderAdapter({ engine: new FakeEngine(), imageDigest: image, installationId, scopeId, exportRoot: tmpdir(), templateStoreVersion: templateVersion, templateStoreSha256, limits: limits({ workspaceBytes: 129, maxWorkspaceBytes: 128 }) })).toThrow('INVALID_BUILDER_LIMIT')
    expect(() => new DockerBuilderAdapter({ engine: new FakeEngine(), imageDigest: image, installationId, scopeId, exportRoot: tmpdir(), templateStoreVersion: templateVersion, templateStoreSha256, limits: limits({ maxRetainedExports: 1_001 }) })).toThrow('INVALID_BUILDER_LIMIT')
  })

  it('rejects duplicate and unknown build references without touching Docker', async () => {
    const engine = new FakeEngine(); const adapter = create(engine); const signal = new AbortController().signal
    await adapter.prepare(buildRef, 'one', artifact, signal)
    await expect(adapter.prepare(buildRef, 'two', artifact, signal)).rejects.toThrow('BUILD_ALREADY_EXISTS')
    await expect(adapter.execute(`build_${'0'.repeat(32)}`, 'build', signal)).rejects.toThrow('BUILD_NOT_FOUND')
    await expect(adapter.exportArtifact(`build_${'0'.repeat(32)}`, signal)).rejects.toThrow('BUILD_NOT_FOUND')
    await expect(adapter.cancel(`build_${'0'.repeat(32)}`, signal)).resolves.toBeUndefined()
  })

  it('validates labeled recovery ownership and preserves resources for lifecycle recovery', async () => {
    const engine = new FakeEngine(); const signal = new AbortController().signal; await create(engine).prepare(buildRef, 'orphan-run', artifact, signal)
    const restarted = create(engine); await expect(restarted.reconcile([{ build_ref: buildRef, build_id: 'orphan-run' }], signal)).resolves.toEqual([{ build_ref: buildRef, build_id: 'orphan-run' }])
    expect(engine.containers.length).toBeGreaterThan(0); expect(engine.volumes.length).toBeGreaterThan(1)
    await restarted.cleanup(buildRef, signal)
    expect(engine.containers).toHaveLength(0); expect(engine.volumes).toHaveLength(1)
    engine.volumes.push({ Name: 'alien', Labels: managedIdentityLabels() })
    await expect(create(engine).reconcile([], signal)).rejects.toThrow('RECOVERY_FAILED')
  })

  it('fails closed on conflicting recovery identities and surviving resources', async () => {
    const signal = new AbortController().signal
    const ref2 = `build_${'c'.repeat(32)}`
    for (const rows of [
      [managedContainer(buildRef, 'one'), managedContainer(buildRef, 'two')],
      [managedContainer(buildRef, 'one'), managedContainer(ref2, 'one')],
      [{ Id: 'alien', Labels: { ...managedIdentityLabels(), 'dz23.build_ref': 'bad', 'dz23.build_id': 'one' } }],
    ]) {
      const engine = new FakeEngine(); engine.containers = rows
      await expect(create(engine).reconcile([], signal)).rejects.toThrow('RECOVERY_FAILED')
    }
    const survivor = new FakeEngine(); survivor.containers = [managedContainer(buildRef, 'one')]; survivor.keepContainer = true
    const adapter = create(survivor)
    await expect(adapter.reconcile([{ build_ref: buildRef, build_id: 'one' }], signal)).resolves.toEqual([{ build_ref: buildRef, build_id: 'one' }])
    await expect(adapter.cleanup(buildRef, signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
  })

  it('preserves all Docker evidence when journal ownership is absent or inconsistent', async () => {
    const signal = new AbortController().signal; const ref2 = `build_${'c'.repeat(32)}`
    for (const expected of [[], [{ build_ref: buildRef, build_id: 'other' }], [{ build_ref: ref2, build_id: 'one' }]]) {
      const engine = new FakeEngine(); engine.containers = [managedContainer(buildRef, 'one')]; const before = structuredClone(engine.containers); const remove = vi.spyOn(engine, 'removeContainer')
      await expect(create(engine).reconcile(expected, signal)).rejects.toThrow('RECOVERY_FAILED')
      expect(engine.containers).toEqual(before); expect(remove).not.toHaveBeenCalled()
    }
    const invalidExpected = create(new FakeEngine())
    await expect(invalidExpected.reconcile([{ build_ref: 'bad', build_id: 'one' }], signal)).rejects.toThrow('RECOVERY_FAILED')
    await expect(invalidExpected.reconcile([{ build_ref: buildRef, build_id: 'one' }, { build_ref: buildRef, build_id: 'two' }], signal)).rejects.toThrow('RECOVERY_FAILED')
    await expect(invalidExpected.reconcile([{ build_ref: buildRef, build_id: 'one' }, { build_ref: ref2, build_id: 'one' }], signal)).rejects.toThrow('RECOVERY_FAILED')
    const root = await mkdtemp(join(tmpdir(), 'dz23-reconcile-archive-')); const archive = await openManagedExportArchive(root, buildRef); await archive.handle.close()
    try {
      const adapter = new DockerBuilderAdapter({ engine: new FakeEngine(), imageDigest: image, installationId, scopeId, exportRoot: root, templateStoreVersion: templateVersion, templateStoreSha256 })
      await expect(adapter.reconcile([], signal)).rejects.toThrow('RECOVERY_FAILED'); await expect(readFile(archive.path)).resolves.toBeInstanceOf(Buffer)
      await expect(adapter.reconcile([{ build_ref: buildRef, build_id: 'one' }], signal)).resolves.toEqual([]); await expect(readFile(archive.path)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rolls back every partially prepared stage and detects rollback API failures', async () => {
    const signal = new AbortController().signal
    const volumeFailure = new FakeEngine(); vi.spyOn(volumeFailure, 'createVolume').mockRejectedValueOnce(new Error('volume failed'))
    await expect(create(volumeFailure).prepare(buildRef, 'one', artifact, signal)).rejects.toThrow('volume failed')
    const anchorFailure = new FakeEngine(); vi.spyOn(anchorFailure, 'createContainer').mockRejectedValueOnce(new Error('anchor failed'))
    await expect(create(anchorFailure).prepare(buildRef, 'one', artifact, signal)).rejects.toThrow('anchor failed')
    const removeAnchor = new FakeEngine(); removeAnchor.archiveFailure = true; vi.spyOn(removeAnchor, 'removeContainer').mockRejectedValueOnce(new Error('remove failed'))
    await expect(create(removeAnchor).prepare(buildRef, 'one', artifact, signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
    const removeVolume = new FakeEngine(); removeVolume.archiveFailure = true; vi.spyOn(removeVolume, 'removeVolume').mockRejectedValueOnce(new Error('remove failed'))
    await expect(create(removeVolume).prepare(buildRef, 'one', artifact, signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
  })

  it('distinguishes unexpected, caller-aborted and output-limit execution failures', async () => {
    const signal = new AbortController().signal
    const unexpected = new FakeEngine(); const first = create(unexpected); await first.prepare(buildRef, 'one', artifact, signal); vi.spyOn(unexpected, 'containerLogs').mockRejectedValueOnce(new Error('unexpected'))
    await expect(first.execute(buildRef, 'build', signal)).rejects.toThrow('unexpected')
    const aborted = new FakeEngine(); const second = create(aborted); await second.prepare(buildRef, 'two', artifact, signal); const controller = new AbortController(); vi.spyOn(aborted, 'waitContainer').mockImplementationOnce(async () => { controller.abort(new Error('cancelled')); throw controller.signal.reason })
    await expect(second.execute(buildRef, 'build', controller.signal)).resolves.toMatchObject({ exit_code: -1, timed_out: false, termination_reason: null })
    const bounded = new FakeEngine(); const third = create(bounded); await third.prepare(buildRef, 'three', artifact, signal); vi.spyOn(bounded, 'containerLogs').mockRejectedValueOnce(new Error('DOCKER_RESPONSE_TOO_LARGE'))
    await expect(third.execute(buildRef, 'build', signal)).resolves.toMatchObject({ exit_code: -1, termination_reason: 'output_limit' })
    const createFailure = new FakeEngine(); const fourth = create(createFailure); await fourth.prepare(buildRef, 'four', artifact, signal); vi.spyOn(createFailure, 'createContainer').mockRejectedValueOnce(new Error('create failed'))
    await expect(fourth.execute(buildRef, 'build', signal)).rejects.toThrow('create failed')
    const stopFailure = new FakeEngine(); const fifth = create(stopFailure); await fifth.prepare(buildRef, 'five', artifact, signal); vi.spyOn(stopFailure, 'containerLogs').mockRejectedValueOnce(new Error('unexpected')); vi.spyOn(stopFailure, 'stopContainer').mockRejectedValueOnce(new Error('stop failed'))
    await expect(fifth.execute(buildRef, 'build', signal)).rejects.toThrow('unexpected')
  })

  it('exports only through bounded Docker archive streaming and returns the revalidated tree SHA', async () => {
    const engine = new FakeEngine(); engine.downloadPayload = exportTar(); const root = await mkdtemp(join(tmpdir(), 'dz23-adapter-export-')); const signal = new AbortController().signal
    try {
      const adapter = new DockerBuilderAdapter({ engine, imageDigest: image, installationId, scopeId, exportRoot: root, templateStoreVersion: templateVersion, templateStoreSha256 }); await adapter.prepare(buildRef, 'export-run', artifact, signal)
      await expect(adapter.exportArtifact(buildRef, signal)).resolves.toMatchObject({ relative_path: `exports/${buildRef}`, files: 3 })
      await expect(adapter.commitArtifact(buildRef, new Set(), signal)).resolves.toBeUndefined()
      expect(JSON.stringify(engine.created)).not.toMatch(/"Type":"bind"|cp","-a/u)
      const exporter = engine.created.find(row => labels(row.body)['dz23.role'] === 'export')?.body
      expect(exporter).toMatchObject({ Cmd: ['node', '-e', expect.stringContaining("evidence/appspec-report.json")] })
      expect(engine.containers.filter(row => row.Labels['dz23.role'] === 'export')).toHaveLength(0)
      expect(engine.volumes.filter(row => row.Labels['dz23.resource'] === 'export')).toHaveLength(0)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('diz em que etapa a exportacao falhou, e o que o exportador escreveu', async () => {
    const engine = new FakeEngine(); engine.exportExitCode = 1; engine.logs = { stdout: Buffer.alloc(0), stderr: Buffer.from('Error: EXPORT_SOURCE_INVALID') }
    const root = await mkdtemp(join(tmpdir(), 'dz23-adapter-export-diag-')); const signal = new AbortController().signal; const eventos: Record<string, unknown>[] = []
    try {
      const adapter = new DockerBuilderAdapter({ engine, imageDigest: image, installationId, scopeId, exportRoot: root, templateStoreVersion: templateVersion, templateStoreSha256, diagnostico: evento => { eventos.push({ ...evento }) } })
      await adapter.prepare(buildRef, 'diag', artifact, signal)
      await expect(adapter.exportArtifact(buildRef, signal)).rejects.toThrow('EXPORT_INVALID')
      expect(eventos).toEqual([
        { evento: 'exportador-saiu-com-erro', status: 1, saida: 'Error: EXPORT_SOURCE_INVALID' },
        { evento: 'exportacao-falhou', etapa: 'exportador', codigo: 'EXPORT_INVALID', onde: expect.stringMatching(/^docker-adapter\.ts:\d+$/u) },
      ])
      eventos.length = 0; engine.exportExitCode = 0; engine.downloadPayload = Buffer.from('bad')
      await expect(adapter.exportArtifact(buildRef, signal)).rejects.toThrow('EXPORT_INVALID')
      expect(eventos).toEqual([{ evento: 'exportacao-falhou', etapa: 'publicar', codigo: 'EXPORT_INVALID', onde: expect.stringMatching(/^export-artifact\.ts:\d+$/u) }])
      eventos.length = 0
      await expect(new DockerBuilderAdapter({ engine, imageDigest: image, installationId, scopeId, exportRoot: root, templateStoreVersion: templateVersion, templateStoreSha256, diagnostico: evento => { eventos.push({ ...evento }) } }).exportArtifact(buildRef, signal)).rejects.toThrow('BUILD_NOT_FOUND')
      expect(eventos).toEqual([{ evento: 'exportacao-falhou', etapa: 'construcao-conhecida', codigo: 'BUILD_NOT_FOUND', onde: expect.stringMatching(/^docker-adapter\.ts:\d+$/u) }])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('baixa a exportacao com o exportador VIVO: o tmpfs some quando ele sai', async () => {
    const engine = new FakeEngine(); engine.exporterExitsBeforeReady = true; engine.downloadPayload = exportTar()
    const root = await mkdtemp(join(tmpdir(), 'dz23-adapter-export-vivo-')); const signal = new AbortController().signal; const eventos: Record<string, unknown>[] = []
    try {
      const adapter = new DockerBuilderAdapter({ engine, imageDigest: image, installationId, scopeId, exportRoot: root, templateStoreVersion: templateVersion, templateStoreSha256, diagnostico: evento => { eventos.push({ ...evento }) } })
      await adapter.prepare(buildRef, 'vivo', artifact, signal)
      await expect(adapter.exportArtifact(buildRef, signal)).rejects.toThrow('EXPORT_INVALID')
      expect(eventos[0]).toMatchObject({ evento: 'exportador-saiu-com-erro', status: -1 })
      expect(engine.downloadsFromStoppedExporter).toBe(0)
      engine.exporterExitsBeforeReady = false
      await expect(adapter.exportArtifact(buildRef, signal)).resolves.toMatchObject({ files: 3 })
      expect(engine.downloadsFromStoppedExporter).toBe(0)
      expect(engine.containers.filter(row => row.Labels['dz23.role'] === 'export')).toHaveLength(0)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('espera a MARCA de pronto: saida sem a marca e copia em andamento', async () => {
    const engine = new FakeEngine(); engine.downloadPayload = exportTar(); engine.exportIncompleto = true
    const root = await mkdtemp(join(tmpdir(), 'dz23-adapter-export-marca-')); const signal = new AbortController().signal
    try {
      const adapter = new DockerBuilderAdapter({ engine, imageDigest: image, installationId, scopeId, exportRoot: root, templateStoreVersion: templateVersion, templateStoreSha256 })
      await adapter.prepare(buildRef, 'marca', artifact, signal)
      vi.spyOn(engine, 'containerLogs').mockImplementationOnce(async () => ({ stdout: Buffer.from('copiando…'), stderr: Buffer.alloc(0) }))
        .mockImplementationOnce(async () => { engine.exportIncompleto = false; return { stdout: Buffer.from('copiando…'), stderr: Buffer.alloc(0) } })
      await expect(adapter.exportArtifact(buildRef, signal)).resolves.toMatchObject({ files: 3 })
      expect(engine.downloadsFromStoppedExporter).toBe(0)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('removes exporter resources even when the downloaded archive is invalid', async () => {
    const engine = new FakeEngine(); engine.downloadPayload = Buffer.from('not a tar'); const root = await mkdtemp(join(tmpdir(), 'dz23-adapter-export-fail-')); const signal = new AbortController().signal
    try {
      const adapter = new DockerBuilderAdapter({ engine, imageDigest: image, installationId, scopeId, exportRoot: root, templateStoreVersion: templateVersion, templateStoreSha256 }); await adapter.prepare(buildRef, 'export-fail', artifact, signal)
      await expect(adapter.exportArtifact(buildRef, signal)).rejects.toThrow('EXPORT_INVALID')
      expect(engine.containers.filter(row => row.Labels['dz23.role'] === 'export')).toHaveLength(0); expect(engine.volumes.filter(row => row.Labels['dz23.resource'] === 'export')).toHaveLength(0)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rejects a non-zero exporter and releases the export permit for retry', async () => {
    const engine = new FakeEngine(); engine.exportExitCode = 1; const root = await mkdtemp(join(tmpdir(), 'dz23-adapter-export-exit-')); const signal = new AbortController().signal
    try {
      const adapter = new DockerBuilderAdapter({ engine, imageDigest: image, installationId, scopeId, exportRoot: root, templateStoreVersion: templateVersion, templateStoreSha256 }); await adapter.prepare(buildRef, 'exit', artifact, signal)
      await expect(adapter.exportArtifact(buildRef, signal)).rejects.toThrow('EXPORT_INVALID')
      engine.exportExitCode = 0; engine.downloadPayload = Buffer.from('bad')
      await expect(adapter.exportArtifact(buildRef, signal)).rejects.toThrow('EXPORT_INVALID')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('cleans partial exporter setup when volume or container creation fails', async () => {
    const signal = new AbortController().signal
    const volume = new FakeEngine(); const first = create(volume); await first.prepare(buildRef, 'volume-fail', artifact, signal); vi.spyOn(volume, 'createVolume').mockRejectedValueOnce(new Error('volume failed'))
    await expect(first.exportArtifact(buildRef, signal)).rejects.toThrow('volume failed')
    const container = new FakeEngine(); const second = create(container); await second.prepare(buildRef, 'container-fail', artifact, signal); vi.spyOn(container, 'createContainer').mockRejectedValueOnce(new Error('container failed'))
    await expect(second.exportArtifact(buildRef, signal)).rejects.toThrow('container failed')
  })

  it('fails closed on every exporter cleanup error while releasing the global export permit', async () => {
    const engine = new FakeEngine(); engine.downloadPayload = Buffer.from('not a tar'); engine.failExporterCleanup = true
    const root = await mkdtemp(join(tmpdir(), 'dz23-adapter-export-cleanup-')); const signal = new AbortController().signal
    try {
      const adapter = new DockerBuilderAdapter({ engine, imageDigest: image, installationId, scopeId, exportRoot: root, templateStoreVersion: templateVersion, templateStoreSha256 }); await adapter.prepare(buildRef, 'export-cleanup', artifact, signal)
      await expect(adapter.exportArtifact(buildRef, signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
      engine.failExporterCleanup = false; engine.containers = engine.containers.filter(row => row.Labels['dz23.role'] !== 'export'); engine.volumes = engine.volumes.filter(row => row.Labels['dz23.resource'] !== 'export')
      await expect(adapter.exportArtifact(buildRef, signal)).rejects.toThrow('EXPORT_INVALID')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('accounts for archive cleanup failures before and after successful publication', async () => {
    const signal = new AbortController().signal; const root = await mkdtemp(join(tmpdir(), 'dz23-adapter-rm-'))
    try {
      const invalid = new FakeEngine(); invalid.downloadPayload = Buffer.from('bad')
      const first = new DockerBuilderAdapter({ engine: invalid, imageDigest: image, installationId, scopeId, exportRoot: root, templateStoreVersion: templateVersion, templateStoreSha256, removeArchive: async () => { throw new Error('rm failed') } }); await first.prepare(buildRef, 'rm-one', artifact, signal)
      await expect(first.exportArtifact(buildRef, signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
      const valid = new FakeEngine(); valid.downloadPayload = exportTar()
      const secondRef = `build_${'4'.repeat(32)}`; const second = new DockerBuilderAdapter({ engine: valid, imageDigest: image, installationId, scopeId, exportRoot: root, templateStoreVersion: templateVersion, templateStoreSha256, removeArchive: async () => { throw new Error('rm failed') } }); await second.prepare(secondRef, 'rm-two', artifact, signal)
      await expect(second.exportArtifact(secondRef, signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
      const recovered = new DockerBuilderAdapter({ engine: valid, imageDigest: image, installationId, scopeId, exportRoot: root, templateStoreVersion: templateVersion, templateStoreSha256 })
      const invalidResidue = join(root, `.archive-${secondRef}-${'a'.repeat(16)}.tar`); await mkdir(invalidResidue)
      await expect(recovered.exportArtifact(secondRef, signal)).rejects.toThrow('CLEANUP_INCOMPLETE'); await rm(invalidResidue, { recursive: true })
      await expect(recovered.exportArtifact(secondRef, signal)).resolves.toMatchObject({ relative_path: `exports/${secondRef}` })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('does not erase a successfully published result when exporter cleanup must be retried by finish', async () => {
    const engine = new FakeEngine(); engine.downloadPayload = exportTar(); engine.failExporterCleanup = true
    const root = await mkdtemp(join(tmpdir(), 'dz23-adapter-export-published-')); const signal = new AbortController().signal
    try {
      const adapter = new DockerBuilderAdapter({ engine, imageDigest: image, installationId, scopeId, exportRoot: root, templateStoreVersion: templateVersion, templateStoreSha256 }); await adapter.prepare(buildRef, 'published-cleanup', artifact, signal)
      await expect(adapter.exportArtifact(buildRef, signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
      expect(engine.containers.some(row => row.Labels['dz23.role'] === 'export')).toBe(true)
      engine.failExporterCleanup = false
      await expect(adapter.cleanup(buildRef, AbortSignal.timeout(1_000))).resolves.toBeUndefined()
      await expect(adapter.exportArtifact(buildRef, signal)).resolves.toMatchObject({ relative_path: `exports/${buildRef}`, files: 3 })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('serializes duplicate exports and reuses the publication created while waiting', async () => {
    const engine = new FakeEngine(); engine.downloadPayload = exportTar(); const root = await mkdtemp(join(tmpdir(), 'dz23-adapter-export-race-')); const signal = new AbortController().signal
    try {
      const adapter = new DockerBuilderAdapter({ engine, imageDigest: image, installationId, scopeId, exportRoot: root, templateStoreVersion: templateVersion, templateStoreSha256 }); await adapter.prepare(buildRef, 'export-race', artifact, signal)
      let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve }); vi.spyOn(engine, 'containerLogs').mockImplementationOnce(async () => { await blocked; return { stdout: Buffer.from(EXPORTACAO_PRONTA), stderr: Buffer.alloc(0) } })
      const first = adapter.exportArtifact(buildRef, signal); await vi.waitFor(() => expect(engine.created.some(row => row.body.Labels && object(row.body.Labels)['dz23.role'] === 'export')).toBe(true)); const second = adapter.exportArtifact(buildRef, signal); release()
      await expect(Promise.all([first, second])).resolves.toEqual([expect.objectContaining({ relative_path: `exports/${buildRef}` }), expect.objectContaining({ relative_path: `exports/${buildRef}` })])
      expect(engine.created.filter(row => object(row.body.Labels)['dz23.role'] === 'export')).toHaveLength(1)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('treats export-garbage cleanup failures and archive identity drift as incomplete/invalid', async () => {
    const signal = new AbortController().signal; const root = await mkdtemp(join(tmpdir(), 'dz23-adapter-export-residue-'))
    try {
      const engine = new FakeEngine(); engine.downloadPayload = exportTar(); engine.reportedDownloadBytesDelta = 1
      const drifted = new DockerBuilderAdapter({ engine, imageDigest: image, installationId, scopeId, exportRoot: root, templateStoreVersion: templateVersion, templateStoreSha256 }); await drifted.prepare(buildRef, 'drifted', artifact, signal)
      await expect(drifted.exportArtifact(buildRef, signal)).rejects.toThrow('EXPORT_INVALID')
      const cleanupFailure = new DockerBuilderAdapter({ engine: new FakeEngine(), imageDigest: image, installationId, scopeId, exportRoot: join(root, 'cleanup'), templateStoreVersion: templateVersion, templateStoreSha256, cleanupExportResources: async () => { throw new Error('fs busy') } })
      await expect(cleanupFailure.cleanup(buildRef, signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
      const exportCleanupEngine = new FakeEngine(); exportCleanupEngine.downloadPayload = exportTar(); const exportCleanup = new DockerBuilderAdapter({ engine: exportCleanupEngine, imageDigest: image, installationId, scopeId, exportRoot: join(root, 'export-cleanup'), templateStoreVersion: templateVersion, templateStoreSha256, cleanupExportResources: async () => { throw new Error('fs busy') } }); await exportCleanup.prepare(buildRef, 'export-cleanup-failure', artifact, signal); await expect(exportCleanup.exportArtifact(buildRef, signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
      const closeEngine = new FakeEngine(); const closeFailure = new DockerBuilderAdapter({ engine: closeEngine, imageDigest: image, installationId, scopeId, exportRoot: join(root, 'close'), templateStoreVersion: templateVersion, templateStoreSha256, closeArchive: async handle => { await handle.close(); throw new Error('close failed') } }); await closeFailure.prepare(buildRef, 'close-failure', artifact, signal); vi.spyOn(closeEngine, 'createVolume').mockRejectedValueOnce(new Error('volume unavailable')); await expect(closeFailure.exportArtifact(buildRef, signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('includes managed archive residues in the Engine inventory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-adapter-archive-list-')); const signal = new AbortController().signal
    try {
      await mkdir(join(root, 'exports'), { recursive: true, mode: 0o700 }); await writeFile(join(root, `.archive-${buildRef}-${'a'.repeat(16)}.tar`), 'pending', { mode: 0o600 })
      const adapter = new DockerBuilderAdapter({ engine: new FakeEngine(), imageDigest: image, installationId, scopeId, exportRoot: root, templateStoreVersion: templateVersion, templateStoreSha256 })
      await expect(adapter.listManaged(signal)).resolves.toEqual([buildRef]); await expect(adapter.cleanup(buildRef, signal)).resolves.toBeUndefined(); await expect(adapter.listManaged(signal)).resolves.toEqual([])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('releases the execution permit even when removal of a step container fails', async () => {
    const engine = new FakeEngine(); const adapter = create(engine); const signal = new AbortController().signal
    await adapter.prepare(buildRef, 'step-cleanup', artifact, signal); engine.failStepRemoval = true
    await expect(adapter.execute(buildRef, 'install', signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
    engine.failStepRemoval = false
    await expect(adapter.execute(buildRef, 'install', signal)).resolves.toMatchObject({ exit_code: 0 })
  })

  it('enforces the aggregate workspace quota across builds and frees it only after observed cleanup', async () => {
    const engine = new FakeEngine(); const adapter = new DockerBuilderAdapter({ engine, imageDigest: image, installationId, scopeId, exportRoot: join(tmpdir(), 'quota'), templateStoreVersion: templateVersion, templateStoreSha256, limits: limits({ workspaceBytes: 64 * 1024 * 1024, maxWorkspaceBytes: 64 * 1024 * 1024 }) }); const signal = new AbortController().signal
    await adapter.prepare(buildRef, 'one', artifact, signal)
    const second = `build_${'c'.repeat(32)}`; await expect(adapter.prepare(second, 'two', artifact, signal)).rejects.toThrow('CAPACITY_EXCEEDED')
    await adapter.cleanup(buildRef, signal); await expect(adapter.prepare(second, 'two', artifact, signal)).resolves.toBeUndefined()
  })

  it('validates all managed inventory rows and cleanup failures', async () => {
    const signal = new AbortController().signal
    const invalidList = new FakeEngine(); invalidList.containers = [{ Id: 'alien', Labels: { ...managedIdentityLabels(), 'dz23.build_ref': 'bad' } }]
    await expect(create(invalidList).listManaged(signal)).rejects.toThrow('RECOVERY_FAILED')
    const invalidContainer = new FakeEngine(); invalidContainer.containers = [{ Id: '', Labels: managedLabels(buildRef, 'one') }]
    await expect(create(invalidContainer).cleanup(buildRef, signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
    const invalidVolume = new FakeEngine(); invalidVolume.volumes.push({ Name: '', Labels: managedLabels(buildRef, 'one') })
    await expect(create(invalidVolume).cleanup(buildRef, signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
    const failing = new FakeEngine(); failing.containers = [managedContainer(buildRef, 'one')]; failing.volumes.push({ Name: 'workspace', Labels: managedLabels(buildRef, 'one') })
    vi.spyOn(failing, 'stopContainer').mockRejectedValueOnce(new Error('stop')); vi.spyOn(failing, 'removeContainer').mockRejectedValueOnce(new Error('remove')); vi.spyOn(failing, 'removeVolume').mockRejectedValueOnce(new Error('volume'))
    await expect(create(failing).cleanup(buildRef, signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
    const inventoryError = new FakeEngine(); vi.spyOn(inventoryError, 'listContainers').mockRejectedValueOnce(new Error('list')); vi.spyOn(inventoryError, 'listVolumes').mockRejectedValueOnce(new Error('list'))
    await expect(create(inventoryError).cleanup(buildRef, signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
    const lateInventoryError = new FakeEngine(); vi.spyOn(lateInventoryError, 'listContainers').mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('late')); vi.spyOn(lateInventoryError, 'listVolumes').mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('late'))
    await expect(create(lateInventoryError).cleanup(buildRef, signal)).rejects.toThrow('CLEANUP_INCOMPLETE')
    const nonRecord = new FakeEngine(); vi.spyOn(nonRecord, 'listContainers').mockResolvedValueOnce([{ Labels: null }])
    await expect(create(nonRecord).listManaged(signal)).rejects.toThrow('RECOVERY_FAILED')
  })

  it('never removes an unproved transporter owned by another attempt', async () => {
    const signal = new AbortController().signal
    const stale = new FakeEngine(); stale.containers.push({ Id: 'stale-verifier', Labels: verifierLabels() })
    await expect(create(stale).preflight(signal)).resolves.toMatchObject({ state: 'OK' })
    expect(stale.containers.some(row => row.Id === 'stale-verifier')).toBe(true)
    const malformed = new FakeEngine(); malformed.containers.push({ Id: '', Labels: verifierLabels() })
    await expect(create(malformed).preflight(signal)).resolves.toMatchObject({ state: 'OK' })
    expect(malformed.containers.some(row => row.Id === '')).toBe(true)
  })

  it('truncates multibyte output only at a complete UTF-8 boundary', async () => {
    const engine = new FakeEngine(); const adapter = create(engine); const signal = new AbortController().signal; await adapter.prepare(buildRef, 'utf8', artifact, signal)
    vi.spyOn(engine, 'containerLogs').mockResolvedValueOnce({ stdout: Buffer.concat([Buffer.alloc(512 * 1024 - 1, 0x61), Buffer.from('é')]), stderr: Buffer.alloc(0) })
    const result = await adapter.execute(buildRef, 'test', signal)
    expect(Buffer.byteLength(result.stdout)).toBe(512 * 1024 - 1); expect(result.stdout.endsWith('é')).toBe(false)
  })
})

function create(engine: FakeEngine, timeoutMs = 1_000): DockerBuilderAdapter {
  return new DockerBuilderAdapter({ engine, imageDigest: image, installationId, scopeId, exportRoot: join(tmpdir(), 'dz23-builder-exports'), templateStoreVersion: templateVersion, templateStoreSha256, limits: limits({ memoryBytes: 512 * 1024 * 1024, nanoCpus: 1_000_000_000, pids: 128, timeoutMs, workspaceBytes: 64 * 1024 * 1024, concurrentContainers: 2 }) })
}

class FakeEngine implements DockerEnginePort {
  imageId = image; pingFailure = false; archiveFailure = false; waitForAbort = false; keepVolume = false; keepContainer = false; failExporterCleanup = false; failStepRemoval = false; failRollbackInventory = false; exportExitCode = 0; reportedDownloadBytesDelta = 0
  templateDigest = templateStoreSha256
  logs = { stdout: Buffer.from('clean output'), stderr: Buffer.alloc(0) }
  readonly inspected: string[] = []; readonly archives: Array<{ destination: string; bytes: number }> = []
  readonly volumeOptions: Array<Readonly<Record<string, string>>> = []
  readonly created: Array<{ name: string; body: Record<string, unknown> }> = []
  containers: Array<{ Id: string; Labels: Record<string, string>; Names?: string[]; State?: string }> = []
  volumes: Array<{ Name: string; Labels: Record<string, string> }> = [{ Name: templateVolume(), Labels: { 'dz23.managed': 'builder-template-store', ...physicalIdentityLabels(), 'dz23.template_version': templateVersion, 'dz23.template_sha256': templateStoreSha256, 'dz23.materialization_nonce': 'a'.repeat(32) } }]
  readonly started: string[] = []
  handleArchives = 0
  readonly waitResolvers = new Map<string, (value: { readonly StatusCode: number }) => void>()
  downloadPayload: Buffer = Buffer.alloc(0)
  exporterExitsBeforeReady = false
  /** A cópia ainda está andando: o que se baixar agora sai pela metade (aqui, vazio). */
  exportIncompleto = false
  /** Downloads feitos de um exportador que já tinha saído: o `tmpfs` estava vazio. */
  downloadsFromStoppedExporter = 0
  async ping(): Promise<void> { if (this.pingFailure) throw new Error('down') }
  async inspectImage(digest: string): Promise<{ readonly Id: string }> { this.inspected.push(digest); return { Id: this.imageId } }
  async createVolume(name: string, volumeLabels: Readonly<Record<string, string>>, driverOpts: Readonly<Record<string, string>>): Promise<void> { this.volumes.push({ Name: name, Labels: { ...volumeLabels } }); this.volumeOptions.push({ ...driverOpts }) }
  async removeVolume(name: string): Promise<void> { if (this.failExporterCleanup && this.volumes.find(row => row.Name === name)?.Labels['dz23.resource'] === 'export') throw new Error('remove export volume failed'); if (!this.keepVolume) this.volumes = this.volumes.filter(row => row.Name !== name) }
  async listVolumes(filters: Readonly<Record<string, readonly string[]>> = {}): Promise<readonly Record<string, unknown>[]> { const wanted = filters.label ?? []; const names = filters.name ?? []; if (this.failExporterCleanup && wanted.includes('dz23.resource=export')) throw new Error('list export volumes failed'); if (this.failRollbackInventory && wanted.some(item => item.startsWith('dz23.build_ref='))) throw new Error('list rollback volumes failed'); return this.volumes.filter(row => (names.length === 0 || names.includes(row.Name)) && wanted.every(item => { const index = item.indexOf('='); return row.Labels[item.slice(0, index)] === item.slice(index + 1) })) }
  async createContainer(name: string, bodyValue: unknown): Promise<string> {
    const body = object(bodyValue); const id = `${String(this.created.length + 1).padStart(12, 'a')}`
    this.created.push({ name, body }); this.containers.push({ Id: id, Labels: labels(body), Names: [`/${name}`], State: 'created' }); return id
  }
  /** Arquivos copiados para um contêiner que não estava rodando: num volume `tmpfs`, somem na partida. */
  archivesLostUnderTmpfs = 0
  async putArchive(container: string, destination: string, _archivePath: string, archiveBytes: number): Promise<void> {
    if (this.archiveFailure) throw new Error('archive failed')
    // Como o Docker de verdade: o `tmpfs` só existe montado enquanto o contêiner roda.
    if (destination === '/workspace' && this.containers.find(value => value.Id === container)?.State !== 'running') this.archivesLostUnderTmpfs += 1
    this.archives.push({ destination, bytes: archiveBytes })
  }
  async putArchiveHandle(_container: string, destination: string, _archiveHandle: FileHandle, archiveBytes: number): Promise<void> {
    this.handleArchives += 1
    await this.putArchive(_container, destination, '<claimed-handle>', archiveBytes)
  }
  async startContainer(id: string): Promise<void> { this.started.push(id); const row = this.containers.find(value => value.Id === id); if (row !== undefined) row.State = 'running' }
  async waitContainer(id: string, signal: AbortSignal): Promise<{ readonly StatusCode: number }> {
    const exportador = this.containers.find(row => row.Id === id)?.Labels['dz23.role'] === 'export'
    // Como o exportador de verdade: com a cópia bem-sucedida ele FICA VIVO até
    // ser parado (o `tmpfs` some quando ele sai). `exporterExitsBeforeReady`
    // é o programa antigo, que saía com 0 logo depois de copiar.
    if (exportador && this.exportExitCode === 0 && !this.exporterExitsBeforeReady && !this.waitForAbort) {
      return new Promise((resolve, reject) => {
        this.waitResolvers.set(id, resolve)
        signal.addEventListener('abort', () => { this.waitResolvers.delete(id); reject(signal.reason) }, { once: true })
      })
    }
    if (!this.waitForAbort) return { StatusCode: exportador ? this.exportExitCode : 0 }
    return new Promise((resolve, reject) => {
      this.waitResolvers.set(id, resolve)
      signal.addEventListener('abort', () => { this.waitResolvers.delete(id); reject(signal.reason) }, { once: true })
    })
  }
  async containerLogs(id: string, maximumBytes: number): Promise<{ readonly stdout: Buffer; readonly stderr: Buffer }> {
    const papel = this.containers.find(row => row.Id === id)?.Labels['dz23.role']
    if (papel === 'export' && this.exportExitCode === 0 && !this.exporterExitsBeforeReady) return { stdout: Buffer.from(`${EXPORTACAO_PRONTA}\n`), stderr: Buffer.alloc(0) }
    if (papel === 'template-verify') return { stdout: Buffer.from(this.templateDigest), stderr: Buffer.alloc(0) }
    if (this.logs.stdout.byteLength + this.logs.stderr.byteLength > maximumBytes) throw new Error('DOCKER_RESPONSE_TOO_LARGE')
    return this.logs
  }
  async downloadArchive(_container: string, source: string, destination: FileHandle): Promise<{ readonly bytes: number; readonly sha256: string }> { const row = this.containers.find(value => value.Id === _container); const vazio = source === '/export/.' && row !== undefined && (row.State !== 'running' || this.exporterExitsBeforeReady || this.exportIncompleto); if (vazio) this.downloadsFromStoppedExporter += 1; const payload = source === '/template-store' ? templateTar(this.templateDigest) : vazio ? Buffer.alloc(1024) : this.downloadPayload; await destination.writeFile(payload); await destination.sync(); return { bytes: payload.length + this.reportedDownloadBytesDelta, sha256: createHash('sha256').update(payload).digest('hex') } }
  async stopContainer(id: string): Promise<void> {
    const parado = this.containers.find(row => row.Id === id); if (parado !== undefined) parado.State = 'exited'
    if (this.failExporterCleanup && this.containers.find(row => row.Id === id)?.Labels['dz23.role'] === 'export') throw new Error('stop exporter failed')
    this.waitResolvers.get(id)?.({ StatusCode: 137 }); this.waitResolvers.delete(id)
  }
  async removeContainer(id: string): Promise<void> { const role = this.containers.find(row => row.Id === id)?.Labels['dz23.role']; if ((this.failExporterCleanup && role === 'export') || (this.failStepRemoval && role === 'step')) throw new Error('remove container failed'); this.waitResolvers.delete(id); if (!this.keepContainer) this.containers = this.containers.filter(row => row.Id !== id) }
  async listContainers(filters: Readonly<Record<string, readonly string[]>> = {}): Promise<readonly Record<string, unknown>[]> { const wanted = filters.label ?? []; const names = filters.name ?? []; if (this.failExporterCleanup && wanted.includes('dz23.role=export')) throw new Error('list export containers failed'); if (this.failRollbackInventory && wanted.some(item => item.startsWith('dz23.build_ref='))) throw new Error('list rollback containers failed'); return this.containers.filter(row => (names.length === 0 || row.Names?.some(name => names.includes(name.replace(/^\//u, ''))) === true) && wanted.every(item => { const index = item.indexOf('='); return row.Labels[item.slice(0, index)] === item.slice(index + 1) })) }
}

function assertHardened(body: unknown): void {
  expect(host(body)).toMatchObject({
    NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
    PidsLimit: 128, Memory: 512 * 1024 * 1024, NanoCpus: 1_000_000_000, PublishAllPorts: false, PortBindings: {}, IpcMode: 'private', ShmSize: 268_435_456,
  })
  expect(object(body)).not.toHaveProperty('ExposedPorts')
  expect(host(body)).not.toHaveProperty('Binds')
}
function assertTransportHardened(body: unknown): void {
  expect(host(body)).toMatchObject({ NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], AutoRemove: true, PidsLimit: 32, Memory: 256 * 1024 * 1024, NanoCpus: 500_000_000, PublishAllPorts: false, PortBindings: {}, IpcMode: 'private' })
  expect(object(body)).toMatchObject({ Image: image, Cmd: ['node', '-e', 'setTimeout(()=>process.exit(0),720000)'], User: '10001:10001', NetworkDisabled: true })
  expect(host(body)).not.toHaveProperty('Binds'); expect(object(body)).not.toHaveProperty('ExposedPorts')
}
function host(value: unknown): Record<string, unknown> { return object(object(value).HostConfig) }
function labels(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(object(object(value).Labels)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}
function object(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function tarSingle(name: string, value: string): Buffer {
  const data = Buffer.from(value); const header = Buffer.alloc(512); header.write(name, 0, 100, 'utf8')
  const octal = (offset: number, length: number, number: number) => header.write(`${number.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii')
  octal(100, 8, 0o644); octal(108, 8, 10_001); octal(116, 8, 10_001); octal(124, 12, data.length); octal(136, 12, 0); header.fill(0x20, 148, 156); header[156] = 48; header.write('ustar', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii'); octal(148, 8, header.reduce((sum, byte) => sum + byte, 0))
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512), Buffer.alloc(1024)])
}
function exportTar(): Buffer { return Buffer.concat([tarSingle('.next/standalone/server.js', 'server').subarray(0, -1024), tarSingle('.next/static/chunk.js', 'chunk').subarray(0, -1024), tarSingle('evidence/appspec-report.json', '{}').subarray(0, -1024), Buffer.alloc(1024)]) }
function templateVolume(): string { return templateStoreVolumeName(installationId, scopeId, templateVersion, templateStoreSha256) }
function limits(overrides: Partial<import('../src/docker-adapter.js').BuilderLimits> = {}): import('../src/docker-adapter.js').BuilderLimits { return { memoryBytes: 512 * 1024 * 1024, nanoCpus: 1_000_000_000, pids: 128, timeoutMs: 1_000, workspaceBytes: 64 * 1024 * 1024, maxWorkspaceBytes: 128 * 1024 * 1024, concurrentContainers: 2, maxExportBytes: 128 * 1024 * 1024, maxRetainedExports: 5, ...overrides } }
function physicalIdentityLabels(selectedScope = scopeId): Record<string, string> { return { 'com.dz23.studio.installation-id': installationId, 'com.dz23.studio.scope-id': selectedScope } }
function managedIdentityLabels(): Record<string, string> { return { 'dz23.managed': 'builder', ...physicalIdentityLabels() } }
function managedLabels(ref: string, id: string): Record<string, string> { return { ...managedIdentityLabels(), 'dz23.build_ref': ref, 'dz23.build_id': id } }
function managedContainer(ref: string, id: string): { Id: string; Labels: Record<string, string> } { return { Id: `${id}-${ref}`.slice(0, 64), Labels: managedLabels(ref, id) } }
function verifierLabels(): Record<string, string> { return { 'dz23.managed': 'builder-template-verifier', ...physicalIdentityLabels(), 'dz23.template_version': templateVersion, 'dz23.template_sha256': templateStoreSha256 } }
function templateTar(markerHash: string): Buffer {
  return Buffer.concat([
    templateTarEntry('template-store', Buffer.alloc(0), '5', 0o555),
    templateTarEntry('template-store/tree', Buffer.alloc(0), '5', 0o555),
    templateTarEntry('template-store/tree/store.txt', Buffer.from(templateContent), '0', 0o444),
    templateTarEntry('template-store/.complete', Buffer.from(`${markerHash}\n`), '0', 0o444),
    Buffer.alloc(1024),
  ])
}
function templateTarEntry(name: string, data: Buffer, type: '0' | '5', mode: number): Buffer {
  const header = Buffer.alloc(512); header.write(name, 0, 100, 'utf8')
  const octal = (offset: number, length: number, value: number) => header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii')
  octal(100, 8, mode); octal(108, 8, 10_001); octal(116, 8, 10_001); octal(124, 12, data.byteLength); octal(136, 12, 0); header.fill(0x20, 148, 156); header[156] = type.charCodeAt(0); header.write('ustar', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii'); octal(148, 8, header.reduce((sum, byte) => sum + byte, 0))
  return Buffer.concat([header, data, Buffer.alloc((512 - data.byteLength % 512) % 512)])
}
