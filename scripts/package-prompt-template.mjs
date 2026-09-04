#!/usr/bin/env node
import { cp, lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const source = resolve(root, 'templates', 'nextjs-app@1')
const target = resolve(root, 'plugins', 'prompt-to-app', 'template', 'nextjs-app@1')

async function assertRegularTree(path) {
  const stat = await lstat(path)
  if (stat.isSymbolicLink()) throw new Error(`PROMPT_TEMPLATE_SYMLINK: ${path}`)
  if (!stat.isDirectory()) return
  for (const entry of await readdir(path)) await assertRegularTree(resolve(path, entry))
}

await assertRegularTree(source)
await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
await cp(source, target, { recursive: true, force: false, errorOnExist: true })
process.stdout.write(`PROMPT_TEMPLATE_PACKAGE=PASS source=${source} target=${target}\n`)
