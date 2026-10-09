import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { t } from './i18n.js'

export async function hashTree(root: string, ignored: ReadonlySet<string> = new Set()): Promise<string> {
  const files = await listTreeFiles(root)
  const hash = createHash('sha256')
  for (const relative of files) {
    if (ignored.has(relative)) continue
    hash.update(relative).update('\0').update(await readFile(resolve(root, relative))).update('\0')
  }
  return hash.digest('hex')
}

export async function listTreeFiles(root: string): Promise<readonly string[]> {
  const absoluteRoot = resolve(root)
  const rootInfo = await lstat(absoluteRoot)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error(t('errors.templateSymlink', { path: absoluteRoot }))
  return (await walk(absoluteRoot)).map(path => path.slice(absoluteRoot.length + 1).replaceAll('\\', '/'))
}

export const PREVIEW_ARTIFACT_RELATIVE_PATH = '.dz23/preview-artifact-v1'
const PREVIEW_ARTIFACT_FILE_LIMIT = 20_000
const PREVIEW_ARTIFACT_BYTE_LIMIT = 128 * 1024 * 1024

/**
 * Materializes the only files the preview runtime may execute. The deployment
 * tree is separate from the pnpm workspace so dependency symlinks and build
 * caches never cross the supervisor boundary.
 */
export async function materializePreviewArtifact(runDirectory: string): Promise<{ readonly path: string; readonly sha256: string }> {
  const root = await realpath(runDirectory)
  const target = resolve(root, PREVIEW_ARTIFACT_RELATIVE_PATH)
  await mkdir(dirname(target), { recursive: true, mode: 0o755 })
  await mkdir(target, { mode: 0o755 })
  const sources = [
    { source: resolve(root, '.next', 'standalone'), target: resolve(target, '.next', 'standalone'), required: true },
    { source: resolve(root, '.next', 'static'), target: resolve(target, '.next', 'static'), required: true },
    { source: resolve(root, 'public'), target: resolve(target, 'public'), required: false },
  ] as const
  const budget = { files: 0, bytes: 0 }
  for (const item of sources) await copyDeploymentTree(item.source, item.target, item.required, budget, root, new Set())
  const server = await lstat(resolve(target, '.next', 'standalone', 'server.js')).catch(() => undefined)
  if (server === undefined || !server.isFile() || server.isSymbolicLink()) throw new Error('PREVIEW_ARTIFACT_SERVER_MISSING')
  return { path: target, sha256: await hashTree(target) }
}

async function copyDeploymentTree(source: string, target: string, required: boolean, budget: { files: number; bytes: number }, allowedRoot: string, active: Set<string>): Promise<void> {
  const rootInfo = await lstat(source).catch(() => undefined)
  if (rootInfo === undefined) {
    if (required) throw new Error('PREVIEW_ARTIFACT_SOURCE_MISSING')
    return
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('PREVIEW_ARTIFACT_SOURCE_INVALID')
  const realSource = await realpath(source)
  if (!isWithin(allowedRoot, realSource) || active.has(realSource)) throw new Error('PREVIEW_ARTIFACT_LINK_INVALID')
  active.add(realSource)
  await mkdir(target, { recursive: true, mode: 0o755 })
  const entries = await readdir(source, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const from = resolve(source, entry.name)
    const to = resolve(target, entry.name)
    if (relative(target, to).startsWith('..')) throw new Error('PREVIEW_ARTIFACT_PATH_INVALID')
    const info = await lstat(from)
    if (info.isSymbolicLink()) {
      const linked = await realpath(from)
      if (!isWithin(allowedRoot, linked)) throw new Error('PREVIEW_ARTIFACT_LINK_OUTSIDE_RUN')
      const linkedInfo = await lstat(linked)
      if (linkedInfo.isDirectory()) await copyDeploymentTree(linked, to, true, budget, allowedRoot, active)
      else await copyDeploymentFile(linked, to, linkedInfo, budget)
      continue
    }
    if (info.isDirectory()) { await copyDeploymentTree(from, to, true, budget, allowedRoot, active); continue }
    await copyDeploymentFile(from, to, info, budget)
  }
  active.delete(realSource)
}

async function copyDeploymentFile(source: string, target: string, info: Stats, budget: { files: number; bytes: number }): Promise<void> {
  if (!info.isFile()) throw new Error('PREVIEW_ARTIFACT_ENTRY_INVALID')
  budget.files += 1; budget.bytes += info.size
  if (budget.files > PREVIEW_ARTIFACT_FILE_LIMIT || budget.bytes > PREVIEW_ARTIFACT_BYTE_LIMIT) throw new Error('PREVIEW_ARTIFACT_LIMIT')
  await copyFile(source, target, 1)
}

function isWithin(root: string, candidate: string): boolean { return candidate === root || candidate.startsWith(`${root}${sep}`) }

async function walk(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const nested = await Promise.all(entries.sort((a, b) => a.name.localeCompare(b.name)).map(async entry => {
    const path = resolve(root, entry.name)
    if (entry.isSymbolicLink()) throw new Error(t('errors.templateSymlink', { path }))
    if (entry.isDirectory()) return walk(path)
    const info = await stat(path)
    return info.isFile() ? [path] : []
  }))
  return nested.flat()
}
