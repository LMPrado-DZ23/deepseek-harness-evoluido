import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { bootstrapUpstream, normalizeSubmoduleWorktreeConfig } from '../../scripts/bootstrap-upstream.mjs'
import { replacePlaceholderWithSymlink } from '../../scripts/check-upstream-content.mjs'

const sandboxes = []

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function studioFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dz23-bootstrap-order-'))
  sandboxes.push(root)
  await writeFile(join(root, 'UPSTREAM.lock'), [
    'repository=https://example.invalid/upstream.git',
    'path=third_party/deepseek-harness',
    `commit=${'1'.repeat(40)}`,
    `tree=${'2'.repeat(40)}`,
    `manifest_sha256=${'3'.repeat(64)}`,
    '',
  ].join('\n'))
  return root
}

function git(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  if (!allowFailure) assert.equal(result.status, 0, result.stderr)
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
}

describe('bootstrap do upstream', () => {
  it('prova a origem antes de materializar symlinks e repete a prova completa depois', async () => {
    const studioRoot = await studioFixture()
    const events = []
    const output = []
    const result = await bootstrapUpstream({
      studioRoot,
      runGit: (_root, args) => events.push(`git:${args.join(' ')}`),
      verifyPin: async options => {
        events.push(`pin:${String(options.requireRealSymlinks)}`)
        return { commit: '1'.repeat(40) }
      },
      verifyContent: async (_root, options) => events.push(`content:${String(options.materializeSymlinks)}`),
      normalizeWorktreeConfig: async () => events.push('normalize'),
      output: { write: value => output.push(value) },
    })

    assert.equal(result.commit, '1'.repeat(40))
    assert.deepEqual(events, [
      'git:submodule sync -- third_party/deepseek-harness',
      'git:submodule update --init --checkout -- third_party/deepseek-harness',
      'pin:false',
      'content:true',
      'normalize',
      'pin:undefined',
    ])
    assert.deepEqual(output, [`UPSTREAM_BOOTSTRAP=PASS commit=${'1'.repeat(40)}\n`])
  })

  it('não materializa nem declara sucesso quando a prova prévia da origem falha', async () => {
    const studioRoot = await studioFixture()
    let contentCalled = false
    let outputCalled = false
    await assert.rejects(
      bootstrapUpstream({
        studioRoot,
        runGit: () => undefined,
        verifyPin: async () => { throw new Error('origin divergente') },
        verifyContent: async () => { contentCalled = true },
        normalizeWorktreeConfig: async () => { throw new Error('não deveria normalizar') },
        output: { write: () => { outputCalled = true } },
      }),
      /origin divergente/u,
    )
    assert.equal(contentCalled, false)
    assert.equal(outputCalled, false)
  })

  it('move apenas core.worktree canônico para configuração local e é idempotente', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-worktree-config-'))
    sandboxes.push(root)
    git(root, ['init', '-q'])
    git(root, ['config', 'core.worktree', '..'])

    const first = await normalizeSubmoduleWorktreeConfig({ studioRoot: root, upstreamRoot: root })
    assert.equal(first.changed, true)
    assert.equal(git(root, ['config', '--file', first.commonConfig, '--get', 'core.worktree'], { allowFailure: true }).status, 1)
    assert.equal(git(root, ['config', '--file', first.commonConfig, '--get', 'core.repositoryFormatVersion']).stdout, '1')
    assert.equal(git(root, ['config', '--file', first.commonConfig, '--get', 'extensions.worktreeConfig']).stdout, 'true')
    assert.equal(git(root, ['config', '--file', first.worktreeConfig, '--get', 'core.worktree']).stdout, '..')
    assert.equal(git(root, ['config', '--get', 'core.worktree']).stdout, '..')

    const second = await normalizeSubmoduleWorktreeConfig({ studioRoot: root, upstreamRoot: root })
    assert.equal(second.changed, false)
  })

  it('recusa core.worktree que aponta para outro diretório sem alterar a configuração', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-worktree-wrong-'))
    sandboxes.push(root)
    git(root, ['init', '-q'])
    await mkdir(join(root, 'outro-diretorio'))
    git(root, ['config', 'core.worktree', '../outro-diretorio'])
    const before = git(root, ['config', '--local', '--list']).stdout

    await assert.rejects(
      normalizeSubmoduleWorktreeConfig({ studioRoot: root, upstreamRoot: root }),
      /não aponta para o submódulo fixado/u,
    )
    assert.equal(git(root, ['config', '--local', '--list']).stdout, before)
  })

  it('recusa configuração worktree preexistente em vez de ativar valores do usuário', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-worktree-owned-'))
    sandboxes.push(root)
    git(root, ['init', '-q'])
    git(root, ['config', 'core.worktree', '..'])
    await writeFile(join(root, '.git', 'config.worktree'), '[user]\n\tname = Não ativar\n')
    const before = git(root, ['config', '--local', '--list']).stdout

    await assert.rejects(
      normalizeSubmoduleWorktreeConfig({ studioRoot: root, upstreamRoot: root }),
      /valores que exigem migração manual/u,
    )
    assert.equal(git(root, ['config', '--local', '--list']).stdout, before)
  })

  it('recusa extensões Git desconhecidas antes de migrar a configuração', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dz23-worktree-extension-'))
    sandboxes.push(root)
    git(root, ['init', '-q'])
    git(root, ['config', 'core.repositoryFormatVersion', '1'])
    git(root, ['config', 'core.worktree', '..'])
    git(root, ['config', 'extensions.objectFormat', 'sha1'])

    await assert.rejects(
      normalizeSubmoduleWorktreeConfig({ studioRoot: root, upstreamRoot: root }),
      /extensão Git que exige auditoria manual/u,
    )
    assert.equal(git(root, ['config', '--get', 'core.worktree']).stdout, '..')
  })
})

