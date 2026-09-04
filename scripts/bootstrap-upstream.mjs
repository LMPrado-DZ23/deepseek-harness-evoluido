#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseUpstreamLock, verifyUpstreamPin } from './upstream-pin-lib.mjs'

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(' ')} falhou`)
}

const studioRoot = resolve(process.cwd())
const lock = parseUpstreamLock(await readFile(resolve(studioRoot, 'UPSTREAM.lock'), 'utf8'))

// O bootstrap apenas materializa o gitlink registrado. Nunca reseta, limpa ou
// escolhe uma branch para contornar divergência local.
git(studioRoot, ['submodule', 'sync', '--', lock.path])
git(studioRoot, ['submodule', 'update', '--init', '--checkout', '--', lock.path])

const result = await verifyUpstreamPin({ studioRoot })
process.stdout.write(`UPSTREAM_BOOTSTRAP=PASS commit=${result.commit}\n`)
