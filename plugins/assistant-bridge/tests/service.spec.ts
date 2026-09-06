import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import type { AgentTeamRecord, AgentTeamTaskRecord, StudioAgentTeamRuntime } from '@dz23-studio/agent-team'
import type { AgentRunRecord, StudioAgentsRuntime } from '@dz23-studio/agents'
import type { StudioIdentityRuntime } from '@dz23-studio/identity'
import type { StudioTenancyRuntime } from '@dz23-studio/tenancy'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AssistantBridgeError,
  normalizeRelativePath,
  StudioAssistantBridge,
  type AssistantRepositoryConfig,
} from '../src/service.ts'
import type { AssistantProvider } from '../src/catalog.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

function agent(id = 'session-1', preset = 'dz23-assistant', child = false): Agent {
  return { session: { id, header: {
    id, version: 1, createdAt: 1, agentPreset: preset,
    ...(child ? { origin: 'subagent', delegationDepth: 1, parentSession: 'session-1' } : {}),
  } } } as unknown as Agent
}

function run(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    run_id: 'run-1', org_id: 'org-1', tenant_id: 'tenant-1', workspace_id: 'tenant-1',
    parent_session_id: 'session-1', coordinator_session_id: 'coordinator', provider: 'spawn-in-process',
    worktree_path: '/copy', repository_path: '/repo', base_commit: 'abcdef1', status: 'PROPOSED',
    changed_files: ['src/safe/a.ts'], diff_bytes: 4, diff_sha256: 'a'.repeat(64),
    main_changed_during_run: false, approved_by: 'user-1', approved_at: '2026-09-05T00:00:00.000Z',
    diagnostic: null, created_at: '2026-09-05T00:00:00.000Z', updated_at: '2026-09-05T00:00:00.000Z',
    ...overrides,
  }
}

function team(overrides: Partial<AgentTeamRecord> = {}): AgentTeamRecord {
  return {
    team_id: 'team-1', org_id: 'org-1', tenant_id: 'tenant-1', workspace_id: 'tenant-1',
    repository_path: '/repo', parent_session_id: 'session-1', name: 'Equipe segura', provider: 'spawn-in-process',
    required_tier: 'T2', sensitive_operation: null, status: 'RUNNING', approved_by: 'user-1', approved_at: '2026-09-05T00:00:00.000Z',
    diagnostic: null, created_at: '2026-09-05T00:00:00.000Z', updated_at: '2026-09-05T00:00:00.000Z',
    ...overrides,
  }
}

function teamTask(overrides: Partial<AgentTeamTaskRecord> = {}): AgentTeamTaskRecord {
  return {
    task_id: 'implementation', team_id: 'team-1', org_id: 'org-1', tenant_id: 'tenant-1', workspace_id: 'tenant-1',
    title: 'Implementar', role: 'implementer', prompt: 'Faça.', intended_paths: ['src/safe'], depends_on: [],
    status: 'RUNNING', run_id: 'run-1', job_id: 'job-1', diagnostic: null,
    created_at: '2026-09-05T00:00:00.000Z', updated_at: '2026-09-05T00:00:00.000Z',
    ...overrides,
  }
}