describe('materialização transacional de symlink', () => {
  it('preserva o placeholder quando o sistema recusa criar o symlink', async () => {
    const calls = []
    const denied = Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    await assert.rejects(
      replacePlaceholderWithSymlink('C:/fixture/CLAUDE.md', 'AGENTS.md', {
        token: 'test',
        operations: {
          symlink: async (...args) => { calls.push(['symlink', ...args]); throw denied },
          rename: async (...args) => calls.push(['rename', ...args]),
          unlink: async (...args) => calls.push(['unlink', ...args]),
        },
      }),
      /placeholder preservado.*Modo de Desenvolvedor.*WSL2/u,
    )
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], 'symlink')
  })

  it('restaura o placeholder quando a promoção do symlink falha', async () => {
    const calls = []
    await assert.rejects(
      replacePlaceholderWithSymlink('/fixture/CLAUDE.md', 'AGENTS.md', {
        token: 'test',
        operations: {
          symlink: async (...args) => calls.push(['symlink', ...args]),
          rename: async (...args) => {
            calls.push(['rename', ...args])
            if (calls.filter(call => call[0] === 'rename').length === 2) throw new Error('promotion failed')
          },
          unlink: async (...args) => calls.push(['unlink', ...args]),
        },
      }),
      /placeholder restaurado/u,
    )
    assert.deepEqual(calls.map(call => call[0]), ['symlink', 'rename', 'rename', 'rename', 'unlink'])
  })

  it('só remove o placeholder de segurança depois da promoção', async () => {
    const calls = []
    await replacePlaceholderWithSymlink('/fixture/CLAUDE.md', 'AGENTS.md', {
      token: 'test',
      operations: {
        symlink: async (...args) => calls.push(['symlink', ...args]),
        rename: async (...args) => calls.push(['rename', ...args]),
        unlink: async (...args) => calls.push(['unlink', ...args]),
      },
    })
    assert.deepEqual(calls.map(call => call[0]), ['symlink', 'rename', 'rename', 'unlink'])
  })
})
