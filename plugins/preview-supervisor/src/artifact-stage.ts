import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { posix, resolve, sep } from 'node:path'

const MAX_FILES = 20_000
// The archive is currently materialized once in file buffers and once in the
// final tar buffer. Keep the accepted payload comfortably below the 512 MiB
// supervisor cgroup until the Docker upload becomes fully streaming.
export const MAX_PREVIEW_SOURCE_BYTES = 160 * 1024 * 1024
export const MAX_PREVIEW_RUNTIME_BYTES = 128 * 1024 * 1024

export interface VerifiedRuntimeArchive {
  readonly archive: Buffer
  readonly sourceSha256: string
  readonly sourceFiles: number
  readonly runtimeFiles: number
  readonly runtimeBytes: number
}

/** Seeds a private writable child without starting a root or capability-bearing container. */
export function createPreviewDataSeedArchive(): Buffer {
  // The runtime owns this directory. The fixed preview proxy receives only the
  // owner group as a supplementary group and mounts the volume read-only so it
  // can expose captured login codes without gaining write access.
  return Buffer.concat([tarHeader('data/', 0, '5', 0o750), Buffer.alloc(1024)])
}

export async function createVerifiedRuntimeArchive(artifactRoot: string, relativePath: string, expectedSha256: string, signal?: AbortSignal): Promise<VerifiedRuntimeArchive> {
  signal?.throwIfAborted()
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) throw new Error('INVALID_ARTIFACT_HASH')
  const root = await realpath(artifactRoot)
  const source = await realpath(resolve(root, relativePath))
  if (!isInside(root, source)) throw new Error('ARTIFACT_OUTSIDE_ROOT')
  const files = await walk(source, '', signal)
  if (files.length === 0 || files.length > MAX_FILES) throw new Error('ARTIFACT_FILE_LIMIT')
  const caseFolded = new Set<string>()
  const sourceHash = createHash('sha256')
  const runtime: Array<{ readonly name: string; readonly bytes: Buffer }> = []
  let sourceBytes = 0; let runtimeBytes = 0
  for (const relative of files) {
    signal?.throwIfAborted()
    const folded = relative.toLocaleLowerCase('en-US')
    if (caseFolded.has(folded)) throw new Error('ARTIFACT_CASE_COLLISION')
    caseFolded.add(folded)
    const absolute = resolve(source, ...relative.split('/'))
    const before = await lstat(absolute)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error('ARTIFACT_UNSAFE_ENTRY')
    const runtimeName = mapRuntimePath(relative)
    sourceBytes += before.size
    if (sourceBytes > MAX_PREVIEW_SOURCE_BYTES) throw new Error('ARTIFACT_SIZE_LIMIT')
    if (runtimeName !== undefined) {
      runtimeBytes += before.size
      if (runtimeBytes > MAX_PREVIEW_RUNTIME_BYTES) throw new Error('RUNTIME_SIZE_LIMIT')
    }
    const bytes = await readFile(absolute)
    signal?.throwIfAborted()
    const after = await lstat(absolute)
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('ARTIFACT_CHANGED_DURING_STAGE')
    sourceHash.update(relative).update('\0').update(bytes).update('\0')
    if (runtimeName !== undefined) {
      runtime.push({ name: runtimeName, bytes })
    }
  }
  const sourceSha256 = sourceHash.digest('hex')
  if (sourceSha256 !== expectedSha256) throw new Error('ARTIFACT_HASH_MISMATCH')
  if (!runtime.some(entry => entry.name === 'server.js')) throw new Error('STANDALONE_SERVER_MISSING')
  runtime.sort((left, right) => left.name.localeCompare(right.name))
  return { archive: tarArchive(runtime), sourceSha256, sourceFiles: files.length, runtimeFiles: runtime.length, runtimeBytes }
}

async function walk(root: string, prefix = '', signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted()
  const entries = await readdir(root, { withFileTypes: true })
  const result: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    signal?.throwIfAborted()
    if (entry.isSymbolicLink()) throw new Error('ARTIFACT_SYMLINK')
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const absolute = resolve(root, entry.name)
    if (entry.isDirectory()) result.push(...await walk(absolute, relative, signal))
    else if (entry.isFile()) result.push(relative)
    else throw new Error('ARTIFACT_UNSAFE_ENTRY')
    if (result.length > MAX_FILES) throw new Error('ARTIFACT_FILE_LIMIT')
  }
  return result
}

function mapRuntimePath(relative: string): string | undefined {
  const standalone = '.next/standalone/'
  if (relative.startsWith(standalone)) return safeTarPath(relative.slice(standalone.length))
  if (relative.startsWith('.next/static/')) return safeTarPath(relative)
  if (relative.startsWith('public/')) return safeTarPath(relative)
  return undefined
}

function tarArchive(files: readonly { readonly name: string; readonly bytes: Buffer }[]): Buffer {
  const directories = new Set<string>()
  for (const file of files) {
    let current = posix.dirname(file.name)
    while (current !== '.') { directories.add(`${current}/`); current = posix.dirname(current) }
  }
  const chunks: Buffer[] = []
  for (const directory of [...directories].sort()) chunks.push(tarHeader(directory, 0, '5'))
  for (const file of files) {
    chunks.push(tarHeader(file.name, file.bytes.byteLength, '0'), file.bytes)
    const padding = (512 - (file.bytes.byteLength % 512)) % 512
    if (padding > 0) chunks.push(Buffer.alloc(padding))
  }
  chunks.push(Buffer.alloc(1024))
  return Buffer.concat(chunks)
}

function tarHeader(name: string, size: number, type: '0' | '5', mode = type === '5' ? 0o555 : 0o444): Buffer {
  const path = splitTarPath(name)
  const header = Buffer.alloc(512)
  writeText(header, 0, 100, path.name)
  writeOctal(header, 100, 8, mode)
  writeOctal(header, 108, 8, 10001); writeOctal(header, 116, 8, 10001)
  writeOctal(header, 124, 12, size); writeOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156); header[156] = type.charCodeAt(0)
  writeText(header, 257, 6, 'ustar'); writeText(header, 263, 2, '00')
  writeText(header, 345, 155, path.prefix)
  writeOctal(header, 148, 8, header.reduce((sum, value) => sum + value, 0))
  return header
}

function splitTarPath(value: string): { readonly name: string; readonly prefix: string } {
  const bytes = Buffer.byteLength(value)
  if (bytes <= 100) return { name: value, prefix: '' }
  for (let at = value.lastIndexOf('/'); at > 0; at = value.lastIndexOf('/', at - 1)) {
    const prefix = value.slice(0, at); const name = value.slice(at + 1)
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix }
  }
  throw new Error('ARTIFACT_PATH_TOO_LONG')
}

function writeText(buffer: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, 'utf8'); if (bytes.byteLength > length) throw new Error('TAR_FIELD_TOO_LONG'); bytes.copy(buffer, offset)
}
function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, '0'); if (text.length >= length) throw new Error('TAR_NUMBER_TOO_LARGE')
  writeText(buffer, offset, length, `${text}\0`)
}
function safeTarPath(value: string): string {
  if (value === '' || value.startsWith('/') || value.includes('\\') || value.split('/').some(part => part === '' || part === '.' || part === '..')) throw new Error('ARTIFACT_UNSAFE_PATH')
  return value
}
function isInside(root: string, candidate: string): boolean { return candidate.startsWith(`${root}${sep}`) }
