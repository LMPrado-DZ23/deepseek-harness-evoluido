import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { PreviewAdmission, PreviewRecord } from '../src/model.ts'
import {
  StudioPreviewService,
  type PreviewActor,
  type PreviewRepository,
  type PreviewRuntimePort,
  type PreviewSessionPort,
  type PreviewSourcePort,
} from '../src/service.ts'

class MemoryRepository implements PreviewRepository {
  readonly previewMap = new Map<string, PreviewRecord>()
  readonly admissionMap = new Map<string, PreviewAdmission>()
  readonly previewWrites: PreviewRecord[] = []

  previews(): readonly PreviewRecord[] { return [...this.previewMap.values()] }
  admissions(): readonly PreviewAdmission[] { return [...this.admissionMap.values()] }
  putPreview(record: PreviewRecord): Promise<void> {
    this.previewMap.set(record.preview_id, record)
    this.previewWrites.push(record)
    return Promise.resolve()
  }
  putAdmission(record: PreviewAdmission): Promise<void> {
    this.admissionMap.set(record.admission_id, record)
    return Promise.resolve()
  }
}

class DelayedExchangeRepository extends MemoryRepository {
  readonly #gate: Promise<void>
  #release!: () => void
  exchangeWrites = 0

  constructor() {
    super()
    this.#gate = new Promise<void>(resolve => { this.#release = resolve })
  }

  override async putAdmission(record: PreviewAdmission): Promise<void> {
    if (record.exchanged_at !== null) {
      this.exchangeWrites++
      await this.#gate
    }
    return super.putAdmission(record)
  }

  releaseExchange(): void { this.#release() }
}

class DelayedHeartbeatRepository extends MemoryRepository {
  readonly #gate: Promise<void>
  #release!: () => void
  blockRenewal = false
  renewalWrites = 0
  admissionReads = 0

  constructor() {
    super()
    this.#gate = new Promise<void>(resolve => { this.#release = resolve })
  }

  override admissions(): readonly PreviewAdmission[] {
    this.admissionReads++
    return super.admissions()
  }

  override async putAdmission(record: PreviewAdmission): Promise<void> {
    if (this.blockRenewal && record.exchanged_at === null && record.revoked_at === null) {
      this.renewalWrites++
      await this.#gate
    }
    return super.putAdmission(record)
  }

