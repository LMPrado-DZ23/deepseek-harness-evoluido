import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ArtifactRetentionError,
  ArtifactRetentionGarbageCollector,
  type ArtifactRetentionCandidate,
  type ArtifactRetentionPolicy,
  type OfflineCleanupLease,
  type ProtectionReservation,
  type RetentionManifest,
} from '../src/retention.ts'

const DAY_MS = 86_400_000
const NOW = 100 * DAY_MS
const roots: string[] = []
let executionSequence = 0

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = resolve(await mkdtemp(join(tmpdir(), 'dz23-retention-adversarial-')))
  roots.push(root)
  return root
}

async function artifact(
  root: string,
  id: string,
  overrides: Partial<ArtifactRetentionCandidate> & Readonly<{ bytes?: number }> = {},
): Promise<ArtifactRetentionCandidate> {
  const directory = join(root, 'artifacts', id)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'payload.bin'), Buffer.alloc(overrides.bytes ?? 4096, id.charCodeAt(0)))
  const { bytes: _bytes, ...candidateOverrides } = overrides
  return {
    artifactId: id,
    orgId: 'org-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    runId: `run-${id}`,
    directory,
    status: 'FAILED',
    completedAt: NOW - 40 * DAY_MS,
    ...candidateOverrides,
  }
}

function collectorOptions(root: string) {
  return {
    artifactRoot: root,
    now: () => NOW,
    createExecutionId: () => `gc-adversarial-${++executionSequence}`,
    freeBytes: async () => 1024 ** 3,
    policy: {
      preserveNewestPerProject: 1,
      tenantQuotaBytes: 1024 ** 3,
      globalQuotaBytes: 1024 ** 3,
      freeSpaceFloorBytes: 0,
    },
  } as const
}

function reservation(overrides: Partial<ProtectionReservation> = {}): ProtectionReservation {
  return {
    generation: 'protection-generation',
    protected: false,
    validate: () => true,
    release: () => undefined,
    ...overrides,
  }
}

function offline(overrides: Partial<OfflineCleanupLease> = {}): OfflineCleanupLease {
  return {
    generation: 'offline-generation',
    validate: () => true,
    release: () => undefined,
    ...overrides,
  }
}

async function deletionSet(root: string): Promise<ArtifactRetentionCandidate[]> {
  return Promise.all([
    artifact(root, 'victim', { completedAt: NOW - 50 * DAY_MS }),
    artifact(root, 'newest', { completedAt: NOW - DAY_MS }),
  ])
}

async function stageLegacy(root: string): Promise<{ candidates: ArtifactRetentionCandidate[]; manifest: RetentionManifest }> {
  const candidates = await deletionSet(root)
  const planned = await new ArtifactRetentionGarbageCollector(collectorOptions(root)).collect(candidates, { dryRun: true })
  const victim = planned.entries.find(entry => entry.artifactId === 'victim')!
  await mkdir(dirname(victim.trash), { recursive: true })
  await rename(victim.source, victim.trash)
  const legacy = structuredClone(planned) as RetentionManifest
  ;(legacy.entries.find(entry => entry.artifactId === 'victim') as { phase: string }).phase = 'RENAMED'
  await writeFile(join(root, '.runtime-governor', 'gc-audit', 'legacy.json'), `${JSON.stringify(legacy)}\n`)
  return { candidates, manifest: legacy }
}

