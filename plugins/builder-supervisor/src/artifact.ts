import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { posix, resolve, sep } from 'node:path'
import { BuilderSupervisorError } from './model.js'

const MAX_FILES = 20_000
const MAX_BYTES = 256 * 1024 * 1024

export interface VerifiedBuildArtifact {
  readonly archive: Buffer
  readonly sourceDirectory: string
  readonly sha256: string
  readonly files: number
  readonly bytes: number
}

export async function createVerifiedBuildArchive(
  artifactRoot: string,
  relativePath: string,
  expectedSha256: string,
  signal?: AbortSignal,
): Promise<VerifiedBuildArtifact> {
  signal?.throwIfAborted()
  const root = await realpath(artifactRoot)
  await assertNoSymlinkBeneath(root, relativePath)
  const source = await realpath(resolve(root, ...relativePath.split('/')))
  if (!inside(root, source)) throw new BuilderSupervisorError('ARTIFACT_OUTSIDE_ROOT')
  const sourceBefore = await lstat(source)
  if (!sourceBefore.isDirectory() || sourceBefore.isSymbolicLink()) throw new BuilderSupervisorError('ARTIFACT_UNSAFE_ENTRY')
  const paths = await walk(source, '', signal)
  if (paths.length === 0 || paths.length > MAX_FILES) throw new BuilderSupervisorError('ARTIFACT_UNSAFE_ENTRY')
  const folded = new Set<string>()
  const hash = createHash('sha256')
  const files: Array<{ readonly name: string; readonly bytes: Buffer }> = []
  let total = 0
  for (const name of paths) {
    signal?.throwIfAborted()
    const normalized = name.toLocaleLowerCase('en-US')
    if (folded.has(normalized)) throw new BuilderSupervisorError('ARTIFACT_UNSAFE_ENTRY')
    folded.add(normalized)
    const path = resolve(source, ...name.split('/'))
    const handle = await open(path, constants.O_RDONLY | noFollow())
    let bytes: Buffer
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new BuilderSupervisorError('ARTIFACT_UNSAFE_ENTRY')
      total += before.size
      if (total > MAX_BYTES) throw new BuilderSupervisorError('ARTIFACT_UNSAFE_ENTRY')
      bytes = await handle.readFile()
      const after = await handle.stat()
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new BuilderSupervisorError('ARTIFACT_CHANGED_DURING_STAGE')
    } finally { await handle.close() }
    hash.update(name).update('\0').update(bytes).update('\0')
    files.push({ name, bytes })
  }
  const sourceAfter = await lstat(source)
  if (sourceBefore.dev !== sourceAfter.dev || sourceBefore.ino !== sourceAfter.ino || sourceBefore.mtimeMs !== sourceAfter.mtimeMs) throw new BuilderSupervisorError('ARTIFACT_CHANGED_DURING_STAGE')
  const sha256 = hash.digest('hex')
  if (sha256 !== expectedSha256) throw new BuilderSupervisorError('ARTIFACT_HASH_MISMATCH')
  return { archive: tarArchive(files), sourceDirectory: source, sha256, files: files.length, bytes: total }
}

async function walk(root: string, prefix: string, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted()
  const before = await lstat(root)
  if (!before.isDirectory() || before.isSymbolicLink() || await realpath(root) !== root) throw new BuilderSupervisorError('ARTIFACT_UNSAFE_ENTRY')
  const entries = await readdir(root, { withFileTypes: true })
  const result: string[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    signal?.throwIfAborted()
    if (entry.isSymbolicLink()) throw new BuilderSupervisorError('ARTIFACT_UNSAFE_ENTRY')
    const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (!safePath(name)) throw new BuilderSupervisorError('ARTIFACT_UNSAFE_ENTRY')
    const path = resolve(root, entry.name)
    if (entry.isDirectory()) result.push(...await walk(path, name, signal))
    else if (entry.isFile()) result.push(name)
    else throw new BuilderSupervisorError('ARTIFACT_UNSAFE_ENTRY')
    if (result.length > MAX_FILES) throw new BuilderSupervisorError('ARTIFACT_UNSAFE_ENTRY')
  }
  const after = await lstat(root)
  if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs) throw new BuilderSupervisorError('ARTIFACT_CHANGED_DURING_STAGE')
  return result
}

function tarArchive(files: readonly { readonly name: string; readonly bytes: Buffer }[]): Buffer {
  const directories = new Set<string>()
  for (const file of files) {
    let current = posix.dirname(file.name)
    while (current !== '.') { directories.add(`${current}/`); current = posix.dirname(current) }
  }
  const chunks: Buffer[] = []
  for (const directory of [...directories].sort()) chunks.push(tarHeader(directory, 0, '5'))
  for (const file of [...files].sort((left, right) => left.name.localeCompare(right.name))) {
    chunks.push(tarHeader(file.name, file.bytes.byteLength, '0'), file.bytes)
    const padding = (512 - file.bytes.byteLength % 512) % 512
    if (padding > 0) chunks.push(Buffer.alloc(padding))
  }
  chunks.push(Buffer.alloc(1_024))
  return Buffer.concat(chunks)
}

function tarHeader(name: string, size: number, type: '0' | '5'): Buffer {
  const split = splitTarPath(name)
  const header = Buffer.alloc(512)
  text(header, 0, 100, split.name)
  octal(header, 100, 8, type === '5' ? 0o755 : 0o644)
  octal(header, 108, 8, 10_001); octal(header, 116, 8, 10_001)
  octal(header, 124, 12, size); octal(header, 136, 12, 0)
  header.fill(0x20, 148, 156); header[156] = type.charCodeAt(0)
  text(header, 257, 6, 'ustar'); text(header, 263, 2, '00'); text(header, 345, 155, split.prefix)
  octal(header, 148, 8, header.reduce((sum, byte) => sum + byte, 0))
  return header
}

function splitTarPath(value: string): { readonly name: string; readonly prefix: string } {
  if (Buffer.byteLength(value) <= 100) return { name: value, prefix: '' }
  for (let at = value.lastIndexOf('/'); at > 0; at = value.lastIndexOf('/', at - 1)) {
    const prefix = value.slice(0, at); const name = value.slice(at + 1)
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix }
  }
  throw new BuilderSupervisorError('ARTIFACT_UNSAFE_ENTRY')
}

function text(target: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.byteLength > length) throw new BuilderSupervisorError('ARTIFACT_UNSAFE_ENTRY')
  bytes.copy(target, offset)
}

function octal(target: Buffer, offset: number, length: number, value: number): void {
  const valueText = `${value.toString(8).padStart(length - 1, '0')}\0`
  text(target, offset, length, valueText)
}

function safePath(value: string): boolean {
  return value !== '' && !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

function inside(root: string, candidate: string): boolean { return candidate.startsWith(`${root}${sep}`) }
async function assertNoSymlinkBeneath(root: string, relativePath: string): Promise<void> {
  let current = root
  for (const part of relativePath.split('/')) {
    current = resolve(current, part)
    const stat = await lstat(current)
    if (stat.isSymbolicLink()) throw new BuilderSupervisorError('ARTIFACT_UNSAFE_ENTRY')
  }
}
function noFollow(): number { return process.platform === 'linux' ? constants.O_NOFOLLOW : 0 }
