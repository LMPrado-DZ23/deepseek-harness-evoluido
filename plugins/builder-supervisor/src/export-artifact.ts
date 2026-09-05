import { createHash, randomBytes } from 'node:crypto'
import { constants, type Dirent } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import type { FileHandle } from 'node:fs/promises'
import type { ExportedArtifact } from './model.js'
import { BuilderSupervisorError } from './model.js'

const BLOCK = 512
const MAX_FILES = 20_000
const MAX_BYTES = 512 * 1024 * 1024

export interface ExportRuntime {
  readonly lstat: typeof lstat; readonly mkdir: typeof mkdir; readonly open: typeof open; readonly readdir: typeof readdir
  readonly realpath: typeof realpath; readonly rename: typeof rename; readonly remove: typeof rm; readonly writeFile: typeof writeFile
  readonly noFollowFlag: number; readonly platform: NodeJS.Platform; readonly uid: number | undefined; readonly randomHex: () => string
}
export interface ManagedExportArchive { readonly path: string; readonly handle: FileHandle; readonly dev: number; readonly ino: number }
export interface ExpectedArchive { readonly dev: number; readonly ino: number; readonly size: number; readonly sha256: string }
export function currentExportIdentity(platform: NodeJS.Platform, getuid: (() => number) | undefined): Pick<ExportRuntime, 'platform' | 'uid'> { return { platform, uid: getuid === undefined ? undefined : getuid() } }
const DEFAULT_RUNTIME: ExportRuntime = { lstat, mkdir, open, readdir, realpath, rename, remove: rm, writeFile, noFollowFlag: constants.O_NOFOLLOW, ...currentExportIdentity(process.platform, process.getuid), randomHex: () => randomBytes(8).toString('hex') }

export async function openManagedExportArchive(exportRoot: string, buildRef: string, runtime: ExportRuntime = DEFAULT_RUNTIME): Promise<ManagedExportArchive> {
  if (!/^build_[a-f0-9]{32}$/u.test(buildRef)) invalid()
  const root = resolve(exportRoot); await prepareExportDirectories(root, runtime)
  const path = resolve(root, `.archive-${buildRef}-${runtime.randomHex()}.tar`); assertExportPathBeneath(root, path)
  const handle = await runtime.open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | runtime.noFollowFlag, 0o600)
  try { const stat = await handle.stat(); if (!stat.isFile() || stat.nlink !== 1) invalid(); return { path, handle, dev: stat.dev, ino: stat.ino } } catch (error) { await handle.close(); await runtime.remove(path, { force: true }).catch(() => undefined); throw error }
}

export async function readValidatedPublishedArtifact(exportRoot: string, buildRef: string, runtime: ExportRuntime = DEFAULT_RUNTIME): Promise<ExportedArtifact | undefined> {
  if (!/^build_[a-f0-9]{32}$/u.test(buildRef)) invalid(); const root = resolve(exportRoot); await prepareExportDirectories(root, runtime)
  return readPublished(resolve(root, 'exports', buildRef), root, buildRef, runtime)
}

export async function listManagedExportArchives(exportRoot: string, runtime: ExportRuntime = DEFAULT_RUNTIME): Promise<readonly string[]> {
  const root = resolve(exportRoot); await prepareExportDirectories(root, runtime); const refs = new Set<string>()
  for (const entry of await runtime.readdir(root, { withFileTypes: true })) {
    const match = /^\.archive-(build_[a-f0-9]{32})-[a-f0-9]{16}\.tar$/u.exec(entry.name); if (match === null) continue
    const path = resolve(root, entry.name); await assertManagedArchive(path, entry, runtime); refs.add(match[1]!)
  }
  const parent = resolve(root, 'exports')
  for (const entry of await runtime.readdir(parent, { withFileTypes: true })) { const match = /^\.stage-(build_[a-f0-9]{32})-[a-f0-9]{16}$/u.exec(entry.name); if (match === null) continue; const path = resolve(parent, entry.name); if (!entry.isDirectory() || entry.isSymbolicLink()) invalid(); await assertOwnedDirectory(path, runtime); refs.add(match[1]!) }
  return [...refs].sort()
}

