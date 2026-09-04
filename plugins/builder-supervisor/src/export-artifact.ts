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

async function extractTar(archivePath: string, stage: string, signal: AbortSignal): Promise<Omit<ExportedArtifact, 'relative_path'>> {
  const archive = await open(archivePath, constants.O_RDONLY | noFollow())
  const tree = createHash('sha256'); const names = new Set<string>(); let offset = 0; let files = 0; let bytes = 0
  try {
    const archiveBefore = await archive.stat(); if (!archiveBefore.isFile() || archiveBefore.nlink !== 1) invalid()
    while (offset + BLOCK <= archiveBefore.size) {
      signal.throwIfAborted()
      const header = Buffer.alloc(BLOCK); if ((await archive.read(header, 0, BLOCK, offset)).bytesRead !== BLOCK) invalid(); offset += BLOCK
      if (header.every(byte => byte === 0)) break
      verifyChecksum(header)
      const rawName = `${cstring(header.subarray(345, 500))}${cstring(header.subarray(345, 500)) === '' ? '' : '/'}${cstring(header.subarray(0, 100))}`
      const name = normalizeTarName(rawName); const size = parseOctal(header.subarray(124, 136)); const type = String.fromCharCode(header[156] || 48)
      if (name === undefined) { if (type !== '5' || size !== 0) invalid() }
      else if (type === '5') { if (size !== 0) invalid(); await secureDirectory(stage, name) }
      else if (type === '0') {
        if (names.has(name.toLowerCase())) invalid(); names.add(name.toLowerCase()); files += 1; bytes += size
        if (files > MAX_FILES || bytes > MAX_BYTES || size > MAX_BYTES) invalid()
        const parent = dirname(resolve(stage, ...name.split('/'))); await secureDirectory(stage, relative(stage, parent).split(sep).join('/'))
        const target = resolve(stage, ...name.split('/')); assertBeneath(stage, target)
        const output = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow(), 0o600)
        try {
          tree.update(name).update('\0'); let remaining = size
          while (remaining > 0) {
            signal.throwIfAborted(); const chunk = Buffer.alloc(Math.min(64 * 1024, remaining)); const read = await archive.read(chunk, 0, chunk.byteLength, offset)
            if (read.bytesRead !== chunk.byteLength) invalid(); await output.write(chunk); tree.update(chunk); offset += chunk.byteLength; remaining -= chunk.byteLength
          }
          tree.update('\0'); await output.sync()
        } finally { await output.close() }
      } else invalid()
      offset += (BLOCK - size % BLOCK) % BLOCK
    }
    if (files < 1) invalid()
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
      if (value.build_ref !== buildRef || value.relative_path !== `exports/${buildRef}` || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256) || !Number.isSafeInteger(value.files) || !Number.isSafeInteger(value.bytes)) invalid()
      return { relative_path: value.relative_path, sha256: value.sha256, files: Number(value.files), bytes: Number(value.bytes) } as ExportedArtifact
    } finally { await handle.close() }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}

async function assertOwnedDirectory(path: string): Promise<void> {
  if (await realpath(path) !== path) invalid(); const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) invalid()
  if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid()))) invalid()
}
function normalizeTarName(value: string): string | undefined {
  const name = value.replace(/^\.\//u, '').replace(/\/$/u, '')
  if (name === '' || name === '.') return undefined
  if (name.startsWith('/') || name.includes('\\') || name.includes('\0') || name.split('/').some(part => part === '' || part === '.' || part === '..')) invalid()
  return name
}
function verifyChecksum(header: Buffer): void {
  const expected = parseOctal(header.subarray(148, 156)); const copy = Buffer.from(header); copy.fill(0x20, 148, 156)
  if (copy.reduce((sum, byte) => sum + byte, 0) !== expected) invalid()
}
function parseOctal(value: Buffer): number { const text = cstring(value).trim(); if (!/^[0-7]+$/u.test(text)) invalid(); const number = Number.parseInt(text, 8); if (!Number.isSafeInteger(number) || number < 0) invalid(); return number }
function cstring(value: Buffer): string { const zero = value.indexOf(0); return value.subarray(0, zero < 0 ? value.length : zero).toString('utf8') }
function assertBeneath(root: string, path: string): void { if (path === root || !path.startsWith(root + sep)) invalid() }
function noFollow(): number { return process.platform === 'linux' ? constants.O_NOFOLLOW : 0 }
function invalid(): never { throw new BuilderSupervisorError('EXPORT_INVALID') }
