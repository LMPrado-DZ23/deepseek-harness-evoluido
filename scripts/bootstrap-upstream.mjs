#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { verifyUpstreamContent } from './check-upstream-content.mjs'
import { parseUpstreamLock, verifyUpstreamPin } from './upstream-pin-lib.mjs'

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(' ')} falhou`)
}

export async function bootstrapUpstream({
  studioRoot = resolve(process.cwd()),
  runGit = git,
  verifyPin = verifyUpstreamPin,
  verifyContent = verifyUpstreamContent,
  output = process.stdout,
} = {}) {
  const lock = parseUpstreamLock(await readFile(resolve(studioRoot, 'UPSTREAM.lock'), 'utf8'))

  // O bootstrap apenas materializa o gitlink registrado. Nunca reseta, limpa ou
  // escolhe uma branch para contornar divergência local.
  runGit(studioRoot, ['submodule', 'sync', '--', lock.path])
  runGit(studioRoot, ['submodule', 'update', '--init', '--checkout', '--', lock.path])

  // Primeiro prova commit, árvore, origin, índice e limpeza sem exigir o tipo
  // físico dos symlinks. Só depois converte placeholders de checkout Windows.
  // Assim uma origem divergente jamais é alterada pelo materializador.
  await verifyPin({ studioRoot, requireRealSymlinks: false })
  await verifyContent(studioRoot, { materializeSymlinks: true })
  const result = await verifyPin({ studioRoot })
  output.write(`UPSTREAM_BOOTSTRAP=PASS commit=${result.commit}\n`)
  return result
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  bootstrapUpstream().catch(error => {
    process.stderr.write(`UPSTREAM_BOOTSTRAP=FAIL ${error.message}\n`)
    process.exitCode = 1
  })
}