export async function cleanupManagedExportResources(exportRoot: string, buildRef: string | undefined, signal: AbortSignal, runtime: ExportRuntime = DEFAULT_RUNTIME): Promise<void> {
  if (buildRef !== undefined && !/^build_[a-f0-9]{32}$/u.test(buildRef)) invalid(); const root = resolve(exportRoot); await prepareExportDirectories(root, runtime); const parent = resolve(root, 'exports')
  for (const entry of await runtime.readdir(root, { withFileTypes: true })) {
    signal.throwIfAborted(); const match = /^\.archive-(build_[a-f0-9]{32})-[a-f0-9]{16}\.tar$/u.exec(entry.name); if (match === null || (buildRef !== undefined && match[1] !== buildRef)) continue
    const path = resolve(root, entry.name); await assertManagedArchive(path, entry, runtime); await runtime.remove(path); await syncDirectory(root, runtime)
  }
  for (const entry of await runtime.readdir(parent, { withFileTypes: true })) {
    signal.throwIfAborted(); const stage = /^\.stage-(build_[a-f0-9]{32})-[a-f0-9]{16}$/u.exec(entry.name); const orphan = /^\.orphan-[a-f0-9]{16}$/u.test(entry.name)
    if (!orphan && (stage === null || (buildRef !== undefined && stage[1] !== buildRef))) continue
    const path = resolve(parent, entry.name); if (!entry.isDirectory() || entry.isSymbolicLink()) invalid(); await assertOwnedDirectory(path, runtime)
    const quarantine = orphan ? path : resolve(parent, `.orphan-${runtime.randomHex()}`)
    if (!orphan) { await runtime.rename(path, quarantine); await syncDirectory(parent, runtime) }
    await runtime.remove(quarantine, { recursive: true }); await syncDirectory(parent, runtime)
  }
}

