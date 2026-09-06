#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, readFile, readlink, readdir, rename, symlink, unlink } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function gitBlobOid(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

const defaultSymlinkOperations = { rename, symlink, unlink }

function symlinkFailure(error, path) {
  const detail = error instanceof Error ? error.message : String(error)
  if (error?.code === 'EPERM' || error?.code === 'EACCES') {
    return new Error(
      `não foi possível criar symlink para ${path}; placeholder preservado. `
      + 'Ative o Modo de Desenvolvedor do Windows ou execute o bootstrap no WSL2',
      { cause: error },
    )
  }
  return new Error(`não foi possível criar symlink para ${path}; placeholder preservado: ${detail}`, { cause: error })
}

export async function replacePlaceholderWithSymlink(
  absolute,
  target,
  { operations = defaultSymlinkOperations, token = `${process.pid}-${randomUUID()}` } = {},
) {
  const staged = `${absolute}.dz23-symlink-${token}`
  const backup = `${absolute}.dz23-placeholder-${token}`
  try {
    await operations.symlink(target, staged)
  } catch (error) {
    throw symlinkFailure(error, absolute)
  }

  try {
    await operations.rename(absolute, backup)
  } catch (error) {
    await operations.unlink(staged).catch(() => undefined)
    throw new Error(`não foi possível preservar o placeholder de ${absolute}`, { cause: error })
  }

  try {
    await operations.rename(staged, absolute)
  } catch (error) {
    const rollbackErrors = []
    await operations.rename(backup, absolute).catch(rollbackError => rollbackErrors.push(rollbackError))
    await operations.unlink(staged).catch(cleanupError => rollbackErrors.push(cleanupError))
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], `falha ao instalar e restaurar symlink em ${absolute}`)
    }
    throw new Error(`falha ao instalar symlink em ${absolute}; placeholder restaurado`, { cause: error })
  }

  try {
    await operations.unlink(backup)
  } catch (error) {
    throw new Error(`symlink instalado, mas o placeholder de segurança não pôde ser removido: ${backup}`, { cause: error })
  }
}

async function presentFiles(root, current = root, result = []) {
  for (const item of await readdir(current, { withFileTypes: true })) {
    if (item.name === '.git' || item.name === 'node_modules') continue
    const absolute = resolve(current, item.name)
    const rel = relative(root, absolute).replaceAll('\\', '/')
    if (item.isDirectory()) await presentFiles(root, absolute, result)
    else result.push(rel)
  }
  return result
}

export async function verifyUpstreamContent(studioRoot, { materializeSymlinks = false } = {}) {
  const root = resolve(studioRoot)
  const manifest = JSON.parse(await readFile(resolve(root, 'integrity', 'deepseek-harness-tree.json'), 'utf8'))
  const lock = Object.fromEntries((await readFile(resolve(root, 'UPSTREAM.lock'), 'utf8'))
    .split(/\r?\n/u).filter(Boolean).map(line => line.split(/=(.*)/su).slice(0, 2)))
  if (manifest.schemaVersion !== 1 || manifest.commit !== lock.commit || manifest.tree !== lock.tree
    || manifest.repository !== lock.repository || manifest.manifestSha256 !== lock.manifest_sha256
    || !Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    throw new Error('manifesto de conteúdo não corresponde ao UPSTREAM.lock')
  }
  const upstreamRoot = resolve(root, lock.path)
  const expected = new Set()
  const canonical = []
  for (const entry of manifest.entries) {
    if (!entry || !/^(100644|100755|120000)$/u.test(entry.mode) || entry.type !== 'blob'
      || !/^[0-9a-f]{40}$/u.test(entry.oid) || typeof entry.path !== 'string') {
      throw new Error('entrada inválida no manifesto de conteúdo')
    }
    const absolute = resolve(upstreamRoot, entry.path)
    const rel = relative(upstreamRoot, absolute)
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || expected.has(entry.path)) {
      throw new Error(`caminho inválido ou duplicado no manifesto: ${entry.path}`)
    }
    expected.add(entry.path)
    let stat = await lstat(absolute).catch(() => undefined)
    if (!stat) throw new Error(`arquivo fixado ausente: ${entry.path}`)
    let bytes
    if (entry.mode === '120000' && !stat.isSymbolicLink() && materializeSymlinks && stat.isFile()) {
      bytes = await readFile(absolute)
      if (gitBlobOid(bytes) !== entry.oid) throw new Error(`placeholder de symlink divergente: ${entry.path}`)
      const target = bytes.toString('utf8')
      if (!target || target.includes('\0')) throw new Error(`alvo de symlink inválido: ${entry.path}`)
      await replacePlaceholderWithSymlink(absolute, target)
      stat = await lstat(absolute)
    }
    bytes = entry.mode === '120000'
      ? Buffer.from(await readlink(absolute), 'utf8')
      : await readFile(absolute)
    if ((entry.mode === '120000') !== stat.isSymbolicLink()) {
      throw new Error(`tipo divergente: ${entry.path}`)
    }
    if (entry.mode !== '120000' && !stat.isFile()) throw new Error(`arquivo regular esperado: ${entry.path}`)
    if (gitBlobOid(bytes) !== entry.oid) throw new Error(`blob divergente: ${entry.path}`)
    if (process.platform !== 'win32' && entry.mode !== '120000') {
      const executable = (stat.mode & 0o111) !== 0
      if (executable !== (entry.mode === '100755')) {
        if (!materializeSymlinks) throw new Error(`modo divergente: ${entry.path}`)
        await chmod(absolute, entry.mode === '100755' ? 0o755 : 0o644)
      }
    }
    canonical.push(`${entry.mode} ${entry.type} ${entry.oid}\t${entry.path}\0`)
  }
  const canonicalSha = createHash('sha256').update(canonical.join('')).digest('hex')
  if (canonicalSha !== manifest.manifestSha256) throw new Error('hash canônico do manifesto diverge')
  const actual = new Set(await presentFiles(upstreamRoot))
  const unexpected = [...actual].filter(path => !expected.has(path))
  if (unexpected.length) throw new Error(`arquivo não fixado no upstream: ${unexpected[0]}`)
  process.stdout.write(`UPSTREAM_CONTENT=PASS entries=${expected.size} sha256=${canonicalSha}\n`)
  return { entries: expected.size, manifestSha256: canonicalSha }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyUpstreamContent(resolve(process.cwd()), {
    materializeSymlinks: process.argv.includes('--materialize-symlinks'),
  }).catch(error => {
    process.stderr.write(`UPSTREAM_CONTENT=FAIL ${error.message}\n`)
    process.exitCode = 1
  })
}
