import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { apply, createAssistantTools } from '../src/index.ts'
import { ASSISTANT_TOOL_NAMES } from '../src/catalog.ts'
import { closedTool } from '../src/closed-tool.ts'

vi.mock('@dz23-studio/identity', () => ({ principalForAgent: vi.fn() }))

describe('assistant bridge tool schemas', () => {
  it('enforces an object root and exact keys before the wrapped tool', async () => {
    const execute = vi.fn(async (args: unknown) => args)
    const tool = closedTool({ name: 'closed', description: 'closed', parameters: {}, execute } as never, ['ok'])
    await expect(tool.execute({ ok: true }, {} as never)).resolves.toEqual({ ok: true })
    await expect(tool.execute('invalid-root', {} as never)).rejects.toBeInstanceOf(ToolArgsError)
    await expect(tool.execute({ extra: true }, {} as never)).rejects.toBeInstanceOf(ToolArgsError)
    expect(tool.parameters).toMatchObject({ additionalProperties: false })
  })

  it('publishes and enforces a closed root schema for every tool', async () => {
    const bridge = {
      start: vi.fn(), list: vi.fn(), review: vi.fn(), cancel: vi.fn(), apply: vi.fn(),
      startTeam: vi.fn(), listTeams: vi.fn(), teamStatus: vi.fn(), continueTeam: vi.fn(), cancelTeam: vi.fn(),
    }
    const tools = createAssistantTools(bridge as never)
    const valid: Record<string, Record<string, unknown>> = {
      studio_agent_start: { provider: 'spawn-in-process', prompt: 'Ajuste.', intended_paths: ['src'] },
      studio_agent_start_sensitive: { provider: 'spawn-in-process', prompt: 'Ajuste.', intended_paths: ['src'], operation: 'secrets' },
      studio_agent_list: {},
      studio_agent_review: { run_id: 'run-1' },
      studio_agent_cancel: { run_id: 'run-1' },
      studio_agent_apply: { run_id: 'run-1' },
      studio_team_start: { provider: 'spawn-in-process', name: 'Equipe', tasks: [{
        task_id: 'implementation', title: 'Implementar', role: 'implementer', prompt: 'Faça.', intended_paths: ['src'], depends_on: [],
      }] },
      studio_team_start_sensitive: { provider: 'spawn-in-process', name: 'Equipe', operation: 'secrets', tasks: [{
        task_id: 'implementation', title: 'Implementar', role: 'implementer', prompt: 'Faça.', intended_paths: ['src'], depends_on: [],
      }] },
      studio_team_list: {},
      studio_team_status: { team_id: 'team-1' },
      studio_team_continue: { team_id: 'team-1' },
      studio_team_continue_sensitive: { team_id: 'team-1' },
      studio_team_cancel: { team_id: 'team-1' },
    }
    const maliciousKeys = ['org_id', 'tenant_id', 'approval', 'repositoryPath']
    for (const tool of tools) {
      expect(tool.parameters).toMatchObject({ type: 'object', additionalProperties: false })
      for (const key of maliciousKeys) {
        await expect(tool.execute({ ...valid[tool.name], [key]: key }, { agent: undefined } as never))
          .rejects.toBeInstanceOf(ToolArgsError)
      }
    }
    expect(bridge.start).not.toHaveBeenCalled()
    expect(bridge.list).not.toHaveBeenCalled()
    expect(bridge.review).not.toHaveBeenCalled()
    expect(bridge.cancel).not.toHaveBeenCalled()
    expect(bridge.apply).not.toHaveBeenCalled()
    expect(bridge.startTeam).not.toHaveBeenCalled()
    expect(bridge.listTeams).not.toHaveBeenCalled()
  })

  it('routes every valid tool to the bridge with only its declared arguments', async () => {
    const bridge = {
      start: vi.fn(() => ({ run_id: 'run-1' })),
      list: vi.fn(() => [{ run_id: 'run-1' }]),
      review: vi.fn(() => Promise.resolve({ run_id: 'run-1', diff_text: 'diff' })),
      cancel: vi.fn(() => ({ run_id: 'run-1', outcome: 'requested' })),
      apply: vi.fn(() => Promise.resolve({ runId: 'run-1', status: 'APPLIED' })),
      startTeam: vi.fn(() => Promise.resolve({ team_id: 'team-1' })),
      listTeams: vi.fn(() => [{ team_id: 'team-1' }]),
      teamStatus: vi.fn(() => Promise.resolve({ team_id: 'team-1' })),
      continueTeam: vi.fn(() => Promise.resolve({ team_id: 'team-1' })),
      cancelTeam: vi.fn(() => Promise.resolve({ team_id: 'team-1' })),
    }
    const byName = new Map(createAssistantTools(bridge as never).map(tool => [tool.name, tool]))
    const exec = { agent: undefined } as never
    await byName.get('studio_agent_start')!.execute({ provider: 'spawn-in-process', prompt: 'Faça.', intended_paths: ['src'] }, exec)
    await byName.get('studio_agent_start_sensitive')!.execute({
      provider: 'spawn-in-process', prompt: 'Faça.', intended_paths: ['src'], operation: 'secrets',
    }, exec)
    await byName.get('studio_agent_list')!.execute({}, exec)
    await byName.get('studio_agent_review')!.execute({ run_id: 'run-1' }, exec)
    await byName.get('studio_agent_cancel')!.execute({ run_id: 'run-1', reason: 'pedido' }, exec)
    await byName.get('studio_agent_apply')!.execute({ run_id: 'run-1' }, exec)
    const team = [{ task_id: 'implementation', title: 'Implementar', role: 'implementer', prompt: 'Faça.', intended_paths: ['src'], depends_on: [] }]
    await byName.get('studio_team_start')!.execute({ provider: 'spawn-in-process', name: 'Equipe', tasks: team }, exec)
    await byName.get('studio_team_start_sensitive')!.execute({ provider: 'spawn-in-process', name: 'Equipe', tasks: team, operation: 'deploy' }, exec)
    await byName.get('studio_team_list')!.execute({}, exec)
    await byName.get('studio_team_status')!.execute({ team_id: 'team-1' }, exec)
    await byName.get('studio_team_continue')!.execute({ team_id: 'team-1' }, exec)
    await byName.get('studio_team_continue_sensitive')!.execute({ team_id: 'team-1' }, exec)
    await byName.get('studio_team_cancel')!.execute({ team_id: 'team-1', reason: 'pare' }, exec)
    expect(bridge.start).toHaveBeenNthCalledWith(1, undefined, {
      provider: 'spawn-in-process', prompt: 'Faça.', intendedPaths: ['src'],
    })
    expect(bridge.start).toHaveBeenNthCalledWith(2, undefined, {
      provider: 'spawn-in-process', prompt: 'Faça.', intendedPaths: ['src'],
    }, 'secrets')
    expect(bridge.list).toHaveBeenCalledWith(undefined)
    expect(bridge.review).toHaveBeenCalledWith(undefined, 'run-1')
    expect(bridge.cancel).toHaveBeenCalledWith(undefined, 'run-1', 'pedido')
    expect(bridge.apply).toHaveBeenCalledWith(undefined, 'run-1')
    expect(bridge.startTeam).toHaveBeenNthCalledWith(1, undefined, {
      provider: 'spawn-in-process', name: 'Equipe', tasks: [{
        taskId: 'implementation', title: 'Implementar', role: 'implementer', prompt: 'Faça.', intendedPaths: ['src'], dependsOn: [],
      }],
    })
    expect(bridge.startTeam).toHaveBeenNthCalledWith(2, undefined, expect.anything(), 'deploy')
    expect(bridge.listTeams).toHaveBeenCalledWith(undefined)
    expect(bridge.teamStatus).toHaveBeenCalledWith(undefined, 'team-1')
    expect(bridge.continueTeam).toHaveBeenNthCalledWith(1, undefined, 'team-1', false)
    expect(bridge.continueTeam).toHaveBeenNthCalledWith(2, undefined, 'team-1', true)
    expect(bridge.cancelTeam).toHaveBeenCalledWith(undefined, 'team-1', 'pare')
    expect(byName.get('studio_agent_list')!.output.render({}, { json: '[{"run_id":"run-1"}]' } as never))
      .toEqual([{ type: 'text', text: '[{"run_id":"run-1"}]' }])
  })

  it('advertises only the local provider on both T2 and sensitive T3', () => {
    const tools = new Map(createAssistantTools({} as never).map(tool => [tool.name, tool]))
    const normal = tools.get('studio_agent_start')!.parameters as { properties: Record<string, { enum?: readonly string[] }> }
    const sensitive = tools.get('studio_agent_start_sensitive')!.parameters as { properties: Record<string, { enum?: readonly string[] }> }
    expect(normal.properties.provider?.enum).toEqual(['spawn-in-process'])
    expect(sensitive.properties.provider?.enum).toEqual(['spawn-in-process'])
  })

  it('registers the exact preset catalog and detaches lifecycle hooks on disposal', async () => {
    const registered: string[] = []
    const disposed: string[] = []
    let doneListener: ((snapshot: { id: string }) => void) | undefined
    let cleanup: (() => void) | undefined
    const provide = vi.fn()
    const ctx = {
      agents: {}, studioIdentity: { service: {} }, studioTenancy: { service: {} }, studioAgents: {}, studioAgentTeams: {},
      jobs: {
        kill: vi.fn(),
        onJobDone: vi.fn((listener: typeof doneListener) => { doneListener = listener; return vi.fn(() => disposed.push('listener')) }),
      },
      tools: { register: vi.fn((tool: { name: string }) => { registered.push(tool.name); return () => disposed.push(tool.name) }) },
      effect: vi.fn((setup: () => () => void) => { cleanup = setup() }),
      provide,
    }
    await apply(ctx as never, { exposedTools: ASSISTANT_TOOL_NAMES, repositories: [] })
    expect(registered).toEqual(ASSISTANT_TOOL_NAMES)
    const runtime = provide.mock.calls[0]![1]
    expect(runtime).toMatchObject({
      tools: ASSISTANT_TOOL_NAMES,
      automaticSessionCreation: 'NOT_PRESENT',
      teamCoordination: 'BETA_MANUAL_DEPENDENCY_CONTINUE',
    })
    const release = vi.spyOn(runtime.bridge, 'releaseJob')
    doneListener!({ id: 'job-finished' })
    expect(release).toHaveBeenCalledWith('job-finished')
    cleanup!()
    expect(disposed).toContain('listener')
    expect(disposed).toEqual(expect.arrayContaining([...ASSISTANT_TOOL_NAMES]))
  })

  it.each([
    [null, /objeto/],
    [{ exposedTools: ASSISTANT_TOOL_NAMES, repositories: [], extra: true }, /campos desconhecidos/],
    [{ exposedTools: 'bad' }, /exposedTools/],
    [{ exposedTools: ASSISTANT_TOOL_NAMES, repositories: 'bad' }, /repositories/],
  ])('rejects malformed plugin config before registering tools: %j', async (config, error) => {
    await expect(apply({} as never, config as never)).rejects.toThrow(error)
  })
})
