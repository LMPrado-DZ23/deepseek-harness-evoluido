import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import type { ExportedArtifact } from './model.js'
import { BuilderSupervisorError } from './model.js'

const BLOCK = 512
const MAX_FILES = 20_000
const MAX_BYTES = 512 * 1024 * 1024

export async function publishValidatedDockerArchive(exportRoot: string, buildRef: string, archivePath: string, signal: AbortSignal): Promise<ExportedArtifact> {
  const root = resolve(exportRoot)
  await mkdir(root, { recursive: true, mode: 0o700 }); await assertOwnedDirectory(root)
  const final = resolve(root, 'exports', buildRef)
  const parent = dirname(final); await mkdir(parent, { recursive: true, mode: 0o700 }); await assertOwnedDirectory(parent)
  const existing = await readPublished(final, root, buildRef)
  if (existing !== undefined) return existing
  const stage = resolve(parent, `.stage-${buildRef}-${randomBytes(8).toString('hex')}`)
  await mkdir(stage, { mode: 0o700 })
  try {
    const result = await extractTar(archivePath, stage, signal)
    await assertRequiredExport(stage)
    const published: ExportedArtifact = { relative_path: `exports/${buildRef}`, ...result }
    await writeFile(resolve(stage, '.dz23-artifact.json'), `${JSON.stringify({ build_ref: buildRef, ...published })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(stage, final)
    return published
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined)
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new BuilderSupervisorError('EXPORT_INVALID')
    throw error
  }
}

export async function enforceExportRetention(exportRoot: string, currentBuildRef: string, maximumExports: number, maximumBytes: number, signal: AbortSignal): Promise<void> {
  if (!Number.isSafeInteger(maximumExports) || maximumExports < 1 || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error('INVALID_EXPORT_RETENTION')
  const root = resolve(exportRoot); const parent = resolve(root, 'exports'); await assertOwnedDirectory(root); await assertOwnedDirectory(parent)
  const rows: Array<{ readonly path: string; readonly buildRef: string; readonly bytes: number; readonly mtimeMs: number }> = []
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    signal.throwIfAborted()
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^build_[a-f0-9]{32}$/u.test(entry.name)) invalid()
    const path = resolve(parent, entry.name); assertBeneath(root, path)
    const stat = await lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) invalid()
    if (await readPublished(path, root, entry.name) === undefined) invalid()
    rows.push({ path, buildRef: entry.name, bytes: await measuredDirectoryBytes(path, maximumBytes, signal), mtimeMs: stat.mtimeMs })
  }
  const current = rows.find(row => row.buildRef === currentBuildRef)
  if (current === undefined || current.bytes > maximumBytes) throw new BuilderSupervisorError('CAPACITY_EXCEEDED')
  let total = rows.reduce((sum, row) => sum + row.bytes, 0); let count = rows.length
  for (const row of rows.filter(item => item.buildRef !== currentBuildRef).sort((left, right) => left.mtimeMs - right.mtimeMs || left.buildRef.localeCompare(right.buildRef))) {
    if (count <= maximumExports && total <= maximumBytes) break
    const stat = await lstat(row.path); if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(row.path) !== row.path) invalid()
    await rm(row.path, { recursive: true }); total -= row.bytes; count -= 1
  }
  if (count > maximumExports || total > maximumBytes) throw new BuilderSupervisorError('CAPACITY_EXCEEDED')
}

async function extractTar(archivePath: string, stage: string, signal: AbortSignal): Promise<Omit<ExportedArtifact, 'relative_path'>> {
  const archive = await open(archivePath, constants.O_RDONLY | noFollow())
  const tree = createHash('sha256'); const names = new Set<string>(); let offset = 0; let files = 0; let bytes = 0; let terminated = false
  try {
    const archiveBefore = await archive.stat(); if (!archiveBefore.isFile() || archiveBefore.nlink !== 1) invalid()
    while (offset + BLOCK <= archiveBefore.size) {
      signal.throwIfAborted()
      const header = Buffer.alloc(BLOCK); if ((await archive.read(header, 0, BLOCK, offset)).bytesRead !== BLOCK) invalid(); offset += BLOCK
      if (header.every(byte => byte === 0)) {
        const second = Buffer.alloc(BLOCK); if ((await archive.read(second, 0, BLOCK, offset)).bytesRead !== BLOCK || !second.every(byte => byte === 0)) invalid(); offset += BLOCK
        while (offset < archiveBefore.size) { const trailing = Buffer.alloc(Math.min(64 * 1024, archiveBefore.size - offset)); if ((await archive.read(trailing, 0, trailing.byteLength, offset)).bytesRead !== trailing.byteLength || !trailing.every(byte => byte === 0)) invalid(); offset += trailing.byteLength }
        terminated = true; break
      }
      verifyChecksum(header)
      const rawName = `${cstring(header.subarray(345, 500))}${cstring(header.subarray(345, 500)) === '' ? '' : '/'}${cstring(header.subarray(0, 100))}`
      const name = normalizeTarName(rawName); const size = parseOctal(header.subarray(124, 136)); const type = String.fromCharCode(header[156] || 48)
      if (name === undefined) { if (type !== '5' || size !== 0) invalid() }
      else if (type === '5') { if (size !== 0 || !allowedExportPath(name, true)) invalid(); await secureDirectory(stage, name) }
      else if (type === '0') {
        if (!allowedExportPath(name, false)) invalid()
        if (names.has(name.toLowerCase())) invalid(); names.add(name.toLowerCase()); files += 1; bytes += size
        if (files > MAX_FILES || bytes > MAX_BYTES || size > MAX_BYTES) invalid()
        const parent = dirname(resolve(stage, ...name.split('/'))); await secureDirectory(stage, relative(stage, parent).split(sep).join('/'))
        const target = resolve(stage, ...name.split('/')); assertBeneath(stage, target)
        const output = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow(), 0o600)
        try {
          tree.update(name).update('\0'); let remaining = size
          while (remaining > 0) {
            signal.throwIfAborted(); const chunk = Buffer.alloc(Math.min(64 * 1024, remaining)); const read = await archive.read(chunk, 0, chunk.byteLength, offset)
            if (read.bytesRead !== chunk.byteLength) invalid(); await writeAll(output, chunk); tree.update(chunk); offset += chunk.byteLength; remaining -= chunk.byteLength
          }
          tree.update('\0'); await output.sync()
        } finally { await output.close() }
      } else invalid()
      offset += (BLOCK - size % BLOCK) % BLOCK
    }
    if (files < 1 || !terminated) invalid()
    const archiveAfter = await archive.stat()
    if (archiveBefore.dev !== archiveAfter.dev || archiveBefore.ino !== archiveAfter.ino || archiveBefore.size !== archiveAfter.size || archiveBefore.mtimeMs !== archiveAfter.mtimeMs) throw new BuilderSupervisorError('ARTIFACT_CHANGED_DURING_STAGE')
    return { sha256: tree.digest('hex'), files, bytes }
  } finally { await archive.close() }
}

async function secureDirectory(root: string, name: string): Promise<void> {
  let current = root
  for (const part of name === '' || name === '.' ? [] : name.split('/')) {
    if (part === '' || part === '.' || part === '..') invalid()
    current = resolve(current, part); assertBeneath(root, current)
    try {
      const stat = await lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) invalid()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await mkdir(current, { mode: 0o700 })
    }
  }
}

async function readPublished(path: string, root: string, buildRef: string): Promise<ExportedArtifact | undefined> {
  try {
    assertBeneath(root, path); const stat = await lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink()) invalid()
    const manifestPath = resolve(path, '.dz23-artifact.json'); const handle = await open(manifestPath, constants.O_RDONLY | noFollow())
    try {
      const value = JSON.parse(await handle.readFile('utf8')) as Record<string, unknown>
      if (value.build_ref !== buildRef || value.relative_path !== `exports/${buildRef}` || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256) || !Number.isSafeInteger(value.files) || Number(value.files) < 1 || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0) invalid()
      const verified = await verifyPublishedTree(path)
      if (verified.sha256 !== value.sha256 || verified.files !== value.files || verified.bytes !== value.bytes) invalid()
      return { relative_path: value.relative_path, sha256: value.sha256, files: Number(value.files), bytes: Number(value.bytes) } as ExportedArtifact
    } finally { await handle.close() }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}

async function assertOwnedDirectory(path: string): Promise<void> {
  if (await realpath(path) !== path) invalid(); const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) invalid()
  if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid()))) invalid()
}
async function measuredDirectoryBytes(path: string, maximum: number, signal: AbortSignal): Promise<number> {
  let total = 0
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      signal.throwIfAborted(); const child = resolve(directory, entry.name); assertBeneath(path, child)
      const stat = await lstat(child)
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) invalid()
      if (entry.isDirectory() && stat.isDirectory()) await walk(child)
      else if (entry.isFile() && stat.isFile() && stat.nlink === 1) { total += stat.size; if (total > maximum) return }
      else invalid()
    }
  }
  await walk(path); return total
}
async function verifyPublishedTree(path: string): Promise<{ readonly sha256: string; readonly files: number; readonly bytes: number }> {
  const names: string[] = []; const folded = new Set<string>()
  async function collect(directory: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      if (prefix === '' && entry.name === '.dz23-artifact.json') continue
      const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`; const child = resolve(directory, entry.name); assertBeneath(path, child)
      const stat = await lstat(child); if (entry.isSymbolicLink() || stat.isSymbolicLink()) invalid()
      if (entry.isDirectory() && stat.isDirectory()) { if (!allowedExportPath(name, true)) invalid(); await collect(child, name) }
      else if (entry.isFile() && stat.isFile() && stat.nlink === 1) { if (!allowedExportPath(name, false) || folded.has(name.toLowerCase())) invalid(); folded.add(name.toLowerCase()); names.push(name) }
      else invalid()
    }
  }
  await collect(path, '')
  const hash = createHash('sha256'); let bytes = 0
  for (const name of names.sort()) {
    const handle = await open(resolve(path, ...name.split('/')), constants.O_RDONLY | noFollow())
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
async function assertRequiredExport(stage: string): Promise<void> {
  const required = [
    [resolve(stage, '.next', 'standalone', 'server.js'), 'file'],
    [resolve(stage, '.next', 'static'), 'directory'],
    [resolve(stage, 'evidence', 'appspec-report.json'), 'file'],
  ] as const
  for (const [path, kind] of required) {
    const stat = await lstat(path).catch(() => undefined)
    if (stat === undefined || stat.isSymbolicLink() || (kind === 'file' ? !stat.isFile() : !stat.isDirectory())) invalid()
  }
}
function verifyChecksum(header: Buffer): void {
  const expected = parseOctal(header.subarray(148, 156)); const copy = Buffer.from(header); copy.fill(0x20, 148, 156)
  if (copy.reduce((sum, byte) => sum + byte, 0) !== expected) invalid()
}
function parseOctal(value: Buffer): number { const text = cstring(value).trim(); if (!/^[0-7]+$/u.test(text)) invalid(); const number = Number.parseInt(text, 8); if (!Number.isSafeInteger(number) || number < 0) invalid(); return number }
function cstring(value: Buffer): string { const zero = value.indexOf(0); return value.subarray(0, zero < 0 ? value.length : zero).toString('utf8') }
function assertBeneath(root: string, path: string): void { if (path === root || !path.startsWith(root + sep)) invalid() }
function noFollow(): number { return process.platform === 'linux' ? constants.O_NOFOLLOW : 0 }
async function writeAll(handle: Awaited<ReturnType<typeof open>>, value: Buffer): Promise<void> { let offset = 0; while (offset < value.byteLength) { const written = await handle.write(value, offset, value.byteLength - offset); if (written.bytesWritten === 0) invalid(); offset += written.bytesWritten } }
function invalid(): never { throw new BuilderSupervisorError('EXPORT_INVALID') }
