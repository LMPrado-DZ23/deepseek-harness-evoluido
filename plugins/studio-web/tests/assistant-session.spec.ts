import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiSessionNotFound } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionRecord } from '@dz23-studio/identity'
import {
  ASSISTANT_AGENT_PRESET,
  AssistantSessionLauncher,
  type AssistantRepositoryLaunchConfig,
  type AssistantSessionControllerPort,
} from '../src/assistant-session.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function identitySession(ids: readonly string[] = []): SessionRecord {
  return {
    session_id: 'identity-1', user_id: 'user-1', org_id: 'org-1', tenant_id: 'tenant-1',
    token_hash: 'a'.repeat(64), csrf_hash: 'b'.repeat(64), device_label: 'Notebook', user_agent: '', ip_truncated: '',
    created_at: '2026-09-06T00:00:00.000Z', last_seen_at: '2026-09-06T00:00:00.000Z',
    expires_sliding_at: '2026-09-07T00:00:00.000Z', expires_absolute_at: '2026-10-06T00:00:00.000Z',
    last_strong_auth_at: null, last_strong_auth_method: null, revoked_at: null, revoked_reason: null,
    harness_session_ids: [...ids],
  }
}

async function repository(overrides: Partial<AssistantRepositoryLaunchConfig> = {}): Promise<AssistantRepositoryLaunchConfig> {
  const root = await mkdtemp(join(tmpdir(), 'dz23-assistant-launch-')); roots.push(root)
  await mkdir(join(root, '.git'))
  return { orgId: 'org-1', tenantId: 'tenant-1', workspaceId: 'tenant-1', repositoryPath: root, ...overrides }
}

async function fixture(options: {
  readonly repositories?: readonly AssistantRepositoryLaunchConfig[]
  readonly role?: 'owner' | 'admin' | 'builder' | 'viewer'
  readonly authorization?: boolean
  readonly inspect?: AssistantSessionControllerPort['inspect']
  readonly create?: AssistantSessionControllerPort['create']
} = {}) {
  const binds: string[] = []
  const create = vi.fn<AssistantSessionControllerPort['create']>(options.create ?? (async request => ({
    sessionId: (request.sessionId ?? 'assistant-new') as never,
    agentPreset: request.agentPreset,
  })))
  const inspect = vi.fn<AssistantSessionControllerPort['inspect']>(options.inspect ?? (async () => {
    throw new ApiSessionNotFound('missing')
  }))
  const repositories = options.repositories ?? [await repository()]
  const launcher = await AssistantSessionLauncher.create({
    identity: { bindHarnessSession: async (_session, id) => { binds.push(id) } },
    tenancy: {
      authorizationFor: () => options.authorization === false ? undefined : ({
        userId: 'user-1', orgId: 'org-1', tenantId: 'tenant-1', role: options.role ?? 'owner',
      }),
    },
    sessions: { create, inspect },
    repositories,
  })
  return { launcher, create, inspect, binds, repository: repositories[0]! }
}

