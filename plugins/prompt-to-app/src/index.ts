import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { JobId, JobStart } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@dz23-studio/identity'
import type {} from '@dz23-studio/route-health'
import type {} from '@dz23-studio/tenancy'
import { mkdir, readFile, statfs } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPromptToAppHttpHandler, type StudioAppsHealth } from './http.js'
import { PromptToAppJobService, type PromptToAppJobRegistry } from './jobs.js'
import {
  studioAppSpecsDomainSpec,
  studioApprovalsDomainSpec,
  studioDesignSpecsDomainSpec,
  studioEvidenceDomainSpec,
  studioIntakeTurnsDomainSpec,
  studioPlansDomainSpec,
  studioProjectsDomainSpec,
  studioRunsDomainSpec,
  type PromptToAppKey,
  type StudioApproval,
  type StudioAppSpecRecord,
  type StudioDesignSpecRecord,
  type StudioEvidence,
  type StudioIntakeTurn,
  type StudioPlan,
  type StudioProject,
  type StudioRun,
} from './model.js'
import { IntakeEngine } from './intake.js'
import { ModelCodeGenerator, PromptToAppPipeline } from './pipeline.js'
import { PlannerEngine } from './planner.js'
import { HarnessPromptModel } from './ports.js'
import { ContainerBuilder, NodeProcessPort } from './runner.js'
import { PromptToAppService, type PromptToAppRepository } from './service.js'
import { SharpLogoProcessor } from './logo.js'

export * from './appspec.js'
export * from './generator.js'
export * from './design.js'
export * from './data-generator.js'
export * from './form-generator.js'
export * from './logo.js'
export * from './import-policy.js'
export * from './acceptance.js'
export * from './http.js'
export * from './intake.js'
export * from './jobs.js'
export * from './model.js'
export * from './planner.js'
export * from './pipeline.js'
export * from './ports.js'
export * from './runner.js'
export * from './service.js'
export * from './state.js'

export const name = 'dz23-studio-prompt-to-app'
export const inject = ['agents', 'jobs', 'llm', 'storageDomain', 'studioIdentity', 'studioRouteHealth', 'studioTenancy', 'webServer']

export interface PromptToAppPluginConfig {
  readonly allowedHosts?: readonly string[]
  readonly allowedOrigins?: readonly string[]
  readonly modelByRoute?: Readonly<Record<string, string>>
  readonly templateDirectory?: string
  readonly runsRoot?: string
  readonly logoStoreRoot?: string
  readonly builder?: {
    readonly engine?: 'docker' | 'podman'
    readonly imageDigest?: `sha256:${string}`
    readonly imageDigestFile?: string
    readonly templateStore?: string
    readonly user?: `${number}:${number}`
    readonly limits?: { readonly pids?: number; readonly memory?: string; readonly cpus?: string; readonly timeoutMs?: number }
  }
}

export interface StudioPromptToAppRuntime {
  readonly service: PromptToAppService
  readonly pipeline: PromptToAppPipeline
  health(): Promise<StudioAppsHealth>
}

declare module '@deepseek-ai/cordis' {
  interface Context { studioPromptToApp: StudioPromptToAppRuntime }
}

