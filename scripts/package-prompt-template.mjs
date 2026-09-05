#!/usr/bin/env node
import { cp, lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const source = resolve(root, 'templates', 'nextjs-app@1')
const target = resolve(root, 'plugins', 'prompt-to-app', 'template', 'nextjs-app@1')

export async function assertRegularTree(path) {
  const stat = await lstat(path)
  if (stat.isSymbolicLink()) throw new Error(`PROMPT_TEMPLATE_SYMLINK: ${path}`)
  if (!stat.isDirectory()) return
  for (const entry of await readdir(path)) await assertRegularTree(resolve(path, entry))
}

export async function packagePromptTemplate(sourceDirectory, targetDirectory) {
  await assertRegularTree(sourceDirectory)
  await rm(targetDirectory, { recursive: true, force: true })
  await mkdir(dirname(targetDirectory), { recursive: true })
  await cp(sourceDirectory, targetDirectory, { recursive: true, force: false, errorOnExist: true })
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  await packagePromptTemplate(source, target)
  process.stdout.write(`PROMPT_TEMPLATE_PACKAGE=PASS source=${source} target=${target}\n`)
}
