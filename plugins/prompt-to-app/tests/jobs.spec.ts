import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it, vi } from 'vitest'
import { MemoryCapacityGovernor } from '@dz23-studio/runtime-governor'
import { PromptToAppJobService, type PromptToAppJobRegistry } from '../src/jobs.js'
import type { PromptToAppPipeline } from '../src/pipeline.js'
import { PromptToAppError, type PromptToAppService } from '../src/service.js'

const actor = { userId: 'owner', orgId: 'org-a', tenantId: 'tenant-a', role: 'owner' as const, sessionId: 'browser-session' }

describe('Prompt-to-App background jobs', () => {
  it('starts one ctx.jobs entry per project, returns immediately and clears it after completion', async () => {
    let finish!: (value: { state: 'VERIFIED_PROTOTYPE'; attempts: number; message: string }) => void
    const done = new Promise<{ state: 'VERIFIED_PROTOTYPE'; attempts: number; message: string }>(resolve => { finish = resolve })
    let hooks!: { cancel(reason?: string): void; done: Promise<JobOutcome> }
    const registry: PromptToAppJobRegistry = {
      start: vi.fn(spec => { hooks = spec.run(); return 'studio-prompt-to-app-1' as JobId }),
      kill: vi.fn((_id, _owner) => { hooks.cancel(); return 'requested' as const }),
    }
    const service = { assertAuthorized: vi.fn(), project: vi.fn(() => ({ state: 'PLAN_APPROVED' })), plan: vi.fn(() => ({ status: 'APPROVED' })) }
    const pipeline = { run: vi.fn(() => done) }
    const governor = new MemoryCapacityGovernor({ createId: () => 'capacity-lease' })
    const dispose = vi.fn(async () => undefined)
    const jobs = new PromptToAppJobService({
      service: service as unknown as PromptToAppService, pipeline: pipeline as unknown as PromptToAppPipeline, registry,
      owners: { create: vi.fn(async () => ({ owner: {} as Agent, dispose })) }, createId: () => 'run-1', governor,
    })
    await expect(jobs.start(actor, 'project', { generate: vi.fn() })).resolves.toMatchObject({ runId: 'run-1' })
    expect(pipeline.run).toHaveBeenCalledTimes(1)
    await expect(jobs.start(actor, 'project', { generate: vi.fn() })).rejects.toThrow('andamento')
    expect(jobs.cancel(actor, 'project')).toBe('requested')
    expect(registry.kill).toHaveBeenCalledWith('studio-prompt-to-app-1', expect.anything(), expect.any(String))
    finish({ state: 'VERIFIED_PROTOTYPE', attempts: 1, message: 'ok' })
    await hooks.done
    await vi.waitFor(async () => expect((await governor.snapshot()).leases).toHaveLength(0))
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
    await expect(jobs.start(actor, 'project', { generate: vi.fn() })).resolves.toMatchObject({ runId: 'run-1' })
  })

  it('fails admission with CAPACITY before creating a job owner', async () => {
    const governor = new MemoryCapacityGovernor({ createId: () => 'held-build' })
    await governor.acquireBundle({
      ownerId: 'other', scope: { orgId: 'org-b', tenantId: 'tenant-b', projectId: 'project-b' },
      requests: [{ resource: 'build' }],
    })
    const owners = { create: vi.fn() }
    const registry: PromptToAppJobRegistry = { start: vi.fn(), kill: vi.fn(() => 'already-finished' as const) }
    const service = { assertAuthorized: vi.fn(), project: vi.fn(() => ({ state: 'PLAN_APPROVED' })), plan: vi.fn(() => ({ status: 'APPROVED' })) }
    const jobs = new PromptToAppJobService({
      service: service as unknown as PromptToAppService,
      pipeline: { run: vi.fn() } as unknown as PromptToAppPipeline,
      registry, owners, governor, createId: () => 'blocked-run',
    })

    await expect(jobs.start(actor, 'project', { generate: vi.fn() })).rejects.toMatchObject({ code: 'CAPACITY' })
    expect(owners.create).not.toHaveBeenCalled()
    expect(registry.start).not.toHaveBeenCalled()
  })

  it('does not start pipeline work when ctx.jobs rejects the owner preflight', async () => {
    const registry: PromptToAppJobRegistry = {
      start: vi.fn(() => { throw new Error('no-controller-for-owner') }),
      kill: vi.fn(() => 'already-finished' as const),
    }
    const service = { assertAuthorized: vi.fn(), project: vi.fn(() => ({ state: 'PLAN_APPROVED' })), plan: vi.fn(() => ({ status: 'APPROVED' })) }
    const pipeline = { run: vi.fn() }
    const dispose = vi.fn(async () => undefined)
    const jobs = new PromptToAppJobService({
      service: service as unknown as PromptToAppService, pipeline: pipeline as unknown as PromptToAppPipeline, registry,
      owners: { create: vi.fn(async () => ({ owner: {} as Agent, dispose })) }, createId: () => 'run-rejected',
    })

    await expect(jobs.start(actor, 'project', { generate: vi.fn() })).rejects.toThrow('no-controller-for-owner')
    expect(pipeline.run).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('rejects a viewer before reading project state or touching the job registry', async () => {
    const forbidden = new PromptToAppError('FORBIDDEN', 'Você não pode alterar este projeto.')
    const registry: PromptToAppJobRegistry = {
      start: vi.fn(() => 'studio-prompt-to-app-1' as JobId),
      kill: vi.fn(() => 'requested' as const),
    }
    const service = {
      assertAuthorized: vi.fn(() => { throw forbidden }),
      project: vi.fn(), plan: vi.fn(),
    }
    const pipeline = { run: vi.fn() }
    const jobs = new PromptToAppJobService({
      service: service as unknown as PromptToAppService, pipeline: pipeline as unknown as PromptToAppPipeline, registry,
      owners: { create: vi.fn() }, createId: () => 'run-forbidden',
    })
    const viewer = { ...actor, role: 'viewer' as const }

    await expect(jobs.start(viewer, 'project', { generate: vi.fn() })).rejects.toBe(forbidden)
    expect(() => jobs.cancel(viewer, 'project')).toThrow(forbidden)
    expect(service.project).not.toHaveBeenCalled()
    expect(service.plan).not.toHaveBeenCalled()
    expect(registry.start).not.toHaveBeenCalled()
    expect(registry.kill).not.toHaveBeenCalled()
    expect(pipeline.run).not.toHaveBeenCalled()
  })
})