async function harness(options: {
  role?: 'owner' | 'admin' | 'builder' | 'viewer'
  runs?: AgentRunRecord[]
  providers?: readonly AssistantProvider[]
} = {}) {
  const repositoryPath = await mkdtemp(join(tmpdir(), 'dz23-assistant-repo-'))
  roots.push(repositoryPath)
  await mkdir(join(repositoryPath, '.git'))
  await mkdir(join(repositoryPath, '.git', 'objects'))
  await mkdir(join(repositoryPath, '.git', 'refs'))
  await writeFile(join(repositoryPath, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  const runs = options.runs ?? [run({ repository_path: repositoryPath })]
  let sequence = 0
  const start = vi.fn(() => {
    sequence += 1
    return { runId: sequence === 1 ? 'run-1' : `run-${sequence}`, jobId: `job-${sequence}` as JobId, requiredTier: 'T2' as const }
  })
  const reviewProposal = vi.fn(() => Promise.resolve({ text: 'diff', bytes: 4, files: ['src/safe/a.ts'] }))
  const applyProposal = vi.fn(() => Promise.resolve({ runId: 'run-1', status: 'APPLIED' as const, changedFiles: ['src/safe/a.ts'] }))
  const studioAgents = {
    service: { start, reviewProposal, applyProposal },
    runs: () => runs,
    leases: () => [],
    providerStates: () => ({ codex: 'NOT_PRESENT', 'claude-code': 'NOT_PRESENT' }),
  } as unknown as StudioAgentsRuntime
  const principal = { userId: 'user-1', orgId: 'org-1', tenantId: 'tenant-1', sessionId: 'identity-session' }
  const identity = { service: { principalForHarnessSession: vi.fn((id: string) => id === 'session-1' ? principal : undefined) } } as unknown as StudioIdentityRuntime
  const tenancy = { service: { authorizationFor: vi.fn(() => ({ ...principal, role: options.role ?? 'builder' })) } } as unknown as StudioTenancyRuntime
  const jobs = { kill: vi.fn((): 'requested' | 'already-finished' => 'requested') }
  const config: AssistantRepositoryConfig = {
    orgId: 'org-1', tenantId: 'tenant-1', workspaceId: 'tenant-1', repositoryPath,
    allowedPaths: ['src/safe'], providers: options.providers ?? ['spawn-in-process'], maxPaths: 4,
    budget: { timeoutMs: 60_000, maxFiles: 4, maxDiffBytes: 1_000, maxTokens: 2_000 },
  }
  const teams = [team({ repository_path: repositoryPath })]
  const teamTasks = [teamTask()]
  const teamStart = vi.fn(async () => ({ team: teams[0]!, tasks: teamTasks }))
  const teamStatus = vi.fn(async () => ({ team: teams[0]!, tasks: teamTasks }))
  const teamContinue = vi.fn(async () => ({ team: teams[0]!, tasks: teamTasks }))
  const teamCancel = vi.fn(async () => ({ team: { ...teams[0]!, status: 'CANCELLED' as const }, tasks: teamTasks }))
  const studioAgentTeams = {
    service: { start: teamStart, status: teamStatus, continue: teamContinue, cancel: teamCancel },
    teams: () => teams,
    tasks: () => teamTasks,
    automaticDependentStart: 'NOT_PRESENT',
  } as unknown as StudioAgentTeamRuntime
  const bridge = await StudioAssistantBridge.create({
    resolvePrincipal: current => identity.service.principalForHarnessSession(current.session.id) as never,
    authorizationFor: (userId, orgId, tenantId) => tenancy.service.authorizationFor(userId, orgId, tenantId),
    studioAgents,
    studioAgentTeams,
    killJob: jobs.kill as never,
  }, [config])
  return {
    bridge, config, repositoryPath, runs, start, reviewProposal, applyProposal, jobs, principal,
    teams, teamTasks, teamStart, teamStatus, teamContinue, teamCancel, studioAgentTeams,
  }
}

const invalidConfigurations: ReadonlyArray<readonly [Partial<AssistantRepositoryConfig>, RegExp]> = [
  [{ maxPaths: 0 }, /maxPaths/],
  [{ maxPaths: 51 }, /maxPaths/],
  [{ allowedPaths: ['src', 'src'] }, /duplicados/],
  [{ providers: ['spawn-in-process', 'spawn-in-process'] }, /provedores duplicados/],
  [{ providers: ['unknown'] as never }, /provedor desconhecido/],
  [{ budget: { maxFiles: 51 } }, /maxFiles/],
  [{ orgId: 'org 1' }, /organização/],
]

describe('StudioAssistantBridge', () => {
  it('derives identity and scope server-side and enforces provider and path allowlists', async () => {
    const h = await harness()
    expect(h.bridge.start(agent(), { provider: 'spawn-in-process', prompt: 'Ajuste o arquivo.', intendedPaths: ['src/safe/a.ts'] }))
      .toMatchObject({ run_id: 'run-1', required_tier: 'T2' })
    expect(h.start).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-1', tenantId: 'tenant-1', workspaceId: 'tenant-1', repositoryPath: h.repositoryPath,
      approval: { approved: true, tier: 'T2', approvedBy: 'user-1' },
    }))
    expect(() => h.bridge.start(agent(), { provider: 'spawn-in-process', prompt: 'Amplie o acesso.', intendedPaths: ['src'] }))
      .toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => h.bridge.start(agent(), { provider: 'codex' as never, prompt: 'Ajuste.', intendedPaths: ['src/safe'] }))
      .toThrowError(expect.objectContaining({ code: 'NOT_CONFIGURED' }))
    expect(h.start).toHaveBeenCalledTimes(1)
  })

  it('keeps sensitive start at T3 and never accepts approval or authority fields from args', async () => {
    const h = await harness()
    h.bridge.start(agent(), { provider: 'spawn-in-process', prompt: 'Use a rede configurada.', intendedPaths: ['src/safe'] }, 'external-network')
    expect(h.start).toHaveBeenLastCalledWith(expect.objectContaining({
      usesExternalNetwork: true,
      approval: { approved: true, tier: 'T3', approvedBy: 'user-1' },
    }))
    h.bridge.releaseJob('job-1' as JobId)
    h.bridge.start(agent(), { provider: 'spawn-in-process', prompt: 'Use somente o segredo.', intendedPaths: ['src/safe'] }, 'secrets')
    expect(h.start).toHaveBeenLastCalledWith(expect.objectContaining({
      touchesSecrets: true,
      approval: { approved: true, tier: 'T3', approvedBy: 'user-1' },
      inProcess: expect.objectContaining({ toolFilter: { deny: ['network'] } }),
    }))
  })

  it.each(['codex', 'claude-code'] as const)('refuses external provider %s in administrative configuration at boot', async provider => {
    const h = await harness()
    await expect(StudioAssistantBridge.create({
      resolvePrincipal: () => undefined, authorizationFor: () => undefined, studioAgents: {} as never, killJob: vi.fn(),
    }, [{ ...h.config, providers: ['spawn-in-process', provider] as never }])).rejects.toMatchObject({
      code: 'NOT_CONFIGURED', message: expect.stringContaining('NOT_CONFIGURED'),
    })
  })

  it.each(['codex', 'claude-code'] as const)('refuses a direct %s call before the authoritative agent service', async provider => {
    const h = await harness()
    expect(() => h.bridge.start(agent(), {
      provider: provider as never, prompt: 'Tente iniciar a CLI externa.', intendedPaths: ['src/safe'],
    }, 'secrets')).toThrowError(expect.objectContaining({ code: 'NOT_CONFIGURED' }))
    expect(h.start).not.toHaveBeenCalled()
  })

  it('does not let a junction-shaped path make an external provider reachable', async () => {
    const h = await harness()
    const outside = await mkdtemp(join(tmpdir(), 'dz23-assistant-outside-'))
    roots.push(outside)
    await mkdir(join(h.repositoryPath, 'src', 'safe'), { recursive: true })
    await writeFile(join(outside, 'victim.txt'), 'unchanged\n')
    await symlink(outside, join(h.repositoryPath, 'src', 'safe', 'portal'), process.platform === 'win32' ? 'junction' : 'dir')

    expect(() => h.bridge.start(agent(), {
      provider: 'codex' as never, prompt: 'Altere portal/victim.txt.', intendedPaths: ['src/safe/portal/victim.txt'],
    }, 'external-network')).toThrowError(expect.objectContaining({ code: 'NOT_CONFIGURED' }))
    expect(h.start).not.toHaveBeenCalled()
    await expect(readFile(join(outside, 'victim.txt'), 'utf8')).resolves.toBe('unchanged\n')
  })

  it.each(['codex', 'claude-code'] as const)('hides and rejects an existing %s run from the global Phase 3 runtime', async provider => {
    const h = await harness()
    h.runs.splice(0, h.runs.length, run({ repository_path: h.repositoryPath, provider }))
    expect(h.bridge.list(agent())).toEqual([])
    await expect(h.bridge.review(agent(), 'run-1')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(h.bridge.apply(agent(), 'run-1')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(h.reviewProposal).not.toHaveBeenCalled()
    expect(h.applyProposal).not.toHaveBeenCalled()
  })

  it.each([
    ['another repository', { repository_path: 'C:/not-configured/repository' }],
    ['a path outside the administrative allowlist', { changed_files: ['outside-policy/secret.ts'] }],
    ['an invalid traversal path', { changed_files: ['../outside-policy/secret.ts'] }],
    ['a non-text changed path', { changed_files: [12 as never] }],
  ] satisfies ReadonlyArray<readonly [string, Partial<AgentRunRecord>]>)('hides and rejects a local run bound to %s', async (_label, override) => {
    const h = await harness()
    h.runs.splice(0, h.runs.length, run({ repository_path: h.repositoryPath, ...override }))
    expect(h.bridge.list(agent())).toEqual([])
    await expect(h.bridge.review(agent(), 'run-1')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(h.bridge.apply(agent(), 'run-1')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(h.reviewProposal).not.toHaveBeenCalled()
    expect(h.applyProposal).not.toHaveBeenCalled()
  })

  it('rejects malformed model requests before any delegation', async () => {
    const h = await harness()
    expect(() => h.bridge.start(agent(), { provider: 'spawn-in-process', prompt: '  ', intendedPaths: ['src/safe'] }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    expect(() => h.bridge.start(agent(), { provider: 'spawn-in-process', prompt: 'Ajuste.', intendedPaths: [] }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    expect(() => h.bridge.start(agent(), {
      provider: 'spawn-in-process', prompt: 'Ajuste.', intendedPaths: ['src/safe', 'src/safe/a', 'src/safe/b', 'src/safe/c', 'src/safe/d'],
    })).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    expect(h.start).not.toHaveBeenCalled()
  })

  it('rejects another preset and inherited subagent lineage before creating work', async () => {
    const h = await harness()
    expect(() => h.bridge.start(agent('session-1', 'standard'), { provider: 'spawn-in-process', prompt: 'Tente.', intendedPaths: ['src/safe'] }))
      .toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => h.bridge.start(agent('child', 'dz23-assistant', true), { provider: 'spawn-in-process', prompt: 'Recursão.', intendedPaths: ['src/safe'] }))
      .toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(h.start).not.toHaveBeenCalled()
  })

  it('filters list and diff review before calling the agent service', async () => {
    const foreign = run({ run_id: 'foreign', org_id: 'org-2', tenant_id: 'tenant-2', workspace_id: 'tenant-2' })
    const h = await harness()
    h.runs.push(foreign)
    expect(h.bridge.list(agent())).toHaveLength(1)
    await expect(h.bridge.review(agent(), 'foreign')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(h.reviewProposal).not.toHaveBeenCalled()
    await expect(h.bridge.review(agent(), 'run-1')).resolves.toMatchObject({ diff_text: 'diff' })
  })

  it('localizes a tampered proposal without exposing an unverified diff', async () => {
    const h = await harness()
    h.reviewProposal.mockRejectedValueOnce(Object.assign(new Error('PROPOSAL_TAMPERED'), { code: 'PROPOSAL_TAMPERED' }))
    await expect(h.bridge.review(agent(), 'run-1')).rejects.toMatchObject({
      code: 'INVALID_REQUEST', message: expect.stringContaining('proposta mudou'),
    })
  })

  it('preserves non-tamper failures from the authoritative diff verifier', async () => {
    const h = await harness()
    const failure = new Error('storage unavailable')
    h.reviewProposal.mockRejectedValueOnce(failure)
    await expect(h.bridge.review(agent(), 'run-1')).rejects.toBe(failure)
  })

  it('cancels only a run started by the same person and reports a reconciled terminal run after restart', async () => {
    const h = await harness()
    h.bridge.start(agent(), { provider: 'spawn-in-process', prompt: 'Ajuste.', intendedPaths: ['src/safe'] })
    expect(h.bridge.cancel(agent(), 'run-1')).toMatchObject({ outcome: 'requested', limitation: expect.stringContaining('BETA') })
    expect(h.jobs.kill).toHaveBeenCalledWith('job-1', expect.anything(), expect.any(String))
    const restarted = await StudioAssistantBridge.create({
      resolvePrincipal: () => h.principal,
      authorizationFor: () => ({ role: 'builder' }),
      studioAgents: { service: h.bridge, runs: () => [run({ repository_path: h.repositoryPath })], leases: () => [], providerStates: () => ({}) } as never,
      killJob: h.jobs.kill as never,
    }, [h.config])
    expect(restarted.cancel(agent(), 'run-1')).toMatchObject({
      outcome: 'already-finished',
      limitation: expect.stringContaining('recuperação do reinício'),
    })
    expect(h.jobs.kill).toHaveBeenCalledTimes(1)

    const unreconciled = await StudioAssistantBridge.create({
      resolvePrincipal: () => h.principal,
      authorizationFor: () => ({ role: 'builder' }),
      studioAgents: {
        service: h.bridge,
        runs: () => [run({ repository_path: h.repositoryPath, status: 'RUNNING' })],
        leases: () => [],
        providerStates: () => ({}),
      } as never,
      killJob: h.jobs.kill as never,
    }, [h.config])
    expect(() => unreconciled.cancel(agent(), 'run-1'))
      .toThrowError(expect.objectContaining({ code: 'CANCEL_UNAVAILABLE' }))
    expect(h.jobs.kill).toHaveBeenCalledTimes(1)
  })

  it('refuses cancellation by a different authenticated owner and ignores unknown lifecycle ids', async () => {
    const h = await harness()
    h.runs.splice(0, h.runs.length, run({ repository_path: h.repositoryPath, approved_by: 'other-user' }))
    h.bridge.releaseJob('unknown-job' as JobId)
    expect(() => h.bridge.cancel(agent(), 'run-1')).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(h.jobs.kill).not.toHaveBeenCalled()
  })

  it('fails closed when an active cancellation handle disagrees with the persisted owner', async () => {
    const h = await harness()
    h.bridge.start(agent(), { provider: 'spawn-in-process', prompt: 'Ajuste.', intendedPaths: ['src/safe'] })
    h.principal.userId = 'replacement-user'
    h.runs.splice(0, h.runs.length, run({ repository_path: h.repositoryPath, approved_by: 'replacement-user' }))
    expect(() => h.bridge.cancel(agent(), 'run-1')).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(h.jobs.kill).not.toHaveBeenCalled()
  })

  it('releases terminal job handles and stays bounded across long conversations', async () => {
    const h = await harness()
    for (let index = 1; index <= 125; index += 1) {
      const accepted = h.bridge.start(agent(), {
        provider: 'spawn-in-process', prompt: `Ajuste seguro ${index}.`, intendedPaths: ['src/safe'],
      })
      expect(h.bridge.activeJobCount()).toBe(1)
      h.bridge.releaseJob(accepted.job_id as JobId)
    }
    expect(h.bridge.activeJobCount()).toBe(0)
  })

  it('drops a stale cancel handle when the registry reports the job already finished', async () => {
    const h = await harness()
    h.jobs.kill.mockReturnValueOnce('already-finished')
    h.bridge.start(agent(), { provider: 'spawn-in-process', prompt: 'Ajuste.', intendedPaths: ['src/safe'] })
    expect(h.bridge.cancel(agent(), 'run-1')).toMatchObject({ outcome: 'already-finished' })
    expect(h.bridge.activeJobCount()).toBe(0)
  })

  it('filters apply by scope and derives the second T2 approval from the current principal', async () => {
    const h = await harness()
    h.runs.push(run({ run_id: 'foreign', org_id: 'other' }))
    await expect(h.bridge.apply(agent(), 'foreign')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(h.applyProposal).not.toHaveBeenCalled()
    await expect(h.bridge.apply(agent(), 'run-1')).resolves.toMatchObject({ status: 'APPLIED' })
    expect(h.applyProposal).toHaveBeenCalledWith('run-1', { approved: true, tier: 'T2', approvedBy: 'user-1' })
  })

  it.each(invalidConfigurations)('validates the administrative allowlist at runtime: %j', async (override, error) => {
    const h = await harness()
    await expect(StudioAssistantBridge.create({
      resolvePrincipal: () => undefined, authorizationFor: () => undefined, studioAgents: {} as never, killJob: vi.fn(),
    }, [{ ...h.config, ...override }])).rejects.toThrow(error)
  })

  it('accepts bounded zero budgets and rejects unknown administrative fields', async () => {
    const h = await harness()
    const zeroBudget = { ...h.config, budget: { timeoutMs: 0, maxFiles: 0, maxDiffBytes: 0, maxTokens: 0 } }
    await expect(StudioAssistantBridge.create({
      resolvePrincipal: () => undefined, authorizationFor: () => undefined, studioAgents: {} as never, killJob: vi.fn(),
    }, [zeroBudget])).resolves.toBeInstanceOf(StudioAssistantBridge)
    await expect(StudioAssistantBridge.create({
      resolvePrincipal: () => undefined, authorizationFor: () => undefined, studioAgents: {} as never, killJob: vi.fn(),
    }, [{ ...h.config, unexpected: true } as never])).rejects.toThrow(/campos desconhecidos/)
  })

  it('uses bounded defaults when optional administrative limits are absent', async () => {
    const h = await harness()
    const { budget: _budget, maxPaths: _maxPaths, ...minimal } = h.config
    const bridge = await StudioAssistantBridge.create({
      resolvePrincipal: () => h.principal,
      authorizationFor: () => ({ role: 'builder' }),
      studioAgents: {
        service: { start: h.start }, runs: () => [], leases: () => [], providerStates: () => ({}),
      } as never,
      killJob: h.jobs.kill as never,
    }, [minimal])
    expect(bridge.start(agent(), {
      provider: 'spawn-in-process', prompt: 'Use os limites seguros.', intendedPaths: ['src/safe'],
    })).toMatchObject({ status: 'RUNNING' })
    expect(h.start).toHaveBeenCalledWith(expect.not.objectContaining({ budget: expect.anything() }))

    const bridgeWithTeams = await StudioAssistantBridge.create({
      resolvePrincipal: () => h.principal,
      authorizationFor: () => ({ role: 'builder' }),
      studioAgents: {
        service: { start: h.start }, runs: () => [], leases: () => [], providerStates: () => ({}),
      } as never,
      studioAgentTeams: h.studioAgentTeams,
      killJob: h.jobs.kill as never,
    }, [minimal])
    await bridgeWithTeams.startTeam(agent(), {
      provider: 'spawn-in-process', name: 'Equipe sem orçamento', tasks: [{
        taskId: 'test', title: 'Testar', role: 'tester', prompt: 'Teste.', intendedPaths: ['src/safe'], dependsOn: [],
      }],
    })
    expect(h.teamStart).toHaveBeenCalledWith(expect.not.objectContaining({ budget: expect.anything() }))
  })

  it('denies writes to a viewer even when the model asks for them', async () => {
    const h = await harness({ role: 'viewer' })
    expect(() => h.bridge.start(agent(), { provider: 'spawn-in-process', prompt: 'Tente.', intendedPaths: ['src/safe'] }))
      .toThrowError(new AssistantBridgeError('FORBIDDEN', 'Seu papel não permite esta ação.'))
  })

  it('fails closed for missing session, identity, membership and repository scope', async () => {
    const h = await harness()
    expect(() => h.bridge.list(undefined)).toThrowError(expect.objectContaining({ code: 'UNAUTHENTICATED' }))
    const noIdentity = await StudioAssistantBridge.create({
      resolvePrincipal: () => undefined,
      authorizationFor: () => ({ role: 'builder' }),
      studioAgents: {} as never,
      killJob: vi.fn(),
    }, [h.config])
    expect(() => noIdentity.list(agent())).toThrowError(expect.objectContaining({ code: 'UNAUTHENTICATED' }))
    const noMembership = await StudioAssistantBridge.create({
      resolvePrincipal: () => h.principal,
      authorizationFor: () => undefined,
      studioAgents: {} as never,
      killJob: vi.fn(),
    }, [h.config])
    expect(() => noMembership.list(agent())).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    const noRepository = await StudioAssistantBridge.create({
      resolvePrincipal: () => h.principal,
      authorizationFor: () => ({ role: 'builder' }),
      studioAgents: {} as never,
      killJob: vi.fn(),
    }, [])
    expect(() => noRepository.list(agent())).toThrowError(expect.objectContaining({ code: 'NOT_CONFIGURED' }))
  })

  it('rejects duplicate repository scopes and filesystem configurations that are not Git roots', async () => {
    const h = await harness()
    const dependencies = {
      resolvePrincipal: () => undefined,
      authorizationFor: () => undefined,
      studioAgents: {} as never,
      killJob: vi.fn(),
    }
    await expect(StudioAssistantBridge.create(dependencies, [h.config, h.config]))
      .rejects.toThrow(/duplicado/)
    await expect(StudioAssistantBridge.create(dependencies, [{ ...h.config, repositoryPath: 'relative' }]))
      .rejects.toThrow(/absoluto/)

    const noGit = await mkdtemp(join(tmpdir(), 'dz23-assistant-no-git-'))
    roots.push(noGit)
    await expect(StudioAssistantBridge.create(dependencies, [{ ...h.config, repositoryPath: noGit }]))
      .rejects.toThrow(/Git/)

    const file = join(h.repositoryPath, 'not-a-directory')
    await writeFile(file, 'x')
    await expect(StudioAssistantBridge.create(dependencies, [{ ...h.config, repositoryPath: file }]))
      .rejects.toThrow(/diretório/)
    await expect(StudioAssistantBridge.create(dependencies, [{ ...h.config, repositoryPath: 12 as never }]))
      .rejects.toThrow(/precisam ser texto/)
  })

  it('rejects a Git root whose HEAD entry disappears', async () => {
    const h = await harness()
    await rm(join(h.repositoryPath, '.git', 'HEAD'))
    await expect(StudioAssistantBridge.create({
      resolvePrincipal: () => undefined,
      authorizationFor: () => undefined,
      studioAgents: {} as never,
      killJob: vi.fn(),
    }, [h.config])).rejects.toThrow(/Git/)
  })

  it('rejects a .git symlink to an external directory before any agent work can start', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'dz23-assistant-linked-git-'))
    const externalGit = await mkdtemp(join(tmpdir(), 'dz23-assistant-external-git-'))
    roots.push(repositoryPath, externalGit)
    await symlink(externalGit, join(repositoryPath, '.git'), 'junction')
    const start = vi.fn()
    await expect(StudioAssistantBridge.create({
      resolvePrincipal: () => undefined,
      authorizationFor: () => undefined,
      studioAgents: { service: { start } } as never,
      killJob: vi.fn(),
    }, [{
      orgId: 'org-1', tenantId: 'tenant-1', workspaceId: 'tenant-1', repositoryPath,
      allowedPaths: ['src'], providers: ['spawn-in-process'],
    }])).rejects.toThrow(/Git/)
    expect(start).not.toHaveBeenCalled()
  })

  it('accepts only a bounded regular .git worktree descriptor', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'dz23-assistant-worktree-'))
    const commonGit = await mkdtemp(join(tmpdir(), 'dz23-assistant-common-git-'))
    const adminPath = join(commonGit, 'worktrees', 'assistant')
    roots.push(repositoryPath, commonGit)
    await mkdir(adminPath, { recursive: true })
    await mkdir(join(commonGit, 'objects'))
    await mkdir(join(commonGit, 'refs'))
    await writeFile(join(commonGit, 'HEAD'), 'ref: refs/heads/main\n')
    await writeFile(join(adminPath, 'HEAD'), '0123456789012345678901234567890123456789\n')
    await writeFile(join(adminPath, 'commondir'), '../..\n')
    await writeFile(join(repositoryPath, '.git'), `gitdir: ${adminPath}\n`)
    await writeFile(join(adminPath, 'gitdir'), `${join(repositoryPath, '.git')}\n`)
    await expect(StudioAssistantBridge.create({
      resolvePrincipal: () => undefined,
      authorizationFor: () => undefined,
      studioAgents: {} as never,
      killJob: vi.fn(),
    }, [{
      orgId: 'org-1', tenantId: 'tenant-1', workspaceId: 'tenant-1', repositoryPath,
      allowedPaths: ['src'], providers: ['spawn-in-process'],
    }])).resolves.toBeInstanceOf(StudioAssistantBridge)

    await rm(join(adminPath, 'gitdir'))
    await expect(StudioAssistantBridge.create({
      resolvePrincipal: () => undefined,
      authorizationFor: () => undefined,
      studioAgents: {} as never,
      killJob: vi.fn(),
    }, [{
      orgId: 'org-1', tenantId: 'tenant-1', workspaceId: 'tenant-1', repositoryPath,
      allowedPaths: ['src'], providers: ['spawn-in-process'],
    }])).rejects.toThrow(/Git/)
    await writeFile(join(adminPath, 'gitdir'), `${join(repositoryPath, 'other.git')}\n`)
    await expect(StudioAssistantBridge.create({
      resolvePrincipal: () => undefined,
      authorizationFor: () => undefined,
      studioAgents: {} as never,
      killJob: vi.fn(),
    }, [{
      orgId: 'org-1', tenantId: 'tenant-1', workspaceId: 'tenant-1', repositoryPath,
      allowedPaths: ['src'], providers: ['spawn-in-process'],
    }])).rejects.toThrow(/Git/)
    await writeFile(join(adminPath, 'gitdir'), `${join(repositoryPath, '.git')}\n`)

    await writeFile(join(repositoryPath, '.git'), `gitdir: ${adminPath}\nextra\n`)
    await expect(StudioAssistantBridge.create({
      resolvePrincipal: () => undefined,
      authorizationFor: () => undefined,
      studioAgents: {} as never,
      killJob: vi.fn(),
    }, [{
      orgId: 'org-1', tenantId: 'tenant-1', workspaceId: 'tenant-1', repositoryPath,
      allowedPaths: ['src'], providers: ['spawn-in-process'],
    }])).rejects.toThrow(/Git/)
  })

  it('fails closed for every malformed worktree descriptor boundary', async () => {
    const dependencies = {
      resolvePrincipal: () => undefined,
      authorizationFor: () => undefined,
      studioAgents: {} as never,
      killJob: vi.fn(),
    }
    const reject = async (repositoryPath: string) => {
      await expect(StudioAssistantBridge.create(dependencies, [{
        orgId: 'org-1', tenantId: 'tenant-1', workspaceId: 'tenant-1', repositoryPath,
        allowedPaths: ['src'], providers: ['spawn-in-process'],
      }])).rejects.toThrow(/Git/)
    }
    const repository = async (descriptor: string) => {
      const path = await mkdtemp(join(tmpdir(), 'dz23-assistant-invalid-worktree-'))
      roots.push(path)
      await writeFile(join(path, '.git'), descriptor)
      return path
    }

    await reject(await repository('x'))
    await reject(await repository('gitdir: missing-admin\n'))

    const adminFile = await mkdtemp(join(tmpdir(), 'dz23-assistant-admin-file-'))
    roots.push(adminFile)
    await writeFile(join(adminFile, 'admin'), 'not a directory')
    await reject(await repository(`gitdir: ${join(adminFile, 'admin')}\n`))

    const noCommon = await mkdtemp(join(tmpdir(), 'dz23-assistant-no-common-'))
    roots.push(noCommon)
    await reject(await repository(`gitdir: ${noCommon}\n`))

    const missingCommon = await mkdtemp(join(tmpdir(), 'dz23-assistant-missing-common-'))
    roots.push(missingCommon)
    await writeFile(join(missingCommon, 'commondir'), '../missing')
    await reject(await repository(`gitdir: ${missingCommon}\n`))

    const outsideAdmin = await mkdtemp(join(tmpdir(), 'dz23-assistant-outside-admin-'))
    const outsideCommon = await mkdtemp(join(tmpdir(), 'dz23-assistant-outside-common-'))
    roots.push(outsideAdmin, outsideCommon)
    await writeFile(join(outsideAdmin, 'commondir'), outsideCommon)
    await reject(await repository(`gitdir: ${outsideAdmin}\n`))

    const commonWithoutHead = await mkdtemp(join(tmpdir(), 'dz23-assistant-common-no-head-'))
    const adminWithoutHead = join(commonWithoutHead, 'worktrees', 'assistant')
    roots.push(commonWithoutHead)
    await mkdir(adminWithoutHead, { recursive: true })
    await mkdir(join(commonWithoutHead, 'objects'))
    await mkdir(join(commonWithoutHead, 'refs'))
    await writeFile(join(adminWithoutHead, 'commondir'), '../..')
    await reject(await repository(`gitdir: ${adminWithoutHead}\n`))

    const nestedCommon = await mkdtemp(join(tmpdir(), 'dz23-assistant-nested-admin-'))
    const nestedAdmin = join(nestedCommon, 'evil', 'nested')
    roots.push(nestedCommon)
    await mkdir(nestedAdmin, { recursive: true })
    await mkdir(join(nestedCommon, 'worktrees'))
    await mkdir(join(nestedCommon, 'objects'))
    await mkdir(join(nestedCommon, 'refs'))
    await writeFile(join(nestedAdmin, 'HEAD'), '0123456789012345678901234567890123456789\n')
    await writeFile(join(nestedAdmin, 'commondir'), '../..')
    await reject(await repository(`gitdir: ${nestedAdmin}\n`))

    const missingObjects = await mkdtemp(join(tmpdir(), 'dz23-assistant-missing-objects-'))
    roots.push(missingObjects)
    await mkdir(join(missingObjects, '.git', 'refs'), { recursive: true })
    await writeFile(join(missingObjects, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    await reject(missingObjects)

    const unsafeConfig = await mkdtemp(join(tmpdir(), 'dz23-assistant-unsafe-config-'))
    roots.push(unsafeConfig)
    await mkdir(join(unsafeConfig, '.git', 'objects'), { recursive: true })
    await mkdir(join(unsafeConfig, '.git', 'refs'))
    await mkdir(join(unsafeConfig, '.git', 'config'))
    await writeFile(join(unsafeConfig, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    await reject(unsafeConfig)
  })

  it.each([
    [{ workspaceId: 'workspace-other' }, /projeto liberado/],
    [{ allowedPaths: [] }, /allowedPaths/],
    [{ allowedPaths: 'src' as never }, /allowedPaths/],
    [{ providers: [] }, /ao menos um provedor/],
    [{ providers: 'spawn-in-process' as never }, /provedores conhecidos/],
    [{ maxPaths: 1.5 }, /maxPaths/],
    [{ budget: { timeoutMs: -1 } }, /timeoutMs/],
    [{ budget: { maxTokens: 2_000_001 } }, /maxTokens/],
    [{ budget: null as never }, /objeto/],
  ] satisfies ReadonlyArray<readonly [Partial<AssistantRepositoryConfig>, RegExp]>)('covers fail-closed configuration variants: %j', async (override, error) => {
    const h = await harness()
    await expect(StudioAssistantBridge.create({
      resolvePrincipal: () => undefined, authorizationFor: () => undefined, studioAgents: {} as never, killJob: vi.fn(),
    }, [{ ...h.config, ...override }])).rejects.toThrow(error)
  })

  it('normalizes safe paths and rejects ambiguous or escaping paths', () => {
    expect(normalizeRelativePath('src\\safe')).toBe('src/safe')
    for (const value of [
      '', '.', '*', '/root', '..', '../src', './src', 'src/.', 'src/..', 'src//safe',
      'C:/root', 'C:\\root', '\\server\\share', ' src', 'src ', 'src\0safe', 'src\nsafe',
    ]) {
      expect(() => normalizeRelativePath(value)).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    }
  })

  it('starts normal and sensitive teams with server-side scope, path policy and approval tier', async () => {
    const h = await harness()
    const input = {
      provider: 'spawn-in-process' as const,
      name: 'Equipe núcleo',
      tasks: [{
        taskId: 'implementation', title: 'Implementar', role: 'implementer' as const,
        prompt: 'Faça a mudança.', intendedPaths: ['src\\safe\\a.ts'], dependsOn: [],
      }],
    }
    await expect(h.bridge.startTeam(agent(), input)).resolves.toMatchObject({ team_id: 'team-1', tasks: [{ task_id: 'implementation' }] })
    expect(h.teamStart).toHaveBeenLastCalledWith(expect.objectContaining({
      orgId: 'org-1', tenantId: 'tenant-1', workspaceId: 'tenant-1', repositoryPath: h.repositoryPath,
      approval: { approved: true, tier: 'T2', approvedBy: 'user-1' },
      tasks: [expect.objectContaining({ intendedPaths: ['src/safe/a.ts'] })],
    }))
    await h.bridge.startTeam(agent(), input, 'deploy')
    expect(h.teamStart).toHaveBeenLastCalledWith(expect.objectContaining({
      sensitive: 'deploy', approval: { approved: true, tier: 'T3', approvedBy: 'user-1' },
    }))
    await expect(h.bridge.startTeam(agent(), { ...input, provider: 'codex' as never }))
      .rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
    await expect(h.bridge.startTeam(agent(), { ...input, tasks: [{ ...input.tasks[0]!, intendedPaths: ['outside'] }] }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(h.bridge.startTeam(agent(), { ...input, tasks: [{ ...input.tasks[0]!, intendedPaths: [] }] }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('lists, reads, continues and cancels only a scoped team', async () => {
    const h = await harness()
    expect(h.bridge.listTeams(agent())).toEqual([expect.objectContaining({
      team_id: 'team-1', name: 'Equipe segura', tasks: [expect.objectContaining({ task_id: 'implementation' })],
    })])
    await expect(h.bridge.teamStatus(agent(), 'team-1')).resolves.toMatchObject({ team_id: 'team-1' })
    await expect(h.bridge.continueTeam(agent(), 'team-1', false)).resolves.toMatchObject({ team_id: 'team-1' })
    expect(h.teamContinue).toHaveBeenCalledWith('team-1', expect.anything(), {
      approved: true, tier: 'T2', approvedBy: 'user-1',
    }, h.config.budget)
    await expect(h.bridge.continueTeam(agent(), 'team-1', true)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    h.teams[0] = { ...h.teams[0]!, required_tier: 'T3', sensitive_operation: 'secrets' }
    await expect(h.bridge.continueTeam(agent(), 'team-1', true)).resolves.toMatchObject({ team_id: 'team-1' })
    await expect(h.bridge.cancelTeam(agent(), 'team-1', 'pare')).resolves.toMatchObject({ status: 'CANCELLED' })
    expect(h.teamCancel).toHaveBeenCalledWith('team-1', 'user-1', 'pare')

    h.teams[0] = { ...h.teams[0]!, org_id: 'foreign' }
    expect(h.bridge.listTeams(agent())).toEqual([])
    await expect(h.bridge.teamStatus(agent(), 'team-1')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(h.bridge.cancelTeam(agent(), 'team-1')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('fails closed when team composition is absent or a returned task crosses scope', async () => {
    const h = await harness()
    const withoutTeams = await StudioAssistantBridge.create({
      resolvePrincipal: () => h.principal,
      authorizationFor: () => ({ role: 'builder' }),
      studioAgents: {} as never,
      killJob: vi.fn(),
    }, [h.config])
    await expect(withoutTeams.startTeam(agent(), {
      provider: 'spawn-in-process', name: 'Equipe', tasks: [{
        taskId: 'task', title: 'Tarefa', role: 'tester', prompt: 'Teste.', intendedPaths: ['src/safe'], dependsOn: [],
      }],
    })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' })

    h.teamTasks[0] = { ...h.teamTasks[0]!, tenant_id: 'foreign' }
    expect(() => h.bridge.listTeams(agent())).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }))
    await expect(h.bridge.teamStatus(agent(), 'team-1')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

})
