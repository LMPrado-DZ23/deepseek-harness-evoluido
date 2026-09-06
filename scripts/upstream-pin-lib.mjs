import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const SHA1 = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/

export function parseUpstreamLock(contents) {
  const values = new Map()
  for (const [index, rawLine] of contents.split(/\r?\n/u).entries()) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator <= 0) throw new Error(`UPSTREAM.lock:${index + 1}: entrada inválida`)
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (values.has(key)) throw new Error(`UPSTREAM.lock: chave duplicada: ${key}`)
    values.set(key, value)
  }

  const required = ['repository', 'path', 'commit', 'tree', 'manifest_sha256']
  for (const key of required) {
    if (!values.get(key)) throw new Error(`UPSTREAM.lock: chave obrigatória ausente: ${key}`)
  }
  if (!SHA1.test(values.get('commit'))) throw new Error('UPSTREAM.lock: commit inválido')
  if (!SHA1.test(values.get('tree'))) throw new Error('UPSTREAM.lock: tree inválida')
  if (!SHA256.test(values.get('manifest_sha256'))) {
    throw new Error('UPSTREAM.lock: manifest_sha256 inválido')
  }
  if (values.has('execution_checkout')) {
    throw new Error('UPSTREAM.lock: execution_checkout é proibido; use path relativo')
  }

  return Object.fromEntries(values)
}

function runGit(cwd, args, { binary = false } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: binary ? null : 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : result.stderr
    throw new Error(`git ${args.join(' ')} falhou: ${stderr.trim()}`)
  }
  return result.stdout
}

export function canonicalTreeManifest(repositoryRoot, revision = 'HEAD') {
  const bytes = runGit(repositoryRoot, ['ls-tree', '-r', '-z', '--full-tree', revision], {
    binary: true,
  })
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

function confinedPath(root, candidate) {
  if (isAbsolute(candidate)) throw new Error('UPSTREAM.lock: path deve ser relativo')
  const absolute = resolve(root, candidate)
  const rel = relative(root, absolute)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('UPSTREAM.lock: path precisa apontar para dentro do repositório Studio')
  }
  return absolute
}

function gitmoduleValues(studioRoot, submodulePath) {
  const text = runGit(studioRoot, [
    'config',
    '--file',
    '.gitmodules',
    '--get-regexp',
    '^submodule\\..*\\.(path|url)$',
  ])
  const sections = new Map()
  for (const line of text.trim().split(/\r?\n/u)) {
    const match = /^submodule\.([^.]*)\.(path|url)\s+(.+)$/u.exec(line)
    if (!match) continue
    const [, name, key, value] = match
    const current = sections.get(name) ?? {}
    current[key] = value
    sections.set(name, current)
  }
  const matches = [...sections.values()].filter((entry) => entry.path === submodulePath)
  if (matches.length !== 1) {
    throw new Error(`.gitmodules: esperado um único submodule em ${submodulePath}`)
  }
  return matches[0]
}

async function assertRealSymlinks(repositoryRoot) {
  const tree = canonicalTreeManifest(repositoryRoot).bytes.toString('utf8')
  const entries = tree.split('\0').filter(Boolean)
  for (const entry of entries) {
    const match = /^(\d{6})\s+\w+\s+[0-9a-f]{40}\t(.+)$/u.exec(entry)
    if (!match || match[1] !== '120000') continue
    const target = resolve(repositoryRoot, match[2])
    const stat = await lstat(target).catch(() => undefined)
    if (!stat?.isSymbolicLink()) {
      throw new Error(`upstream: symlink não materializado corretamente: ${match[2]}`)
    }
  }
}

export async function verifyUpstreamPin({
  studioRoot,
  lockPath = 'UPSTREAM.lock',
  requireRealSymlinks = true,
}) {
  const lock = parseUpstreamLock(await readFile(resolve(studioRoot, lockPath), 'utf8'))
  const upstreamRoot = confinedPath(studioRoot, lock.path)
  const rootStat = await lstat(upstreamRoot).catch(() => undefined)
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`upstream ausente ou inválido em ${lock.path}`)
  }

  const module = gitmoduleValues(studioRoot, lock.path.replaceAll('\\', '/'))
  if (module.url !== lock.repository) {
    throw new Error(`.gitmodules: URL divergente (${module.url})`)
  }

  const gitlink = runGit(studioRoot, ['ls-files', '--stage', '--', lock.path]).trim()
  const expectedGitlink = `160000 ${lock.commit} 0\t${lock.path.replaceAll('\\', '/')}`
  if (gitlink !== expectedGitlink) {
    throw new Error(`índice Studio: gitlink divergente (${gitlink || 'ausente'})`)
  }

  const origin = runGit(upstreamRoot, ['remote', 'get-url', 'origin']).trim()
  if (origin !== lock.repository) throw new Error(`upstream: origin divergente (${origin})`)

  const commit = runGit(upstreamRoot, ['rev-parse', 'HEAD']).trim()
  const tree = runGit(upstreamRoot, ['rev-parse', 'HEAD^{tree}']).trim()
  if (commit !== lock.commit) throw new Error(`upstream: commit divergente (${commit})`)
  if (tree !== lock.tree) throw new Error(`upstream: tree divergente (${tree})`)

  const dirty = runGit(upstreamRoot, ['status', '--porcelain=v1', '--untracked-files=all'])
  if (dirty) throw new Error('upstream: árvore possui alterações ou arquivos não rastreados')

  const manifest = canonicalTreeManifest(upstreamRoot)
  if (manifest.sha256 !== lock.manifest_sha256) {
    throw new Error(`upstream: manifesto divergente (${manifest.sha256})`)
  }
  if (requireRealSymlinks) await assertRealSymlinks(upstreamRoot)

  return { ...lock, upstreamRoot, commit, tree, manifest_sha256: manifest.sha256 }
}
