import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobStart } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, type StudioAgentsRuntime } from '../src/index.ts'

const exec = promisify(execFile)
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'dz23-agents-index-'))
  roots.push(root)
  await exec('git', ['init', '-q'], { cwd: root })
  await exec('git', ['config', 'user.email', 'test@dz23.local'], { cwd: root })
  await exec('git', ['config', 'user.name', 'DZ23 Test'], { cwd: root })
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'a.ts'), 'before\n')
  await exec('git', ['add', '.'], { cwd: root })
  await exec('git', ['commit', '-qm', 'base'], { cwd: root })
  return root
}

function table() {
  const records = new Map<string, unknown>()
  return {
    entries: () => records.entries(),
    put: (key: string, value: unknown) => { records.set(key, value); return Promise.resolve() },
  }
}

describe('@dz23-studio/agents composition', () => {
  it('carries the real worktree cwd through an owned internal coordinator and disposes it', async () => {
    const repositoryPath = await repo()
    const worktreeRoot = await mkdtemp(join(tmpdir(), 'dz23-agent-worktrees-'))
    roots.push(worktreeRoot)
    const runTables = { runs: table() }
    const leaseTables = { leases: table() }
    const closes = [vi.fn(() => Promise.resolve()), vi.fn(() => Promise.resolve())]
    let runtime!: StudioAgentsRuntime
    let hooks!: ReturnType<JobStart['run']>
    const coordinatorDispose = vi.fn(() => Promise.resolve())
    const parent = { session: { id: SessionId('person') } } as Agent
    const ctx = {
      storageDomain: {
        open: vi.fn((spec: { name: string }) => Promise.resolve(spec.name === 'studio_agent_runs'
          ? { table: (name: 'runs') => runTables[name], close: closes[0] }
          : { table: (name: 'leases') => leaseTables[name], close: closes[1] })),
      },
      effect: vi.fn((factory: () => unknown) => factory()),
      provide: vi.fn((_name: string, value: StudioAgentsRuntime) => { runtime = value }),
      on: vi.fn(() => vi.fn()),
      studioPolicy: { setDelegationGrantResolver: vi.fn(() => vi.fn()) },
      agentPresets: { mount: vi.fn(() => Promise.resolve()) },
      agents: {
        create: vi.fn((options: { sessionId: ReturnType<typeof SessionId>; meta: { cwd: string }; setup(agentCtx: unknown): Promise<void> }) => {
          void options.setup({})
          return Promise.resolve({
            agent: { session: { id: options.sessionId, header: { cwd: options.meta.cwd } } },
            dispose: coordinatorDispose,
          })
        }),
      },
      subagents: {
        getProvider: vi.fn((name: string) => name === 'codex' ? {} : undefined),
        start: vi.fn(async (_provider: string, input: { parent: Agent }) => {
          await writeFile(join(input.parent.session.header.cwd!, 'src', 'a.ts'), 'after\n')
          return {
            id: SessionId('child'), localAgent: undefined,
            result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'feito' }] }),
            dispose: vi.fn(() => Promise.resolve()),
          }
        }),
      },
      jobs: {
        attachController: vi.fn(() => vi.fn()),
        start: vi.fn((spec: JobStart) => { hooks = spec.run(); return 'studio-agent-1' }),
      },
    }
    await apply(ctx as never, { worktreeRoot, coordinatorPreset: 'dz23-coordinator' })
    expect(runtime.providerStates().codex).toMatch(/^(OK|NOT_PRESENT|NOT_CONFIGURED)$/)
    expect(runtime.providerStates()['claude-code']).toBe('NOT_CONFIGURED')
    runtime.service.start({
      orgId: 'org', tenantId: 'tenant', workspaceId: 'workspace', repositoryPath,
      parent, provider: 'codex', prompt: 'mude src/a.ts', intendedPaths: ['src/a.ts'],
      approval: { approved: true, tier: 'T2', approvedBy: 'person' },
    })
    await expect(hooks.done).resolves.toMatchObject({ status: 'completed', output: expect.stringContaining('+after') })
    expect(await readFile(join(repositoryPath, 'src', 'a.ts'), 'utf8')).toBe('before\n')
    expect(runtime.runs()[0]).toMatchObject({ status: 'PROPOSED', coordinator_session_id: expect.stringMatching(/^studio-coordinator-/) })
    expect(runtime.leases()[0]).toMatchObject({ active: false })
    expect(coordinatorDispose).toHaveBeenCalledOnce()
    expect(ctx.subagents.start).toHaveBeenCalledWith('codex', expect.objectContaining({
      parent: expect.objectContaining({ session: expect.objectContaining({ header: expect.objectContaining({ cwd: expect.stringContaining(worktreeRoot) }) }) }),
    }))
    await Promise.all(closes.map(close => close()))
  })
})