describe('artifact retention defensive branch contracts', () => {
  it('rejects relative roots and every invalid policy family', async () => {
    expect(() => new ArtifactRetentionGarbageCollector({ artifactRoot: 'relative' }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_RETENTION_CONFIG' }))

    const root = await temporaryRoot()
    const invalid: Array<Partial<ArtifactRetentionPolicy>> = [
      { failedRetentionMs: 0 },
      { supersededPassedRetentionMs: 0 },
      { preserveNewestPerProject: 0 },
      { tenantQuotaBytes: -1 },
      { globalQuotaBytes: Number.MAX_SAFE_INTEGER + 1 },
      { freeSpaceFloorBytes: Number.NaN },
    ]
    for (const policy of invalid) {
      expect(() => new ArtifactRetentionGarbageCollector({ artifactRoot: root, policy }))
        .toThrowError(expect.objectContaining({ code: 'INVALID_RETENTION_CONFIG' }))
    }
  })

  it('uses safe production defaults and validates clock, execution id, and disk bytes', async () => {
    const root = await temporaryRoot()
    const manifest = await new ArtifactRetentionGarbageCollector({ artifactRoot: root }).collect([], { dryRun: true })
    expect(manifest.executionId).toMatch(/^[A-Za-z0-9._-]+$/u)
    expect(manifest.before.freeBytes).toBeGreaterThanOrEqual(0)

    await expect(new ArtifactRetentionGarbageCollector({ ...collectorOptions(root), now: () => -1 }).collect([]))
      .rejects.toMatchObject({ code: 'INVALID_RETENTION_CONFIG' })
    await expect(new ArtifactRetentionGarbageCollector({ ...collectorOptions(root), createExecutionId: () => 'bad/id' }).collect([]))
      .rejects.toMatchObject({ code: 'INVALID_RETENTION_CONFIG' })
    await expect(new ArtifactRetentionGarbageCollector({ ...collectorOptions(root), freeBytes: async () => -1 }).collect([]))
      .rejects.toMatchObject({ code: 'GC_IO_FAILURE' })
  })

  it('turns malformed candidate fields into auditable unsafe entries', async () => {
    const root = await temporaryRoot()
    const candidates = await Promise.all([
      artifact(root, 'bad-artifact', { artifactId: '/bad' }),
      artifact(root, 'bad-org', { orgId: '' }),
      artifact(root, 'bad-tenant', { tenantId: 'bad/tenant' }),
      artifact(root, 'bad-project', { projectId: '.bad project' }),
      artifact(root, 'bad-run', { runId: 'bad\0run' }),
      artifact(root, 'bad-time', { completedAt: -1 }),
      artifact(root, 'bad-status', { status: 'UNKNOWN' as never }),
      artifact(root, 'bad-directory', { directory: 'relative' }),
    ])
    const manifest = await new ArtifactRetentionGarbageCollector(collectorOptions(root)).collect(candidates, { dryRun: true })
    expect(manifest.entries).toHaveLength(candidates.length)
    expect(manifest.entries.every(entry => entry.decision === 'SKIP_UNSAFE')).toBe(true)
    expect(manifest.outcome).toBe('BLOCKED_UNSAFE')
  })

  it('fails closed for duplicate ids, overlapping paths, absent paths, and source/trash collisions', async () => {
    const root = await temporaryRoot()
    const first = await artifact(root, 'duplicate')
    const second = await artifact(root, 'duplicate-two', { artifactId: 'duplicate' })
    const parent = await artifact(root, 'parent')
    const nested = await artifact(root, 'nested', { directory: join(parent.directory, 'nested') })
    await mkdir(nested.directory, { recursive: true })
    const absent = await artifact(root, 'absent')
    await rm(absent.directory, { recursive: true })
    const manifest = await new ArtifactRetentionGarbageCollector(collectorOptions(root)).collect(
      [first, second, parent, nested, absent], { dryRun: true },
    )
    expect(manifest.entries.every(entry => entry.decision === 'SKIP_UNSAFE')).toBe(true)

    const collisionRoot = await temporaryRoot()
    const staged = await stageLegacy(collisionRoot)
    const victim = staged.candidates[0]!
    const victimEntry = staged.manifest.entries.find(entry => entry.artifactId === 'victim')!
    await mkdir(victim.directory, { recursive: true })
    await writeFile(join(victim.directory, 'replacement'), 'safe')
    const collision = await new ArtifactRetentionGarbageCollector(collectorOptions(collisionRoot)).collect(staged.candidates, { dryRun: true })
    expect(collision.entries.find(entry => entry.artifactId === 'victim')).toMatchObject({ decision: 'SKIP_UNSAFE' })
    await expect(stat(victimEntry.trash)).resolves.toBeDefined()
  })

  it('classifies intrinsic protections, terminal ages, invalid passes, and future timestamps independently', async () => {
    const root = await temporaryRoot()
    const values = await Promise.all([
      artifact(root, 'newest-anchor', { completedAt: NOW }),
      artifact(root, 'active', { active: true }),
      artifact(root, 'pending', { status: 'PENDING' }),
      artifact(root, 'running', { status: 'RUNNING' }),
      artifact(root, 'preview', { previewActive: true }),
      artifact(root, 'latest', { latest: true }),
      artifact(root, 'future', { completedAt: NOW + 1 }),
      artifact(root, 'failed-young', { completedAt: NOW - DAY_MS }),
      artifact(root, 'interrupted-old', { status: 'INTERRUPTED' }),
      artifact(root, 'cancelled-old', { status: 'CANCELLED' }),
      artifact(root, 'pass-latest', { status: 'PASSED', completedAt: NOW - 2 * DAY_MS }),
      artifact(root, 'pass-old', { status: 'PASSED', completedAt: NOW - 50 * DAY_MS }),
      artifact(root, 'pass-invalid', { status: 'PASSED', valid: false, completedAt: NOW - 60 * DAY_MS }),
    ])
    const manifest = await new ArtifactRetentionGarbageCollector(collectorOptions(root)).collect(values, { dryRun: true })
    const byId = new Map(manifest.entries.map(entry => [entry.artifactId, entry]))
    for (const id of ['active', 'pending', 'running', 'preview', 'latest', 'future', 'failed-young', 'pass-latest']) {
      expect(byId.get(id)?.decision, id).toBe('KEEP')
    }
    for (const id of ['interrupted-old', 'cancelled-old', 'pass-old', 'pass-invalid']) {
      expect(byId.get(id)?.decision, id).toBe('DELETE')
    }
  })

  it('distinguishes future completion and young superseded pass states after newest protection is assigned', async () => {
    const root = await temporaryRoot()
    const values = await Promise.all([
      artifact(root, 'anchor', { completedAt: NOW + 2 }),
      artifact(root, 'future', { completedAt: NOW + 1 }),
      artifact(root, 'pass-newer', { status: 'PASSED', completedAt: NOW - DAY_MS }),
      artifact(root, 'pass-young', { status: 'PASSED', completedAt: NOW - 2 * DAY_MS }),
    ])
    const manifest = await new ArtifactRetentionGarbageCollector(collectorOptions(root)).collect(values, { dryRun: true })
    expect(manifest.entries.find(entry => entry.artifactId === 'future')).toMatchObject({
      decision: 'KEEP', reason: 'completion timestamp is in the future',
    })
    expect(manifest.entries.find(entry => entry.artifactId === 'pass-young')).toMatchObject({
      decision: 'KEEP', reason: 'superseded passed artifact is within retention',
    })
  })

  it('stops quota eviction when already satisfied and skips an unrelated tenant during targeted pressure', async () => {
    const satisfiedRoot = await temporaryRoot()
    const satisfied = await Promise.all([
      artifact(satisfiedRoot, 'new', { completedAt: NOW - DAY_MS }),
      artifact(satisfiedRoot, 'old', { completedAt: NOW - 2 * DAY_MS }),
    ])
    const baseline = await new ArtifactRetentionGarbageCollector({
      ...collectorOptions(satisfiedRoot),
      policy: { failedRetentionMs: 100 * DAY_MS, supersededPassedRetentionMs: 100 * DAY_MS },
    }).collect(satisfied, { dryRun: true })
    expect(baseline.entries.every(entry => entry.decision === 'KEEP')).toBe(true)

    const pressuredRoot = await temporaryRoot()
    const values = await Promise.all([
      artifact(pressuredRoot, 'a-new', { bytes: 64 * 1024, completedAt: NOW - DAY_MS }),
      artifact(pressuredRoot, 'a-old', { bytes: 64 * 1024, completedAt: NOW - 2 * DAY_MS }),
      artifact(pressuredRoot, 'b-new', { bytes: 1, tenantId: 'tenant-2', completedAt: NOW - DAY_MS }),
      artifact(pressuredRoot, 'b-old', { bytes: 1, tenantId: 'tenant-2', completedAt: NOW - 2 * DAY_MS }),
    ])
    const targeted = await new ArtifactRetentionGarbageCollector({
      ...collectorOptions(pressuredRoot),
      policy: {
        failedRetentionMs: 100 * DAY_MS, supersededPassedRetentionMs: 100 * DAY_MS, preserveNewestPerProject: 1,
        tenantQuotaBytes: 32 * 1024, globalQuotaBytes: 1024 ** 3, freeSpaceFloorBytes: 0,
      },
    }).collect(values, { dryRun: true })
    expect(targeted.entries.find(entry => entry.artifactId === 'a-old')?.decision).toBe('DELETE')
    expect(targeted.entries.find(entry => entry.artifactId === 'b-old')?.decision).toBe('KEEP')
  })

  it('applies quota pressure only to the tenant that is over quota', async () => {
    const root = await temporaryRoot()
    const values = await Promise.all([
      artifact(root, 'a-new', { completedAt: NOW - DAY_MS }),
      artifact(root, 'a-old', { completedAt: NOW - 2 * DAY_MS }),
      artifact(root, 'b-new', { tenantId: 'tenant-2', completedAt: NOW - DAY_MS }),
      artifact(root, 'b-old', { tenantId: 'tenant-2', completedAt: NOW - 2 * DAY_MS }),
    ])
    const manifest = await new ArtifactRetentionGarbageCollector({
      ...collectorOptions(root),
      policy: {
        failedRetentionMs: 100 * DAY_MS,
        supersededPassedRetentionMs: 100 * DAY_MS,
        preserveNewestPerProject: 1,
        tenantQuotaBytes: 5_000,
        globalQuotaBytes: 1024 ** 3,
        freeSpaceFloorBytes: 0,
      },
    }).collect(values, { dryRun: true })
    expect(manifest.entries.filter(entry => entry.decision === 'DELETE').length).toBeGreaterThan(0)
    expect(manifest.projectedAfter.globalAllocatedBytes).toBeLessThanOrEqual(manifest.before.globalAllocatedBytes)
  })

  it('honors a protected online reservation and validates every reservation contract', async () => {
    const root = await temporaryRoot()
    const protectedManifest = await new ArtifactRetentionGarbageCollector({
      ...collectorOptions(root),
      resolveProtection: () => reservation({ protected: true }),
    }).collect(await deletionSet(root))
    expect(protectedManifest.entries.find(entry => entry.artifactId === 'victim')).toMatchObject({
      decision: 'KEEP', reason: 'protected by authoritative runtime state',
    })

    for (const invalid of [
      {} as ProtectionReservation,
      reservation({ generation: '' }),
      reservation({ protected: 'yes' as never }),
      reservation({ reason: 42 as never }),
    ]) {
      const nextRoot = await temporaryRoot()
      await expect(new ArtifactRetentionGarbageCollector({
        ...collectorOptions(nextRoot), resolveProtection: () => invalid,
      }).collect(await deletionSet(nextRoot))).rejects.toThrow(/reservation/u)
    }
  })

  it('keeps recovered intrinsic state without a resolver and with protected or unprotected reservations', async () => {
    for (const mode of ['none', 'protected', 'unprotected'] as const) {
      const root = await temporaryRoot()
      const { candidates } = await stageLegacy(root)
      const recovered = candidates.map(candidate => candidate.artifactId === 'victim'
        ? { ...candidate, status: 'RUNNING' as const }
        : candidate)
      const options = mode === 'none' ? collectorOptions(root) : {
        ...collectorOptions(root),
        resolveProtection: () => reservation({ protected: mode === 'protected' }),
      }
      const manifest = await new ArtifactRetentionGarbageCollector(options).collect(recovered)
      const victim = manifest.entries.find(entry => entry.artifactId === 'victim')!
      expect(victim.decision).toBe(mode === 'none' ? 'SKIP_UNSAFE' : 'KEEP')
      expect(victim.phase).toBe('RECOVERED')
    }
  })

  it('handles recovered aliases, protected primary state, restored sources, and lost recovery generations', async () => {
    const protectedRoot = await temporaryRoot()
    const protectedStage = await stageLegacy(protectedRoot)
    const unrelated = await artifact(protectedRoot, 'unrelated', { tenantId: 'tenant-other' })
    const protectedResult = await new ArtifactRetentionGarbageCollector({
      ...collectorOptions(protectedRoot),
      createExecutionId: () => 'protected-recovery',
      resolveProtection: candidate => reservation({
        protected: candidate.artifactId === 'victim',
        ...(candidate.artifactId === 'victim' ? { reason: 'primary active state' } : {}),
      }),
      beginOfflineCleanup: () => offline(),
    }).recoverOffline([unrelated])
    expect(protectedResult.entries.find(entry => entry.artifactId === 'victim')).toMatchObject({
      decision: 'KEEP', reason: expect.stringContaining('primary active state'),
    })

    const restoredRoot = await temporaryRoot()
    const restoredStage = await stageLegacy(restoredRoot)
    const restoredVictim = restoredStage.manifest.entries.find(entry => entry.artifactId === 'victim')!
    await rename(restoredVictim.trash, restoredVictim.source)
    const restored = await new ArtifactRetentionGarbageCollector({
      ...collectorOptions(restoredRoot), createExecutionId: () => 'already-restored',
      resolveProtection: () => reservation(), beginOfflineCleanup: () => offline(),
    }).recoverOffline()
    expect(restored.entries.find(entry => entry.artifactId === 'victim')).toMatchObject({ phase: 'RESTORED', decision: 'KEEP' })

    const lostRoot = await temporaryRoot()
    await stageLegacy(lostRoot)
    await expect(new ArtifactRetentionGarbageCollector({
      ...collectorOptions(lostRoot), createExecutionId: () => 'lost-protection',
      resolveProtection: () => reservation({ validate: () => false }), beginOfflineCleanup: () => offline(),
    }).recoverOffline()).rejects.toBeInstanceOf(ArtifactRetentionError)
  })

  it('rejects a live collector lease and safely takes over malformed and dead leases', async () => {
    const root = await temporaryRoot()
    const control = join(root, '.runtime-governor')
    await mkdir(control)
    await writeFile(join(control, 'gc.lock'), JSON.stringify({ executionId: 'live', token: 't', pid: process.pid }))
    await expect(new ArtifactRetentionGarbageCollector(collectorOptions(root)).collect([]))
      .rejects.toMatchObject({ code: 'GC_ALREADY_RUNNING' })

    await writeFile(join(control, 'gc.lock'), '{broken json')
    await expect(new ArtifactRetentionGarbageCollector({ ...collectorOptions(root), createExecutionId: () => 'takeover' }).collect([], { dryRun: true }))
      .resolves.toMatchObject({ executionId: 'takeover' })

    await writeFile(join(control, 'gc.lock'), JSON.stringify({ executionId: 'dead', token: 't', pid: 2_000_000_000 }))
    await expect(new ArtifactRetentionGarbageCollector({ ...collectorOptions(root), createExecutionId: () => 'dead-takeover' }).collect([], { dryRun: true }))
      .resolves.toMatchObject({ executionId: 'dead-takeover' })
  })

  it('propagates phase callback failures but always releases the collector lease', async () => {
    const root = await temporaryRoot()
    await expect(new ArtifactRetentionGarbageCollector({
      ...collectorOptions(root), onPhase: () => { throw new Error('observer failed') },
    }).collect(await deletionSet(root), { dryRun: true })).rejects.toThrow('observer failed')
    await expect(stat(join(root, '.runtime-governor', 'gc.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('validates offline lease shape and generation before inspecting staged state', async () => {
    const root = await temporaryRoot()
    await stageLegacy(root)
    await expect(new ArtifactRetentionGarbageCollector({
      ...collectorOptions(root),
      resolveProtection: () => reservation(),
      beginOfflineCleanup: () => ({} as OfflineCleanupLease),
    }).recoverOffline()).rejects.toThrow(/offline cleanup lease is invalid/u)

    const second = await temporaryRoot()
    await stageLegacy(second)
    await expect(new ArtifactRetentionGarbageCollector({
      ...collectorOptions(second),
      resolveProtection: () => reservation(),
      beginOfflineCleanup: () => offline({ validate: () => false }),
    }).recoverOffline()).rejects.toMatchObject({ code: 'GC_IO_FAILURE' })
  })

  it.skipIf(process.platform !== 'linux')('rejects non-file filesystem payloads without reading them', async () => {
    const root = await temporaryRoot()
    const value = await artifact(root, 'fifo')
    execFileSync('mkfifo', [join(value.directory, 'pipe')])
    const manifest = await new ArtifactRetentionGarbageCollector(collectorOptions(root)).collect([value], { dryRun: true })
    expect(manifest.entries[0]).toMatchObject({ decision: 'SKIP_UNSAFE' })
    expect(manifest.entries[0]!.reason).toMatch(/unsupported filesystem entry/u)
  })

  it('retains a readable immutable manifest contract', async () => {
    const root = await temporaryRoot()
    const manifest = await new ArtifactRetentionGarbageCollector(collectorOptions(root)).collect([], { dryRun: true })
    const persisted = JSON.parse(await readFile(manifest.manifestPath, 'utf8')) as RetentionManifest
    expect(persisted.manifestPath).toBe(manifest.manifestPath)
    expect(Object.isFrozen(manifest)).toBe(true)
    expect(Object.isFrozen(manifest.entries)).toBe(true)
  })
})
