import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { registerPromptToAppHttpExtension, hashTree, PREVIEW_ARTIFACT_RELATIVE_PATH, type PromptToAppActor } from '@dz23-studio/prompt-to-app'
import { roleAllows } from '@dz23-studio/policy'
import { createPreviewProjectHttpExtension } from './http.js'
import { createPreviewGatewayHttpHandler } from './gateway.js'
import { t } from './i18n.js'
import {
  studioPreviewAdmissionsDomainSpec,
  studioPreviewsDomainSpec,
  type PreviewAdmission,
  type PreviewKey,
  type PreviewRecord,
} from './model.js'
import {
  PreviewError,
  StudioPreviewService,
  type PreviewActor,
  type PreviewRepository,
  type PreviewRuntimePort,
} from './service.js'
import { SupervisorPreviewRuntime, UnixHttpSupervisorTransport, UnixProxySupervisorTransport } from './supervisor-client.js'

export * from './http.js'
export * from './gateway.js'
export * from './model.js'
export * from './mutex.js'
export * from './service.js'
export * from './supervisor-client.js'

export const name = 'dz23-studio-preview'
export const inject = ['storageDomain', 'studioIdentity', 'studioPromptToApp', 'studioTenancy', 'webServer']

export interface PreviewPluginConfig {
  readonly runtime?: PreviewRuntimePort
  readonly supervisor?: {
    readonly enabled: boolean
    readonly socketPath: string
    readonly tokenFile: string
    readonly artifactRoot: string
    readonly proxySocketRoot: string
    readonly studioOrigin: string
    readonly edgeSecretRef: string
  }
  readonly ttlSeconds?: number
  readonly reaperIntervalMs?: number
  readonly publicPort?: number
  readonly runtimeTimeoutMs?: number
}

export interface StudioPreviewRuntime {
  readonly service: StudioPreviewService
  readonly state: 'BETA' | 'NOT_CONFIGURED'
  /** Narrow CSP source matching the exact local gateway port used in preview URLs. */
  readonly frameSource: string
  readonly cleanupFailureAt: string | null
}

declare module '@deepseek-ai/cordis' {
  interface Context { studioPreview: StudioPreviewRuntime }
}

class DomainPreviewRepository implements PreviewRepository {
  constructor(
    private readonly previewsTable: KvTable<PreviewKey, PreviewRecord>,
    private readonly admissionsTable: KvTable<PreviewKey, PreviewAdmission>,
  ) {}
  previews(): readonly PreviewRecord[] { return [...this.previewsTable.entries()].map(([, value]) => value) }
  putPreview(record: PreviewRecord): Promise<void> { return this.previewsTable.put(record.preview_id as PreviewKey, record) }
  admissions(): readonly PreviewAdmission[] { return [...this.admissionsTable.entries()].map(([, value]) => value) }
  putAdmission(record: PreviewAdmission): Promise<void> { return this.admissionsTable.put(record.admission_id as PreviewKey, record) }
}

class UnconfiguredRuntime implements PreviewRuntimePort {
  async start(): Promise<{ readonly runtimeRef: string }> { throw new PreviewError('UNAVAILABLE', t('plugin.supervisorNotConfigured')) }
  async stop(): Promise<void> { return undefined }
  async health(): Promise<'DOWN'> { return 'DOWN' }
  async logs(): Promise<readonly string[]> { return [] }
  async verificationMessages(): Promise<readonly unknown[]> { return [] }
  async listManaged(): Promise<readonly { readonly runtimeRef: string; readonly previewId: string }[]> { return [] }
}

