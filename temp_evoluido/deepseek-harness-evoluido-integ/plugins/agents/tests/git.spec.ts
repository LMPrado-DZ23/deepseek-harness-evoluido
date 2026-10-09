import { execFile } from 'node:child_process'
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { GitWorktreeManager } from '../src/service.ts'
import { isolatedGitEnvironment } from '../src/git.ts'

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

describe('GitWorktreeManager', { timeout: 30_000 }, () => {
  it('passes only the minimal runtime environment to Git subprocesses', () => {
    const injected = {
      OPENAI_API_KEY: 'fake-openai',
      ANTHROPIC_API_KEY: 'fake-anthropic',
      HTTP_PROXY: 'http://127.0.0.1:1',
      Git_External_Diff: 'hostile-diff',
      git_config_count: '1',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: 'hostile-fsmonitor',
      GIT_CONFIG_PARAMETERS: "'diff.external'='hostile-diff'",
    } as const
    const previous = new Map<string, string | undefined>()
    for (const [key, value] of Object.entries(injected)) {
      previous.set(key, process.env[key])
      process.env[key] = value
    }
    try {
      const environment = isolatedGitEnvironment('C:/trusted/index')
      expect(environment.PATH).toBe(process.env.PATH)
      expect(environment.GIT_INDEX_FILE).toBe('C:/trusted/index')
      expect(environment.GIT_OPTIONAL_LOCKS).toBe('0')
      expect(environment.GIT_CONFIG_NOSYSTEM).toBe('1')
      for (const key of Object.keys(injected)) {
        expect(Object.keys(environment).map(name => name.toUpperCase())).not.toContain(key.toUpperCase())
      }
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('creates a detached worktree, computes a proposed diff and fingerprints main-workspace drift', async () => {
    const root = await repository()
    const copies = await mkdtemp(join(tmpdir(), 'dz23-agent-copies-'))
    roots.push(copies)
    const manager = new GitWorktreeManager(copies)
    const snapshot = await manager.create(root, 'run-1')
    expect(snapshot.worktreePath).toBe(join(copies, 'run-1'))
    await writeFile(join(snapshot.worktreePath, 'src', 'a.ts'), 'export const value = 2\n')
    await writeFile(join(snapshot.worktreePath, 'src', 'new.ts'), 'export const added = true\n')
    const descriptor = await readFile(join(snapshot.worktreePath, '.git'), 'utf8')
    const worktreeGitDir = descriptor.match(/^gitdir: (.+)\r?\n?$/u)?.[1]
    expect(worktreeGitDir).toBeDefined()
    const indexBefore = await readFile(join(worktreeGitDir!, 'index'))
    const diff = await manager.diff(snapshot)
    expect([...diff.files].sort()).toEqual(['src/a.ts', 'src/new.ts'])
    expect(diff.text).toContain('export const value = 2')
    expect(diff.text).toContain('export const added = true')
    expect(diff.bytes).toBe(Buffer.byteLength(diff.text))
    expect(await readFile(join(worktreeGitDir!, 'index'))).toEqual(indexBefore)
    expect((await readdir(copies)).filter(name => name.startsWith('.dz23-index-'))).toEqual([])
    expect(await manager.mainFingerprint(root)).toBe(snapshot.mainFingerprint)
    await manager.applyProposal({
      run_id: 'run-1', org_id: 'org', tenant_id: 'tenant', workspace_id: 'workspace',
      parent_session_id: 'parent', coordinator_session_id: 'coordinator', provider: 'spawn-in-process',
      worktree_path: snapshot.worktreePath, repository_path: root, base_commit: snapshot.baseCommit,
      status: 'PROPOSED', changed_files: [...diff.files], diff_bytes: diff.bytes,
      diff_sha256: (await import('node:crypto')).createHash('sha256').update(diff.text).digest('hex'),
      main_changed_during_run: false, approved_by: 'person', approved_at: new Date().toISOString(),
      diagnostic: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    })
    expect((await readFile(join(root, 'src', 'a.ts'), 'utf8')).replaceAll('\r\n', '\n')).toBe('export const value = 2\n')
    expect((await readFile(join(root, 'src', 'new.ts'), 'utf8')).replaceAll('\r\n', '\n')).toBe('export const added = true\n')
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
      main_changed_during_run: false, approved_by: 'person', approved_at: new Date().toISOString(),
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
        main_changed_during_run: false, approved_by: 'person', approved_at: new Date().toISOString(),
        diagnostic: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }
    }

    const firstProposal = await proposal('run-first', first.worktreePath)
    const secondProposal = await proposal('run-second', second.worktreePath)
    await expect(manager.applyProposal(firstProposal)).resolves.toBeUndefined()
    await exec('git', ['add', '.'], { cwd: root })
    await exec('git', ['commit', '-qm', 'apply first proposal'], { cwd: root })
    await expect(manager.applyProposal(secondProposal)).rejects.toMatchObject({ code: 'WRITE_CONFLICT' })
    expect((await readFile(join(root, 'src', 'a.ts'), 'utf8')).replaceAll('\r\n', '\n')).toBe('export const value = 2\n')
  })

  it('rejects a repository subdirectory instead of widening scope', async () => {
    const root = await repository()
    const copies = await mkdtemp(join(tmpdir(), 'dz23-agent-copies-'))
    roots.push(copies)
    const manager = new GitWorktreeManager(copies)
    await expect(manager.create(join(root, 'src'), 'run-1')).rejects.toThrow(/raiz exata|fronteira Git/)
  })

  it('accepts an authorized repository that is itself a real linked worktree', async () => {
    const root = await repository()
    const linkedParent = await mkdtemp(join(tmpdir(), 'dz23-authorized-linked-'))
    const copies = await mkdtemp(join(tmpdir(), 'dz23-agent-copies-'))
    roots.push(linkedParent, copies)
    const linkedRepository = join(linkedParent, 'repository')
    await exec('git', ['worktree', 'add', '--detach', linkedRepository, 'HEAD'], { cwd: root })

    const manager = new GitWorktreeManager(copies)
    const snapshot = await manager.create(linkedRepository, 'run-from-linked')
    expect(snapshot.repositoryPath).toBe(linkedRepository)
    await writeFile(join(snapshot.worktreePath, 'src', 'a.ts'), 'export const value = 5\n')
    const diff = await manager.diff(snapshot)
    expect(diff.files).toEqual(['src/a.ts'])
    expect(diff.text).toContain('export const value = 5')
  })

  it('rejects an authorized linked repository when its reciprocal Git link is missing or points elsewhere', async () => {
    const root = await repository()
    const linkedParent = await mkdtemp(join(tmpdir(), 'dz23-authorized-linked-tampered-'))
    const copies = await mkdtemp(join(tmpdir(), 'dz23-agent-copies-'))
    roots.push(linkedParent, copies)
    const linkedRepository = join(linkedParent, 'repository')
    await exec('git', ['worktree', 'add', '--detach', linkedRepository, 'HEAD'], { cwd: root })
    const descriptor = await readFile(join(linkedRepository, '.git'), 'utf8')
    const adminPath = descriptor.match(/^gitdir: (.+)\r?\n?$/u)?.[1]
    expect(adminPath).toBeDefined()
    const manager = new GitWorktreeManager(copies)

    await rm(join(adminPath!, 'gitdir'), { force: true })
    await expect(manager.create(linkedRepository, 'run-missing-reciprocal'))
      .rejects.toMatchObject({ code: 'WORKTREE_TAMPERED' })

    await writeFile(join(adminPath!, 'gitdir'), `${join(root, '.git')}\n`)
    await expect(manager.create(linkedRepository, 'run-wrong-reciprocal'))
      .rejects.toMatchObject({ code: 'WORKTREE_TAMPERED' })
  })

  it('rejects a replaced worktree Git link before side effects and leaves the main index byte-identical', async () => {
    const root = await repository()
    const copies = await mkdtemp(join(tmpdir(), 'dz23-agent-copies-'))
    roots.push(copies)
    const manager = new GitWorktreeManager(copies)
    const snapshot = await manager.create(root, 'run-link-swap')
    const mainIndexPath = join(root, '.git', 'index')
    const indexBefore = await readFile(mainIndexPath)
    const statusBefore = (await exec('git', ['status', '--porcelain=v1', '-z'], { cwd: root })).stdout

    await rename(join(snapshot.worktreePath, '.git'), join(snapshot.worktreePath, '.git.original'))
    await writeFile(join(snapshot.worktreePath, '.git'), `gitdir: ${join(root, '.git')}\n`)
    await writeFile(join(snapshot.worktreePath, 'untracked-by-agent.ts'), 'export const unsafe = true\n')

    await expect(manager.diff(snapshot)).rejects.toMatchObject({ code: 'WORKTREE_TAMPERED' })
    expect(await readFile(mainIndexPath)).toEqual(indexBefore)
    expect((await exec('git', ['status', '--porcelain=v1', '-z'], { cwd: root })).stdout).toBe(statusBefore)
    expect((await readdir(copies)).filter(name => name.startsWith('.dz23-index-'))).toEqual([])
  })

  it('neutralizes repository hooks, filters, fsmonitor, external diff and textconv', async () => {
    const root = await repository()
    const copies = await mkdtemp(join(tmpdir(), 'dz23-agent-copies-'))
    roots.push(copies)
    const helper = join(root, 'git-extension.cjs')
    const attributes = join(root, '.gitattributes')
    const filtered = join(root, 'src', 'filtered.evil')
    const diffDriven = join(root, 'src', 'driver.driver')
    const textConverted = join(root, 'src', 'converted.textconv')
    const markers = Object.fromEntries(['hook', 'fsmonitor', 'clean', 'smudge', 'process', 'diff', 'textconv', 'external']
      .map(name => [name, join(root, `${name}-executed.log`)])) as Record<string, string>
    await writeFile(helper, "const fs=require('node:fs');fs.appendFileSync(process.argv[2],'EXECUTED\\n');process.stdin.pipe(process.stdout)\n")
    await writeFile(attributes, '*.evil filter=evil\n*.driver diff=driver\n*.textconv diff=textconv\n')
    await writeFile(filtered, 'safe-content\n')
    await writeFile(diffDriven, 'driver-content\n')
    await writeFile(textConverted, 'textconv-content\n')
    await exec('git', ['add', '.'], { cwd: root })
    await exec('git', ['commit', '-qm', 'adversarial extensions fixture'], { cwd: root })

    const command = (name: string) => `node "${helper.replaceAll('\\', '/')}" "${markers[name]!.replaceAll('\\', '/')}"`
    const hooks = join(root, 'hostile-hooks')
    await mkdir(hooks)
    const postCheckout = join(hooks, 'post-checkout')
    await writeFile(postCheckout, `#!/bin/sh\n${command('hook')}\n`)
    await chmod(postCheckout, 0o755)
    const includedConfig = join(root, '.git', 'dz23-hostile-include.config')
    await writeFile(includedConfig, [
      '[filter "evil"]',
      `\tsmudge = ${command('smudge')}`,
      `\tclean = ${command('clean')}`,
      `\tprocess = ${command('process')}`,
      '\trequired = true',
      '',
    ].join('\n'))
    for (const [key, value] of [
      ['core.hooksPath', hooks],
      ['core.fsmonitor', command('fsmonitor')],
      ['include.path', includedConfig],
      ['diff.driver.command', command('diff')],
      ['diff.textconv.textconv', command('textconv')],
    ] as const) await exec('git', ['config', '--local', key, value], { cwd: root })

    const manager = new GitWorktreeManager(copies)
    const previousExternalDiff = process.env.GIT_EXTERNAL_DIFF
    process.env.GIT_EXTERNAL_DIFF = command('external')
    try {
      const snapshot = await manager.create(root, 'run-hostile-git')
      await writeFile(join(snapshot.worktreePath, 'src', 'filtered.evil'), 'changed-without-extension\n')
      await writeFile(join(snapshot.worktreePath, 'src', 'driver.driver'), 'changed-driver\n')
      await writeFile(join(snapshot.worktreePath, 'src', 'converted.textconv'), 'changed-textconv\n')
      const diff = await manager.diff(snapshot)
      expect(diff.text).toContain('changed-without-extension')
      await manager.mainFingerprint(root)
    } finally {
      if (previousExternalDiff === undefined) delete process.env.GIT_EXTERNAL_DIFF
      else process.env.GIT_EXTERNAL_DIFF = previousExternalDiff
    }
    for (const [name, marker] of Object.entries(markers)) {
      expect(await readFile(marker, 'utf8').catch(() => ''), `${name} não pode executar`).toBe('')
    }
  })

  it('neutralizes filters activated only for the linked-worktree Git directory', async () => {
    const root = await repository()
    const copies = await mkdtemp(join(tmpdir(), 'dz23-agent-copies-'))
    roots.push(copies)
    const helper = join(root, 'conditional-filter.cjs')
    const marker = join(root, 'conditional-filter-executed.log')
    await writeFile(helper, "const fs=require('node:fs');fs.appendFileSync(process.argv[2],'EXECUTED\\n');process.stdin.pipe(process.stdout)\n")
    await writeFile(join(root, '.gitattributes'), '*.conditional filter=conditional\n')
    await writeFile(join(root, 'src', 'conditional.conditional'), 'safe-content\n')
    await exec('git', ['add', '.'], { cwd: root })
    await exec('git', ['commit', '-qm', 'conditional filter fixture'], { cwd: root })

    const command = `node "${helper.replaceAll('\\', '/')}" "${marker.replaceAll('\\', '/')}"`
    const includedConfig = join(root, '.git', 'dz23-worktree-only.config')
    await writeFile(includedConfig, [
      '[filter "conditional"]',
      `\tsmudge = ${command}`,
      '\trequired = true',
      '',
    ].join('\n'))
    const worktreeGitDirPattern = `${join(root, '.git', 'worktrees').replaceAll('\\', '/')}/**`
    await exec('git', ['config', '--local', `includeIf.gitdir/i:${worktreeGitDirPattern}.path`, includedConfig], { cwd: root })
    await expect(exec('git', ['config', '--includes', '--get', 'filter.conditional.smudge'], { cwd: root })).rejects.toMatchObject({ code: 1 })

    const manager = new GitWorktreeManager(copies)
    const snapshot = await manager.create(root, 'run-conditional-filter')
    const activeFilter = (await exec('git', ['config', '--includes', '--get', 'filter.conditional.smudge'], { cwd: snapshot.worktreePath })).stdout.trim()
    expect(activeFilter).toContain('conditional-filter.cjs')
    expect(activeFilter).toContain('conditional-filter-executed.log')
    expect(await readFile(marker, 'utf8').catch(() => '')).toBe('')
    expect((await readFile(join(snapshot.worktreePath, 'src', 'conditional.conditional'), 'utf8')).replaceAll('\r\n', '\n')).toBe('safe-content\n')
  })

  it('fails closed when included Git configuration declares too many filter drivers', async () => {
    const root = await repository()
    const copies = await mkdtemp(join(tmpdir(), 'dz23-agent-copies-'))
    roots.push(copies)
    const includedConfig = join(root, '.git', 'dz23-filter-limit.config')
    await writeFile(includedConfig, Array.from({ length: 129 }, (_, index) => [
      `[filter "driver${String(index)}"]`,
      '\tclean = cat',
      '',
    ].join('\n')).join(''))
    await exec('git', ['config', '--local', 'include.path', includedConfig], { cwd: root })

    const manager = new GitWorktreeManager(copies)
    await expect(manager.create(root, 'run-filter-limit')).rejects.toMatchObject({ code: 'WORKTREE_TAMPERED' })
    await expect(lstat(join(copies, 'run-filter-limit'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    ['unsafe syntax', 'bad=name'],
    ['overlong name', `a${'b'.repeat(128)}`],
  ])('fails closed before creating a worktree for a filter driver with %s', async (_case, driverName) => {
    const root = await repository()
    const copies = await mkdtemp(join(tmpdir(), 'dz23-agent-copies-'))
    roots.push(copies)
    const includedConfig = join(root, '.git', 'dz23-filter-name.config')
    await writeFile(includedConfig, [
      `[filter "${driverName}"]`,
      '\tclean = cat',
      '',
    ].join('\n'))
    await exec('git', ['config', '--local', 'include.path', includedConfig], { cwd: root })

    const manager = new GitWorktreeManager(copies)
    await expect(manager.create(root, 'run-filter-name')).rejects.toMatchObject({ code: 'WORKTREE_TAMPERED' })
    await expect(lstat(join(copies, 'run-filter-name'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