export async function publishValidatedDockerArchive(exportRoot: string, buildRef: string, archivePath: string, signal: AbortSignal, runtime: ExportRuntime = DEFAULT_RUNTIME, expected?: ExpectedArchive): Promise<ExportedArtifact> {
  if (!/^build_[a-f0-9]{32}$/u.test(buildRef)) invalid()
  const root = resolve(exportRoot)
  await prepareExportDirectories(root, runtime)
  const final = resolve(root, 'exports', buildRef)
  const parent = dirname(final); await runtime.mkdir(parent, { recursive: true, mode: 0o700 }); await assertOwnedDirectory(parent, runtime)
  const existing = await readPublished(final, root, buildRef, runtime)
  if (existing !== undefined) return existing
  const stage = resolve(parent, `.stage-${buildRef}-${runtime.randomHex()}`)
  await runtime.mkdir(stage, { mode: 0o700 })
  try {
    const extracted = await extractTar(archivePath, stage, signal, runtime, expected)
    await assertRequiredExport(stage, runtime)
    const result = await verifyPublishedTree(stage, runtime)
    if (result.files !== extracted.files || result.bytes !== extracted.bytes) invalid()
    const published: ExportedArtifact = { relative_path: `exports/${buildRef}`, ...result }
    await runtime.writeFile(resolve(stage, '.dz23-artifact.json'), `${JSON.stringify({ build_ref: buildRef, ...published })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await runtime.rename(stage, final); await syncDirectory(parent, runtime)
    return published
  } catch (error) {
    const orphan = resolve(parent, `.orphan-${runtime.randomHex()}`)
    await runtime.rename(stage, orphan).then(async () => { await syncDirectory(parent, runtime); await runtime.remove(orphan, { recursive: true }); await syncDirectory(parent, runtime) }).catch(() => undefined)
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new BuilderSupervisorError('EXPORT_INVALID')
    throw error
  }
}

export async function enforceExportRetention(exportRoot: string, currentBuildRef: string, maximumExports: number, maximumBytes: number, signal: AbortSignal, runtime: ExportRuntime = DEFAULT_RUNTIME): Promise<void> {
  if (!Number.isSafeInteger(maximumExports) || maximumExports < 1 || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error('INVALID_EXPORT_RETENTION')
  if (!/^build_[a-f0-9]{32}$/u.test(currentBuildRef)) invalid()
  const root = resolve(exportRoot); const parent = resolve(root, 'exports'); await assertOwnedDirectory(root, runtime); await assertOwnedDirectory(parent, runtime)
  const rows: Array<{ readonly path: string; readonly buildRef: string; readonly bytes: number; readonly mtimeMs: number }> = []
  for (const entry of await runtime.readdir(parent, { withFileTypes: true })) {
    signal.throwIfAborted()
    if (/^\.orphan-[a-f0-9]{16}$/u.test(entry.name)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) invalid()
      const orphan = resolve(parent, entry.name); assertExportPathBeneath(root, orphan); await assertOwnedDirectory(orphan, runtime); await runtime.remove(orphan, { recursive: true }); await syncDirectory(parent, runtime); continue
    }
    if (/^\.stage-build_[a-f0-9]{32}-[a-f0-9]{16}$/u.test(entry.name)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) invalid()
      const stage = resolve(parent, entry.name); assertExportPathBeneath(root, stage)
      const stat = await runtime.lstat(stage)
      if (!stat.isDirectory() || stat.isSymbolicLink() || await runtime.realpath(stage) !== stage) invalid()
      const quarantine = resolve(parent, `.orphan-${runtime.randomHex()}`); await runtime.rename(stage, quarantine); await syncDirectory(parent, runtime); await runtime.remove(quarantine, { recursive: true }); await syncDirectory(parent, runtime)
      continue
    }
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^build_[a-f0-9]{32}$/u.test(entry.name)) invalid()
    const path = resolve(parent, entry.name); assertExportPathBeneath(root, path)
    const stat = await runtime.lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink() || await runtime.realpath(path) !== path) invalid()
    if (await readPublished(path, root, entry.name, runtime) === undefined) invalid()
    rows.push({ path, buildRef: entry.name, bytes: await measuredDirectoryBytes(path, maximumBytes, signal, runtime), mtimeMs: stat.mtimeMs })
  }
  const current = rows.find(row => row.buildRef === currentBuildRef)
  if (current === undefined || current.bytes > maximumBytes) throw new BuilderSupervisorError('CAPACITY_EXCEEDED')
  let total = rows.reduce((sum, row) => sum + row.bytes, 0); let count = rows.length
  for (const row of rows.filter(item => item.buildRef !== currentBuildRef).sort((left, right) => left.mtimeMs - right.mtimeMs || left.buildRef.localeCompare(right.buildRef))) {
    if (count <= maximumExports && total <= maximumBytes) break
    const stat = await runtime.lstat(row.path); if (!stat.isDirectory() || stat.isSymbolicLink() || await runtime.realpath(row.path) !== row.path) invalid()
    await runtime.remove(row.path, { recursive: true }); await syncDirectory(parent, runtime); total -= row.bytes; count -= 1
  }
}

async function extractTar(archivePath: string, stage: string, signal: AbortSignal, runtime: ExportRuntime, expected?: ExpectedArchive): Promise<{ readonly files: number; readonly bytes: number }> {
  const archive = await runtime.open(archivePath, constants.O_RDONLY | runtime.noFollowFlag)
  const names = new Set<string>(); let offset = 0; let files = 0; let bytes = 0; let terminated = false
  try {
    const archiveBefore = await archive.stat(); if (!archiveBefore.isFile() || archiveBefore.nlink !== 1) invalid()
    if (expected !== undefined) {
      if (archiveBefore.dev !== expected.dev || archiveBefore.ino !== expected.ino || archiveBefore.size !== expected.size || await hashFile(archive, archiveBefore.size, signal) !== expected.sha256) throw new BuilderSupervisorError('ARTIFACT_CHANGED_DURING_STAGE')
    }
    while (offset + BLOCK <= archiveBefore.size) {
      signal.throwIfAborted()
      const header = Buffer.alloc(BLOCK); if ((await archive.read(header, 0, BLOCK, offset)).bytesRead !== BLOCK) invalid(); offset += BLOCK
      if (header.every(byte => byte === 0)) {
        const second = Buffer.alloc(BLOCK); if ((await archive.read(second, 0, BLOCK, offset)).bytesRead !== BLOCK || !second.every(byte => byte === 0)) invalid(); offset += BLOCK
        while (offset < archiveBefore.size) {
          const trailing = Buffer.alloc(Math.min(64 * 1024, archiveBefore.size - offset))
          const read = await archive.read(trailing, 0, trailing.byteLength, offset)
          if (read.bytesRead !== trailing.byteLength) invalid()
          if (!trailing.every(byte => byte === 0)) invalid()
          offset += trailing.byteLength
        }
        terminated = true; break
      }
      verifyChecksum(header)
      const rawName = `${cstring(header.subarray(345, 500))}${cstring(header.subarray(345, 500)) === '' ? '' : '/'}${cstring(header.subarray(0, 100))}`
      const name = normalizeTarName(rawName); const size = parseOctal(header.subarray(124, 136)); const type = String.fromCharCode(header[156] || 48)
      if (name === undefined) { if (type !== '5' || size !== 0) invalid() }
      else if (type === '5') { if (size !== 0 || !allowedExportPath(name, true)) invalid(); await secureDirectory(stage, name, runtime) }
      else if (type === '0') {
        if (!allowedExportPath(name, false)) invalid()
        if (names.has(name.toLowerCase())) invalid(); names.add(name.toLowerCase()); files += 1; bytes += size
        if (files > MAX_FILES || bytes > MAX_BYTES || size > MAX_BYTES) invalid()
        const parent = dirname(resolve(stage, ...name.split('/'))); await secureDirectory(stage, relative(stage, parent).split(sep).join('/'), runtime)
        const target = resolve(stage, ...name.split('/')); assertExportPathBeneath(stage, target)
        const output = await runtime.open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | runtime.noFollowFlag, 0o600)
        try {
          let remaining = size
          while (remaining > 0) {
            signal.throwIfAborted(); const chunk = Buffer.alloc(Math.min(64 * 1024, remaining)); const read = await archive.read(chunk, 0, chunk.byteLength, offset)
            if (read.bytesRead !== chunk.byteLength) invalid(); await writeAll(output, chunk); offset += chunk.byteLength; remaining -= chunk.byteLength
          }
          await output.sync()
        } finally { await output.close() }
      } else invalid()
      offset += (BLOCK - size % BLOCK) % BLOCK
    }
    if (files < 1 || !terminated) invalid()
    const archiveAfter = await archive.stat()
    if (archiveBefore.dev !== archiveAfter.dev || archiveBefore.ino !== archiveAfter.ino || archiveBefore.size !== archiveAfter.size || archiveBefore.mtimeMs !== archiveAfter.mtimeMs) throw new BuilderSupervisorError('ARTIFACT_CHANGED_DURING_STAGE')
    return { files, bytes }
  } finally { await archive.close() }
}

async function secureDirectory(root: string, name: string, runtime: ExportRuntime): Promise<void> {
  let current = root
  for (const part of name.split('/')) {
    current = resolve(current, part); assertExportPathBeneath(root, current)
    try {
      const stat = await runtime.lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) invalid()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await runtime.mkdir(current, { mode: 0o700 })
    }
  }
}

async function readPublished(path: string, root: string, buildRef: string, runtime: ExportRuntime): Promise<ExportedArtifact | undefined> {
  try {
    assertExportPathBeneath(root, path); const stat = await runtime.lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink()) invalid()
    const manifestPath = resolve(path, '.dz23-artifact.json'); const handle = await runtime.open(manifestPath, constants.O_RDONLY | runtime.noFollowFlag)
    try {
      const value = JSON.parse(await handle.readFile('utf8')) as Record<string, unknown>
      if (value.build_ref !== buildRef || value.relative_path !== `exports/${buildRef}` || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256) || !Number.isSafeInteger(value.files) || Number(value.files) < 1 || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0) invalid()
      const verified = await verifyPublishedTree(path, runtime)
      if (verified.sha256 !== value.sha256 || verified.files !== value.files || verified.bytes !== value.bytes) invalid()
      return { relative_path: value.relative_path, sha256: value.sha256, files: Number(value.files), bytes: Number(value.bytes) } as ExportedArtifact
    } finally { await handle.close() }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}

async function assertOwnedDirectory(path: string, runtime: ExportRuntime): Promise<void> {
  if (await runtime.realpath(path) !== path) invalid(); const stat = await runtime.lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) invalid()
  if (runtime.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || (runtime.uid !== undefined && stat.uid !== runtime.uid))) invalid()
}
async function assertManagedArchive(path: string, entry: Pick<Dirent, 'isFile' | 'isSymbolicLink'>, runtime: ExportRuntime): Promise<void> { const stat = await runtime.lstat(path); if (!entry.isFile() || entry.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || await runtime.realpath(path) !== path) invalid() }
async function prepareExportDirectories(root: string, runtime: ExportRuntime): Promise<void> { await runtime.mkdir(root, { recursive: true, mode: 0o700 }); await assertOwnedDirectory(root, runtime); const parent = resolve(root, 'exports'); await runtime.mkdir(parent, { recursive: true, mode: 0o700 }); await assertOwnedDirectory(parent, runtime) }
async function hashFile(handle: FileHandle, size: number, signal: AbortSignal): Promise<string> { const hash = createHash('sha256'); let offset = 0; const chunk = Buffer.allocUnsafe(64 * 1024); while (offset < size) { signal.throwIfAborted(); const read = await handle.read(chunk, 0, Math.min(chunk.byteLength, size - offset), offset); if (read.bytesRead === 0) invalid(); hash.update(chunk.subarray(0, read.bytesRead)); offset += read.bytesRead } return hash.digest('hex') }
async function measuredDirectoryBytes(path: string, maximum: number, signal: AbortSignal, runtime: ExportRuntime): Promise<number> {
  let total = 0
  async function walk(directory: string): Promise<void> {
    for (const entry of await runtime.readdir(directory, { withFileTypes: true })) {
      signal.throwIfAborted(); const child = resolve(directory, entry.name); assertExportPathBeneath(path, child)
      const stat = await runtime.lstat(child)
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) invalid()
      if (entry.isDirectory() && stat.isDirectory()) await walk(child)
      else if (entry.isFile() && stat.isFile() && stat.nlink === 1) { total += stat.size; if (total > maximum) return }
      else invalid()
    }
  }
  await walk(path); return total
}
async function verifyPublishedTree(path: string, runtime: ExportRuntime): Promise<{ readonly sha256: string; readonly files: number; readonly bytes: number }> {
  const names: string[] = []; const folded = new Set<string>()
  async function collect(directory: string, prefix: string): Promise<void> {
    for (const entry of (await runtime.readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      if (prefix === '' && entry.name === '.dz23-artifact.json') continue
      const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`; const child = resolve(directory, entry.name); assertExportPathBeneath(path, child)
      const stat = await runtime.lstat(child); if (entry.isSymbolicLink() || stat.isSymbolicLink()) invalid()
      if (entry.isDirectory() && stat.isDirectory()) { if (!allowedExportPath(name, true)) invalid(); await collect(child, name) }
      else if (entry.isFile() && stat.isFile() && stat.nlink === 1) { if (!allowedExportPath(name, false) || folded.has(name.toLowerCase())) invalid(); folded.add(name.toLowerCase()); names.push(name) }
      else invalid()
    }
  }
  await collect(path, '')
  const hash = createHash('sha256'); let bytes = 0
  for (const name of names.sort()) {
    const handle = await runtime.open(resolve(path, ...name.split('/')), constants.O_RDONLY | runtime.noFollowFlag)
    try {
      const stat = await handle.stat(); if (!stat.isFile() || stat.nlink !== 1) invalid(); bytes += stat.size; hash.update(name).update('\0')
      let position = 0; const chunk = Buffer.allocUnsafe(64 * 1024)
      while (position < stat.size) { const read = await handle.read(chunk, 0, Math.min(chunk.byteLength, stat.size - position), position); if (read.bytesRead === 0) invalid(); hash.update(chunk.subarray(0, read.bytesRead)); position += read.bytesRead }
      const after = await handle.stat(); if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) invalid(); hash.update('\0')
    } finally { await handle.close() }
  }
  if (names.length < 1) invalid(); return { sha256: hash.digest('hex'), files: names.length, bytes }
}
function normalizeTarName(value: string): string | undefined {
  const name = value.replace(/^\.\//u, '').replace(/\/$/u, '')
  if (name === '' || name === '.') return undefined
  if (name.startsWith('/') || name.includes('\\') || name.includes('\0') || name.split('/').some(part => part === '' || part === '.' || part === '..')) invalid()
  return name
}
function allowedExportPath(name: string, directory: boolean): boolean {
  if (directory && (name === '.next' || name === 'evidence')) return true
  if (name === '.next/standalone' || name.startsWith('.next/standalone/')) return directory || name !== '.next/standalone'
  if (name === '.next/static' || name.startsWith('.next/static/')) return directory || name !== '.next/static'
  if (name === 'public' || name.startsWith('public/')) return directory || name !== 'public'
  return !directory && name === 'evidence/appspec-report.json'
}
async function assertRequiredExport(stage: string, runtime: ExportRuntime): Promise<void> {
  const required = [
    [resolve(stage, '.next', 'standalone', 'server.js'), 'file'],
    [resolve(stage, '.next', 'static'), 'directory'],
    [resolve(stage, 'evidence', 'appspec-report.json'), 'file'],
  ] as const
  for (const [path, kind] of required) {
    const stat = await runtime.lstat(path).catch(() => undefined)
    if (stat === undefined || stat.isSymbolicLink() || (kind === 'file' ? !stat.isFile() : !stat.isDirectory())) invalid()
  }
}
function verifyChecksum(header: Buffer): void {
  const expected = parseOctal(header.subarray(148, 156)); const copy = Buffer.from(header); copy.fill(0x20, 148, 156)
  if (copy.reduce((sum, byte) => sum + byte, 0) !== expected) invalid()
}
function parseOctal(value: Buffer): number { const text = cstring(value).trim(); if (!/^[0-7]+$/u.test(text)) invalid(); return Number.parseInt(text, 8) }
function cstring(value: Buffer): string { const zero = value.indexOf(0); return value.subarray(0, zero < 0 ? value.length : zero).toString('utf8') }
export function assertExportPathBeneath(root: string, path: string): void { if (path === root || !path.startsWith(root + sep)) invalid() }
async function writeAll(handle: Awaited<ReturnType<typeof open>>, value: Buffer): Promise<void> { let offset = 0; while (offset < value.byteLength) { const written = await handle.write(value, offset, value.byteLength - offset); if (written.bytesWritten === 0) invalid(); offset += written.bytesWritten } }
function invalid(): never { throw new BuilderSupervisorError('EXPORT_INVALID') }
async function syncDirectory(path: string, runtime: ExportRuntime): Promise<void> { if (runtime.platform === 'win32') return; const handle = await runtime.open(path, constants.O_RDONLY); try { await handle.sync() } finally { await handle.close() } }