  releaseHeartbeat(): void { this.#release() }
}

const owner: PreviewActor = {
  userId: 'user-1', orgId: 'org-1', tenantId: 'tenant-1', role: 'owner', sessionId: 'session-1',
}

const viewer: PreviewActor = { ...owner, userId: 'viewer-1', role: 'viewer', sessionId: 'session-viewer' }

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function createHarness(options: {
  now?: Date
  ttlSeconds?: number
  repository?: MemoryRepository
  source?: Partial<PreviewSourcePort>
  runtime?: Partial<PreviewRuntimePort>
  sessions?: Partial<PreviewSessionPort>
  runtimeTimeoutMs?: number
  onCleanupFailure?: (previewId: string) => void
} = {}) {
  const repository = options.repository ?? new MemoryRepository()
  let currentTime = options.now ?? new Date('2026-09-03T12:00:00.000Z')
  let id = 0
  let secret = 0
  const sourceArtifact = {
    projectId: 'project-1', runId: 'run-from-source', artifactPath: '/verified/artifact-only', artifactSha256: sha('artifact'),
  }
  const source: PreviewSourcePort = {
    verifiedArtifact: vi.fn(() => Promise.resolve(sourceArtifact)),
    ...options.source,
  }
  const runtime: PreviewRuntimePort = {
    start: vi.fn(() => Promise.resolve({ runtimeRef: 'container:preview-1' })),
    stop: vi.fn(() => Promise.resolve()),
    health: vi.fn(() => Promise.resolve('OK' as const)),
    logs: vi.fn(() => Promise.resolve([])),
    verificationMessages: vi.fn(() => Promise.resolve([])),
    listManaged: vi.fn(() => Promise.resolve([])),
    ...options.runtime,
  }
  const sessions: PreviewSessionPort = {
    isActive: vi.fn(() => true),
    canRead: vi.fn(() => true),
    ...options.sessions,
  }
  const service = new StudioPreviewService({
    repository, source, runtime, sessions,
    now: () => currentTime,
    createId: () => `id-${++id}`,
    createSecret: () => `secret-${++secret}`,
    ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
    ...(options.runtimeTimeoutMs === undefined ? {} : { runtimeTimeoutMs: options.runtimeTimeoutMs }),
    ...(options.onCleanupFailure === undefined ? {} : { onCleanupFailure: options.onCleanupFailure }),
  })
  return {
    repository, source, runtime, sessions, service, sourceArtifact,
    setNow(value: Date) { currentTime = value },
  }
}

async function ready(h: ReturnType<typeof createHarness>, actor = owner) {
  return h.service.start(actor, 'project-1', 'requested-run')
}

describe('StudioPreviewService lifecycle and isolation', () => {
  it('persists REQUESTED -> STARTING -> READY and starts only the artifact verified by the source port', async () => {
    const h = createHarness()
    const result = await ready(h)

    expect(h.source.verifiedArtifact).toHaveBeenCalledWith(owner, 'project-1', 'requested-run')
    expect(h.repository.previewWrites.map(record => record.state)).toEqual(['REQUESTED', 'STARTING', 'READY'])
    expect(h.runtime.start).toHaveBeenCalledWith({
      previewId: 'id-1',
      artifactPath: '/verified/artifact-only',
      artifactSha256: h.sourceArtifact.artifactSha256,
      labels: { 'dz23.managed': 'preview', 'dz23.preview_id': 'id-1' },
      environment: { APP_EMAIL_MODE: 'studio-preview', DZ23_PREVIEW_ID: 'id-1', DATA_DIR: '/data' },
    }, expect.any(AbortSignal))
    expect(result.preview).toMatchObject({
      preview_id: 'id-1', project_id: 'project-1', run_id: 'run-from-source', state: 'READY', health: 'OK',
    })
  })

  it('deduplicates concurrent starts for the same verified artifact', async () => {
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const start = vi.fn(async () => {
      await blocked
      return { runtimeRef: 'container:one' }
    })
    const h = createHarness({ runtime: { start } })

    const first = ready(h)
    const second = ready(h)
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1))
    release()
    const [a, b] = await Promise.all([first, second])

    expect(start).toHaveBeenCalledTimes(1)
    expect(a.preview.preview_id).toBe(b.preview.preview_id)
    expect(a.admissionTicket).not.toBe(b.admissionTicket)
    expect(h.repository.previews()).toHaveLength(1)
    expect(h.repository.admissions()).toHaveLength(2)
  })

  it('does not reuse a READY record when the live runtime is down', async () => {
    const h = createHarness()
    const first = await ready(h)
    vi.mocked(h.runtime.health).mockResolvedValue('DOWN')

    await expect(ready(h)).rejects.toMatchObject({ code: 'UNAVAILABLE' })

    expect(h.runtime.start).toHaveBeenCalledTimes(2)
    expect(h.repository.previews().find(item => item.preview_id === first.preview.preview_id)).toMatchObject({
      state: 'FAILED', health: 'DOWN', failure_code: 'RUNTIME_DOWN',
    })
    expect(h.repository.previews().filter(item => item.state === 'READY')).toEqual([])
    expect(h.repository.admissions().find(item => item.preview_id === first.preview.preview_id)?.revoked_at).not.toBeNull()
  })

  it('fails closed before a new runtime when unhealthy READY cleanup fails', async () => {
    const onCleanupFailure = vi.fn()
    const h = createHarness({ onCleanupFailure })
    const first = await ready(h)
    vi.mocked(h.runtime.health).mockResolvedValue('DOWN')
    vi.mocked(h.runtime.stop).mockRejectedValue(new Error('runtime still alive'))

    await expect(ready(h)).rejects.toMatchObject({ code: 'UNAVAILABLE' })

    expect(h.runtime.start).toHaveBeenCalledTimes(1)
    expect(h.repository.previews()).toHaveLength(1)
    expect(h.repository.previews()[0]).toMatchObject({
      preview_id: first.preview.preview_id,
      state: 'STOPPING', stopped_at: null, stop_reason: 'failed', health: 'DOWN',
      runtime_ref: 'container:preview-1', failure_code: 'RUNTIME_CLEANUP_INCOMPLETE',
    })
    expect(h.repository.previews().some(item => item.state === 'READY')).toBe(false)
    expect(h.repository.admissions().find(item => item.preview_id === first.preview.preview_id)?.revoked_at).not.toBeNull()
    expect(onCleanupFailure).toHaveBeenCalledTimes(1)
    expect(onCleanupFailure).toHaveBeenCalledWith(first.preview.preview_id)
  })