export async function apply(ctx: Context, config: PreviewPluginConfig = {}): Promise<void> {
  const publicPort = config.publicPort ?? ctx.webServer.port
  const [previewsDomain, admissionsDomain]: [
    Domain<typeof studioPreviewsDomainSpec>, Domain<typeof studioPreviewAdmissionsDomainSpec>,
  ] = await Promise.all([
    ctx.storageDomain.open(studioPreviewsDomainSpec),
    ctx.storageDomain.open(studioPreviewAdmissionsDomainSpec),
  ])
  ctx.effect(() => async () => { await Promise.all([previewsDomain.close(), admissionsDomain.close()]) }, 'studio-preview.domainClose')
  const repository = new DomainPreviewRepository(previewsDomain.table('previews'), admissionsDomain.table('admissions'))
  const supervisor = config.supervisor?.enabled === true ? configuredSupervisor(config.supervisor) : undefined
  const runtime = config.runtime ?? supervisor?.runtime ?? new UnconfiguredRuntime()
  const identity = ctx.studioIdentity.service
  let cleanupFailureAt: string | null = null
  const service = new StudioPreviewService({
    repository,
    runtime,
    ...(config.ttlSeconds === undefined ? {} : { ttlSeconds: config.ttlSeconds }),
    publicPort,
    onCleanupFailure: () => { cleanupFailureAt = new Date().toISOString() },
    ...(config.runtimeTimeoutMs === undefined ? {} : { runtimeTimeoutMs: config.runtimeTimeoutMs }),
    source: {
      async verifiedArtifact(actor: PreviewActor, projectId: string, runId?: string) {
        const promptActor: PromptToAppActor = actor
        const project = ctx.studioPromptToApp.service.project(promptActor, projectId)
        if (project.state !== 'VERIFIED_PROTOTYPE') throw new PreviewError('CONFLICT', t('plugin.projectNotVerified'))
        const candidates = ctx.studioPromptToApp.service.runs(promptActor, projectId)
          .filter(run => run.state === 'PASSED' && run.stage === 'verify' && (runId === undefined || run.run_id === runId))
          .sort((left, right) => right.started_at.localeCompare(left.started_at) || right.attempt - left.attempt)
        const selected = candidates[0]
        if (selected === undefined || selected.run_directory === 'not-created' || selected.artifact_sha256 == null) throw new PreviewError('CONFLICT', t('plugin.verifiedArtifactMissing'))
        const artifactPath = `${selected.run_directory}/${PREVIEW_ARTIFACT_RELATIVE_PATH}`
        const currentSha256 = await hashTree(artifactPath)
        if (currentSha256 !== selected.artifact_sha256) throw new PreviewError('CONFLICT', t('plugin.prototypeChanged'))
        const owner = identity.userRecords().find(user => user.user_id === actor.userId && user.org_id === actor.orgId && user.tenant_id === actor.tenantId)
        if (owner === undefined) throw new PreviewError('UNAUTHENTICATED', t('plugin.ownerMissing'))
        return {
          projectId, runId: selected.run_id, artifactPath,
          artifactSha256: selected.artifact_sha256,
          ownerEmail: owner.email,
        }
      },
    },
    sessions: {
      isActive(input) {
        const session = identity.sessionRecords().find(candidate => candidate.session_id === input.sessionId
          && candidate.user_id === input.userId && candidate.org_id === input.orgId && candidate.tenant_id === input.tenantId)
        const now = Date.now()
        return session !== undefined && session.revoked_at === null
          && Date.parse(session.expires_absolute_at) > now && Date.parse(session.expires_sliding_at) > now
      },
      canRead(input) {
        const authorization = ctx.studioTenancy.service.authorizationFor(input.userId, input.orgId, input.tenantId)
        return authorization !== undefined && roleAllows(authorization.role, 'project.read')
      },
    },
  })
  const unregister = registerPromptToAppHttpExtension(createPreviewProjectHttpExtension(service))
  ctx.effect(() => unregister, 'studio-preview.httpExtension')
  if (supervisor !== undefined) {
    const gateway = createPreviewGatewayHttpHandler({ service, forward: supervisor.runtime, studioOrigin: supervisor.studioOrigin })
    const edgeSecret = requiredSecret(supervisor.edgeSecretRef)
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix', path: '/__dz23/preview-gateway',
      handler: edgeGuard(edgeSecret, gateway),
    }), 'studio-preview.gateway')
  }
  let reaperRunning = false
  const interval = setInterval(() => {
    if (reaperRunning) return
    reaperRunning = true
    void service.reap()
      .catch(() => { cleanupFailureAt = new Date().toISOString() })
      .finally(() => { reaperRunning = false })
  }, Math.max(5_000, config.reaperIntervalMs ?? 30_000))
  interval.unref()
  ctx.effect(() => () => clearInterval(interval), 'studio-preview.reaper')
  await service.reconcile()
  ctx.provide('studioPreview', {
    service,
    state: config.runtime === undefined && supervisor === undefined ? 'NOT_CONFIGURED' : 'BETA',
    frameSource: localPreviewFrameSource(publicPort),
    get cleanupFailureAt() { return cleanupFailureAt },
  })
}

function configuredSupervisor(config: NonNullable<PreviewPluginConfig['supervisor']>): { readonly runtime: SupervisorPreviewRuntime; readonly studioOrigin: string; readonly edgeSecretRef: string } {
  const transport = new UnixHttpSupervisorTransport({ socketPath: config.socketPath, tokenFile: config.tokenFile })
  return {
    runtime: new SupervisorPreviewRuntime({ artifactRoot: config.artifactRoot, transport, dataTransport: new UnixProxySupervisorTransport({ socketRoot: config.proxySocketRoot }) }),
    studioOrigin: config.studioOrigin,
    edgeSecretRef: config.edgeSecretRef,
  }
}

function edgeGuard(secret: string, handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const supplied = typeof request.headers['x-dz23-edge'] === 'string' ? request.headers['x-dz23-edge'] : ''
    const left = Buffer.from(secret, 'utf8'); const right = Buffer.from(supplied, 'utf8')
    if (left.byteLength !== right.byteLength || !timingSafeEqual(left, right)) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      response.end(t('plugin.resourceUnavailable'))
      return
    }
    const original = request.url ?? '/'
    const prefix = '/__dz23/preview-gateway'
    request.url = original.startsWith(prefix) ? original.slice(prefix.length) || '/' : '/'
    try { await handler(request, response) } finally { request.url = original }
  }
}

function requiredSecret(reference: string): string {
  if (!/^[A-Z][A-Z0-9_]{2,100}$/u.test(reference)) throw new Error(t('plugin.invalidEdgeSecretRef'))
  const value = process.env[reference]
  if (value === undefined || value.length < 32 || value.length > 512) throw new Error(t('plugin.requiredSecretMissing', { reference }))
  return value
}

export function localPreviewFrameSource(publicPort: number): string {
  if (!Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65_535) throw new Error(t('plugin.invalidPublicPort'))
  return `http://*.dz23.localhost${publicPort === 80 ? '' : `:${publicPort}`}`
}