class DomainPromptToAppRepository implements PromptToAppRepository {
  constructor(
    private readonly projectTable: KvTable<PromptToAppKey, StudioProject>,
    private readonly specTable: KvTable<PromptToAppKey, StudioAppSpecRecord>,
    private readonly designTable: KvTable<PromptToAppKey, StudioDesignSpecRecord>,
    private readonly turnTable: KvTable<PromptToAppKey, StudioIntakeTurn>,
    private readonly planTable: KvTable<PromptToAppKey, StudioPlan>,
    private readonly runTable: KvTable<PromptToAppKey, StudioRun>,
    private readonly evidenceTable: KvTable<PromptToAppKey, StudioEvidence>,
    private readonly approvalTable: KvTable<PromptToAppKey, StudioApproval>,
  ) {}
  projects() { return tableValues(this.projectTable) }
  putProject(value: StudioProject) { return this.projectTable.put(value.project_id as PromptToAppKey, value) }
  specs() { return tableValues(this.specTable) }
  putSpec(value: StudioAppSpecRecord) { return this.specTable.put(value.spec_id as PromptToAppKey, value) }
  designs() { return tableValues(this.designTable) }
  putDesign(value: StudioDesignSpecRecord) { return this.designTable.put(value.design_id as PromptToAppKey, value) }
  turns() { return tableValues(this.turnTable) }
  putTurn(value: StudioIntakeTurn) { return this.turnTable.put(value.turn_id as PromptToAppKey, value) }
  plans() { return tableValues(this.planTable) }
  putPlan(value: StudioPlan) { return this.planTable.put(value.plan_id as PromptToAppKey, value) }
  runs() { return tableValues(this.runTable) }
  putRun(value: StudioRun) { return this.runTable.put(value.run_id as PromptToAppKey, value) }
  evidence() { return tableValues(this.evidenceTable) }
  putEvidence(value: StudioEvidence) { return this.evidenceTable.put(value.evidence_id as PromptToAppKey, value) }
  approvals() { return tableValues(this.approvalTable) }
  putApproval(value: StudioApproval) { return this.approvalTable.put(value.approval_id as PromptToAppKey, value) }
}

function tableValues<T>(table: KvTable<PromptToAppKey, T>): T[] { return [...table.entries()].map(([, value]) => value) }