  it('fails closed after revoking a prior preview whose runtime cleanup fails', async () => {
    const firstArtifact = { projectId: 'project-1', runId: 'run-1', artifactPath: '/verified/run-1', artifactSha256: sha('run-1') }
    const secondArtifact = { projectId: 'project-1', runId: 'run-2', artifactPath: '/verified/run-2', artifactSha256: sha('run-2') }
    const verifiedArtifact = vi.fn()
      .mockResolvedValueOnce(firstArtifact)
      .mockResolvedValueOnce(secondArtifact)
    const start = vi.fn(async (input: Parameters<PreviewRuntimePort['start']>[0]) => ({ runtimeRef: `container:${input.previewId}` }))
    const stop = vi.fn(async (runtimeRef: string) => {
      if (runtimeRef === 'container:id-1') throw new Error('cleanup failed')
    })
    const onCleanupFailure = vi.fn()
    const h = createHarness({ source: { verifiedArtifact }, runtime: { start, stop }, onCleanupFailure })

    const first = await ready(h)
    await expect(ready(h)).rejects.toMatchObject({ code: 'UNAVAILABLE' })

    expect(start).toHaveBeenCalledTimes(1)
    expect(h.repository.previews().filter(record => ['REQUESTED', 'STARTING', 'READY', 'STOPPING'].includes(record.state))).toHaveLength(1)
    expect(h.repository.previews().filter(record => record.state === 'READY')).toHaveLength(0)
    expect(h.repository.previews().find(record => record.preview_id === first.preview.preview_id)).toMatchObject({
      state: 'STOPPING', stopped_at: null, stop_reason: 'replaced', health: 'DOWN', failure_code: 'RUNTIME_CLEANUP_INCOMPLETE',
    })
    expect(h.repository.admissions().find(item => item.preview_id === first.preview.preview_id)?.revoked_at).not.toBeNull()
    expect(stop).toHaveBeenCalledWith('container:id-1', expect.any(AbortSignal))
    expect(onCleanupFailure).toHaveBeenCalledWith(first.preview.preview_id)
  })

  it('successfully replaces a prior preview while preserving exactly one active runtime', async () => {
    const firstArtifact = { projectId: 'project-1', runId: 'run-1', artifactPath: '/verified/run-1', artifactSha256: sha('run-1') }
    const secondArtifact = { projectId: 'project-1', runId: 'run-2', artifactPath: '/verified/run-2', artifactSha256: sha('run-2') }
    const verifiedArtifact = vi.fn()
      .mockResolvedValueOnce(firstArtifact)
      .mockResolvedValueOnce(secondArtifact)
    const start = vi.fn(async (input: Parameters<PreviewRuntimePort['start']>[0]) => ({ runtimeRef: `container:${input.previewId}` }))
    const h = createHarness({ source: { verifiedArtifact }, runtime: { start } })

    const first = await ready(h)
    const second = await ready(h)

    expect(start).toHaveBeenCalledTimes(2)
    expect(h.repository.previews().filter(record => ['REQUESTED', 'STARTING', 'READY', 'STOPPING'].includes(record.state))).toHaveLength(1)
    expect(h.repository.previews().find(record => record.preview_id === first.preview.preview_id)).toMatchObject({
      state: 'STOPPED', stop_reason: 'replaced', health: 'DOWN', failure_code: null,
    })
    expect(h.repository.admissions().find(item => item.preview_id === first.preview.preview_id)?.revoked_at).not.toBeNull()
    expect(second.preview).toMatchObject({ state: 'READY', run_id: 'run-2', artifact_sha256: secondArtifact.artifactSha256 })
  })

  it('never publishes READY when runtime readiness is DOWN and attempts cleanup', async () => {
    const h = createHarness({ runtime: { health: vi.fn(() => Promise.resolve('DOWN' as const)) } })

    await expect(ready(h)).rejects.toMatchObject({ code: 'UNAVAILABLE' })

    expect(h.runtime.stop).toHaveBeenCalledWith('container:preview-1', expect.any(AbortSignal))
    expect(h.repository.previews()[0]).toMatchObject({ state: 'FAILED', health: 'DOWN', stop_reason: 'failed', failure_code: 'UNAVAILABLE' })
    expect(h.repository.previewWrites.some(record => record.state === 'READY')).toBe(false)
    expect(h.repository.admissions()).toEqual([])
  })

