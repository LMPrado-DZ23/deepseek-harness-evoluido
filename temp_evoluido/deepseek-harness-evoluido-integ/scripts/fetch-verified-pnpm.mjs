#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateImageLock } from './check-image-lock.mjs'

export function verifyPnpmArchive(content, expected) {
  const integrity = `sha512-${createHash('sha512').update(content).digest('base64')}`
  const sha1 = createHash('sha1').update(content).digest('hex')
  const sha256 = createHash('sha256').update(content).digest('hex')
  if (integrity !== expected.integrity || sha1 !== expected.sha1 || sha256 !== expected.sha256) {
    throw new Error(`PNPM_INTEGRITY_MISMATCH integrity=${integrity} sha1=${sha1} sha256=${sha256}`)
  }
}

export async function main(argv = process.argv.slice(2)) {
  const outputIndex = argv.indexOf('--output')
  if (outputIndex < 0 || argv[outputIndex + 1] === undefined) throw new Error('--output é obrigatório')
  const lock = validateImageLock(JSON.parse(await readFile(resolve('deploy/images.lock.json'), 'utf8')))
  const response = await fetch(lock.tools.pnpm.tarball, { redirect: 'follow', signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`PNPM_DOWNLOAD_FAILED status=${response.status}`)
  const content = Buffer.from(await response.arrayBuffer())
  verifyPnpmArchive(content, lock.tools.pnpm)
  await writeFile(resolve(argv[outputIndex + 1]), content, { mode: 0o600 })
  process.stdout.write(`PNPM_ARCHIVE=PASS version=${lock.tools.pnpm.version} bytes=${content.length}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`PNPM_ARCHIVE=FAIL ${error.message}\n`)
    process.exitCode = 1
  })
}