describe('governed Assistant Session launcher', () => {
  it('creates, binds and serially reuses one preset Session for concurrent device requests', async () => {
    const f = await fixture()
    f.inspect.mockResolvedValue({ meta: { cwd: f.repository.repositoryPath, agentPreset: ASSISTANT_AGENT_PRESET } })
    const session = identitySession()
    const [first, second] = await Promise.all([f.launcher.launch(session), f.launcher.launch(session)])
    expect(first).toEqual({ session_id: 'assistant-new', reused: false, preset: ASSISTANT_AGENT_PRESET })
    expect(second).toEqual({ session_id: 'assistant-new', reused: true, preset: ASSISTANT_AGENT_PRESET })
    expect(f.create).toHaveBeenCalledTimes(2)
    expect(f.create.mock.calls[0]![0]).toEqual({ cwd: f.repository.repositoryPath, agentPreset: ASSISTANT_AGENT_PRESET })
    expect(f.create.mock.calls[1]![0]).toMatchObject({ sessionId: 'assistant-new', agentPreset: ASSISTANT_AGENT_PRESET })
    expect(f.binds).toEqual(['assistant-new', 'assistant-new'])
  })

  it('adopts the newest matching persisted Session and skips unrelated or missing ones', async () => {
    const f = await fixture({
      inspect: async id => {
        if (id === 'gone') throw new ApiSessionNotFound('gone')
        return id === 'other'
          ? { meta: { cwd: fakedPath(), agentPreset: 'default' } }
          : { meta: { cwd: fakedPath(), agentPreset: ASSISTANT_AGENT_PRESET } }
      },
    })
    const cwd = f.repository.repositoryPath
    f.inspect.mockImplementation(async id => {
      if (id === 'gone') throw new ApiSessionNotFound('gone')
      return id === 'other'
        ? { meta: { cwd, agentPreset: 'default' } }
        : { meta: { cwd, agentPreset: ASSISTANT_AGENT_PRESET } }
    })
    await expect(f.launcher.launch(identitySession(['match', 'other', 'gone']))).resolves.toEqual({
      session_id: 'match', reused: true, preset: ASSISTANT_AGENT_PRESET,
    })
    expect(f.create).toHaveBeenCalledWith({ cwd, sessionId: 'match', agentPreset: ASSISTANT_AGENT_PRESET })
  })

  it('fails closed for absent membership or repository configuration', async () => {
    const forbidden = await fixture({ authorization: false })
    await expect(forbidden.launcher.launch(identitySession())).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const missing = await fixture({ repositories: [] })
    await expect(missing.launcher.launch(identitySession())).rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
  })

  it('rejects a matching preset bound to another repository instead of opening it', async () => {
    const f = await fixture({ inspect: async () => ({ meta: { cwd: fakedPath(), agentPreset: ASSISTANT_AGENT_PRESET } }) })
    await expect(f.launcher.launch(identitySession(['foreign']))).rejects.toMatchObject({ code: 'SESSION_CONFLICT' })
    expect(f.create).not.toHaveBeenCalled()
  })

  it('separates transient inspection and creation failures from safe conflicts', async () => {
    const unavailable = await fixture({ inspect: async () => { throw new Error('storage offline') } })
    await expect(unavailable.launcher.launch(identitySession(['existing']))).rejects.toMatchObject({ code: 'SESSION_UNAVAILABLE' })

    const creation = await fixture({ create: async () => { throw new Error('unavailable') } })
    await expect(creation.launcher.launch(identitySession())).rejects.toMatchObject({ code: 'SESSION_UNAVAILABLE' })

    const wrongPreset = await fixture({ create: async () => ({ sessionId: 'new' as never, agentPreset: 'default' }) })
    await expect(wrongPreset.launcher.launch(identitySession())).rejects.toMatchObject({ code: 'SESSION_CONFLICT' })

    const adoption = await fixture({
      inspect: async () => ({ meta: { cwd: '', agentPreset: ASSISTANT_AGENT_PRESET } }),
    })
    adoption.inspect.mockResolvedValue({ meta: { cwd: adoption.repository.repositoryPath, agentPreset: ASSISTANT_AGENT_PRESET } })
    adoption.create.mockRejectedValue(new Error('preset changed'))
    await expect(adoption.launcher.launch(identitySession(['existing']))).rejects.toMatchObject({ code: 'SESSION_CONFLICT' })

    const changedPreset = await fixture({
      inspect: async () => ({ meta: { cwd: '', agentPreset: ASSISTANT_AGENT_PRESET } }),
    })
    changedPreset.inspect.mockResolvedValue({ meta: { cwd: changedPreset.repository.repositoryPath, agentPreset: ASSISTANT_AGENT_PRESET } })
    changedPreset.create.mockResolvedValue({ sessionId: 'existing' as never, agentPreset: 'default' })
    await expect(changedPreset.launcher.launch(identitySession(['existing']))).rejects.toMatchObject({ code: 'SESSION_CONFLICT' })
  })

  it('validates repository scope, uniqueness, absolute Git roots and input shape before serving', async () => {
    const valid = await repository()
    await expect(AssistantSessionLauncher.create({
      identity: {} as never, tenancy: {} as never, sessions: {} as never,
      repositories: [valid, valid],
    })).rejects.toThrow('mais de um')
    await expect(AssistantSessionLauncher.create({
      identity: {} as never, tenancy: {} as never, sessions: {} as never,
      repositories: [{ ...valid, workspaceId: 'outro' }],
    })).rejects.toThrow('mesmo identificador')
    await expect(AssistantSessionLauncher.create({
      identity: {} as never, tenancy: {} as never, sessions: {} as never,
      repositories: [{ ...valid, repositoryPath: 'relative' }],
    })).rejects.toThrow('absoluto')
    const plain = await mkdtemp(join(tmpdir(), 'dz23-plain-')); roots.push(plain)
    await expect(AssistantSessionLauncher.create({
      identity: {} as never, tenancy: {} as never, sessions: {} as never,
      repositories: [{ ...valid, repositoryPath: plain }],
    })).rejects.toThrow('raiz Git')
    await expect(AssistantSessionLauncher.create({
      identity: {} as never, tenancy: {} as never, sessions: {} as never,
      repositories: 'bad' as never,
    })).rejects.toThrow('lista')
    await expect(AssistantSessionLauncher.create({
      identity: {} as never, tenancy: {} as never, sessions: {} as never,
      repositories: [null as never],
    })).rejects.toThrow('objeto')
    await expect(AssistantSessionLauncher.create({
      identity: {} as never, tenancy: {} as never, sessions: {} as never,
      repositories: [[] as never],
    })).rejects.toThrow('objeto')
    await writeFile(join(plain, '.git'), 'bad')
    await expect(AssistantSessionLauncher.create({
      identity: {} as never, tenancy: {} as never, sessions: {} as never,
      repositories: [{ ...valid, orgId: '', repositoryPath: plain }],
    })).rejects.toThrow('organização')

    const file = join(plain, 'not-a-directory'); await writeFile(file, 'plain')
    await expect(AssistantSessionLauncher.create({
      identity: {} as never, tenancy: {} as never, sessions: {} as never,
      repositories: [{ ...valid, repositoryPath: file }],
    })).rejects.toThrow('pasta')

    const linked = await mkdtemp(join(tmpdir(), 'dz23-linked-git-')); roots.push(linked)
    await symlink(join(valid.repositoryPath, '.git'), join(linked, '.git'))
    await expect(AssistantSessionLauncher.create({
      identity: {} as never, tenancy: {} as never, sessions: {} as never,
      repositories: [{ ...valid, repositoryPath: linked }],
    })).rejects.toThrow('raiz Git')
  })
})

function fakedPath(): string { return process.platform === 'win32' ? 'C:\\outro' : '/outro' }
