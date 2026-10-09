import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { canonicalTreeManifest, verifyUpstreamPin } from './upstream-pin-lib.mjs'

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} falhou: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

async function expectRejected(label, operation, pattern) {
  try {
    await operation()
  } catch (error) {
    if (pattern.test(String(error?.message ?? error))) return
    throw new Error(`${label}: erro inesperado: ${error?.message ?? error}`)
  }
  throw new Error(`${label}: adulteração foi aceita`)
}

export async function runUpstreamPinSelfTest() {
  const prefix = join(tmpdir(), 'dz23-upstream-pin-')
  const sandbox = await mkdtemp(prefix)
  const resolvedSandbox = resolve(sandbox)
  if (!resolvedSandbox.startsWith(resolve(tmpdir()) + sep) || !basename(resolvedSandbox).startsWith('dz23-upstream-pin-')) {
    throw new Error('fixture temporária fora da raiz esperada')
  }
  try {
    const source = join(resolvedSandbox, 'upstream-source')
    const studio = join(resolvedSandbox, 'studio-fixture')
    await mkdir(source)
    await mkdir(studio)
    git(source, ['init', '-q'])
    git(source, ['config', 'user.email', 'fixture@dz23.invalid'])
    git(source, ['config', 'user.name', 'DZ23 fixture'])
    await writeFile(join(source, 'README.md'), 'upstream pinned\n', 'utf8')
    git(source, ['add', 'README.md'])
    git(source, ['commit', '-qm', 'fixture upstream'])
    const repository = pathToFileURL(source).href
    const commit = git(source, ['rev-parse', 'HEAD'])
    const tree = git(source, ['rev-parse', 'HEAD^{tree}'])
    const manifest = canonicalTreeManifest(source).sha256

    git(studio, ['init', '-q'])
    git(studio, ['config', 'user.email', 'fixture@dz23.invalid'])
    git(studio, ['config', 'user.name', 'DZ23 fixture'])
    git(studio, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '--', repository, 'third_party/deepseek-harness'])
    const lock = [
      `repository=${repository}`,
      'path=third_party/deepseek-harness',
      `commit=${commit}`,
      `tree=${tree}`,
      `manifest_sha256=${manifest}`,
      '',
    ].join('\n')
    await writeFile(join(studio, 'UPSTREAM.lock'), lock, 'utf8')
    git(studio, ['add', '.gitmodules', 'UPSTREAM.lock', 'third_party/deepseek-harness'])
    git(studio, ['commit', '-qm', 'fixture studio'])
    const checkout = join(studio, 'third_party', 'deepseek-harness')
    const originalReadme = await readFile(join(checkout, 'README.md'))

    await verifyUpstreamPin({ studioRoot: studio })

    await writeFile(join(checkout, 'untracked.txt'), 'tamper\n', 'utf8')
    await expectRejected('untracked', () => verifyUpstreamPin({ studioRoot: studio }), /alterações|não rastreados/u)
    await rm(join(checkout, 'untracked.txt'))

    await writeFile(join(checkout, 'README.md'), 'modified\n', 'utf8')
    await expectRejected('tracked', () => verifyUpstreamPin({ studioRoot: studio }), /alterações|não rastreados/u)
    await writeFile(join(checkout, 'README.md'), originalReadme)

    const modulesPath = join(studio, '.gitmodules')
    const modules = await readFile(modulesPath, 'utf8')
    await writeFile(modulesPath, modules.replace(repository, 'https://example.invalid/tampered.git'), 'utf8')
    await expectRejected('gitmodules', () => verifyUpstreamPin({ studioRoot: studio }), /URL divergente/u)
    await writeFile(modulesPath, modules, 'utf8')

    await writeFile(join(studio, 'UPSTREAM.lock'), lock.replace(manifest, '0'.repeat(64)), 'utf8')
    await expectRejected('manifest', () => verifyUpstreamPin({ studioRoot: studio }), /manifesto divergente/u)
    await writeFile(join(studio, 'UPSTREAM.lock'), lock, 'utf8')

    git(checkout, ['remote', 'set-url', 'origin', 'https://example.invalid/tampered.git'])
    await expectRejected('origin', () => verifyUpstreamPin({ studioRoot: studio }), /origin divergente/u)
    git(checkout, ['remote', 'set-url', 'origin', repository])
    await verifyUpstreamPin({ studioRoot: studio })

    return { negativeFixtures: 5, commit, tree, manifest_sha256: manifest }
  } finally {
    await rm(resolvedSandbox, { recursive: true, force: true })
  }
}
