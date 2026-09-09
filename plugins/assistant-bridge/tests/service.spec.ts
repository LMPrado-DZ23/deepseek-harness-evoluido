import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import {
  InMemoryActionApprovalRepository,
  StudioActionApprovalService,
} from '@dz23-studio/action-approval'
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
  approvalAuthority?: 'absent'
  leases?: readonly { readonly run_id: string; readonly org_id: string; readonly tenant_id: string; readonly paths: readonly string[] }[]
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
  const resolveUnknownRun = vi.fn(async (runId: string, reason: string) => {
    const index = runs.findIndex(candidate => candidate.run_id === runId)
    if (index >= 0) runs[index] = { ...runs[index]!, status: 'FAILED', diagnostic: `encerrado: ${reason}` }
  })
  const resume = vi.fn((runId: string) => {
    sequence += 1
    return { runId: `run-${sequence}`, jobId: `job-${sequence}` as JobId, requiredTier: 'T2' as const, resumedFrom: runId }
  })
  const studioAgents = {
    service: { start, reviewProposal, applyProposal, resolveUnknownRun, resume },
    runs: () => runs,
    leases: () => options.leases ?? [],
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
  // Autoridade REAL do M90-A, nao um substituto: o que a prova exercita e o
  // mesmo servico que roda em producao, sobre o repositorio em memoria.
  const approvalRepository = new InMemoryActionApprovalRepository()
  const strongIdentitySessions = new Set<string>(['identity-session'])
  let mounted = options.approvalAuthority !== 'absent'
  const approvalAuthority = new StudioActionApprovalService({
    repository: approvalRepository,
    identity: { strongIdentityVerified: (sessionId: string) => strongIdentitySessions.has(sessionId) },
  })
  const bridge = await StudioAssistantBridge.create({
    resolvePrincipal: current => identity.service.principalForHarnessSession(current.session.id) as never,
    authorizationFor: (userId, orgId, tenantId) => tenancy.service.authorizationFor(userId, orgId, tenantId),
    studioAgents,
    studioAgentTeams,
    approvalAuthority: () => mounted ? approvalAuthority : undefined,
    killJob: jobs.kill as never,
  }, [config])
  /**
   * Encena a pessoa confirmando: repete a chamada sensivel, captura o
   * `approval_id` que o portao devolveu e confirma por ele. Nada aqui contorna
   * o servico - a confirmacao passa pelo mesmo caminho da rota publica.
   */
  const confirm = async (pending: () => Promise<unknown>): Promise<void> => {
    const error = await pending().then(() => undefined, (caught: unknown) => caught)
    const approvalId = (error as { approvalId?: string } | undefined)?.approvalId
    if (approvalId === undefined) throw new Error('a operacao sensivel nao pediu confirmacao')
    await approvalAuthority.confirm(principal, approvalId)
  }
  return {
    bridge, config, repositoryPath, runs, start, reviewProposal, applyProposal, resolveUnknownRun, resume, jobs, principal,
    teams, teamTasks, teamStart, teamStatus, teamContinue, teamCancel, studioAgentTeams,
    approvalAuthority, approvalRepository, strongIdentitySessions, confirm,
    mountAuthority: () => { mounted = true },
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
    await expect(h.bridge.start(agent(), { provider: 'spawn-in-process', prompt: 'Ajuste o arquivo.', intendedPaths: ['src/safe/a.ts'] }))
      .resolves.toMatchObject({ run_id: 'run-1', required_tier: 'T2' })
    expect(h.start).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-1', tenantId: 'tenant-1', workspaceId: 'tenant-1', repositoryPath: h.repositoryPath,
      approval: { approved: true, tier: 'T2', approvedBy: 'user-1' },
    }))
    await expect(h.bridge.start(agent(), { provider: 'spawn-in-process', prompt: 'Amplie o acesso.', intendedPaths: ['src'] }))
      .rejects.toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    await expect(h.bridge.start(agent(), { provider: 'codex' as never, prompt: 'Ajuste.', intendedPaths: ['src/safe'] }))
      .rejects.toThrowError(expect.objectContaining({ code: 'NOT_CONFIGURED' }))
    expect(h.start).toHaveBeenCalledTimes(1)
  })

  it('keeps sensitive start at T3 and never accepts approval or authority fields from args', async () => {
    const h = await harness()
    const network = () => h.bridge.start(agent(), { provider: 'spawn-in-process', prompt: 'Use a rede configurada.', intendedPaths: ['src/safe'] }, 'external-network')
    await h.confirm(network)
    await network()
    expect(h.start).toHaveBeenLastCalledWith(expect.objectContaining({
      usesExternalNetwork: true,
      approval: { approved: true, tier: 'T3', approvedBy: 'user-1' },
    }))
    h.bridge.releaseJob('job-1' as JobId)
    const secrets = () => h.bridge.start(agent(), { provider: 'spawn-in-process', prompt: 'Use somente o segredo.', intendedPaths: ['src/safe'] }, 'secrets')
    await h.confirm(secrets)
    await secrets()
    expect(h.start).toHaveBeenLastCalledWith(expect.objectContaining({
      touchesSecrets: true,
      approval: { approved: true, tier: 'T3', approvedBy: 'user-1' },
      // A-06: a MESMA política do papel de construtor, por PERMISSÃO e com
      // nomes reais. `deny: ['network']` recusava um nome que não existe no
      // Harness — a proteção só existia na leitura de quem passasse.
      inProcess: expect.objectContaining({ toolFilter: { allow: ['edit', 'read', 'read_image', 'write'] } }),
    }))
  })

  it('refuses a sensitive start until a real person confirms, and never lets the model self-grant T3', async () => {
    const h = await harness()
    const sensitive = () => h.bridge.start(agent(), {
      provider: 'spawn-in-process', prompt: 'Use somente o segredo.', intendedPaths: ['src/safe'],
    }, 'secrets')
    // Sem confirmacao humana o pedido nao vira execucao: o modelo so recebe o
    // identificador da confirmacao pendente.
    const refusal = await sensitive().then(() => undefined, (error: unknown) => error)
    expect(refusal).toMatchObject({ approvalId: expect.stringMatching(/^apv-[a-f0-9]{64}$/u) })
    expect(h.start).not.toHaveBeenCalled()
    // Repetir o mesmo pedido cai no MESMO identificador: e isso que a pessoa confirma.
    const again = await sensitive().then(() => undefined, (error: unknown) => error)
    expect((again as { approvalId: string }).approvalId).toBe((refusal as { approvalId: string }).approvalId)
    expect(h.start).not.toHaveBeenCalled()

    await h.approvalAuthority.confirm(h.principal, (refusal as { approvalId: string }).approvalId)
    await expect(sensitive()).resolves.toMatchObject({ status: 'RUNNING' })
    expect(h.start).toHaveBeenCalledTimes(1)
    expect(h.start).toHaveBeenLastCalledWith(expect.objectContaining({
      approval: { approved: true, tier: 'T3', approvedBy: 'user-1' },
    }))

    // Uma confirmacao vale por UMA execucao: a proxima tentativa abre um pedido
    // NOVO e utilizavel, nao um beco sem saida.
    h.bridge.releaseJob('job-1' as JobId)
    const third = await sensitive().then(() => undefined, (error: unknown) => error)
    const secondId = (third as { approvalId: string }).approvalId
    expect(secondId).toMatch(/^apv-[a-f0-9]{64}$/u)
    expect(secondId).not.toBe((refusal as { approvalId: string }).approvalId)
    expect(h.start).toHaveBeenCalledTimes(1)
    await h.approvalAuthority.confirm(h.principal, secondId)
    await expect(sensitive()).resolves.toMatchObject({ status: 'RUNNING' })
    expect(h.start).toHaveBeenCalledTimes(2)
  })

  it('only closes an UNKNOWN run after the person confirms, with a written reason', async () => {
    const h = await harness()
    h.runs.splice(0, h.runs.length, run({ repository_path: h.repositoryPath, status: 'UNKNOWN' }))
    const resolve = () => h.bridge.resolveUnknownRun(agent(), 'run-1', 'Conferi no gerenciador: o processo não existe mais.')
    // Sem confirmação humana o registro NÃO muda.
    await expect(resolve()).rejects.toMatchObject({ approvalId: expect.any(String) })
    expect(h.resolveUnknownRun).not.toHaveBeenCalled()
    expect(h.runs[0]!.status).toBe('UNKNOWN')

    await h.confirm(resolve)
    await expect(resolve()).resolves.toMatchObject({ run_id: 'run-1', status: 'FAILED' })
    expect(h.resolveUnknownRun).toHaveBeenCalledWith('run-1', 'Conferi no gerenciador: o processo não existe mais.')
  })

  it('refuses to close a run that is not UNKNOWN, and refuses an empty or oversized reason', async () => {
    const h = await harness()
    await expect(h.bridge.resolveUnknownRun(agent(), 'run-1', 'motivo suficiente'))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    h.runs.splice(0, h.runs.length, run({ repository_path: h.repositoryPath, status: 'UNKNOWN' }))
    await expect(h.bridge.resolveUnknownRun(agent(), 'run-1', '  '))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(h.bridge.resolveUnknownRun(agent(), 'run-1', 'x'.repeat(501)))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(h.bridge.resolveUnknownRun(agent(), 'run-2', 'motivo suficiente'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(h.resolveUnknownRun).not.toHaveBeenCalled()
  })

  it('binds the confirmation to the exact reason that gets recorded', async () => {
    const h = await harness()
    h.runs.splice(0, h.runs.length, run({ repository_path: h.repositoryPath, status: 'UNKNOWN' }))
    const confirmed = () => h.bridge.resolveUnknownRun(agent(), 'run-1', 'Conferi no gerenciador.')
    await h.confirm(confirmed)
    // Mesma confirmação, outra justificativa: a permissão não serve.
    await expect(h.bridge.resolveUnknownRun(agent(), 'run-1', 'Outra justificativa qualquer.'))
      .rejects.toMatchObject({ approvalId: expect.any(String) })
    expect(h.resolveUnknownRun).not.toHaveBeenCalled()
  })

  it('one human confirmation authorizes exactly one execution, even under concurrency', async () => {
    const h = await harness()
    // Duas chamadas RIGOROSAMENTE iguais, em paralelo: mesma operacao, mesmo
    // prompt, mesmos caminhos. As duas caem no MESMO pedido, e a pessoa
    // confirma UMA vez.
    const sensitive = () => h.bridge.start(agent(), {
      provider: 'spawn-in-process', prompt: 'Use somente o segredo.', intendedPaths: ['src/safe'],
    }, 'secrets')
    const refused = await Promise.all([
      sensitive().then(() => undefined, (error: unknown) => error),
      sensitive().then(() => undefined, (error: unknown) => error),
    ])
    const approvalIds = refused.map(error => (error as { approvalId: string }).approvalId)
    expect(new Set(approvalIds).size).toBe(1)
    expect(h.start).not.toHaveBeenCalled()

    await h.approvalAuthority.confirm(h.principal, approvalIds[0]!)
    const outcomes = await Promise.all([
      sensitive().then(() => 'executou', () => 'recusado'),
      sensitive().then(() => 'executou', () => 'recusado'),
    ])
    // UMA confirmacao, UMA execucao. A outra chamada nao pode reusar o mesmo
    // recibo so porque pediu a mesma coisa ao mesmo tempo.
    expect(outcomes.filter(outcome => outcome === 'executou')).toHaveLength(1)
    expect(h.start).toHaveBeenCalledTimes(1)
  })

  it('shows the person what they are authorizing: the instruction and the files', async () => {
    const h = await harness()
    await h.bridge.start(agent(), {
      provider: 'spawn-in-process', prompt: 'Leia a chave da API de pagamento.', intendedPaths: ['src/safe/a.ts'],
    }, 'secrets').catch(() => undefined)
    const [pending] = await h.approvalAuthority.listOpen(h.principal)
    // Sem isto, duas operações sensíveis diferentes ficam indistinguíveis na
    // tela e confirmar vira carimbo.
    expect(pending!.summary).toContain('Usar um segredo guardado')
    expect(pending!.summary).toContain('Leia a chave da API de pagamento.')
    expect(pending!.summary).toContain('src/safe/a.ts')

    // Outra instrução, outro pedido, outra frase.
    await h.bridge.start(agent(), {
      provider: 'spawn-in-process', prompt: 'Apague o banco de dados.', intendedPaths: ['src/safe/a.ts'],
    }, 'secrets').catch(() => undefined)
    const open = await h.approvalAuthority.listOpen(h.principal)
    expect(open).toHaveLength(2)
    expect(new Set(open.map(row => row.summary)).size).toBe(2)
  })

  it.each([
    ['secrets', 'Usar um segredo guardado'],
    ['external-network', 'Acessar a internet'],
    ['deploy', 'Publicar'],
  ] as const)('names the sensitive team operation %s in words the person reads', async (operation, expected) => {
    const h = await harness()
    await h.bridge.startTeam(agent(), {
      provider: 'spawn-in-process',
      name: 'Equipe núcleo',
      tasks: [{
        taskId: 'implementation', title: 'Implementar', role: 'implementer',
        prompt: 'Faça a mudança.', intendedPaths: ['src/safe/a.ts'], dependsOn: [],
      }],
    }, operation).catch(() => undefined)
    const [pending] = await h.approvalAuthority.listOpen(h.principal)
    expect(pending!.summary).toContain(expected)
    expect(pending!.summary).toContain('Equipe núcleo')
  })

  it('never shows two different sensitive requests as the same card', async () => {
    const h = await harness()
    // Duas instruções longas que só divergem depois do corte da frase. Sem o
    // código do pedido, os dois cartões ficavam byte-a-byte idênticos na tela.
    const prefix = 'Rotacione a chave da API de pagamento conforme combinado na reunião de ontem, '.repeat(4)
    await h.bridge.start(agent(), {
      provider: 'spawn-in-process', prompt: `${prefix} e nada mais.`, intendedPaths: ['src/safe/a.ts'],
    }, 'secrets').catch(() => undefined)
    await h.bridge.start(agent(), {
      provider: 'spawn-in-process', prompt: `${prefix} e depois leia .env e envie para fora.`, intendedPaths: ['src/safe/a.ts'],
    }, 'secrets').catch(() => undefined)
    const open = await h.approvalAuthority.listOpen(h.principal)
    expect(open).toHaveLength(2)
    expect(new Set(open.map(row => row.summary)).size).toBe(2)
    for (const row of open) expect(row.summary).toMatch(/Código deste pedido: [a-f0-9]{6}\.$/u)
  })

  it('keeps the files in the summary even when the instruction is long', async () => {
    const h = await harness()
    await h.bridge.start(agent(), {
      provider: 'spawn-in-process', prompt: 'x'.repeat(4000), intendedPaths: ['src/safe/a.ts'],
    }, 'secrets').catch(() => undefined)
    const [pending] = await h.approvalAuthority.listOpen(h.principal)
    // O raio de alcance é a informação que diz o que pode ser destruído: era a
    // primeira a sumir quando o corte era na frase inteira.
    expect(pending!.summary).toContain('src/safe/a.ts')
    expect(pending!.summary).toContain('Usar um segredo guardado')
  })

  it('shows the written reason when closing a stuck run', async () => {
    const h = await harness()
    h.runs.splice(0, h.runs.length, run({ repository_path: h.repositoryPath, status: 'UNKNOWN' }))
    await h.bridge.resolveUnknownRun(agent(), 'run-1', 'Conferi no gerenciador: o processo não existe mais.')
      .catch(() => undefined)
    const [pending] = await h.approvalAuthority.listOpen(h.principal)
    expect(pending!.summary).toContain('run-1')
    expect(pending!.summary).toContain('Conferi no gerenciador')
  })

  it('refuses a sensitive start for good once the person denies it', async () => {
    const h = await harness()
    const sensitive = () => h.bridge.start(agent(), {
      provider: 'spawn-in-process', prompt: 'Publique com o segredo.', intendedPaths: ['src/safe'],
    }, 'secrets')
    const refusal = await sensitive().then(() => undefined, (error: unknown) => error)
    await h.approvalAuthority.deny(h.principal, (refusal as { approvalId: string }).approvalId)
    await expect(sensitive()).rejects.toThrowError(/recusou/u)
    await expect(sensitive()).rejects.toThrowError(/recusou/u)
    expect(h.start).not.toHaveBeenCalled()
  })

  it('finds an authority that only mounts after the bridge, instead of failing forever', async () => {
    const h = await harness({ approvalAuthority: 'absent' })
    const sensitive = () => h.bridge.start(agent(), {
      provider: 'spawn-in-process', prompt: 'Use somente o segredo.', intendedPaths: ['src/safe'],
    }, 'secrets')
    await expect(sensitive()).rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
    // A autoridade sobe DEPOIS do bridge. Capturar o serviço na montagem
    // deixaria a operação T3 recusando para sempre, sem nenhum sinal.
    h.mountAuthority()
    await expect(sensitive()).rejects.toMatchObject({ approvalId: expect.any(String) })
    expect(h.start).not.toHaveBeenCalled()
  })

  it('refuses a sensitive start when the confirmation authority is not mounted', async () => {
    const h = await harness({ approvalAuthority: 'absent' })
    await expect(h.bridge.start(agent(), {
      provider: 'spawn-in-process', prompt: 'Use somente o segredo.', intendedPaths: ['src/safe'],
    }, 'secrets')).rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
    expect(h.start).not.toHaveBeenCalled()
  })

  it('refuses a sensitive start when the session has no strong identity, and never consumes the request', async () => {
    const h = await harness()
    h.strongIdentitySessions.clear()
    const sensitive = () => h.bridge.start(agent(), {
      provider: 'spawn-in-process', prompt: 'Use somente o segredo.', intendedPaths: ['src/safe'],
    }, 'secrets')
    const refusal = await sensitive().then(() => undefined, (error: unknown) => error)
    const approvalId = (refusal as { approvalId: string }).approvalId
    await expect(h.approvalAuthority.confirm(h.principal, approvalId))
      .rejects.toMatchObject({ code: 'STRONG_IDENTITY_REQUIRED' })
    await expect(sensitive()).rejects.toMatchObject({ approvalId })
    expect(h.start).not.toHaveBeenCalled()
    // O pedido continua confirmavel depois da chave de acesso: recusar por
    // identidade fraca nao pode queimar a confirmacao.
    h.strongIdentitySessions.add('identity-session')
    await h.approvalAuthority.confirm(h.principal, approvalId)
    await expect(sensitive()).resolves.toMatchObject({ status: 'RUNNING' })
  })

  it('binds a confirmation to exactly what was confirmed', async () => {
    const h = await harness()
    const confirmed = () => h.bridge.start(agent(), {
      provider: 'spawn-in-process', prompt: 'Leia o segredo A.', intendedPaths: ['src/safe'],
    }, 'secrets')
    await h.confirm(confirmed)
    // Mesma confirmacao, outra instrucao: a impressao digital muda e a
    // permissao nao serve.
    await expect(h.bridge.start(agent(), {
      provider: 'spawn-in-process', prompt: 'Leia o segredo B.', intendedPaths: ['src/safe'],
    }, 'secrets')).rejects.toMatchObject({ approvalId: expect.any(String) })
    expect(h.start).not.toHaveBeenCalled()
    await expect(confirmed()).resolves.toMatchObject({ status: 'RUNNING' })
  })

  it.each(['codex', 'claude-code'] as const)('refuses external provider %s in administrative configuration at boot', async provider => {
    const h = await harness()
    await expect(StudioAssistantBridge.create({
      resolvePrincipal: () => undefined, authorizationFor: () => undefined, studioAgents: {} as never, killJob: vi.fn(),
    }, [{ ...h.config, providers: ['spawn-in-process', provider] as never }])).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
      // A mensagem é para uma pessoa leiga: o código técnico fica no `code`,
      // que é para quem programa, e não no texto que ela lê.
      message: expect.stringContaining('verificação de segurança'),
    })
  })

  it.each(['codex', 'claude-code'] as const)('refuses a direct %s call before the authoritative agent service', async provider => {
    const h = await harness()
    await expect(h.bridge.start(agent(), {
      provider: provider as never, prompt: 'Tente iniciar a CLI externa.', intendedPaths: ['src/safe'],
    }, 'secrets')).rejects.toThrowError(expect.objectContaining({ code: 'NOT_CONFIGURED' }))
    expect(h.start).not.toHaveBeenCalled()
  })

  it('does not let a junction-shaped path make an external provider reachable', async () => {
    const h = await harness()
    const outside = await mkdtemp(join(tmpdir(), 'dz23-assistant-outside-'))
    roots.push(outside)
    await mkdir(join(h.repositoryPath, 'src', 'safe'), { recursive: true })
    await writeFile(join(outside, 'victim.txt'), 'unchanged\n')
    await symlink(outside, join(h.repositoryPath, 'src', 'safe', 'portal'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(h.bridge.start(agent(), {
      provider: 'codex' as never, prompt: 'Altere portal/victim.txt.', intendedPaths: ['src/safe/portal/victim.txt'],
    }, 'external-network')).rejects.toThrowError(expect.objectContaining({ code: 'NOT_CONFIGURED' }))
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
    await expect(h.bridge.start(agent(), { provider: 'spawn-in-process', prompt: '  ', intendedPaths: ['src/safe'] }))
      .rejects.toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    await expect(h.bridge.start(agent(), { provider: 'spawn-in-process', prompt: 'Ajuste.', intendedPaths: [] }))
      .rejects.toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    await expect(h.bridge.start(agent(), {
      provider: 'spawn-in-process', prompt: 'Ajuste.', intendedPaths: ['src/safe', 'src/safe/a', 'src/safe/b', 'src/safe/c', 'src/safe/d'],
    })).rejects.toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    expect(h.start).not.toHaveBeenCalled()
  })

  it('rejects another preset and inherited subagent lineage before creating work', async () => {
    const h = await harness()
    await expect(h.bridge.start(agent('session-1', 'standard'), { provider: 'spawn-in-process', prompt: 'Tente.', intendedPaths: ['src/safe'] }))
      .rejects.toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    await expect(h.bridge.start(agent('child', 'dz23-assistant', true), { provider: 'spawn-in-process', prompt: 'Recursão.', intendedPaths: ['src/safe'] }))
      .rejects.toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
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
    await h.bridge.start(agent(), { provider: 'spawn-in-process', prompt: 'Ajuste.', intendedPaths: ['src/safe'] })
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
    await h.bridge.start(agent(), { provider: 'spawn-in-process', prompt: 'Ajuste.', intendedPaths: ['src/safe'] })
    h.principal.userId = 'replacement-user'
    h.runs.splice(0, h.runs.length, run({ repository_path: h.repositoryPath, approved_by: 'replacement-user' }))
    expect(() => h.bridge.cancel(agent(), 'run-1')).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(h.jobs.kill).not.toHaveBeenCalled()
  })

  it('releases terminal job handles and stays bounded across long conversations', async () => {
    const h = await harness()
    for (let index = 1; index <= 125; index += 1) {
      const accepted = await h.bridge.start(agent(), {
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
    await h.bridge.start(agent(), { provider: 'spawn-in-process', prompt: 'Ajuste.', intendedPaths: ['src/safe'] })
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
    await expect(bridge.start(agent(), {
      provider: 'spawn-in-process', prompt: 'Use os limites seguros.', intendedPaths: ['src/safe'],
    })).resolves.toMatchObject({ status: 'RUNNING' })
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
    await expect(h.bridge.start(agent(), { provider: 'spawn-in-process', prompt: 'Tente.', intendedPaths: ['src/safe'] }))
      .rejects.toThrowError(new AssistantBridgeError('FORBIDDEN', 'Seu papel não permite esta ação.'))
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
    const deploy = () => h.bridge.startTeam(agent(), input, 'deploy')
    await expect(deploy()).rejects.toMatchObject({ approvalId: expect.any(String) })
    await h.confirm(deploy)
    await deploy()
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
    const continueSensitive = () => h.bridge.continueTeam(agent(), 'team-1', true)
    await expect(continueSensitive()).rejects.toMatchObject({ approvalId: expect.any(String) })
    await h.confirm(continueSensitive)
    await expect(continueSensitive()).resolves.toMatchObject({ team_id: 'team-1' })
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

describe('A-03 — retomar pelo assistente', () => {
  const interrupted = (repositoryPath: string) => run({
    repository_path: repositoryPath, status: 'FAILED', interrupted_by_restart: true,
  })
  const lease = { run_id: 'run-1', org_id: 'org-1', tenant_id: 'tenant-1', paths: ['src/safe'] }

  it('retoma e diz de onde partiu', async () => {
    const h = await harness({ runs: [], leases: [lease] })
    h.runs.push(interrupted(h.repositoryPath))
    const answer = await h.bridge.resume(agent(), 'run-1', 'Continue de onde parou.')
    expect(answer).toMatchObject({ status: 'RUNNING', resumed_from: 'run-1' })
    expect(h.resume).toHaveBeenCalledOnce()
  })

  it('os caminhos vêm da RESERVA do trabalho retomado, nunca de quem pede', async () => {
    // Retomar não é a hora de ampliar o que o assistente pode escrever.
    const h = await harness({ runs: [], leases: [{ ...lease, paths: ['src/safe/um', 'src/safe/dois'] }] })
    h.runs.push(interrupted(h.repositoryPath))
    await h.bridge.resume(agent(), 'run-1', 'Continue.')
    expect(h.resume.mock.calls[0]![1]).toMatchObject({ intendedPaths: ['src/safe/um', 'src/safe/dois'] })
  })

  it('sem reserva não há o que retomar', async () => {
    const h = await harness({ runs: [], leases: [] })
    h.runs.push(interrupted(h.repositoryPath))
    await expect(h.bridge.resume(agent(), 'run-1', 'Continue.')).rejects.toThrow()
    expect(h.resume).not.toHaveBeenCalled()
  })

  it('NÃO retoma o que não parou por reinício', async () => {
    for (const overrides of [
      { status: 'CANCELLED' as const }, { status: 'UNKNOWN' as const },
      { status: 'PROPOSED' as const }, { interrupted_by_restart: false },
    ]) {
      const h = await harness({ runs: [], leases: [lease] })
      h.runs.push({ ...interrupted(h.repositoryPath), ...overrides })
      await expect(h.bridge.resume(agent(), 'run-1', 'Continue.')).rejects.toThrow()
      expect(h.resume).not.toHaveBeenCalled()
    }
  })

  it('o trabalho de outro escopo recebe o mesmo "não existe" de um id inventado', async () => {
    const h = await harness({ runs: [], leases: [{ ...lease, org_id: 'org-invasora' }] })
    h.runs.push({ ...interrupted(h.repositoryPath), org_id: 'org-invasora' })
    await expect(h.bridge.resume(agent(), 'run-1', 'Continue.')).rejects.toThrow()
    await expect(h.bridge.resume(agent(), 'nunca-existiu', 'Continue.')).rejects.toThrow()
    expect(h.resume).not.toHaveBeenCalled()
  })

  it('a instrução tem o mesmo teto de um trabalho novo', async () => {
    const h = await harness({ runs: [], leases: [lease] })
    h.runs.push(interrupted(h.repositoryPath))
    for (const prompt of ['', '  ', 'ab', 'x'.repeat(20_001)]) {
      await expect(h.bridge.resume(agent(), 'run-1', prompt)).rejects.toThrow()
    }
    expect(h.resume).not.toHaveBeenCalled()
  })
})
