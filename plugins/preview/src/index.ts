import type { Context } from '@deepseek-ai/cordis'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { registerPromptToAppHttpExtension, hashTree, type PromptToAppActor } from '@dz23-studio/prompt-to-app'
import { roleAllows } from '@dz23-studio/policy'
import { createPreviewProjectHttpExtension } from './http.js'
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

export * from './http.js'
export * from './gateway.js'
export * from './model.js'
export * from './mutex.js'
export * from './service.js'

export const name = 'dz23-studio-preview'
export const inject = ['storageDomain', 'studioIdentity', 'studioPromptToApp', 'studioTenancy', 'webServer']

export interface PreviewPluginConfig {
  readonly runtime?: PreviewRuntimePort
  readonly ttlSeconds?: number
  readonly reaperIntervalMs?: number
  readonly publicPort?: number
  readonly runtimeTimeoutMs?: number
}

export interface StudioPreviewRuntime {
  readonly service: StudioPreviewService
  readonly state: 'BETA' | 'NOT_CONFIGURED'
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
  async start(): Promise<{ readonly runtimeRef: string }> { throw new PreviewError('UNAVAILABLE', 'O supervisor isolado de prévias ainda não está configurado.') }
  async stop(): Promise<void> { return undefined }
  async health(): Promise<'DOWN'> { return 'DOWN' }
  async logs(): Promise<readonly string[]> { return [] }
  async verificationMessages(): Promise<readonly unknown[]> { return [] }
  async listManaged(): Promise<readonly { readonly runtimeRef: string; readonly previewId: string }[]> { return [] }
}

export async function apply(ctx: Context, config: PreviewPluginConfig = {}): Promise<void> {
  const [previewsDomain, admissionsDomain]: [
    Domain<typeof studioPreviewsDomainSpec>, Domain<typeof studioPreviewAdmissionsDomainSpec>,
  ] = await Promise.all([
    ctx.storageDomain.open(studioPreviewsDomainSpec),
    ctx.storageDomain.open(studioPreviewAdmissionsDomainSpec),
  ])
  ctx.effect(() => async () => { await Promise.all([previewsDomain.close(), admissionsDomain.close()]) }, 'studio-preview.domainClose')
  const repository = new DomainPreviewRepository(previewsDomain.table('previews'), admissionsDomain.table('admissions'))
  const runtime = config.runtime ?? new UnconfiguredRuntime()
  const identity = ctx.studioIdentity.service
  const service = new StudioPreviewService({
    repository,
    runtime,
    ...(config.ttlSeconds === undefined ? {} : { ttlSeconds: config.ttlSeconds }),
    ...(config.publicPort === undefined ? {} : { publicPort: config.publicPort }),
    ...(config.runtimeTimeoutMs === undefined ? {} : { runtimeTimeoutMs: config.runtimeTimeoutMs }),
    source: {
      async verifiedArtifact(actor: PreviewActor, projectId: string, runId?: string) {
        const promptActor: PromptToAppActor = actor
        const project = ctx.studioPromptToApp.service.project(promptActor, projectId)
        if (project.state !== 'VERIFIED_PROTOTYPE') throw new PreviewError('CONFLICT', 'O projeto ainda não possui um protótipo verificado.')
        const candidates = ctx.studioPromptToApp.service.runs(promptActor, projectId)
          .filter(run => run.state === 'PASSED' && run.stage === 'verify' && (runId === undefined || run.run_id === runId))
          .sort((left, right) => right.started_at.localeCompare(left.started_at) || right.attempt - left.attempt)
        const selected = candidates[0]
        if (selected === undefined || selected.run_directory === 'not-created' || selected.artifact_sha256 == null) throw new PreviewError('CONFLICT', 'Nenhuma execução verificada com artefato fixado está disponível para prévia.')
        const currentSha256 = await hashTree(selected.run_directory)
        if (currentSha256 !== selected.artifact_sha256) throw new PreviewError('CONFLICT', 'O protótipo mudou depois da verificação; gere e verifique novamente antes da prévia.')
        return {
          projectId, runId: selected.run_id, artifactPath: selected.run_directory,
          artifactSha256: selected.artifact_sha256,
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
  const interval = setInterval(() => { void service.reap() }, Math.max(5_000, config.reaperIntervalMs ?? 30_000))
  interval.unref()
  ctx.effect(() => () => clearInterval(interval), 'studio-preview.reaper')
  await service.reconcile()
  ctx.provide('studioPreview', { service, state: config.runtime === undefined ? 'NOT_CONFIGURED' : 'BETA' })
}
