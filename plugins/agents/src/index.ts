import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type AgentPresets from '@deepseek-ai/dsh-agent-presets'
import type { JobId, JobStart } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { PolicyDelegationGrant, StudioPolicyRuntime } from '@dz23-studio/policy'
import type { StudioIdentityRuntime } from '@dz23-studio/identity'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { delimiter, extname, join, resolve } from 'node:path'
import { accessSync, constants, existsSync } from 'node:fs'
import { t } from './i18n.js'
import {
  studioAgentLeasesDomainSpec,
  studioAgentRunsDomainSpec,
  type AgentLeaseKey,
  type AgentLeaseRecord,
  type AgentRunKey,
  type AgentRunRecord,
} from './model.js'
import {
  GitWorktreeManager,
  StudioAgentService,
  type AgentRestartReconciliation,
  type AgentProvider,
  type AgentRepository,
  type DelegationRequest,
  type JobPort,
} from './service.js'

export * from './model.js'
export * from './service.js'

export const name = 'dz23-studio-agents'
export const inject = ['agentPresets', 'agents', 'jobs', 'storageDomain', 'studioIdentity', 'studioPolicy', 'subagents']

export interface Config {
  readonly worktreeRoot?: string
  readonly coordinatorPreset?: string
  readonly inProcessCoordinatorPreset?: string
  readonly inProcessProvider?: string
  readonly inProcessModel?: string
}

export interface StudioAgentsRuntime {
  readonly service: StudioAgentService
  readonly restartReconciliation: AgentRestartReconciliation
  runs(): readonly AgentRunRecord[]
  leases(): readonly AgentLeaseRecord[]
  providerStates(): Readonly<Record<'codex' | 'claude-code', 'OK' | 'NOT_PRESENT' | 'NOT_CONFIGURED'>>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    studioAgents: StudioAgentsRuntime
  }
}

class DomainAgentRepository implements AgentRepository {
  constructor(
    private readonly runTable: KvTable<AgentRunKey, AgentRunRecord>,
    private readonly leaseTable: KvTable<AgentLeaseKey, AgentLeaseRecord>,
  ) {}
  runs() { return [...this.runTable.entries()].map(([, value]) => value) }
  leases() { return [...this.leaseTable.entries()].map(([, value]) => value) }
  putRun(record: AgentRunRecord) { return this.runTable.put(record.run_id as AgentRunKey, record) }
  putLease(record: AgentLeaseRecord) { return this.leaseTable.put(record.lease_id as AgentLeaseKey, record) }
}

function providerState(ctx: Context, name: 'codex' | 'claude-code') {
  if (ctx.subagents.getProvider(name) === undefined) return 'NOT_CONFIGURED' as const
  const executable = name === 'claude-code' ? 'claude' : 'codex'
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : ['']
  const present = (process.env.PATH ?? '').split(delimiter).filter(Boolean).some(directory => extensions.some(extension => {
    const candidate = join(directory, process.platform === 'win32' && extname(executable) === '' ? `${executable}${extension}` : executable)
    try {
      accessSync(candidate, constants.X_OK)
      return true
    } catch {
      return false
    }
  }))
  if (!present) return 'NOT_PRESENT' as const
  const configured = name === 'codex'
    ? existsSync(join(homedir(), '.codex', 'auth.json'))
    : existsSync(join(homedir(), '.claude', '.credentials.json')) || existsSync(join(homedir(), '.claude.json'))
  return configured ? 'OK' as const : 'NOT_CONFIGURED' as const
}

