#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { chmod, lstat, readFile, readlink, readdir, symlink, unlink } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function gitBlobOid(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
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
      await unlink(absolute)
      await symlink(target, absolute)
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
