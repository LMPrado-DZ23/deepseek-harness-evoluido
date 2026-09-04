import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { scanPortableSources } from '../../scripts/check-portability.mjs'
import { canonicalTreeManifest, verifyUpstreamPin } from '../../scripts/upstream-pin-lib.mjs'

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

test('pin aceita árvore exata e recusa alteração não rastreada', async (t) => {
  const studioRoot = await mkdtemp(join(tmpdir(), 'dz23-pin-'))
  t.after(() => rm(studioRoot, { recursive: true, force: true }))
  const upstreamRoot = join(studioRoot, 'third_party', 'upstream')
  await mkdir(upstreamRoot, { recursive: true })
  git(upstreamRoot, ['init'])
  git(upstreamRoot, ['config', 'user.name', 'DZ23 Test'])
  git(upstreamRoot, ['config', 'user.email', 'test@localhost'])
  await writeFile(join(upstreamRoot, 'package.json'), '{"name":"fixture"}\n')
  git(upstreamRoot, ['add', 'package.json'])
  git(upstreamRoot, ['commit', '-m', 'fixture'])

  const repository = 'https://example.invalid/upstream.git'
  await writeFile(
    join(studioRoot, '.gitmodules'),
    `[submodule "upstream"]\n\tpath = third_party/upstream\n\turl = ${repository}\n`,
  )
  const commit = git(upstreamRoot, ['rev-parse', 'HEAD'])
  const tree = git(upstreamRoot, ['rev-parse', 'HEAD^{tree}'])
  git(upstreamRoot, ['remote', 'add', 'origin', repository])
  git(studioRoot, ['init'])
  git(studioRoot, ['config', 'user.name', 'DZ23 Test'])
  git(studioRoot, ['config', 'user.email', 'test@localhost'])
  git(studioRoot, ['add', '.gitmodules'])
  git(studioRoot, ['update-index', '--add', '--cacheinfo', `160000,${commit},third_party/upstream`])
  const { sha256 } = canonicalTreeManifest(upstreamRoot)
  await writeFile(
    join(studioRoot, 'UPSTREAM.lock'),
    `repository=${repository}\npath=third_party/upstream\ncommit=${commit}\ntree=${tree}\nmanifest_sha256=${sha256}\n`,
  )

  const result = await verifyUpstreamPin({ studioRoot })
  assert.equal(result.commit, commit)
  await writeFile(join(upstreamRoot, 'untracked.txt'), 'mutação\n')
  await assert.rejects(
    verifyUpstreamPin({ studioRoot }),
    /árvore possui alterações ou arquivos não rastreados/u,
  )
})

test('portabilidade ignora URLs legítimas e recusa imports e links de máquina', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dz23-portability-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'plugins', 'fixture', 'src'), { recursive: true })
  await writeFile(
    join(root, 'plugins', 'fixture', 'src', 'safe.ts'),
    "export const docs = new URL('file:///documentation', import.meta.url)\n",
  )
  await writeFile(
    join(root, 'plugins', 'fixture', 'src', 'bad.ts'),
    "import secret from '/home/alice/private/secret.ts'\nexport { secret }\n",
  )
  await writeFile(
    join(root, 'plugins', 'fixture', 'package.json'),
    '{"dependencies":{"bad":"link:C:/Users/Alice/private/pkg"}}\n',
  )

  const findings = await scanPortableSources(root, [
    'plugins/fixture/src/safe.ts',
    'plugins/fixture/src/bad.ts',
    'plugins/fixture/package.json',
  ])
  assert.equal(findings.some((item) => item.file.endsWith('safe.ts')), false)
  assert.equal(findings.some((item) => item.rule === 'ABSOLUTE_IMPORT'), true)
  assert.equal(findings.some((item) => item.rule === 'ABSOLUTE_LINK'), true)
})