  it('keeps readiness failure in STOPPING when its started runtime cannot be cleaned up', async () => {
    const onCleanupFailure = vi.fn()
    const h = createHarness({
      onCleanupFailure,
      runtime: {
        health: vi.fn(() => Promise.resolve('DOWN' as const)),
        stop: vi.fn(() => Promise.reject(new Error('cleanup unavailable'))),
      },
    })

    await expect(ready(h)).rejects.toMatchObject({ code: 'UNAVAILABLE' })

    expect(h.repository.previews()[0]).toMatchObject({
      state: 'STOPPING', stopped_at: null, stop_reason: 'failed', health: 'DOWN',
      runtime_ref: 'container:preview-1', failure_code: 'RUNTIME_CLEANUP_INCOMPLETE',
    })
    expect(h.repository.previewWrites.some(record => record.state === 'READY')).toBe(false)
    expect(onCleanupFailure).toHaveBeenCalledWith('id-1')
  })

  it('forbids viewers from starting or stopping previews', async () => {
    const h = createHarness()
    await expect(h.service.start(viewer, 'project-1')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const { preview } = await ready(h)
    await expect(h.service.stop(viewer, 'project-1', preview.preview_id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(h.runtime.stop).not.toHaveBeenCalled()
  })

  it('returns NOT_FOUND instead of revealing a preview across tenant boundaries', async () => {
    const h = createHarness()
    const { preview } = await ready(h)
    const outsider: PreviewActor = { ...owner, tenantId: 'tenant-2', sessionId: 'session-2' }

    expect(h.service.list(outsider, 'project-1')).toEqual([])
    expect(() => h.service.get(outsider, 'project-1', preview.preview_id)).toThrowError(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    )
    await expect(h.service.stop(outsider, 'project-1', preview.preview_id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('returns no runtime reference, hostname, artifact path, ticket or cookie in public records', async () => {
    const h = createHarness()
    const { preview } = await ready(h)
    const serialized = JSON.stringify(preview)

    expect(Object.keys(preview).sort()).toEqual([
      'artifact_sha256', 'created_at', 'expires_at', 'failure_code', 'health', 'preview_id', 'project_id',
      'ready_at', 'run_id', 'state', 'stop_reason', 'stopped_at', 'url',
    ])
    expect(serialized).not.toContain('runtime_ref')
    expect(serialized).not.toContain('container:preview-1')
    expect(serialized).not.toContain('/verified/artifact-only')
    expect(serialized).not.toContain('admissionTicket')
    expect(serialized).not.toContain('cookie')
    expect(preview.url).toMatch(/^http:\/\/p-[a-f0-9]{24}\.localhost$/u)
  })

  it('marks a failed runtime start as FAILED without issuing admission', async () => {
    const h = createHarness({ runtime: { start: vi.fn(() => Promise.reject(new Error('docker secret detail'))) } })

    await expect(ready(h)).rejects.toThrow('docker secret detail')
    expect(h.repository.previews()[0]).toMatchObject({
      state: 'FAILED', health: 'DOWN', stop_reason: 'failed', failure_code: 'RUNTIME_START_FAILED',
    })
    expect(h.repository.admissions()).toEqual([])
  })

  it('stops once, revokes admission and remains idempotent', async () => {
    const h = createHarness()
    const { preview } = await ready(h)

    const first = await h.service.stop(owner, 'project-1', preview.preview_id)
    const second = await h.service.stop(owner, 'project-1', preview.preview_id)

    expect(h.runtime.stop).toHaveBeenCalledTimes(1)
    expect(first).toMatchObject({ state: 'STOPPED', health: 'DOWN', stop_reason: 'user' })
    expect(second).toEqual(first)
    expect(h.repository.admissions()[0]?.revoked_at).not.toBeNull()
  })
})

describe('StudioPreviewService admissions', () => {
  it('stores ticket and cookie only as hashes and exchanges a ticket once', async () => {
    const h = createHarness()
    const { preview, admissionTicket } = await ready(h)
    const before = h.repository.admissions()[0]!

    expect(before.ticket_hash).toBe(sha(admissionTicket))
    expect(JSON.stringify(before)).not.toContain(admissionTicket)
    const exchanged = await h.service.exchange(new URL(preview.url).hostname.toUpperCase(), admissionTicket)
    const after = h.repository.admissions()[0]!

    expect(exchanged.cookie).toBe('secret-2')
    expect(after.cookie_hash).toBe(sha(exchanged.cookie))
    expect(after.ticket_hash).not.toBe(before.ticket_hash)
    expect(JSON.stringify(after)).not.toContain(exchanged.cookie)
    await expect(h.service.exchange(new URL(preview.url).hostname, admissionTicket)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('allows exactly one concurrent exchange of the same one-shot ticket', async () => {
    const repository = new DelayedExchangeRepository()
    const h = createHarness({ repository })
    const { preview, admissionTicket } = await ready(h)
    const host = new URL(preview.url).hostname

    const exchanges = [h.service.exchange(host, admissionTicket), h.service.exchange(host, admissionTicket)]
    await vi.waitFor(() => expect(repository.exchangeWrites).toBe(1))
    repository.releaseExchange()
    const results = await Promise.allSettled(exchanges)

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter(result => result.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('rejects exchange after session revocation and authorization after membership removal', async () => {
    let active = true
    let membership = true
    const h = createHarness({
      sessions: {
        isActive: vi.fn(() => active),
        canRead: vi.fn(() => membership),
      },
    })
    const first = await ready(h)
    const host = new URL(first.preview.url).hostname
    active = false
    await expect(h.service.exchange(host, first.admissionTicket)).rejects.toMatchObject({ code: 'FORBIDDEN' })

    active = true
    const cookie = (await h.service.exchange(host, first.admissionTicket)).cookie
    expect(h.service.authorize(host, cookie)).toEqual({ previewId: first.preview.preview_id, runtimeRef: 'container:preview-1' })
    membership = false
    expect(() => h.service.authorize(host, cookie)).toThrowError(expect.objectContaining({ code: 'UNAUTHENTICATED' }))
  })
})

describe('StudioPreviewService heartbeat', () => {
  it('renews preview and admissions in steps without crossing the absolute two-hour limit', async () => {
    const h = createHarness({ ttlSeconds: 30 * 60 })
    const { preview, admissionTicket } = await ready(h)

    for (const time of ['12:20:00', '12:40:00', '13:00:00', '13:20:00', '13:40:00']) {
      h.setNow(new Date(`2026-09-03T${time}.000Z`))
      await h.service.heartbeat(owner, 'project-1', preview.preview_id)
    }

    const renewed = h.service.get(owner, 'project-1', preview.preview_id)
    expect(renewed.expires_at).toBe('2026-09-03T14:00:00.000Z')
    expect(h.repository.admissions()[0]?.expires_at).toBe(renewed.expires_at)
    const exchanged = await h.service.exchange(new URL(preview.url).hostname, admissionTicket)
    expect(exchanged.maxAge).toBe(20 * 60)
  })

  it('refuses viewer, expired, and unhealthy preview renewals', async () => {
    const viewerHarness = createHarness()
    const viewerPreview = await ready(viewerHarness)
    await expect(viewerHarness.service.heartbeat(viewer, 'project-1', viewerPreview.preview.preview_id)).rejects.toMatchObject({ code: 'FORBIDDEN' })

    const expiredHarness = createHarness({ ttlSeconds: 60 })
    const expiredPreview = await ready(expiredHarness)
    expiredHarness.setNow(new Date('2026-09-03T12:01:01.000Z'))
    await expect(expiredHarness.service.heartbeat(owner, 'project-1', expiredPreview.preview.preview_id)).rejects.toMatchObject({ code: 'CONFLICT' })

    const downHarness = createHarness()
    const downPreview = await ready(downHarness)
    vi.mocked(downHarness.runtime.health).mockResolvedValue('DOWN')
    await expect(downHarness.service.heartbeat(owner, 'project-1', downPreview.preview.preview_id)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it('serializes heartbeat renewal with one-shot exchange without reviving the old ticket', async () => {
    const repository = new DelayedHeartbeatRepository()
    const h = createHarness({ repository, ttlSeconds: 30 * 60 })
    const { preview, admissionTicket } = await ready(h)
    const host = new URL(preview.url).hostname
    h.setNow(new Date('2026-09-03T12:20:00.000Z'))
    repository.blockRenewal = true
    const readsBefore = repository.admissionReads

    const heartbeat = h.service.heartbeat(owner, 'project-1', preview.preview_id)
    await vi.waitFor(() => expect(repository.renewalWrites).toBe(1))
    const exchange = h.service.exchange(host, admissionTicket)
    await vi.waitFor(() => expect(repository.admissionReads).toBeGreaterThanOrEqual(readsBefore + 2))
    repository.releaseHeartbeat()

    await expect(heartbeat).resolves.toMatchObject({ expires_at: '2026-09-03T12:50:00.000Z' })
    const exchanged = await exchange
    expect(h.service.authorize(host, exchanged.cookie)).toEqual({ previewId: preview.preview_id, runtimeRef: 'container:preview-1' })
    expect(h.repository.admissions()[0]).toMatchObject({ exchanged_at: '2026-09-03T12:20:00.000Z', expires_at: '2026-09-03T12:50:00.000Z' })
    await expect(h.service.exchange(host, admissionTicket)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('StudioPreviewService maintenance and diagnostics', () => {
  it('expires active previews after TTL, stops their runtime and revokes admissions', async () => {
    const h = createHarness({ ttlSeconds: 60 })
    const { preview } = await ready(h)
    h.setNow(new Date('2026-09-03T12:01:01.000Z'))

    await expect(h.service.reap()).resolves.toBe(1)
    expect(h.runtime.stop).toHaveBeenCalledWith('container:preview-1', expect.any(AbortSignal))
    expect(h.service.get(owner, 'project-1', preview.preview_id)).toMatchObject({
      state: 'EXPIRED', health: 'DOWN', stop_reason: 'expired',
    })
    expect(h.repository.admissions()[0]?.revoked_at).not.toBeNull()
    await expect(h.service.reap()).resolves.toBe(0)
  })

  it('stops orphan runtimes and fails READY records whose runtime disappeared', async () => {
    const h = createHarness()
    const { preview } = await ready(h)
    vi.mocked(h.runtime.listManaged).mockResolvedValue([
      { runtimeRef: 'container:orphan', previewId: 'not-recorded' },
    ])

    await expect(h.service.reconcile()).resolves.toEqual({ stoppedOrphans: 1, failedRecords: 1 })
    expect(h.runtime.stop).toHaveBeenCalledWith('container:orphan', expect.any(AbortSignal))
    expect(h.service.get(owner, 'project-1', preview.preview_id)).toMatchObject({
      state: 'FAILED', health: 'DOWN', stop_reason: 'reconciled', failure_code: 'RUNTIME_MISSING',
    })
    expect(h.repository.admissions()[0]?.revoked_at).not.toBeNull()
  })

  it('keeps an expired managed record in STOPPING when reconcile cannot clean its runtime', async () => {
    const onCleanupFailure = vi.fn()
    const h = createHarness({ ttlSeconds: 60, onCleanupFailure })
    const { preview } = await ready(h)
    h.setNow(new Date('2026-09-03T12:01:01.000Z'))
    vi.mocked(h.runtime.listManaged).mockResolvedValue([
      { runtimeRef: 'container:preview-1', previewId: preview.preview_id },
    ])
    vi.mocked(h.runtime.stop).mockRejectedValue(new Error('runtime still alive'))

    await expect(h.service.reconcile()).resolves.toEqual({ stoppedOrphans: 0, failedRecords: 0 })

    expect(h.repository.previews().find(item => item.preview_id === preview.preview_id)).toMatchObject({
      state: 'STOPPING', stopped_at: null, stop_reason: 'expired', health: 'DOWN',
      runtime_ref: 'container:preview-1', failure_code: 'RUNTIME_CLEANUP_INCOMPLETE',
    })
    expect(h.repository.admissions().find(item => item.preview_id === preview.preview_id)?.revoked_at).not.toBeNull()
    expect(onCleanupFailure).toHaveBeenCalledWith(preview.preview_id)
  })

  it('does not count a failed terminal cleanup and continues with later orphan runtimes', async () => {
    const onCleanupFailure = vi.fn()
    const h = createHarness({ onCleanupFailure })
    const { preview } = await ready(h)
    await h.service.stop(owner, 'project-1', preview.preview_id)
    vi.mocked(h.runtime.stop).mockClear()
    vi.mocked(h.runtime.stop).mockImplementation(runtimeRef => runtimeRef === 'container:preview-1'
      ? Promise.reject(new Error('terminal runtime survived'))
      : Promise.resolve())
    vi.mocked(h.runtime.listManaged).mockResolvedValue([
      { runtimeRef: 'container:preview-1', previewId: preview.preview_id },
      { runtimeRef: 'container:orphan-good', previewId: 'orphan-good' },
    ])

    await expect(h.service.reconcile()).resolves.toEqual({ stoppedOrphans: 1, failedRecords: 0 })

    expect(h.runtime.stop).toHaveBeenNthCalledWith(1, 'container:preview-1', expect.any(AbortSignal))
    expect(h.runtime.stop).toHaveBeenNthCalledWith(2, 'container:orphan-good', expect.any(AbortSignal))
    expect(onCleanupFailure).toHaveBeenCalledTimes(1)
    expect(onCleanupFailure).toHaveBeenCalledWith(preview.preview_id)
  })

  it('refreshes health and returns only schema-valid structured log events', async () => {
    const valid = { at: '2026-09-03T12:00:02.000Z', level: 'warn', event: 'RUNTIME_RESTARTED' }
    const health = vi.fn()
      .mockResolvedValueOnce('OK' as const)
      .mockResolvedValue('DOWN' as const)
    const h = createHarness({
      runtime: {
        health,
        logs: vi.fn(() => Promise.resolve([
          valid,
          'Authorization: Bearer segredo cookie=session-abc',
          { ...valid, token: 'segredo' },
          { ...valid, email: 'pessoa@example.com' },
          { ...valid, event: 'CODE_123456' },
          { ...valid, event: 'user@example.com' },
          { ...valid, level: 'debug' },
        ])),
      },
    })
    const { preview } = await ready(h)

    await expect(h.service.health(viewer, 'project-1', preview.preview_id)).resolves.toMatchObject({ health: 'DOWN' })
    const lines = await h.service.logs(viewer, 'project-1', preview.preview_id, 999)
    expect(h.runtime.logs).toHaveBeenCalledWith('container:preview-1', 200, expect.any(AbortSignal))
    expect(lines).toEqual([valid])
    expect(JSON.stringify(lines)).not.toMatch(/segredo|example\.com|authorization|cookie/iu)
  })

  it('serializes a health probe with stop so a stale READY snapshot cannot revive the preview', async () => {
    let release!: (value: 'OK') => void
    const blockedHealth = new Promise<'OK'>(resolve => { release = resolve })
    const h = createHarness()
    const { preview } = await ready(h)
    vi.mocked(h.runtime.health).mockImplementation(() => blockedHealth)

    const health = h.service.health(owner, 'project-1', preview.preview_id)
    await vi.waitFor(() => expect(h.runtime.health).toHaveBeenCalledTimes(1))
    const stop = h.service.stop(owner, 'project-1', preview.preview_id)
    release('OK')
    const [observed, stopped] = await Promise.all([health, stop])

    expect(observed.state).toBe('READY')
    expect(stopped.state).toBe('STOPPED')
    expect(h.repository.previews()[0]?.state).toBe('STOPPED')
    expect(h.runtime.stop).toHaveBeenCalledTimes(1)
  })

  it('exposes preview access codes only to writers in the same project and filters hostile messages', async () => {
    const valid = { kind: 'code', email: 'owner@example.test', code: '123456', expiresAt: '2026-09-03T12:10:00.000Z' }
    const h = createHarness({
      runtime: {
        verificationMessages: vi.fn(() => Promise.resolve([
          valid,
          { ...valid, token: 'secret' },
          { ...valid, code: '12345' },
          { kind: 'invitation', email: 'owner@example.test', expiresAt: valid.expiresAt },
          'Authorization: Bearer secret',
        ])),
      },
    })
    const { preview } = await ready(h)

    await expect(h.service.verificationMessages(owner, 'project-1', preview.preview_id)).resolves.toEqual([valid])
    await expect(h.service.verificationMessages(viewer, 'project-1', preview.preview_id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const outsider: PreviewActor = { ...owner, tenantId: 'tenant-2' }
    await expect(h.service.verificationMessages(outsider, 'project-1', preview.preview_id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('serializes stop and reaper so one runtime reaches one terminal state', async () => {
    const h = createHarness({ ttlSeconds: 60 })
    const { preview } = await ready(h)
    h.setNow(new Date('2026-09-03T12:01:01.000Z'))

    const [stopped, reaped] = await Promise.all([
      h.service.stop(owner, 'project-1', preview.preview_id),
      h.service.reap(),
    ])

    expect(stopped.state).toBe('STOPPED')
    expect(reaped).toBe(0)
    expect(h.runtime.stop).toHaveBeenCalledTimes(1)
    expect(h.repository.previews()).toHaveLength(1)
    expect(h.repository.previews()[0]?.state).toBe('STOPPED')
  })

  it('stops a still-managed runtime whose record is already terminal', async () => {
    const h = createHarness()
    const { preview } = await ready(h)
    await h.service.stop(owner, 'project-1', preview.preview_id)
    vi.mocked(h.runtime.listManaged).mockResolvedValue([
      { runtimeRef: 'container:preview-1', previewId: preview.preview_id },
    ])

    await expect(h.service.reconcile()).resolves.toEqual({ stoppedOrphans: 1, failedRecords: 0 })
    expect(h.runtime.stop).toHaveBeenCalledTimes(2)
    expect(h.repository.previews()[0]?.state).toBe('STOPPED')
  })

  it('reconciles persisted STOPPING and expired records without blocking other runtimes', async () => {
    const h = createHarness({ ttlSeconds: 60 })
    const { preview } = await ready(h)
    const current = h.repository.previews()[0]!
    await h.repository.putPreview({ ...current, state: 'STOPPING' })
    vi.mocked(h.runtime.listManaged).mockResolvedValue([{ runtimeRef: 'container:preview-1', previewId: preview.preview_id }])

    await expect(h.service.reconcile()).resolves.toEqual({ stoppedOrphans: 0, failedRecords: 0 })
    expect(h.repository.previews()[0]).toMatchObject({ state: 'STOPPED', stop_reason: 'reconciled' })

    const second = await ready(h)
    vi.mocked(h.runtime.listManaged).mockResolvedValue([{ runtimeRef: 'container:preview-1', previewId: second.preview.preview_id }])
    h.setNow(new Date('2026-09-03T12:01:01.000Z'))
    await expect(h.service.reconcile()).resolves.toEqual({ stoppedOrphans: 0, failedRecords: 0 })
    expect(h.repository.previews().find(item => item.preview_id === second.preview.preview_id)).toMatchObject({ state: 'EXPIRED', stop_reason: 'expired' })
  })

  it('bounds a stuck runtime inventory call', async () => {
    const h = createHarness({
      runtimeTimeoutMs: 15,
      runtime: {
        listManaged: vi.fn(() => new Promise<readonly { runtimeRef: string; previewId: string }[]>(() => undefined)),
      },
    })
    await expect(h.service.reconcile()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it('returns no logs or preview codes before a runtime exists', async () => {
    const h = createHarness()
    await h.repository.putPreview({
      preview_id: 'failed-preview', org_id: owner.orgId, tenant_id: owner.tenantId, project_id: 'project-1', run_id: 'run-1',
      artifact_sha256: sha('artifact'), created_by: owner.userId, source_session_id: owner.sessionId,
      hostname: 'p-0123456789abcdef01234567.localhost', state: 'FAILED', created_at: '2026-09-03T12:00:00.000Z', ready_at: null,
      expires_at: '2026-09-03T12:30:00.000Z', stopped_at: '2026-09-03T12:00:01.000Z', stop_reason: 'failed', failure_code: 'RUNTIME_START_FAILED', runtime_ref: null, health: 'DOWN',
    })
    await expect(h.service.logs(owner, 'project-1', 'failed-preview')).resolves.toEqual([])
    await expect(h.service.verificationMessages(owner, 'project-1', 'failed-preview')).resolves.toEqual([])
  })

  it('bounds a stuck start call and records a terminal failure', async () => {
    const never = new Promise<{ runtimeRef: string }>(() => undefined)
    const h = createHarness({ runtimeTimeoutMs: 15, runtime: { start: vi.fn(() => never) } })

    await expect(ready(h)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(h.repository.previews()[0]).toMatchObject({ state: 'FAILED', health: 'DOWN', failure_code: 'UNAVAILABLE' })
  })

  it('bounds stuck health and stop calls while preserving STOPPING and observable cleanup failure', async () => {
    const onCleanupFailure = vi.fn()
    const h = createHarness({ runtimeTimeoutMs: 15, ttlSeconds: 60, onCleanupFailure })
    const { preview } = await ready(h)
    vi.mocked(h.runtime.health).mockImplementation(() => new Promise(() => undefined))

    await expect(h.service.health(owner, 'project-1', preview.preview_id)).resolves.toMatchObject({ state: 'READY', health: 'DOWN' })
    vi.mocked(h.runtime.stop).mockImplementation(() => new Promise(() => undefined))
    await expect(h.service.stop(owner, 'project-1', preview.preview_id)).resolves.toMatchObject({
      state: 'STOPPING', stopped_at: null, health: 'DOWN', failure_code: 'RUNTIME_CLEANUP_INCOMPLETE',
    })
    expect(onCleanupFailure).toHaveBeenCalledWith(preview.preview_id)

    h.setNow(new Date('2026-09-03T12:01:01.000Z'))
    await expect(h.service.reap()).resolves.toBe(0)
    expect(h.repository.previews().find(item => item.preview_id === preview.preview_id)).toMatchObject({
      state: 'STOPPING', stopped_at: null, failure_code: 'RUNTIME_CLEANUP_INCOMPLETE',
    })
    expect(onCleanupFailure).toHaveBeenCalledTimes(2)
  })
})