/** Mount the Studio-only delegation gate. Generic tool-subagent is deliberately not exposed. */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const presetService = (ctx as Context & { agentPresets: AgentPresets }).agentPresets
  const runsDomain: Domain<typeof studioAgentRunsDomainSpec> = await ctx.storageDomain.open(studioAgentRunsDomainSpec)
  const leasesDomain: Domain<typeof studioAgentLeasesDomainSpec> = await ctx.storageDomain.open(studioAgentLeasesDomainSpec)
  // Um disposer só, na ordem certa. O cordis dispara os disposers com
  // `Promise.all`: dois efeitos separados rodariam CONCORRENTEMENTE, e o
  // fechamento do domínio (que passa a recusar escritas assim que começa)
  // corria contra o encerramento ativo, que ainda precisa gravar o desfecho
  // das execuções em voo. Registrar dois efeitos e confiar na ordem inversa
  // era uma suposição errada sobre o runtime.
  let shutdownAgents: (() => Promise<void>) | undefined
  ctx.effect(() => async () => {
    if (shutdownAgents !== undefined) await shutdownAgents()
    await Promise.all([runsDomain.close(), leasesDomain.close()])
  }, 'studio-agents.shutdownThenClose')
  const repository = new DomainAgentRepository(runsDomain.table('runs'), leasesDomain.table('leases'))
  const coordinatorPreset = config.coordinatorPreset ?? 'dz23-coordinator'
  const inProcessCoordinatorPreset = config.inProcessCoordinatorPreset ?? 'dz23-coordinator-in-process'
  const approvedCoordinators = new Map<string, { readonly tier: 'T2' | 'T3'; readonly worktreePath: string }>()
  const unsetDelegationGrant = (ctx.studioPolicy as StudioPolicyRuntime).setDelegationGrantResolver((execution) => {
    if (execution.agent === undefined) return undefined
    return approvedGrantFor(ctx, execution.agent, approvedCoordinators)
  })
  ctx.effect(() => unsetDelegationGrant, 'studio-agents.delegationGrant')
  const worktreeRoot = resolve(config.worktreeRoot
    ?? process.env.DZ23_AGENT_WORKTREE_ROOT
    ?? resolve(homedir(), '.dz23-studio', 'worktrees'))
  const service = new StudioAgentService({
    repository,
    worktrees: new GitWorktreeManager(worktreeRoot),
    coordinators: {
      async create(cwd, parentSessionId, provider, approvedTier) {
        const selectedPreset = provider === 'spawn-in-process' ? inProcessCoordinatorPreset : coordinatorPreset
        const coordinatorSessionId = SessionId(`studio-coordinator-${randomUUID()}`)
        const handle = await ctx.agents.create({
          sessionId: coordinatorSessionId,
          meta: {
            cwd,
            parentSession: parentSessionId,
            origin: 'subagent',
            delegationDepth: 1,
            agentPreset: selectedPreset,
          },
          ...(provider === 'spawn-in-process' && config.inProcessProvider !== undefined && config.inProcessModel !== undefined
            ? { agentOptions: { provider: config.inProcessProvider, model: config.inProcessModel } }
            : {}),
          setup: agentCtx => presetService.mount(agentCtx, selectedPreset).then(() => undefined),
        })
        const agent = handle.agent
        if (agent.session.header.cwd !== cwd) throw new Error(t('delegation.coordinatorCwdLost'))
        if (String(parentSessionId) === String(coordinatorSessionId)) throw new Error(t('delegation.coordinatorIsPersonSession'))
        approvedCoordinators.set(String(coordinatorSessionId), { tier: approvedTier, worktreePath: cwd })
        return {
          sessionId: coordinatorSessionId,
          agent,
          async dispose() { approvedCoordinators.delete(String(coordinatorSessionId)); await handle.dispose() },
        }
      },
    },
    subagents: {
      start(provider: AgentProvider, request): Promise<SubagentRun> {
        const inProcess = request.inProcess
        return ctx.subagents.start(provider, {
          parent: request.parent, prompt: request.prompt, signal: request.signal,
          ...(provider === 'spawn-in-process' && inProcess?.toolFilter !== undefined
            ? { toolFilter: inProcess.toolFilter as never }
            : {}),
          ...(provider === 'spawn-in-process' && inProcess?.persona !== undefined
            ? { persona: inProcess.persona }
            : {}),
        })
      },
    },
    identity: {
      strongIdentityVerified(parentSessionId) {
        return (ctx.studioIdentity as StudioIdentityRuntime).service
          .strongIdentityForHarnessSession(String(parentSessionId))
      },
    },
    jobs: {
      hasLiveJobs() {
        const seen = new Set<string>()
        for (const agent of ctx.agents.list()) {
          for (const job of ctx.jobs.list(agent)) {
            if (seen.has(String(job.id))) continue
            seen.add(String(job.id))
            if (String(job.kind) === 'studio-agent' && (job.status === 'running' || job.status === 'stopping')) return true
          }
        }
        return false
      },
      start(spec) {
        return ctx.jobs.start(spec as unknown as JobStart) as JobId
      },
    } satisfies JobPort,
  })
  const restartReconciliation = await service.reconcileInterruptedRuns()
  ctx.jobs.attachController('dz23-studio-agents')
  // Encerramento ATIVO, ligado ao disposer único acima para que aconteça
  // ANTES do fechamento dos domínios. O que sobreviver ao prazo não é
  // declarado morto: fica para a reconciliação do próximo início.
  shutdownAgents = async () => {
    const outcome = await service.shutdown()
    if (outcome.pending > 0) {
      ctx.logger.warn(t('recovery.shutdownPending', { count: outcome.pending }))
    }
  }
  ctx.provide('studioAgents', {
    service,
    restartReconciliation,
    runs: () => repository.runs(),
    leases: () => repository.leases(),
    providerStates: () => ({ codex: providerState(ctx, 'codex'), 'claude-code': providerState(ctx, 'claude-code') }),
  })
}

export function hasApprovedAncestor(ctx: Pick<Context, 'agents'>, agent: Agent, approved: ReadonlySet<string>): boolean {
  const seen = new Set<string>()
  let current: Agent | undefined = agent
  while (current !== undefined && !seen.has(String(current.session.id))) {
    const id = String(current.session.id)
    if (approved.has(id)) return true
    seen.add(id)
    const parent: SessionId | undefined = current.session.header.parentSession
    current = parent === undefined ? undefined : ctx.agents.get(parent)
  }
  return false
}

export function approvedGrantFor(
  ctx: Pick<Context, 'agents'>,
  agent: Agent,
  approved: ReadonlyMap<string, { readonly tier: 'T2' | 'T3'; readonly worktreePath: string }>,
): PolicyDelegationGrant | undefined {
  const seen = new Set<string>()
  let current: Agent | undefined = agent
  while (current !== undefined && !seen.has(String(current.session.id))) {
    const id = String(current.session.id)
    const grant = approved.get(id)
    if (grant !== undefined) {
      if (agent.session.header.cwd !== grant.worktreePath || current.session.header.cwd !== grant.worktreePath) return undefined
      return {
        approvedTier: grant.tier,
        reason: t('delegation.coveredByIsolatedGrant'),
      }
    }
    seen.add(id)
    const parent: SessionId | undefined = current.session.header.parentSession
    current = parent === undefined ? undefined : ctx.agents.get(parent)
  }
  return undefined
}

export function startDelegation(ctx: Context, request: DelegationRequest) {
  return ctx.studioAgents.service.start(request)
}
