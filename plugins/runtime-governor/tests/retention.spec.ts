import { execFileSync } from 'node:child_process'
import { link, mkdtemp, mkdir, open, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ArtifactRetentionGarbageCollector,
  DEFAULT_ARTIFACT_RETENTION_POLICY,
  readRetentionManifest,
  type ArtifactRetentionCandidate,
  type OfflineCleanupLease,
  type ProtectionReservation,
  type RetentionManifest,
  type RetentionManifestEntry,
  type RetentionPhaseEvent,
} from '../src/retention.ts'

const DAY_MS = 86_400_000
const NOW = 100 * DAY_MS
const roots: string[] = []
const isRoot = process.platform !== 'win32' && process.getuid?.() === 0
const canBindMount = process.platform === 'linux' && (isRoot || (() => {
  try { execFileSync('sudo', ['-n', 'true'], { stdio: 'ignore' }); return true } catch { return false }
})())

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dz23-retention-'))
  roots.push(root)
  return resolve(root)
}

async function artifact(
  root: string,
  id: string,
  options: Partial<ArtifactRetentionCandidate> & Readonly<{ bytes?: number }> = {},
): Promise<ArtifactRetentionCandidate> {
  const directory = join(root, 'artifacts', id)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'payload.bin'), Buffer.alloc(options.bytes ?? 8_192, id.charCodeAt(0)))
  return {
    artifactId: id, orgId: 'org-1', tenantId: 'tenant-1', projectId: 'project-1', runId: `run-${id}`,
    directory, status: 'FAILED', completedAt: NOW - 40 * DAY_MS, ...options,
  }
}

function reservation(options: Readonly<{ protected?: boolean; reason?: string; validate?: () => boolean }> = {}): ProtectionReservation {
  return {
    generation: 'protection-generation-1', protected: options.protected === true,
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    validate: options.validate ?? (() => true), release: () => undefined,
  }
}

function offlineLease(): OfflineCleanupLease {
  return { generation: 'offline-generation-1', validate: () => true, release: () => undefined }
}

function collector(root: string, options: Partial<ConstructorParameters<typeof ArtifactRetentionGarbageCollector>[0]> = {}): ArtifactRetentionGarbageCollector {
  return new ArtifactRetentionGarbageCollector({
    artifactRoot: root, now: () => NOW, createExecutionId: () => 'gc-test', freeBytes: async () => 1024 ** 3,
    policy: { tenantQuotaBytes: 1024 ** 3, globalQuotaBytes: 1024 ** 3, freeSpaceFloorBytes: 0 }, ...options,
  })
}

async function deletionSet(root: string): Promise<ArtifactRetentionCandidate[]> {
  return Promise.all([
    artifact(root, 'victim', { completedAt: NOW - 50 * DAY_MS }),
    artifact(root, 'keep-a', { completedAt: NOW - 3 * DAY_MS }),
    artifact(root, 'keep-b', { completedAt: NOW - 2 * DAY_MS }),
    artifact(root, 'keep-c', { completedAt: NOW - DAY_MS }),
  ])
}

async function legacyStage(root: string, candidates: readonly ArtifactRetentionCandidate[]): Promise<RetentionManifestEntry> {
  const planned = await collector(root, { createExecutionId: () => 'gc-plan' }).collect(candidates, { dryRun: true })
  const victim = planned.entries.find(entry => entry.artifactId === 'victim')
  if (victim === undefined) throw new Error('test fixture has no victim')
  await mkdir(dirname(victim.trash), { recursive: true })
  await rename(victim.source, victim.trash)
  const legacy = JSON.parse(JSON.stringify(planned)) as RetentionManifest
  const entry = legacy.entries.find(value => value.artifactId === 'victim') as RetentionManifestEntry & { phase: string }
  entry.phase = 'RENAMED'
  await writeFile(join(root, '.runtime-governor', 'gc-audit', 'legacy-stage.json'), `${JSON.stringify(legacy)}\n`)
  return entry
}

