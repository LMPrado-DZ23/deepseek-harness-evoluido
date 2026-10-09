import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, statfs, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const DAY_MS = 86_400_000
const CONTROL_DIRECTORY = '.runtime-governor'

export const DEFAULT_ARTIFACT_RETENTION_POLICY = Object.freeze({
  failedRetentionMs: 7 * DAY_MS,
  supersededPassedRetentionMs: 30 * DAY_MS,
  preserveNewestPerProject: 3,
  tenantQuotaBytes: 5 * 1024 ** 3,
  globalQuotaBytes: 20 * 1024 ** 3,
  freeSpaceFloorBytes: 2 * 1024 ** 3,
})

export type ArtifactRunStatus = 'PENDING' | 'RUNNING' | 'PASSED' | 'FAILED' | 'INTERRUPTED' | 'CANCELLED'
export type ArtifactRetentionCandidate = Readonly<{
  artifactId: string
  orgId: string
  tenantId: string
  projectId: string
  runId: string
  directory: string
  status: ArtifactRunStatus
  completedAt: number
  active?: boolean
  previewActive?: boolean
  latest?: boolean
  valid?: boolean
}>
export type ArtifactRetentionPolicy = Readonly<{
  failedRetentionMs: number
  supersededPassedRetentionMs: number
  preserveNewestPerProject: number
  tenantQuotaBytes: number
  globalQuotaBytes: number
  freeSpaceFloorBytes: number
}>
export type RetentionDecision = 'KEEP' | 'DELETE' | 'SKIP_UNSAFE'
export type RetentionPhase = 'PLANNED' | 'DRY_RUN' | 'RENAMED' | 'RECOVERED' | 'DELETING' | 'REMOVED' | 'RESTORED'
export type RetentionOutcome = 'SATISFIED' | 'PROJECTED_SATISFIED' | 'QUOTA_UNSATISFIABLE' | 'BLOCKED_UNSAFE'
export type FilesystemIdentity = Readonly<{ device: string; inode: string; treeHash: string }>
export type RetentionManifestEntry = Readonly<{
  artifactId: string
  orgId: string
  tenantId: string
  projectId: string
  runId: string
  source: string
  trash: string
  status: ArtifactRunStatus
  completedAt: number
  sizeBytes: number
  logicalBytes: number
  allocatedBytes: number
  identity?: FilesystemIdentity
  protectionGeneration?: string
  decision: RetentionDecision
  reason: string
  phase: RetentionPhase
}>
export type RetentionQuotaSnapshot = Readonly<{
  globalBytes: number
  globalLogicalBytes: number
  globalAllocatedBytes: number
  countedBytes: number
  countedLogicalBytes: number
  countedAllocatedBytes: number
  uncountedBytes: number
  uncountedLogicalBytes: number
  uncountedAllocatedBytes: number
  attributionComplete: boolean
  tenantBytes: Readonly<Record<string, number>>
  freeBytes: number
  globalOverQuota: boolean
  tenantsOverQuota: readonly string[]
  belowFreeSpaceFloor: boolean
}>
export type RetentionManifest = Readonly<{
  schemaVersion: 1
  executionId: string
  fencingToken: string
  createdAt: number
  completedAt?: number
  dryRun: boolean
  artifactRoot: string
  policy: ArtifactRetentionPolicy
  outcome: RetentionOutcome
  before: RetentionQuotaSnapshot
  projectedAfter: RetentionQuotaSnapshot
  after?: RetentionQuotaSnapshot
  offlineGeneration?: string
  entries: readonly RetentionManifestEntry[]
  manifestPath: string
}>
export type RetentionPhaseEvent = Readonly<{ artifactId: string; phase: RetentionPhase; manifestPath: string }>
export type ProtectionReservation = Readonly<{
  generation: string
  protected: boolean
  reason?: string
  validate: () => boolean | Promise<boolean>
  release: () => void | Promise<void>
}>
export type OfflineCleanupLease = Readonly<{
  generation: string
  validate: () => boolean | Promise<boolean>
  release: () => void | Promise<void>
}>
export type ArtifactRetentionOptions = Readonly<{
  artifactRoot: string
  policy?: Partial<ArtifactRetentionPolicy>
  now?: () => number
  createExecutionId?: () => string
  freeBytes?: (root: string) => Promise<number>
  resolveProtection?: (candidate: ArtifactRetentionCandidate) => ProtectionReservation | Promise<ProtectionReservation>
  beginOfflineCleanup?: () => OfflineCleanupLease | Promise<OfflineCleanupLease>
  onPhase?: (event: RetentionPhaseEvent) => void | Promise<void>
}>

type MutableEntry = { -readonly [Key in keyof RetentionManifestEntry]: RetentionManifestEntry[Key] }
type MutableManifest = { -readonly [Key in keyof RetentionManifest]: Key extends 'entries' ? MutableEntry[] : RetentionManifest[Key] }
type TreeInspection = Readonly<{
  logicalBytes: number
  allocatedBytes: number
  identity: FilesystemIdentity
  inodeCounts: ReadonlyMap<string, number>
  inodeLinkCounts: ReadonlyMap<string, number>
}>
type RootInventory = Readonly<{
  logicalBytes: number
  allocatedBytes: number
  complete: boolean
  payloadPaths: readonly string[]
  inodePaths: ReadonlyMap<string, readonly string[]>
  inodeLinkCounts: ReadonlyMap<string, number>
}>
type Inspected = Readonly<{
  candidate: ArtifactRetentionCandidate
  source: string
  trash: string
  recovered: boolean
  logicalBytes: number
  allocatedBytes: number
  identity?: FilesystemIdentity
  inodeCounts?: ReadonlyMap<string, number>
  inodeLinkCounts?: ReadonlyMap<string, number>
  unsafeReason?: string
}>
type Planned = Readonly<{ inspection: Inspected; entry: MutableEntry; protected: boolean }>
type Lease = Readonly<{ path: string; token: string }>
type CatalogRecord = Readonly<{ entry: MutableEntry; owners: Array<{ path: string; manifest: MutableManifest }> }>

class RetentionPhaseCallbackError extends Error {
  constructor(cause: unknown) {
    super(message(cause))
    this.name = 'RetentionPhaseCallbackError'
  }
}

export class ArtifactRetentionError extends Error {
  constructor(
    readonly code: 'INVALID_RETENTION_CONFIG' | 'UNSAFE_ARTIFACT_ROOT' | 'GC_IO_FAILURE' | 'GC_ALREADY_RUNNING',
    message: string,
  ) {
    super(message)
    this.name = 'ArtifactRetentionError'
  }
}

export class ArtifactRetentionGarbageCollector {
  readonly #root: string
  readonly #policy: ArtifactRetentionPolicy
  readonly #now: () => number
  readonly #executionId: () => string
  readonly #freeBytes: (root: string) => Promise<number>
  readonly #resolveProtection: ArtifactRetentionOptions['resolveProtection']
  readonly #beginOfflineCleanup: ArtifactRetentionOptions['beginOfflineCleanup']
  readonly #onPhase: ArtifactRetentionOptions['onPhase']

