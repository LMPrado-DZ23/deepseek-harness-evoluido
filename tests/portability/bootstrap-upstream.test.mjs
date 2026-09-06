import { strict as assert } from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { bootstrapUpstream } from '../../scripts/bootstrap-upstream.mjs'
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
      output: { write: value => output.push(value) },
    })

    assert.equal(result.commit, '1'.repeat(40))
    assert.deepEqual(events, [
      'git:submodule sync -- third_party/deepseek-harness',
      'git:submodule update --init --checkout -- third_party/deepseek-harness',
      'pin:false',
      'content:true',
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
        output: { write: () => { outputCalled = true } },
      }),
      /origin divergente/u,
    )
    assert.equal(contentCalled, false)
    assert.equal(outputCalled, false)
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