describe('ArtifactRetentionGarbageCollector fail-closed v1', () => {
  it('keeps the agreed policy defaults', () => {
    expect(DEFAULT_ARTIFACT_RETENTION_POLICY).toEqual({
      failedRetentionMs: 7 * DAY_MS, supersededPassedRetentionMs: 30 * DAY_MS, preserveNewestPerProject: 3,
      tenantQuotaBytes: 5 * 1024 ** 3, globalQuotaBytes: 20 * 1024 ** 3, freeSpaceFloorBytes: 2 * 1024 ** 3,
    })
  })

  it('dry-run produces a deterministic deletion plan without mutation', async () => {
    const root = await temporaryRoot()
    const candidates = await deletionSet(root)
    const manifest = await collector(root).collect(candidates, { dryRun: true })
    expect(manifest.outcome).toBe('PROJECTED_SATISFIED')
    expect(manifest.entries.find(entry => entry.artifactId === 'victim')).toMatchObject({ decision: 'DELETE', phase: 'DRY_RUN' })
    await Promise.all(candidates.map(candidate => expect(stat(candidate.directory)).resolves.toBeDefined()))
  })

  it('requires protection for a non-dry run and never mutates without it', async () => {
    const root = await temporaryRoot()
    const candidates = await deletionSet(root)
    const manifest = await collector(root).collect(candidates)
    expect(manifest.outcome).toBe('BLOCKED_UNSAFE')
    expect(manifest.entries.find(entry => entry.artifactId === 'victim')).toMatchObject({ decision: 'SKIP_UNSAFE', phase: 'PLANNED' })
    await expect(stat(candidates[0]!.directory)).resolves.toBeDefined()
  })

  it('does not path-rename even with a valid reservation', async () => {
    const root = await temporaryRoot()
    const manifest = await collector(root, { resolveProtection: () => reservation() }).collect(await deletionSet(root))
    const victim = manifest.entries.find(entry => entry.artifactId === 'victim')!
    expect(manifest.outcome).toBe('BLOCKED_UNSAFE')
    expect(victim).toMatchObject({ decision: 'SKIP_UNSAFE', phase: 'PLANNED' })
    expect(victim.reason).toMatch(/descriptor-safe artifact move is unavailable/u)
    await expect(stat(victim.source)).resolves.toBeDefined()
    await expect(stat(victim.trash)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cannot move a replacement raced after the reservation check', async () => {
    const root = await temporaryRoot()
    const candidates = await deletionSet(root)
    const victim = candidates[0]!
    const replacement = join(root, 'replacement')
    const original = join(root, 'original')
    await mkdir(replacement)
    await writeFile(join(replacement, 'must-survive'), 'replacement')
    let scheduled = false
    const result = await collector(root, {
      resolveProtection: () => reservation({ validate: () => {
        if (!scheduled) {
          scheduled = true
          setImmediate(async () => { await rename(victim.directory, original); await rename(replacement, victim.directory) })
        }
        return true
      } }),
    }).collect(candidates)
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
    const entry = result.entries.find(value => value.artifactId === 'victim')!
    await expect(readFile(join(victim.directory, 'must-survive'), 'utf8')).resolves.toBe('replacement')
    await expect(stat(entry.trash)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a lost reservation generation without touching the artifact', async () => {
    const root = await temporaryRoot()
    const candidates = await deletionSet(root)
    await expect(collector(root, { resolveProtection: () => reservation({ validate: () => false }) }).collect(candidates))
      .rejects.toThrow(/generation is no longer current/u)
    await expect(stat(candidates[0]!.directory)).resolves.toBeDefined()
  })

  it('recoverOffline blocks without offline proof and preserves legacy trash', async () => {
    const root = await temporaryRoot()
    const candidates = await deletionSet(root)
    const victim = await legacyStage(root, candidates)
    const result = await collector(root, { createExecutionId: () => 'blocked', resolveProtection: () => reservation() }).recoverOffline()
    expect(result.outcome).toBe('BLOCKED_UNSAFE')
    await expect(stat(victim.trash)).resolves.toBeDefined()
  })

  it('never physically deletes legacy trash even with both leases', async () => {
    const root = await temporaryRoot()
    const candidates = await deletionSet(root)
    const victim = await legacyStage(root, candidates)
    const events: RetentionPhaseEvent[] = []
    const result = await collector(root, {
      createExecutionId: () => 'offline', resolveProtection: () => reservation(), beginOfflineCleanup: offlineLease,
      onPhase: event => { events.push(event) },
    }).recoverOffline()
    expect(result.outcome).toBe('BLOCKED_UNSAFE')
    expect(result.entries.find(entry => entry.artifactId === 'victim')).toMatchObject({ phase: 'RENAMED' })
    expect(events.some(event => event.phase === 'DELETING' || event.phase === 'REMOVED')).toBe(false)
    await expect(readFile(join(victim.trash, 'payload.bin'))).resolves.toHaveLength(8_192)
  })

  it('protects an active alias at the trash path independent of artifactId', async () => {
    const root = await temporaryRoot()
    const candidates = await deletionSet(root)
    const victim = await legacyStage(root, candidates)
    const alias: ArtifactRetentionCandidate = {
      ...candidates[0]!, artifactId: 'active-alias', runId: 'run-active', directory: victim.trash, status: 'RUNNING', active: true,
    }
    const result = await collector(root, {
      createExecutionId: () => 'alias',
      resolveProtection: candidate => reservation({ protected: candidate.artifactId === 'active-alias', reason: 'active alias' }),
      beginOfflineCleanup: offlineLease,
    }).recoverOffline([alias])
    expect(result.outcome).toBe('BLOCKED_UNSAFE')
    expect(result.entries.find(entry => entry.artifactId === 'victim')).toMatchObject({ decision: 'KEEP' })
    await expect(stat(victim.trash)).resolves.toBeDefined()
  })

  it.skipIf(!canBindMount)('blocks an active inode alias through a bind mount', async () => {
    const root = await temporaryRoot()
    const candidates = await deletionSet(root)
    const victim = await legacyStage(root, candidates)
    const aliasDirectory = join(root, 'artifacts', 'active-bind-alias')
    await mkdir(aliasDirectory)
    execFileSync(isRoot ? 'mount' : 'sudo', isRoot ? ['--bind', victim.trash, aliasDirectory] : ['-n', 'mount', '--bind', victim.trash, aliasDirectory])
    try {
      const alias: ArtifactRetentionCandidate = {
        ...candidates[0]!, artifactId: 'inode-alias', runId: 'run-inode-alias', directory: aliasDirectory, status: 'RUNNING', active: true,
      }
      const result = await collector(root, {
        createExecutionId: () => 'inode-alias', resolveProtection: () => reservation(), beginOfflineCleanup: offlineLease,
      }).recoverOffline([alias])
      expect(result.outcome).toBe('BLOCKED_UNSAFE')
      expect(result.before.attributionComplete).toBe(false)
      await expect(readFile(join(aliasDirectory, 'payload.bin'))).resolves.toHaveLength(8_192)
      await expect(stat(victim.trash)).resolves.toBeDefined()
    } finally {
      execFileSync(isRoot ? 'umount' : 'sudo', isRoot ? [aliasDirectory] : ['-n', 'umount', aliasDirectory])
    }
  })

  it('counts allocated directory blocks as physical usage', async () => {
    const root = await temporaryRoot()
    const candidate = await artifact(root, 'directory-blocks', { bytes: 1 })
    for (let index = 0; index < 256; index += 1) await mkdir(join(candidate.directory, `directory-${String(index).padStart(4, '0')}`))
    const manifest = await collector(root).collect([candidate], { dryRun: true })
    const fileBlocks = Number((await stat(join(candidate.directory, 'payload.bin'), { bigint: true })).blocks) * 512
    expect(manifest.entries[0]!.allocatedBytes).toBeGreaterThan(fileBlocks)
  })

  it('blocks attribution when an artifact payload is omitted from the authoritative candidates', async () => {
    const root = await temporaryRoot()
    const included = await artifact(root, 'included')
    await artifact(root, 'omitted')

    const manifest = await collector(root).collect([included], { dryRun: true })

    expect(manifest.outcome).toBe('BLOCKED_UNSAFE')
    expect(manifest.before.attributionComplete).toBe(false)
    expect(manifest.before.uncountedAllocatedBytes).toBeGreaterThan(0)
  })

  it('separates sparse logical bytes from allocated bytes', async () => {
    const root = await temporaryRoot()
    const candidate = await artifact(root, 'sparse', { bytes: 0 })
    const handle = await open(join(candidate.directory, 'payload.bin'), 'r+')
    await handle.truncate(16 * 1024 ** 2)
    await handle.close()
    const entry = (await collector(root).collect([candidate], { dryRun: true })).entries[0]!
    expect(entry.logicalBytes).toBe(16 * 1024 ** 2)
    expect(entry.allocatedBytes).toBeLessThan(entry.logicalBytes)
    expect(entry.sizeBytes).toBe(entry.allocatedBytes)
  })

  it('deduplicates internal hardlinks and blocks external ownership', async () => {
    const root = await temporaryRoot()
    const internal = await artifact(root, 'internal-hardlink')
    await link(join(internal.directory, 'payload.bin'), join(internal.directory, 'copy.bin'))
    expect((await collector(root).collect([internal], { dryRun: true })).entries[0]!.logicalBytes).toBe(8_192)
    const external = await artifact(root, 'external-hardlink')
    const outside = await temporaryRoot()
    await link(join(external.directory, 'payload.bin'), join(outside, 'outside-link.bin'))
    const unsafe = await collector(root, { createExecutionId: () => 'hardlink' }).collect([external], { dryRun: true })
    expect(unsafe.entries[0]).toMatchObject({ decision: 'SKIP_UNSAFE' })
    expect(unsafe.before.attributionComplete).toBe(false)
  })

  it('produces the same code-point dry-run plan for input permutations', async () => {
    async function run(order: readonly string[]): Promise<string[]> {
      const root = await temporaryRoot()
      const values = new Map<string, ArtifactRetentionCandidate>()
      for (const id of order) values.set(id, await artifact(root, id, { completedAt: NOW - 50 * DAY_MS }))
      const manifest = await collector(root, {
        policy: { failedRetentionMs: 100 * DAY_MS, tenantQuotaBytes: 36_864, globalQuotaBytes: 36_864, freeSpaceFloorBytes: 0 },
      }).collect(order.map(id => values.get(id)!), { dryRun: true })
      return manifest.entries.filter(entry => entry.decision === 'DELETE').map(entry => entry.artifactId)
    }
    const first = await run(['f', 'e', 'd', 'c', 'b', 'a'])
    const second = await run(['a', 'c', 'e', 'b', 'd', 'f'])
    expect(first.length).toBeGreaterThan(0)
    expect(first).toEqual(second)
  })

  it('blocks conflicting manifests and orphan trash without removing either', async () => {
    const root = await temporaryRoot()
    const candidates = await deletionSet(root)
    const victim = await legacyStage(root, candidates)
    const original = JSON.parse(await readFile(join(root, '.runtime-governor', 'gc-audit', 'legacy-stage.json'), 'utf8')) as RetentionManifest
    const conflicting = JSON.parse(JSON.stringify(original)) as RetentionManifest
    ;(conflicting.entries.find(entry => entry.artifactId === 'victim') as { artifactId: string }).artifactId = 'conflicting-id'
    await writeFile(join(root, '.runtime-governor', 'gc-audit', 'conflict.json'), `${JSON.stringify(conflicting)}\n`)
    const orphan = join(root, '.runtime-governor', 'gc-trash', 'unowned-trash')
    await mkdir(orphan)
    await writeFile(join(orphan, 'data.bin'), 'must-survive')
    const result = await collector(root, {
      createExecutionId: () => 'recovery', resolveProtection: () => reservation(), beginOfflineCleanup: offlineLease,
    }).recoverOffline()
    expect(result.outcome).toBe('BLOCKED_UNSAFE')
    await expect(stat(victim.trash)).resolves.toBeDefined()
    await expect(readFile(join(orphan, 'data.bin'), 'utf8')).resolves.toBe('must-survive')
  })

  it('blocks a source collision with legacy trash', async () => {
    const root = await temporaryRoot()
    const candidates = await deletionSet(root)
    const victim = await legacyStage(root, candidates)
    await mkdir(victim.source)
    await writeFile(join(victim.source, 'replacement.bin'), 'must-survive')
    const result = await collector(root, {
      createExecutionId: () => 'collision', resolveProtection: () => reservation(), beginOfflineCleanup: offlineLease,
    }).recoverOffline()
    expect(result.outcome).toBe('BLOCKED_UNSAFE')
    await expect(stat(victim.trash)).resolves.toBeDefined()
    await expect(readFile(join(victim.source, 'replacement.bin'), 'utf8')).resolves.toBe('must-survive')
  })

  it('preserves a partially removed legacy tree for manual recovery', async () => {
    const root = await temporaryRoot()
    const candidates = await deletionSet(root)
    const victim = await legacyStage(root, candidates)
    await writeFile(join(victim.trash, 'survivor.bin'), 'survivor')
    await rm(join(victim.trash, 'payload.bin'))
    const result = await collector(root, {
      createExecutionId: () => 'partial', resolveProtection: () => reservation(), beginOfflineCleanup: offlineLease,
    }).recoverOffline()
    expect(result.outcome).toBe('BLOCKED_UNSAFE')
    await expect(readFile(join(victim.trash, 'survivor.bin'), 'utf8')).resolves.toBe('survivor')
  })

  it('refuses traversal and symlinks without touching outside roots', async () => {
    const root = await temporaryRoot()
    const outsideRoot = await temporaryRoot()
    const outside = await artifact(outsideRoot, 'outside')
    const linked = await artifact(root, 'linked')
    await symlink(outside.directory, join(linked.directory, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    const manifest = await collector(root).collect([outside, linked], { dryRun: true })
    expect(manifest.entries.every(entry => entry.decision === 'SKIP_UNSAFE')).toBe(true)
    await expect(stat(outside.directory)).resolves.toBeDefined()
  })

  it.skipIf(!canBindMount)('fails closed for a nested bind mount', async () => {
    const root = await temporaryRoot()
    const mounted = await artifact(root, 'bind-mounted')
    const source = join(root, 'bind-source')
    const mountPoint = join(mounted.directory, 'mounted')
    await mkdir(source)
    await mkdir(mountPoint)
    await writeFile(join(source, 'external.bin'), 'must-survive')
    execFileSync(isRoot ? 'mount' : 'sudo', isRoot ? ['--bind', source, mountPoint] : ['-n', 'mount', '--bind', source, mountPoint])
    try {
      const manifest = await collector(root).collect([mounted], { dryRun: true })
      expect(manifest.entries[0]).toMatchObject({ decision: 'SKIP_UNSAFE' })
      await expect(readFile(join(source, 'external.bin'), 'utf8')).resolves.toBe('must-survive')
    } finally {
      execFileSync(isRoot ? 'umount' : 'sudo', isRoot ? [mountPoint] : ['-n', 'umount', mountPoint])
    }
  })

  it('writes durable manifests without leftover temporary files', async () => {
    const root = await temporaryRoot()
    const manifest = await collector(root).collect([await artifact(root, 'manifest')], { dryRun: true })
    expect(await readdir(join(root, '.runtime-governor', 'gc-audit'))).toEqual(['gc-test.json'])
    await expect(readRetentionManifest(manifest.manifestPath)).resolves.toMatchObject({ fencingToken: expect.any(String) })
  })
})