export async function apply(ctx: Context, config: PromptToAppPluginConfig = {}): Promise<void> {
  const projectRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
  const [projects, specs, designs, turns, plans, runs, evidence, approvals]: [
    Domain<typeof studioProjectsDomainSpec>, Domain<typeof studioAppSpecsDomainSpec>,
    Domain<typeof studioDesignSpecsDomainSpec>,
    Domain<typeof studioIntakeTurnsDomainSpec>, Domain<typeof studioPlansDomainSpec>,
    Domain<typeof studioRunsDomainSpec>, Domain<typeof studioEvidenceDomainSpec>,
    Domain<typeof studioApprovalsDomainSpec>,
  ] = await Promise.all([
    ctx.storageDomain.open(studioProjectsDomainSpec), ctx.storageDomain.open(studioAppSpecsDomainSpec),
    ctx.storageDomain.open(studioDesignSpecsDomainSpec),
    ctx.storageDomain.open(studioIntakeTurnsDomainSpec), ctx.storageDomain.open(studioPlansDomainSpec),
    ctx.storageDomain.open(studioRunsDomainSpec), ctx.storageDomain.open(studioEvidenceDomainSpec),
    ctx.storageDomain.open(studioApprovalsDomainSpec),
  ])
  ctx.effect(() => async () => { await Promise.all([projects.close(), specs.close(), designs.close(), turns.close(), plans.close(), runs.close(), evidence.close(), approvals.close()]) }, 'studio-prompt-to-app.domainClose')

  const repository = new DomainPromptToAppRepository(
    projects.table('projects'), specs.table('specs'), designs.table('designs'), turns.table('turns'), plans.table('plans'),
    runs.table('runs'), evidence.table('evidence'), approvals.table('approvals'),
  )
  const service = new PromptToAppService({ repository })
  const model = new HarnessPromptModel({
    llm: ctx.llm,
    routes: ctx.studioRouteHealth.service,
    markScope: (options, scope) => ctx.studioRouteHealth.markScope(options, scope),
    modelByRoute: config.modelByRoute ?? {
      ollama: 'qwen2.5-coder:7b', omniroute: 'deepseek-v3.2', 'deepseek-official': 'deepseek-chat',
    },
  })
  const runsRoot = resolve(config.runsRoot ?? resolve(homedir(), '.dz23-studio', 'generated-runs'))
  const logoStoreRoot = resolve(config.logoStoreRoot ?? resolve(homedir(), '.dz23-studio', 'assets'))
  const templateDirectory = resolve(config.templateDirectory ?? resolve(projectRoot, 'templates', 'nextjs-app@1'))
  const templateStore = resolve(config.builder?.templateStore ?? resolve(projectRoot, 'runtime', 'template-store-v2'))
  const imageDigest = config.builder?.imageDigest ?? await readDigest(config.builder?.imageDigestFile ?? resolve(projectRoot, 'runtime', 'builder-image-digest'))
  await Promise.all([mkdir(runsRoot, { recursive: true }), mkdir(logoStoreRoot, { recursive: true })])
  const builder = new ContainerBuilder({
    engine: config.builder?.engine ?? 'docker', imageDigest, templateStore,
    user: config.builder?.user ?? defaultContainerUser(),
    limits: {
      pids: config.builder?.limits?.pids ?? 256,
      memory: config.builder?.limits?.memory ?? '2g',
      cpus: config.builder?.limits?.cpus ?? '2',
      timeoutMs: config.builder?.limits?.timeoutMs ?? 180_000,
    },
  }, new NodeProcessPort())
  const pipeline = new PromptToAppPipeline({ service, builder, templateDirectory, runsRoot })
  const registry: PromptToAppJobRegistry = {
    start: spec => ctx.jobs.start(spec as JobStart) as JobId,
    kill: (id, owner, reason) => ctx.jobs.kill(id, owner, reason),
  }
  const jobs = new PromptToAppJobService({
    service, pipeline, registry,
    owners: {
      async create(_actor, runId) {
        const handle = await ctx.agents.create({
          sessionId: SessionId(`studio-prompt-job-${runId}`),
          meta: { cwd: runsRoot, origin: 'subagent', delegationDepth: 0, agentPreset: 'dz23-prompt-job-owner' },
          setup: () => undefined,
        })
        return { owner: handle.agent, dispose: () => handle.dispose() }
      },
    },
  })
  ctx.jobs.attachController('dz23-studio-prompt-to-app')
  const intake = new IntakeEngine(model); const planner = new PlannerEngine(model)
  const healthFor = async (scope: { readonly orgId: string; readonly tenantId: string }): Promise<StudioAppsHealth> => {
    const routes = ctx.studioRouteHealth.service.list(scope)
    const route = routes.find(candidate => candidate.state === 'OK')?.route ?? null
    const [builderHealth, disk] = await Promise.all([builder.preflight(), diskState(runsRoot)])
    const state = route !== null && builderHealth.state === 'OK' && disk === 'OK' ? 'OK' : 'ATTENTION'
    return { state, route, builder: builderHealth.state, disk }
  }
  const health = () => healthFor({ orgId: 'studio-system', tenantId: 'studio-system' })
  ctx.provide('studioPromptToApp', { service, pipeline, health })

  const port = ctx.webServer.port
  const defaultHost = `127.0.0.1:${port}`; const defaultOrigin = `http://localhost:${port}`
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: '/api/studio/apps',
    handler: createPromptToAppHttpHandler({
      service, identity: ctx.studioIdentity.service, tenancy: ctx.studioTenancy.service,
      intake, planner, jobs,
      logos: new SharpLogoProcessor(logoStoreRoot),
      generatorFor: (actor, projectId) => new ModelCodeGenerator(model, actor, service.project(actor, projectId).privacy),
      health: actor => healthFor({ orgId: actor.orgId, tenantId: actor.tenantId }),
      allowedHosts: config.allowedHosts ?? [defaultHost, `localhost:${port}`],
      allowedOrigins: config.allowedOrigins ?? [defaultOrigin, `http://${defaultHost}`],
    }),
  }), 'studio-prompt-to-app.http')
}

function defaultContainerUser(): `${number}:${number}` {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
  const gid = typeof process.getgid === 'function' ? process.getgid() : 1000
  return `${uid}:${gid}`
}

async function readDigest(path: string): Promise<`sha256:${string}`> {
  try { return (await readFile(path, 'utf8')).trim() as `sha256:${string}` } catch { return 'sha256:unconfigured' }
}

async function diskState(path: string): Promise<'OK' | 'ATTENTION'> {
  try {
    const info = await statfs(path)
    return Number(info.bavail) * Number(info.bsize) >= 512 * 1024 * 1024 ? 'OK' : 'ATTENTION'
  } catch { return 'ATTENTION' }
}
