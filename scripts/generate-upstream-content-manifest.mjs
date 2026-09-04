#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const studioRoot = resolve(process.cwd())
const upstreamRoot = resolve(studioRoot, 'third_party', 'deepseek-harness')
const output = resolve(studioRoot, 'integrity', 'deepseek-harness-tree.json')
const lock = Object.fromEntries((await readFile(resolve(studioRoot, 'UPSTREAM.lock'), 'utf8'))
  .split(/\r?\n/u).filter(Boolean).map(line => line.split(/=(.*)/su).slice(0, 2)))
const raw = execFileSync('git', ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], { cwd: upstreamRoot })
const entries = raw.toString('utf8').split('\0').filter(Boolean).map(record => {
  const match = /^(\d{6}) ([a-z]+) ([0-9a-f]{40})\t(.+)$/u.exec(record)
  if (!match) throw new Error(`entrada ls-tree inválida: ${record}`)
  return { mode: match[1], type: match[2], oid: match[3], path: match[4] }
})
const manifestSha256 = createHash('sha256').update(raw).digest('hex')
if (manifestSha256 !== lock.manifest_sha256) throw new Error('manifesto do checkout diverge de UPSTREAM.lock')
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify({
  schemaVersion: 1,
  repository: lock.repository,
  commit: lock.commit,
  tree: lock.tree,
  manifestSha256,
  entries,
}, null, 2)}\n`)
process.stdout.write(`UPSTREAM_CONTENT_MANIFEST=PASS entries=${entries.length} sha256=${manifestSha256}\n`)
