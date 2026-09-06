import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import type { StudioAgentsRuntime } from '@dz23-studio/agents'
import { describe, expect, it, vi } from 'vitest'
import { apply, type StudioAgentTeamRuntime } from '../src/index.ts'

function table() {
  const records = new Map<string, unknown>()
  return {
    entries: () => records.entries(),
    put: (key: string, value: unknown) => { records.set(key, value); return Promise.resolve() },
  }
}

describe('@dz23-studio/agent-team composition', () => {
  it('opens one domain, exposes the runtime and releases job handles and the domain', async () => {
    const teams = table()
    const tasks = table()
    const close = vi.fn(() => Promise.resolve())
    const detach = vi.fn()
    let onDone!: (snapshot: { id: string }) => void
    const cleanups: Array<() => unknown> = []
    let runtime!: StudioAgentTeamRuntime
    const start = vi.fn(() => ({ runId: 'run-1', jobId: 'job-1' as JobId, requiredTier: 'T2' as const }))
    const ctx = {
      storageDomain: { open: vi.fn(() => Promise.resolve({
        table: (name: 'teams' | 'tasks') => name === 'teams' ? teams : tasks,
        close,
      })) },
      studioAgents: {
        service: { start }, runs: () => [], leases: () => [], providerStates: () => ({}),
      } as unknown as StudioAgentsRuntime,
      jobs: {
        kill: vi.fn(() => 'requested'),
        onJobDone: vi.fn((listener: typeof onDone) => { onDone = listener; return detach }),
      },
      effect: vi.fn((factory: () => () => unknown) => { cleanups.push(factory()) }),
      provide: vi.fn((_name: string, value: StudioAgentTeamRuntime) => { runtime = value }),
    }
    await apply(ctx as never)
    expect(runtime.automaticDependentStart).toBe('NOT_PRESENT')
    await runtime.service.start({
      orgId: 'org', tenantId: 'tenant', workspaceId: 'tenant', repositoryPath: '/repo',
      parent: { session: { id: 'person' } } as Agent,
      provider: 'spawn-in-process', name: 'Equipe',
      tasks: [{ taskId: 'task', title: 'Tarefa', role: 'tester', prompt: 'Teste.', intendedPaths: ['src'], dependsOn: [] }],
      approval: { approved: true, tier: 'T2', approvedBy: 'person' },
    })
    expect(runtime.teams()).toHaveLength(1)
    expect(runtime.tasks()).toHaveLength(1)
    expect(runtime.service.activeTaskCount()).toBe(1)
    onDone({ id: 'job-1' })
    expect(runtime.service.activeTaskCount()).toBe(0)
    await Promise.all(cleanups.map(cleanup => cleanup()))
    expect(close).toHaveBeenCalledOnce()
    expect(detach).toHaveBeenCalledOnce()
  })
})