  constructor(options: ArtifactRetentionOptions) {
    if (!isAbsolute(options.artifactRoot)) throw new ArtifactRetentionError('INVALID_RETENTION_CONFIG', 'artifactRoot must be absolute')
    this.#root = resolve(options.artifactRoot)
    this.#policy = validatePolicy({ ...DEFAULT_ARTIFACT_RETENTION_POLICY, ...options.policy })
    this.#now = options.now ?? Date.now
    this.#executionId = options.createExecutionId ?? randomUUID
    this.#freeBytes = options.freeBytes ?? diskFreeBytes
    this.#resolveProtection = options.resolveProtection
    this.#beginOfflineCleanup = options.beginOfflineCleanup
    this.#onPhase = options.onPhase
  }

  async collect(candidates: readonly ArtifactRetentionCandidate[], options: Readonly<{ dryRun?: boolean }> = {}): Promise<RetentionManifest> {
    const context = await this.#openExecution(options.dryRun === true)
    try {
      const orderedCandidates = [...candidates].sort(candidateOrder)
      const rawInventory = await inventoryRoot(this.#root, context.auditRoot)
      const duplicateIds = duplicates(orderedCandidates.map(candidate => candidate.artifactId))
      const paths = orderedCandidates.map(candidate => canonicalPath(candidate.directory))
      const overlaps = overlappingPaths(paths)
      const initiallyInspected = await Promise.all(orderedCandidates.map((candidate, index) => this.#inspect(
        candidate,
        context.controlRoot,
        context.trashRoot,
        duplicateIds.has(candidate.artifactId) || overlaps.has(paths[index] ?? ''),
      )))
      const ownershipChecked = initiallyInspected.map(item => verifyOwnership(item, rawInventory))
      const inventory = attributeInventory(rawInventory, ownershipChecked)
      const inspected = ownershipChecked.map(item => verifyOwnership(item, inventory))
      const freeBefore = validBytes(await this.#freeBytes(this.#root), 'freeBytes')
      const planned = decide(inspected, this.#policy, context.now, inventory, freeBefore)
      const entries = planned.map(item => item.entry)
      const before = quotaSnapshot(entries, inventory, freeBefore, this.#policy, 'before')
      const projectedAfter = quotaSnapshot(entries, inventory, freeBefore, this.#policy, 'projected')
      const manifest = this.#newManifest(context, before, projectedAfter, entries)
      manifest.outcome = outcomeForPlan(projectedAfter, entries, manifest.dryRun)
      await persistManifest(manifest.manifestPath, manifest)

      for (const item of planned) {
        if (item.entry.decision !== 'DELETE') {
          if (!manifest.dryRun && item.inspection.recovered && item.entry.decision === 'KEEP') {
            await this.#holdRecoveredProtected(item, context.lease, manifest)
          }
          continue
        }
        if (manifest.dryRun) {
          item.entry.phase = 'DRY_RUN'
          await this.#persistAndEmit(item.entry, manifest)
          continue
        }
        await this.#stage(item, context.lease, manifest)
      }

      const afterInventory = await inventoryRoot(this.#root, context.auditRoot)
      const afterFree = validBytes(await this.#freeBytes(this.#root), 'freeBytes')
      manifest.after = quotaSnapshot(entries, afterInventory, afterFree, this.#policy, 'after')
      manifest.outcome = manifest.dryRun
        ? outcomeForPlan(projectedAfter, entries, true)
        : outcomeAfterOnline(manifest)
      if (!manifest.dryRun && this.#resolveProtection === undefined) manifest.outcome = 'BLOCKED_UNSAFE'
      manifest.completedAt = validTimestamp(this.#now(), 'clock')
      await persistManifest(manifest.manifestPath, manifest)
      return freezeManifest(manifest)
    } finally {
      await releaseLease(context.lease)
    }
  }

  async recoverOffline(currentCandidates: readonly ArtifactRetentionCandidate[] = []): Promise<RetentionManifest> {
    const context = await this.#openExecution(false)
    let offline: OfflineCleanupLease | undefined
    try {
      const beforeInventory = await inventoryRoot(this.#root, context.auditRoot)
      const beforeFree = validBytes(await this.#freeBytes(this.#root), 'freeBytes')
      const catalog = await loadCatalog(context.auditRoot, context.trashRoot, this.#root)
      const entries = catalog.records.map(record => ({ ...record.entry }))
      const before = quotaSnapshot(entries, beforeInventory, beforeFree, this.#policy, 'before')
      const manifest = this.#newManifest(context, before, before, entries)
      if (!beforeInventory.complete || this.#beginOfflineCleanup === undefined || this.#resolveProtection === undefined || catalog.unsafe.length > 0) {
        entries.push(...catalog.unsafe)
        manifest.outcome = 'BLOCKED_UNSAFE'
        await this.#finishRecoveryManifest(manifest, context.auditRoot)
        return freezeManifest(manifest)
      }

      const acquiredOffline = await this.#beginOfflineCleanup()
      validateGuard(acquiredOffline, 'offline cleanup lease')
      offline = acquiredOffline
      await assertGuard(offline, 'offline cleanup lease')
      manifest.offlineGeneration = offline.generation
      await persistManifest(manifest.manifestPath, manifest)
      const records = [...catalog.records].sort((left, right) => entryOrder(left.entry, right.entry))
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index]
        const reportEntry = manifest.entries[index]
        if (record === undefined || reportEntry === undefined) continue
        await this.#recoverRecord(record, reportEntry, context.lease, offline, manifest, currentCandidates)
        const currentInventory = await inventoryRoot(this.#root, context.auditRoot)
        const currentFree = validBytes(await this.#freeBytes(this.#root), 'freeBytes')
        manifest.after = quotaSnapshot(manifest.entries, currentInventory, currentFree, this.#policy, 'after')
        await persistManifest(manifest.manifestPath, manifest)
      }
      await this.#finishRecoveryManifest(manifest, context.auditRoot)
      // v1 deliberately has no descriptor-relative deletion backend. Recovery
      // is inspection-only and can never claim success while path-based rm
      // would be the only available primitive.
      manifest.outcome = 'BLOCKED_UNSAFE'
      await persistManifest(manifest.manifestPath, manifest)
      return freezeManifest(manifest)
    } finally {
      await offline?.release()
      await releaseLease(context.lease)
    }
  }

  async #openExecution(dryRun: boolean): Promise<{
    now: number; executionId: string; fencingToken: string; dryRun: boolean
    controlRoot: string; trashRoot: string; auditRoot: string; lease: Lease
  }> {
    await assertSafeDirectory(this.#root, this.#root)
    const now = validTimestamp(this.#now(), 'clock')
    const executionId = validIdentifier(this.#executionId(), 'executionId')
    const fencingToken = randomUUID()
    const controlRoot = join(this.#root, CONTROL_DIRECTORY)
    const trashRoot = join(controlRoot, 'gc-trash')
    const auditRoot = join(controlRoot, 'gc-audit')
    await ensureDirectory(this.#root, controlRoot)
    const lease = await acquireLease(controlRoot, executionId, fencingToken)
    try {
      await ensureDirectory(this.#root, trashRoot)
      await ensureDirectory(this.#root, auditRoot)
      await assertNoMountBoundary(this.#root, controlRoot)
      return { now, executionId, fencingToken, dryRun, controlRoot, trashRoot, auditRoot, lease }
    } catch (error) {
      await releaseLease(lease)
      throw error
    }
  }

  #newManifest(
    context: { now: number; executionId: string; fencingToken: string; dryRun: boolean; auditRoot: string },
    before: RetentionQuotaSnapshot,
    projectedAfter: RetentionQuotaSnapshot,
    entries: MutableEntry[],
  ): MutableManifest {
    return {
      schemaVersion: 1,
      executionId: context.executionId,
      fencingToken: context.fencingToken,
      createdAt: context.now,
      dryRun: context.dryRun,
      artifactRoot: this.#root,
      policy: this.#policy,
      outcome: 'BLOCKED_UNSAFE',
      before,
      projectedAfter,
      entries,
      manifestPath: join(context.auditRoot, `${context.executionId}.json`),
    }
  }

  async #inspect(candidate: ArtifactRetentionCandidate, controlRoot: string, trashRoot: string, duplicate: boolean): Promise<Inspected> {
    const source = resolve(candidate.directory)
    const trash = join(trashRoot, trashName(candidate))
    try {
      validateCandidate(candidate)
      if (duplicate) throw new Error('duplicate artifactId or overlapping artifact directory')
      assertDescendant(this.#root, source)
      assertOutside(controlRoot, source)
      const sourceExists = await exists(source)
      const trashExists = await exists(trash)
      if (sourceExists && trashExists) throw new Error('source and recovery trash both exist')
      if (!sourceExists && !trashExists) throw new Error('artifact directory does not exist')
      const tree = await inspectTree(this.#root, sourceExists ? source : trash)
      return {
        candidate, source, trash, recovered: !sourceExists,
        logicalBytes: tree.logicalBytes, allocatedBytes: tree.allocatedBytes,
        identity: tree.identity, inodeCounts: tree.inodeCounts, inodeLinkCounts: tree.inodeLinkCounts,
      }
    } catch (error) {
      return { candidate, source, trash, recovered: false, logicalBytes: 0, allocatedBytes: 0, unsafeReason: message(error) }
    }
  }

  async #stage(item: Planned, lease: Lease, manifest: MutableManifest): Promise<void> {
    const entry = item.entry
    if (this.#resolveProtection === undefined) {
      entry.decision = 'SKIP_UNSAFE'
      entry.reason = 'resolveProtection reservation is required for online mutation'
      await persistManifest(manifest.manifestPath, manifest)
      return
    }
    const reservation = await this.#resolveProtection(item.inspection.candidate)
    validateReservation(reservation, 'protection reservation')
    entry.protectionGeneration = reservation.generation
    try {
      if (reservation.protected) {
        entry.decision = 'KEEP'
        entry.reason = reservation.reason ?? 'protected by authoritative runtime state'
        await persistManifest(manifest.manifestPath, manifest)
        return
      }
      await assertGuard(reservation, 'protection reservation')
      await assertFence(lease)
      entry.decision = 'SKIP_UNSAFE'
      entry.reason = 'descriptor-safe artifact move is unavailable in v1; no filesystem mutation was performed'
      await persistManifest(manifest.manifestPath, manifest)
    } finally {
      await reservation.release()
    }
  }

  async #holdRecoveredProtected(item: Planned, lease: Lease, manifest: MutableManifest): Promise<void> {
    if (this.#resolveProtection === undefined) {
      item.entry.decision = 'SKIP_UNSAFE'
      item.entry.reason = 'resolveProtection reservation is required to classify protected trash'
      await persistManifest(manifest.manifestPath, manifest)
      return
    }
    const reservation = await this.#resolveProtection(item.inspection.candidate)
    validateReservation(reservation, 'protection reservation')
    item.entry.protectionGeneration = reservation.generation
    try {
      await assertGuard(reservation, 'protection reservation')
      await assertFence(lease)
      item.entry.decision = 'KEEP'
      item.entry.reason = reservation.protected
        ? reservation.reason ?? 'protected staged artifact; descriptor-safe restore is unavailable in v1'
        : 'intrinsically protected staged artifact; descriptor-safe restore is unavailable in v1'
      await persistManifest(manifest.manifestPath, manifest)
    } finally {
      await reservation.release()
    }
  }

  async #recoverRecord(
    record: CatalogRecord,
    reportEntry: MutableEntry,
    lease: Lease,
    offline: OfflineCleanupLease,
    report: MutableManifest,
    currentCandidates: readonly ArtifactRetentionCandidate[],
  ): Promise<void> {
    const entry = record.entry
    const reservation = await this.#resolveProtection!(candidateFromEntry(entry))
    const aliasReservations: ProtectionReservation[] = []
    validateReservation(reservation, 'protection reservation')
    reportEntry.protectionGeneration = reservation.generation
    try {
      await assertGuard(offline, 'offline cleanup lease')
      await assertGuard(reservation, 'protection reservation')
      await assertFence(lease)
      await assertNoMountBoundary(this.#root, dirname(entry.trash))
      const aliases: ArtifactRetentionCandidate[] = []
      for (const candidate of [...currentCandidates].sort(candidateOrder)) {
        if (await candidateOverlapsEntry(this.#root, candidate, entry)) aliases.push(candidate)
      }
      for (const alias of aliases) {
        const aliasReservation = await this.#resolveProtection!(alias)
        validateReservation(aliasReservation, 'overlapping protection reservation')
        aliasReservations.push(aliasReservation)
        await assertGuard(aliasReservation, 'overlapping protection reservation')
      }
      const protectedAlias = aliases.some((alias, index) => aliasReservations[index]?.protected === true || intrinsicProtection(alias))
      const protectedAliasReason = aliasReservations.find(value => value.protected)?.reason
      if (aliases.length > 0 && !protectedAlias && aliases.some(alias => entrySignatureFromCandidate(alias) !== entrySignature(entry))) {
        throw new Error('current candidate metadata conflicts with staged source path')
      }
      if (reservation.protected || protectedAlias) {
        const reason = (reservation.protected ? reservation.reason : protectedAliasReason) ?? 'protected by authoritative runtime state'
        Object.assign(reportEntry, { decision: 'KEEP', reason: `${reason}; staged data was not moved because descriptor-safe restore is unavailable in v1` })
        await this.#persistAndEmit(reportEntry, report)
        return
      }
      const sourceExists = await exists(entry.source)
      const trashExists = await exists(entry.trash)
      if (sourceExists && trashExists) throw new Error('staged trash collides with an existing source path')
      if (!trashExists) {
        if (sourceExists) {
          await assertRootIdentity(this.#root, entry.source, requireIdentity(entry))
          Object.assign(reportEntry, { decision: 'KEEP', reason: 'artifact was already restored', phase: 'RESTORED' })
        } else {
          reportEntry.reason = `${entry.reason}; staged path is absent and requires manual reconciliation`
        }
        await this.#persistAndEmit(reportEntry, report)
        return
      }
      await assertSafePartialTree(this.#root, entry.trash, requireIdentity(entry))
      reportEntry.reason = `${entry.reason}; descriptor-safe physical deletion is unavailable in v1`
      await this.#persistAndEmit(reportEntry, report)
    } catch (error) {
      if (error instanceof ArtifactRetentionError || error instanceof RetentionPhaseCallbackError) throw error
      reportEntry.decision = 'SKIP_UNSAFE'
      reportEntry.reason = `offline recovery skipped: ${message(error)}`
      await persistManifest(report.manifestPath, report)
    } finally {
      await Promise.all(aliasReservations.map(value => value.release()))
      await reservation.release()
    }
  }

  async #finishRecoveryManifest(manifest: MutableManifest, auditRoot: string): Promise<void> {
    const inventory = await inventoryRoot(this.#root, auditRoot)
    const free = validBytes(await this.#freeBytes(this.#root), 'freeBytes')
    manifest.after = quotaSnapshot(manifest.entries, inventory, free, this.#policy, 'after')
    manifest.completedAt = validTimestamp(this.#now(), 'clock')
    await persistManifest(manifest.manifestPath, manifest)
  }

  async #persistAndEmit(entry: MutableEntry, manifest: MutableManifest): Promise<void> {
    await persistManifest(manifest.manifestPath, manifest)
    try {
      await this.#onPhase?.({ artifactId: entry.artifactId, phase: entry.phase, manifestPath: manifest.manifestPath })
    } catch (error) {
      throw new RetentionPhaseCallbackError(error)
    }
  }
}

function decide(inspected: readonly Inspected[], policy: ArtifactRetentionPolicy, now: number, inventory: RootInventory, free: number): Planned[] {
  const newest = new Map<string, Set<string>>()
  const latestValid = new Map<string, string>()
  const groups = new Map<string, Inspected[]>()
  for (const item of inspected) {
    if (item.unsafeReason !== undefined) continue
    const key = projectKey(item.candidate)
    const group = groups.get(key) ?? []
    group.push(item)
    groups.set(key, group)
  }
  for (const [key, group] of groups) {
    const ordered = [...group].sort(newestFirst)
    newest.set(key, new Set(ordered.slice(0, policy.preserveNewestPerProject).map(item => item.candidate.artifactId)))
    const valid = ordered.find(item => item.candidate.status === 'PASSED' && item.candidate.valid !== false)
    if (valid !== undefined) latestValid.set(key, valid.candidate.artifactId)
  }
  const result = inspected.map(item => {
    const candidate = item.candidate
    const entry: MutableEntry = {
      artifactId: candidate.artifactId,
      orgId: candidate.orgId,
      tenantId: candidate.tenantId,
      projectId: candidate.projectId,
      runId: candidate.runId,
      source: item.source,
      trash: item.trash,
      status: candidate.status,
      completedAt: candidate.completedAt,
      sizeBytes: item.allocatedBytes,
      logicalBytes: item.logicalBytes,
      allocatedBytes: item.allocatedBytes,
      ...(item.identity === undefined ? {} : { identity: item.identity }),
      decision: 'KEEP',
      reason: 'retained',
      phase: item.recovered ? 'RECOVERED' : 'PLANNED',
    }
    if (item.unsafeReason !== undefined) {
      entry.decision = 'SKIP_UNSAFE'
      entry.reason = item.unsafeReason
      return { inspection: item, entry, protected: true }
    }
    const key = projectKey(candidate)
    const protection = protectionReason(candidate, newest.get(key), latestValid.get(key))
    if (protection !== undefined) {
      entry.reason = protection
      return { inspection: item, entry, protected: true }
    }
    const age = now - candidate.completedAt
    if (age < 0) {
      entry.reason = 'completion timestamp is in the future'
      return { inspection: item, entry, protected: true }
    }
    if (['FAILED', 'INTERRUPTED', 'CANCELLED'].includes(candidate.status)) {
      entry.decision = age >= policy.failedRetentionMs ? 'DELETE' : 'KEEP'
      entry.reason = entry.decision === 'DELETE' ? 'failed terminal artifact exceeded retention' : 'failed terminal artifact is within retention'
    } else if (candidate.status === 'PASSED') {
      const superseded = latestValid.get(key) !== candidate.artifactId
      entry.decision = superseded && age >= policy.supersededPassedRetentionMs ? 'DELETE' : 'KEEP'
      entry.reason = entry.decision === 'DELETE' ? 'superseded passed artifact exceeded retention' : superseded ? 'superseded passed artifact is within retention' : 'latest valid artifact'
    } else {
      entry.reason = 'non-terminal artifact'
    }
    return { inspection: item, entry, protected: false }
  })
  const entries = result.map(item => item.entry)
  for (const item of result.filter(item => !item.protected && item.entry.decision !== 'DELETE').sort(oldestFirst)) {
    const current = quotaSnapshot(entries, inventory, free, policy, 'projected')
    if (!pressured(current)) break
    if (!inventory.complete) break
    const tenant = tenantKey(item.entry)
    if (current.tenantsOverQuota.length > 0 && !current.tenantsOverQuota.includes(tenant)
      && !current.globalOverQuota && !current.belowFreeSpaceFloor) continue
    item.entry.decision = 'DELETE'
    item.entry.reason = 'deterministic allocated-byte quota pressure eviction'
  }
  return result
}

function quotaSnapshot(
  entries: readonly MutableEntry[],
  inventory: RootInventory,
  free: number,
  policy: ArtifactRetentionPolicy,
  mode: 'before' | 'projected' | 'after',
): RetentionQuotaSnapshot {
  let countedLogical = 0
  let countedAllocated = 0
  let reclaimedLogical = 0
  let reclaimedAllocated = 0
  const tenantBytes: Record<string, number> = {}
  for (const entry of entries) {
    if (entry.decision === 'SKIP_UNSAFE') continue
    if (mode === 'after' && entry.phase === 'REMOVED') continue
    countedLogical += entry.logicalBytes
    countedAllocated += entry.allocatedBytes
    if (mode === 'projected' && entry.decision === 'DELETE') {
      reclaimedLogical += entry.logicalBytes
      reclaimedAllocated += entry.allocatedBytes
      continue
    }
    const key = tenantKey(entry)
    tenantBytes[key] = (tenantBytes[key] ?? 0) + entry.allocatedBytes
  }
  const globalLogicalBytes = Math.max(0, inventory.logicalBytes - (mode === 'projected' ? reclaimedLogical : 0))
  const globalAllocatedBytes = Math.max(0, inventory.allocatedBytes - (mode === 'projected' ? reclaimedAllocated : 0))
  const countedLogicalBytes = countedLogical - (mode === 'projected' ? reclaimedLogical : 0)
  const countedAllocatedBytes = countedAllocated - (mode === 'projected' ? reclaimedAllocated : 0)
  const resultingFree = free + (mode === 'projected' ? reclaimedAllocated : 0)
  return Object.freeze({
    globalBytes: globalAllocatedBytes,
    globalLogicalBytes,
    globalAllocatedBytes,
    countedBytes: countedAllocatedBytes,
    countedLogicalBytes,
    countedAllocatedBytes,
    uncountedBytes: Math.max(0, globalAllocatedBytes - countedAllocatedBytes),
    uncountedLogicalBytes: Math.max(0, globalLogicalBytes - countedLogicalBytes),
    uncountedAllocatedBytes: Math.max(0, globalAllocatedBytes - countedAllocatedBytes),
    attributionComplete: inventory.complete,
    tenantBytes: Object.freeze({ ...tenantBytes }),
    freeBytes: resultingFree,
    globalOverQuota: globalAllocatedBytes > policy.globalQuotaBytes,
    tenantsOverQuota: Object.freeze(Object.entries(tenantBytes)
      .filter(([, bytes]) => bytes > policy.tenantQuotaBytes)
      .map(([key]) => key)
      .sort(codePoint)),
    belowFreeSpaceFloor: resultingFree < policy.freeSpaceFloorBytes,
  })
}

function outcomeForPlan(snapshot: RetentionQuotaSnapshot, entries: readonly MutableEntry[], dryRun: boolean): RetentionOutcome {
  if (!snapshot.attributionComplete || entries.some(entry => entry.decision === 'SKIP_UNSAFE')) return 'BLOCKED_UNSAFE'
  if (pressured(snapshot)) return 'QUOTA_UNSATISFIABLE'
  if (dryRun && entries.some(entry => entry.decision === 'DELETE')) return 'PROJECTED_SATISFIED'
  if (!dryRun && entries.some(entry => entry.decision === 'DELETE')) return 'BLOCKED_UNSAFE'
  return 'SATISFIED'
}

function outcomeAfterOnline(manifest: MutableManifest): RetentionOutcome {
  if (manifest.entries.some(entry => entry.decision === 'SKIP_UNSAFE' || entry.phase === 'RENAMED' || entry.phase === 'RECOVERED')) return 'BLOCKED_UNSAFE'
  if (!manifest.after?.attributionComplete) return 'BLOCKED_UNSAFE'
  return pressured(manifest.after) ? 'QUOTA_UNSATISFIABLE' : 'SATISFIED'
}

function pressured(snapshot: RetentionQuotaSnapshot): boolean {
  return snapshot.globalOverQuota || snapshot.tenantsOverQuota.length > 0 || snapshot.belowFreeSpaceFloor
}

function verifyOwnership(item: Inspected, inventory: RootInventory): Inspected {
  if (item.unsafeReason !== undefined || item.inodeCounts === undefined || item.inodeLinkCounts === undefined) return item
  const ownedRoot = item.recovered ? item.trash : item.source
  for (const [inode, count] of item.inodeCounts) {
    const paths = inventory.inodePaths.get(inode)
    const linkCount = item.inodeLinkCounts.get(inode)
    if (paths === undefined || linkCount === undefined || paths.length !== linkCount || paths.length !== count
      || paths.some(path => !samePath(path, ownedRoot) && !isDescendant(ownedRoot, path))) {
      return { ...item, unsafeReason: 'hard-link ownership cannot be attributed exclusively to this artifact' }
    }
  }
  return item
}

function attributeInventory(inventory: RootInventory, inspected: readonly Inspected[]): RootInventory {
  const ownedRoots = inspected
    .filter(item => item.unsafeReason === undefined)
    .map(item => item.recovered ? item.trash : item.source)
  // A directory that is only an ancestor of one or more declared artifacts is
  // structural overhead, not an unattributed tenant payload. Siblings and
  // descendants outside every owned root remain uncovered and fail closed.
  const complete = inventory.complete && inventory.payloadPaths.every(path => ownedRoots.some(root => pathsOverlap(root, path)))
  return { ...inventory, complete }
}

async function loadCatalog(auditRoot: string, trashRoot: string, root: string): Promise<{ records: CatalogRecord[]; unsafe: MutableEntry[] }> {
  const manifests: Array<{ path: string; manifest: MutableManifest }> = []
  const documented = new Set<string>()
  const persistentUnsafe: MutableEntry[] = []
  for (const name of (await readdir(auditRoot)).filter(name => name.endsWith('.json')).sort(codePoint)) {
    const path = join(auditRoot, name)
    try {
      const manifest = JSON.parse(await readFile(path, 'utf8')) as MutableManifest
      if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries)) continue
      manifests.push({ path, manifest })
      for (const entry of manifest.entries) {
        if (typeof entry.trash !== 'string') continue
        documented.add(canonicalPath(entry.trash))
        if (entry.decision === 'SKIP_UNSAFE' && entry.reason.includes('orphan trash') && await exists(entry.trash)) persistentUnsafe.push({ ...entry })
      }
    } catch {
      // A malformed audit file is retained and ignored; it never authorizes deletion.
    }
  }
  const groups = new Map<string, Array<{ entry: MutableEntry; path: string; manifest: MutableManifest }>>()
  for (const owner of manifests) {
    for (const entry of owner.manifest.entries) {
      if (!['PLANNED', 'RENAMED', 'RECOVERED', 'DELETING'].includes(entry.phase) || entry.decision !== 'DELETE') continue
      if (typeof entry.trash !== 'string') continue
      const key = canonicalPath(entry.trash)
      const group = groups.get(key) ?? []
      group.push({ entry, path: owner.path, manifest: owner.manifest })
      groups.set(key, group)
    }
  }
  const unsafe: MutableEntry[] = [...persistentUnsafe]
  const records: CatalogRecord[] = []
  const seenInodes = new Map<string, CatalogRecord>()
  for (const [trash, owners] of [...groups].sort(([left], [right]) => codePoint(left, right))) {
    const representative = owners[0]?.entry
    if (representative === undefined) continue
    try {
      validateCatalogEntry(representative)
      assertDescendant(trashRoot, trash)
      assertDescendant(root, representative.source)
      assertOutside(dirname(trashRoot), representative.source)
      const signature = catalogSignature(representative)
      if (owners.some(owner => {
        try { validateCatalogEntry(owner.entry) } catch { return true }
        return catalogSignature(owner.entry) !== signature
      })) throw new Error('conflicting metadata refers to the same trash path')
      if (await exists(trash)) {
        const identity = await rootIdentity(root, trash)
        if (representative.identity === undefined || identity.device !== representative.identity.device || identity.inode !== representative.identity.inode) throw new Error('trash root identity conflicts with manifest')
        const existing = seenInodes.get(`${identity.device}:${identity.inode}`)
        if (existing !== undefined && !samePath(existing.entry.trash, trash)) throw new Error('same inode is referenced by conflicting trash paths')
      }
      const record: CatalogRecord = { entry: { ...representative }, owners: owners.map(owner => ({ path: owner.path, manifest: owner.manifest })) }
      records.push(record)
      if (representative.identity !== undefined) seenInodes.set(`${representative.identity.device}:${representative.identity.inode}`, record)
    } catch (error) {
      unsafe.push({ ...representative, decision: 'SKIP_UNSAFE', reason: message(error) })
    }
  }
  for (let leftIndex = 0; leftIndex < records.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < records.length; rightIndex += 1) {
      const left = records[leftIndex]
      const right = records[rightIndex]
      if (left === undefined || right === undefined) continue
      if (samePath(left.entry.source, right.entry.source) || isDescendant(left.entry.source, right.entry.source) || isDescendant(right.entry.source, left.entry.source)) {
        unsafe.push({ ...left.entry, decision: 'SKIP_UNSAFE', reason: 'overlapping source paths in recovery metadata' })
        unsafe.push({ ...right.entry, decision: 'SKIP_UNSAFE', reason: 'overlapping source paths in recovery metadata' })
      }
    }
  }
  const unsafeTrash = new Set(unsafe.map(entry => canonicalPath(entry.trash)))
  const safeRecords = records.filter(record => !unsafeTrash.has(canonicalPath(record.entry.trash)))
  for (const item of (await readdir(trashRoot, { withFileTypes: true })).sort((left, right) => codePoint(left.name, right.name))) {
    const path = join(trashRoot, item.name)
    if (!documented.has(canonicalPath(path))) {
      const identity = item.isDirectory() && !item.isSymbolicLink() ? await rootIdentity(root, path).catch(() => undefined) : undefined
      unsafe.push(orphanEntry(path, identity))
    }
  }
  return { records: safeRecords.sort((left, right) => entryOrder(left.entry, right.entry)), unsafe: uniqueUnsafe(unsafe) }
}

function uniqueUnsafe(entries: readonly MutableEntry[]): MutableEntry[] {
  const values = new Map<string, MutableEntry>()
  for (const entry of entries) values.set(`${canonicalPath(entry.trash)}\0${entry.reason}`, entry)
  return [...values.values()].sort(entryOrder)
}

function orphanEntry(path: string, identity: FilesystemIdentity | undefined): MutableEntry {
  const digest = createHash('sha256').update(canonicalPath(path)).digest('hex').slice(0, 24)
  return {
    artifactId: `orphan-${digest}`, orgId: 'unknown', tenantId: 'unknown', projectId: 'unknown', runId: `orphan-${digest}`,
    source: path, trash: path, status: 'INTERRUPTED', completedAt: 0, sizeBytes: 0, logicalBytes: 0, allocatedBytes: 0,
    ...(identity === undefined ? {} : { identity }), decision: 'SKIP_UNSAFE', reason: 'orphan trash has no valid manifest owner', phase: 'RECOVERED',
  }
}

function entrySignature(entry: MutableEntry): string {
  return [entry.artifactId, entry.orgId, entry.tenantId, entry.projectId, entry.runId, canonicalPath(entry.source), entry.status, entry.completedAt].join('\0')
}

function catalogSignature(entry: MutableEntry): string {
  return [entrySignature(entry), entry.logicalBytes, entry.allocatedBytes, entry.identity?.device, entry.identity?.inode].join('\0')
}

function validateCatalogEntry(entry: MutableEntry): void {
  validateCandidate(candidateFromEntry(entry))
  if (!isAbsolute(entry.source) || !isAbsolute(entry.trash)) throw new Error('recovery paths must be absolute')
  validBytes(entry.logicalBytes, 'logicalBytes')
  validBytes(entry.allocatedBytes, 'allocatedBytes')
  if (entry.sizeBytes !== entry.allocatedBytes) throw new Error('legacy sizeBytes conflicts with allocatedBytes')
  if (entry.identity === undefined || !/^\d+$/u.test(entry.identity.device) || !/^\d+$/u.test(entry.identity.inode)) throw new Error('recovery metadata has no valid root identity')
}

function entrySignatureFromCandidate(candidate: ArtifactRetentionCandidate): string {
  return [candidate.artifactId, candidate.orgId, candidate.tenantId, candidate.projectId, candidate.runId, canonicalPath(candidate.directory), candidate.status, candidate.completedAt].join('\0')
}

async function candidateOverlapsEntry(root: string, candidate: ArtifactRetentionCandidate, entry: MutableEntry): Promise<boolean> {
  validateCandidate(candidate)
  const path = resolve(candidate.directory)
  assertDescendant(root, path)
  if (pathsOverlap(path, entry.source) || pathsOverlap(path, entry.trash)) return true
  if (!await exists(path)) return false
  const actual = await rootIdentity(root, path)
  const expected = requireIdentity(entry)
  return actual.device === expected.device && actual.inode === expected.inode
}

function pathsOverlap(left: string, right: string): boolean {
  return samePath(left, right) || isDescendant(left, right) || isDescendant(right, left)
}

function intrinsicProtection(candidate: ArtifactRetentionCandidate): boolean {
  return candidate.active === true || candidate.previewActive === true || candidate.latest === true || candidate.status === 'PENDING' || candidate.status === 'RUNNING'
}

async function inspectTree(root: string, directory: string): Promise<TreeInspection> {
  await assertSafeDirectory(root, directory)
  const mountPoints = await nestedMountPoints(root, directory)
  if (mountPoints.length > 0) throw new Error('artifact tree contains a nested mount point')
  const records: string[] = []
  const inodeCounts = new Map<string, number>()
  const inodeLinkCounts = new Map<string, number>()
  const counted = new Set<string>()
  let logicalBytes = 0
  let allocatedBytes = 0
  const queue: Array<{ path: string; relativePath: string }> = [{ path: directory, relativePath: '.' }]
  while (queue.length > 0) {
    const current = queue.pop()
    if (current === undefined) break
    const info = await lstat(current.path, { bigint: true })
    if (info.isSymbolicLink()) throw new Error('artifact tree contains a symlink or junction')
    const kind = info.isDirectory() ? 'd' : info.isFile() ? 'f' : 'x'
    if (kind === 'x') throw new Error('artifact tree contains an unsupported filesystem entry')
    if (info.dev <= 0n || info.ino <= 0n) throw new Error('artifact tree entry has no stable device/inode identity')
    const inode = `${info.dev}:${info.ino}`
    records.push(`${current.relativePath}\0${kind}\0${inode}\0${info.size}\0${info.mtimeNs}\0${info.blocks}`)
    if (!counted.has(inode)) {
      counted.add(inode)
      allocatedBytes = addSafe(allocatedBytes, allocatedSize(info), 'allocated artifact size')
      if (kind === 'f') logicalBytes = addSafe(logicalBytes, info.size, 'logical artifact size')
    }
    if (kind === 'f') {
      inodeCounts.set(inode, (inodeCounts.get(inode) ?? 0) + 1)
      const links = Number(info.nlink)
      if (!Number.isSafeInteger(links) || links < 1) throw new Error('artifact file has an invalid hard-link count')
      inodeLinkCounts.set(inode, links)
      continue
    }
    const children = (await readdir(current.path, { withFileTypes: true })).sort((left, right) => codePoint(left.name, right.name))
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]
      if (child === undefined) continue
      queue.push({ path: join(current.path, child.name), relativePath: current.relativePath === '.' ? child.name : join(current.relativePath, child.name) })
    }
  }
  const fields = records[0]?.split('\0')
  const inode = fields?.[2]?.split(':')
  if (inode?.[0] === undefined || inode[1] === undefined) throw new Error('artifact tree identity is incomplete')
  return {
    logicalBytes,
    allocatedBytes,
    identity: Object.freeze({ device: inode[0], inode: inode[1], treeHash: createHash('sha256').update(records.join('\n')).digest('hex') }),
    inodeCounts,
    inodeLinkCounts,
  }
}

async function inventoryRoot(root: string, auditRoot: string): Promise<RootInventory> {
  await assertSafeDirectory(root, root)
  const mounts = new Set((await nestedMountPoints(root, root)).map(canonicalPath))
  const controlRoot = dirname(auditRoot)
  const trashRoot = join(controlRoot, 'gc-trash')
  const payloadPaths: string[] = []
  const inodePaths = new Map<string, string[]>()
  const inodeLinkCounts = new Map<string, number>()
  const counted = new Set<string>()
  let logicalBytes = 0
  let allocatedBytes = 0
  let complete = true
  const rootInfo = await lstat(root, { bigint: true })
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootInfo.dev <= 0n || rootInfo.ino <= 0n) throw new Error('artifact root has no safe stable identity')
  const queue = [root]
  while (queue.length > 0) {
    const current = queue.pop()
    if (current === undefined) break
    const children = (await readdir(current, { withFileTypes: true })).sort((left, right) => codePoint(left.name, right.name))
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]
      if (child === undefined) continue
      const path = join(current, child.name)
      if (samePath(path, auditRoot) || isDescendant(auditRoot, path)) continue
      const insideControl = samePath(path, controlRoot) || isDescendant(controlRoot, path)
      const insideTrash = samePath(path, trashRoot) || isDescendant(trashRoot, path)
      if (insideControl && !insideTrash && !samePath(path, controlRoot)) continue
      if (mounts.has(canonicalPath(path))) { complete = false; continue }
      const info = await lstat(path, { bigint: true })
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || info.dev <= 0n || info.ino <= 0n) { complete = false; continue }
      const inode = `${info.dev}:${info.ino}`
      const administrativeContainer = samePath(path, controlRoot) || samePath(path, trashRoot)
      if (!administrativeContainer && !counted.has(inode)) {
        counted.add(inode)
        try { allocatedBytes = addSafe(allocatedBytes, allocatedSize(info), 'allocated root usage') } catch { complete = false }
        if (info.isFile()) logicalBytes = addSafe(logicalBytes, info.size, 'logical root usage')
        payloadPaths.push(path)
      }
      if (info.isDirectory()) { queue.push(path); continue }
      const paths = inodePaths.get(inode) ?? []
      paths.push(path)
      inodePaths.set(inode, paths)
      const links = Number(info.nlink)
      if (!Number.isSafeInteger(links) || links < 1) complete = false
      else inodeLinkCounts.set(inode, links)
    }
  }
  for (const paths of inodePaths.values()) paths.sort(codePoint)
  for (const [inode, paths] of inodePaths) if (paths.length !== inodeLinkCounts.get(inode)) complete = false
  payloadPaths.sort(codePoint)
  return { logicalBytes, allocatedBytes, complete, payloadPaths, inodePaths, inodeLinkCounts }
}

function allocatedSize(info: Awaited<ReturnType<typeof lstat>> & { blocks?: bigint | number }): bigint {
  if (process.platform === 'win32' && info.size > 0 && (info.blocks === 0n || info.blocks === 0)) {
    throw new Error('filesystem does not expose trustworthy allocated block usage')
  }
  if (typeof info.blocks === 'bigint' && info.blocks >= 0n) return info.blocks * 512n
  if (typeof info.blocks === 'number' && Number.isSafeInteger(info.blocks) && info.blocks >= 0) return BigInt(info.blocks) * 512n
  throw new Error('filesystem does not expose allocated block usage')
}

function addSafe(current: number, increment: bigint, label: string): number {
  const result = BigInt(current) + increment
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds safe integer range`)
  return Number(result)
}

async function rootIdentity(root: string, path: string): Promise<FilesystemIdentity> {
  await assertSafeDirectory(root, path)
  const info = await lstat(path, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink() || info.dev <= 0n || info.ino <= 0n) throw new Error('trash root has no safe stable identity')
  return { device: String(info.dev), inode: String(info.ino), treeHash: '' }
}

async function assertRootIdentity(root: string, path: string, expected: FilesystemIdentity): Promise<void> {
  const actual = await rootIdentity(root, path)
  if (actual.device !== expected.device || actual.inode !== expected.inode) throw new Error('filesystem root device/inode identity changed')
}

async function assertSafePartialTree(root: string, path: string, expected: FilesystemIdentity): Promise<void> {
  await assertRootIdentity(root, path, expected)
  if ((await nestedMountPoints(root, path)).length > 0) throw new Error('partial trash contains a nested mount point')
  const queue = [path]
  while (queue.length > 0) {
    const current = queue.pop()
    if (current === undefined) break
    for (const child of (await readdir(current, { withFileTypes: true })).sort((left, right) => codePoint(left.name, right.name))) {
      const childPath = join(current, child.name)
      const info = await lstat(childPath, { bigint: true })
      if (info.isSymbolicLink()) throw new Error('partial trash contains a symlink or junction')
      if (info.isDirectory()) queue.push(childPath)
      else if (!info.isFile()) throw new Error('partial trash contains an unsupported filesystem entry')
    }
  }
}

async function nestedMountPoints(root: string, target: string): Promise<string[]> {
  if (process.platform === 'win32') return []
  if (process.platform !== 'linux') throw new Error('safe mount-boundary verification is unsupported on this platform')
  let contents: string
  try { contents = await readFile('/proc/self/mountinfo', 'utf8') } catch { throw new Error('cannot prove mount boundaries without /proc/self/mountinfo') }
  const result: string[] = []
  for (const line of contents.split('\n')) {
    const encoded = line.split(' ')[4]
    if (encoded === undefined) continue
    const mount = resolve(encoded.replace(/\\([0-7]{3})/gu, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8))))
    if (samePath(mount, root)) continue
    if (samePath(mount, target) || isDescendant(target, mount)) result.push(mount)
  }
  return result.sort(codePoint)
}

async function assertNoMountBoundary(root: string, target: string): Promise<void> {
  if ((await nestedMountPoints(root, target)).length > 0) throw new Error('retention control path contains a mount boundary')
}

async function assertSafeDirectory(root: string, target: string): Promise<void> {
  assertDescendantOrSame(root, target)
  const rootPath = resolve(root)
  const targetPath = resolve(target)
  if (!samePath(await realpath(rootPath), rootPath)) throw new Error('artifact root resolves through a symlink or junction')
  let current = rootPath
  for (const part of ['', ...relative(rootPath, targetPath).split(sep).filter(Boolean)]) {
    if (part !== '') current = join(current, part)
    const info = await lstat(current, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('artifact path is not a safe directory')
    if (info.dev <= 0n || info.ino <= 0n) throw new Error('artifact path has no stable device/inode identity')
  }
  if (!samePath(await realpath(targetPath), targetPath)) throw new Error('artifact path resolves outside its lexical location')
}

async function ensureDirectory(root: string, target: string): Promise<void> {
  assertDescendant(root, target)
  await mkdir(target, { recursive: true, mode: 0o700 })
  await assertSafeDirectory(root, target)
}

function validateGuard(guard: { generation: string; validate: () => unknown; release: () => unknown }, label: string): void {
  if (typeof guard.generation !== 'string' || guard.generation.length === 0 || typeof guard.validate !== 'function' || typeof guard.release !== 'function') throw new Error(`${label} is invalid`)
}

function validateReservation(reservation: ProtectionReservation, label: string): void {
  validateGuard(reservation, label)
  if (typeof reservation.protected !== 'boolean' || (reservation.reason !== undefined && typeof reservation.reason !== 'string')) throw new Error(`${label} has an invalid protection state`)
}

async function assertGuard(guard: { validate: () => boolean | Promise<boolean> }, label: string): Promise<void> {
  if (!await guard.validate()) throw new ArtifactRetentionError('GC_IO_FAILURE', `${label} generation is no longer current`)
}

function validatePolicy(policy: ArtifactRetentionPolicy): ArtifactRetentionPolicy {
  for (const [key, value] of Object.entries(policy)) if (!Number.isSafeInteger(value) || value < 0) throw new ArtifactRetentionError('INVALID_RETENTION_CONFIG', `${key} must be a non-negative safe integer`)
  if (policy.failedRetentionMs === 0 || policy.supersededPassedRetentionMs === 0 || policy.preserveNewestPerProject < 1) throw new ArtifactRetentionError('INVALID_RETENTION_CONFIG', 'retention durations and preserveNewestPerProject must be positive')
  return Object.freeze({ ...policy })
}

function validateCandidate(candidate: ArtifactRetentionCandidate): void {
  for (const [key, value] of Object.entries({ artifactId: candidate.artifactId, orgId: candidate.orgId, tenantId: candidate.tenantId, projectId: candidate.projectId, runId: candidate.runId })) validIdentifier(value, key)
  validTimestamp(candidate.completedAt, 'completedAt')
  if (!['PENDING', 'RUNNING', 'PASSED', 'FAILED', 'INTERRUPTED', 'CANCELLED'].includes(candidate.status)) throw new ArtifactRetentionError('INVALID_RETENTION_CONFIG', 'status is invalid')
  if (!isAbsolute(candidate.directory)) throw new Error('artifact directory must be absolute')
}

function validIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) throw new ArtifactRetentionError('INVALID_RETENTION_CONFIG', `${label} is invalid`)
  return value
}

function validTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new ArtifactRetentionError('INVALID_RETENTION_CONFIG', `${label} must be a non-negative safe integer`)
  return value
}

function validBytes(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new ArtifactRetentionError('GC_IO_FAILURE', `${label} must be a non-negative safe integer`)
  return value
}

async function diskFreeBytes(root: string): Promise<number> {
  const result = await statfs(root, { bigint: true })
  const bytes = result.bavail * result.bsize
  return bytes > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(bytes)
}

async function persistManifest(path: string, manifest: object): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, path)
    await syncDirectory(dirname(path))
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle
  try {
    handle = await open(path, 'r')
    await handle.sync()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (process.platform === 'win32' && ['EISDIR', 'EINVAL', 'EPERM', 'EACCES'].includes(code ?? '')) return
    throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function acquireLease(controlRoot: string, executionId: string, token: string): Promise<Lease> {
  const path = join(controlRoot, 'gc.lock')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify({ executionId, token, pid: process.pid, createdAt: Date.now() })}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await syncDirectory(controlRoot)
      return { path, token }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = await readLease(path)
      if (existing !== undefined && processAlive(existing.pid)) throw new ArtifactRetentionError('GC_ALREADY_RUNNING', `retention collector ${existing.executionId} is already running`)
      const stale = `${path}.stale.${randomUUID()}`
      try {
        await rename(path, stale)
        await syncDirectory(controlRoot)
        await unlink(stale)
        await syncDirectory(controlRoot)
      } catch (staleError) {
        if ((staleError as NodeJS.ErrnoException).code !== 'ENOENT') throw staleError
      }
    }
  }
  throw new ArtifactRetentionError('GC_ALREADY_RUNNING', 'could not acquire retention collector lease')
}

async function releaseLease(lease: Lease): Promise<void> {
  if ((await readLease(lease.path))?.token !== lease.token) return
  await unlink(lease.path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
  await syncDirectory(dirname(lease.path))
}

async function assertFence(lease: Lease): Promise<void> {
  if ((await readLease(lease.path))?.token !== lease.token) throw new ArtifactRetentionError('GC_IO_FAILURE', 'retention collector lost its fencing lease')
}

async function readLease(path: string): Promise<{ executionId: string; token: string; pid: number } | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as { executionId?: unknown; token?: unknown; pid?: unknown }
    return typeof value.executionId === 'string' && typeof value.token === 'string' && Number.isSafeInteger(value.pid)
      ? { executionId: value.executionId, token: value.token, pid: value.pid as number }
      : undefined
  } catch {
    return undefined
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

function protectionReason(candidate: ArtifactRetentionCandidate, newest: Set<string> | undefined, latestValid: string | undefined): string | undefined {
  if (candidate.active === true || candidate.status === 'PENDING' || candidate.status === 'RUNNING') return 'active artifact'
  if (candidate.previewActive === true) return 'active preview artifact'
  if (candidate.latest === true) return 'explicit latest artifact'
  if (latestValid === candidate.artifactId) return 'latest valid artifact'
  if (newest?.has(candidate.artifactId) === true) return 'one of the newest project artifacts'
  return undefined
}

function trashName(candidate: ArtifactRetentionCandidate): string {
  const digest = createHash('sha256').update(`${candidate.orgId}\0${candidate.tenantId}\0${candidate.projectId}\0${candidate.runId}\0${canonicalPath(candidate.directory)}`).digest('hex')
  return `${candidate.artifactId}-${digest.slice(0, 24)}`
}

function projectKey(value: Pick<ArtifactRetentionCandidate, 'orgId' | 'tenantId' | 'projectId'>): string { return `${value.orgId}\0${value.tenantId}\0${value.projectId}` }
function tenantKey(value: Pick<ArtifactRetentionCandidate, 'orgId' | 'tenantId'>): string { return `${value.orgId}/${value.tenantId}` }
function candidateOrder(left: ArtifactRetentionCandidate, right: ArtifactRetentionCandidate): number { return codePoint(projectKey(left), projectKey(right)) || codePoint(left.artifactId, right.artifactId) || codePoint(canonicalPath(left.directory), canonicalPath(right.directory)) }
function newestFirst(left: Inspected, right: Inspected): number { return right.candidate.completedAt - left.candidate.completedAt || candidateOrder(left.candidate, right.candidate) }
function oldestFirst(left: Planned, right: Planned): number { return left.entry.completedAt - right.entry.completedAt || entryOrder(left.entry, right.entry) }
function entryOrder(left: MutableEntry, right: MutableEntry): number { return codePoint(projectKey(left), projectKey(right)) || codePoint(left.artifactId, right.artifactId) || codePoint(canonicalPath(left.source), canonicalPath(right.source)) }
function codePoint(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
function duplicates(values: readonly string[]): Set<string> {
  const seen = new Map<string, string>()
  const result = new Set<string>()
  for (const value of values) {
    const key = process.platform === 'win32' ? value.toLowerCase() : value
    const previous = seen.get(key)
    if (previous !== undefined) { result.add(previous); result.add(value) } else seen.set(key, value)
  }
  return result
}
function overlappingPaths(values: readonly string[]): Set<string> {
  const result = new Set<string>()
  for (let leftIndex = 0; leftIndex < values.length; leftIndex += 1) for (let rightIndex = leftIndex + 1; rightIndex < values.length; rightIndex += 1) {
    const left = values[leftIndex]
    const right = values[rightIndex]
    if (left !== undefined && right !== undefined && (samePath(left, right) || isDescendant(left, right) || isDescendant(right, left))) { result.add(left); result.add(right) }
  }
  return result
}
function assertOutside(root: string, target: string): void { if (samePath(root, target) || isDescendant(root, target)) throw new Error('artifact path overlaps the retention control directory') }
function assertDescendant(root: string, target: string): void { if (!isDescendant(root, target)) throw new Error('artifact path must be a strict descendant of the configured root') }
function assertDescendantOrSame(root: string, target: string): void { if (!samePath(root, target) && !isDescendant(root, target)) throw new Error('artifact path escapes the configured root') }
function isDescendant(root: string, target: string): boolean { const path = relative(resolve(root), resolve(target)); return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path) }
function canonicalPath(path: string): string { const value = resolve(path); return process.platform === 'win32' ? value.toLowerCase() : value }
function samePath(left: string, right: string): boolean { return canonicalPath(left) === canonicalPath(right) }
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }
function requireIdentity(entry: MutableEntry): FilesystemIdentity { if (entry.identity === undefined) throw new Error('retention entry has no persisted filesystem identity'); return entry.identity }
function candidateFromEntry(entry: MutableEntry): ArtifactRetentionCandidate { return { artifactId: entry.artifactId, orgId: entry.orgId, tenantId: entry.tenantId, projectId: entry.projectId, runId: entry.runId, directory: entry.source, status: entry.status, completedAt: entry.completedAt } }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function freezeManifest(manifest: MutableManifest): RetentionManifest { return Object.freeze({ ...manifest, entries: Object.freeze(manifest.entries.map(entry => Object.freeze({ ...entry }))) }) }

export async function readRetentionManifest(path: string): Promise<RetentionManifest> {
  return JSON.parse(await readFile(path, 'utf8')) as RetentionManifest
}
