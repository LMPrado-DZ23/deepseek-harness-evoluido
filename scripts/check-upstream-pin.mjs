#!/usr/bin/env node
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyUpstreamPin } from './upstream-pin-lib.mjs'

export async function main(argv = process.argv.slice(2)) {
  const rootIndex = argv.indexOf('--root')
  const lockIndex = argv.indexOf('--lock')
  const studioRoot = resolve(rootIndex >= 0 ? argv[rootIndex + 1] : process.cwd())
  const lockPath = lockIndex >= 0 ? argv[lockIndex + 1] : 'UPSTREAM.lock'
  const result = await verifyUpstreamPin({ studioRoot, lockPath })
  process.stdout.write(
    `UPSTREAM_PIN=PASS commit=${result.commit} tree=${result.tree} manifest_sha256=${result.manifest_sha256}\n`,
  )
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`UPSTREAM_PIN=FAIL ${error.message}\n`)
    process.exitCode = 1
  })
}
