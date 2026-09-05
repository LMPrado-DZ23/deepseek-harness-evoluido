#!/usr/bin/env node
import { cp, lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const source = resolve(root, 'apps', 'studio-web', 'dist')
const target = resolve(root, 'plugins', 'studio-web', 'lib', 'client')

export async function assertRegularTree(path) {
  const stat = await lstat(path)
  if (stat.isSymbolicLink()) throw new Error(`UI_ASSET_SYMLINK: ${path}`)
  if (!stat.isDirectory()) return
  for (const entry of await readdir(path)) await assertRegularTree(resolve(path, entry))
}

export async function packageStudioWeb(sourceDirectory, targetDirectory) {
  await assertRegularTree(sourceDirectory)
  await rm(targetDirectory, { recursive: true, force: true })
  await mkdir(dirname(targetDirectory), { recursive: true })
  await cp(sourceDirectory, targetDirectory, { recursive: true, force: false, errorOnExist: true })
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  await packageStudioWeb(source, target)
  process.stdout.write(`STUDIO_WEB_PACKAGE=PASS source=${source} target=${target}\n`)
}
