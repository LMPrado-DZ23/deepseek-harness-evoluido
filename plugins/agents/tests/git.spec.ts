import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { GitWorktreeManager } from '../src/service.ts'

const exec = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'dz23-agents-'))
  roots.push(root)
  await exec('git', ['init', '-q'], { cwd: root })
  await exec('git', ['config', 'user.email', 'test@dz23.local'], { cwd: root })
  await exec('git', ['config', 'user.name', 'DZ23 Test'], { cwd: root })
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'a.ts'), 'export const value = 1\n')
  await exec('git', ['add', '.'], { cwd: root })
  await exec('git', ['commit', '-qm', 'base'], { cwd: root })
  return root
}

describe('GitWorktreeManager', () => {
  it('creates a detached worktree, computes a proposed diff and fingerprints main-workspace drift', async () => {
    const root = await repository()
    const copies = await mkdtemp(join(tmpdir(), 'dz23-agent-copies-'))
    roots.push(copies)
    const manager = new GitWorktreeManager(copies)
    const snapshot = await manager.create(root, 'run-1')
    expect(snapshot.worktreePath).toBe(join(copies, 'run-1'))
    await writeFile(join(snapshot.worktreePath, 'src', 'a.ts'), 'export const value = 2\n')
    await writeFile(join(snapshot.worktreePath, 'src', 'new.ts'), 'export const added = true\n')
    const diff = await manager.diff(snapshot)
    expect([...diff.files].sort()).toEqual(['src/a.ts', 'src/new.ts'])
    expect(diff.text).toContain('export const value = 2')
    expect(diff.text).toContain('export const added = true')
    expect(diff.bytes).toBe(Buffer.byteLength(diff.text))
    expect(await manager.mainFingerprint(root)).toBe(snapshot.mainFingerprint)
    await manager.applyProposal({
      run_id: 'run-1', org_id: 'org', tenant_id: 'tenant', workspace_id: 'workspace',
      parent_session_id: 'parent', coordinator_session_id: 'coordinator', provider: 'spawn-in-process',
      worktree_path: snapshot.worktreePath, repository_path: root, base_commit: snapshot.baseCommit,
      status: 'PROPOSED', changed_files: [...diff.files], diff_bytes: diff.bytes,
      diff_sha256: (await import('node:crypto')).createHash('sha256').update(diff.text).digest('hex'),
      diagnostic: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    })
    expect(await readFile(join(root, 'src', 'a.ts'), 'utf8')).toBe('export const value = 2\n')
    expect(await readFile(join(root, 'src', 'new.ts'), 'utf8')).toBe('export const added = true\n')
    await writeFile(join(root, 'untracked.txt'), 'outside')
    expect(await manager.mainFingerprint(root)).not.toBe(snapshot.mainFingerprint)
  })

  it('rejects a changed or conflicting proposal instead of applying over user work', async () => {
    const root = await repository()
    const copies = await mkdtemp(join(tmpdir(), 'dz23-agent-copies-'))
    roots.push(copies)
    const manager = new GitWorktreeManager(copies)
    const snapshot = await manager.create(root, 'run-conflict')
    await writeFile(join(snapshot.worktreePath, 'src', 'a.ts'), 'agent\n')
    const diff = await manager.diff(snapshot)
    const record = {
      run_id: 'run-conflict', org_id: 'org', tenant_id: 'tenant', workspace_id: 'workspace',
      parent_session_id: 'parent', coordinator_session_id: 'coordinator', provider: 'spawn-in-process' as const,
      worktree_path: snapshot.worktreePath, repository_path: root, base_commit: snapshot.baseCommit,
      status: 'PROPOSED' as const, changed_files: [...diff.files], diff_bytes: diff.bytes,
      diff_sha256: (await import('node:crypto')).createHash('sha256').update(diff.text).digest('hex'),
      diagnostic: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }
    await writeFile(join(root, 'src', 'a.ts'), 'person\n')
    await expect(manager.applyProposal(record)).rejects.toMatchObject({ code: 'WRITE_CONFLICT' })
    await writeFile(join(root, 'src', 'a.ts'), 'export const value = 1\n')
    await writeFile(join(snapshot.worktreePath, 'src', 'a.ts'), 'tampered\n')
    await expect(manager.applyProposal(record)).rejects.toMatchObject({ code: 'PROPOSAL_TAMPERED' })
  })

  it('applies the first reviewed proposal and blocks a second proposal from the same base', async () => {
    const root = await repository()
    const copies = await mkdtemp(join(tmpdir(), 'dz23-agent-copies-'))
    roots.push(copies)
    const manager = new GitWorktreeManager(copies)
    const first = await manager.create(root, 'run-first')
    const second = await manager.create(root, 'run-second')
    await writeFile(join(first.worktreePath, 'src', 'a.ts'), 'export const value = 2\n')
    await writeFile(join(second.worktreePath, 'src', 'a.ts'), 'export const value = 3\n')

    async function proposal(runId: string, worktreePath: string) {
      const diff = await manager.diff({
        repositoryPath: root,
        worktreePath,
        baseCommit: first.baseCommit,
        mainFingerprint: first.mainFingerprint,
      })
      return {
        run_id: runId, org_id: 'org', tenant_id: 'tenant', workspace_id: 'workspace',
        parent_session_id: 'parent', coordinator_session_id: 'coordinator', provider: 'spawn-in-process' as const,
        worktree_path: worktreePath, repository_path: root, base_commit: first.baseCommit,
        status: 'PROPOSED' as const, changed_files: [...diff.files], diff_bytes: diff.bytes,
        diff_sha256: (await import('node:crypto')).createHash('sha256').update(diff.text).digest('hex'),
        diagnostic: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }
    }

    const firstProposal = await proposal('run-first', first.worktreePath)
    const secondProposal = await proposal('run-second', second.worktreePath)
    await expect(manager.applyProposal(firstProposal)).resolves.toBeUndefined()
    await expect(manager.applyProposal(secondProposal)).rejects.toMatchObject({ code: 'WRITE_CONFLICT' })
    expect(await readFile(join(root, 'src', 'a.ts'), 'utf8')).toBe('export const value = 2\n')
  })

  it('rejects a repository subdirectory instead of widening scope', async () => {
    const root = await repository()
    const copies = await mkdtemp(join(tmpdir(), 'dz23-agent-copies-'))
    roots.push(copies)
    const manager = new GitWorktreeManager(copies)
    await expect(manager.create(join(root, 'src'), 'run-1')).rejects.toThrow(/raiz exata/)
  })
})
