import { constants } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { createHash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { lstat, open } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import {
  DEFAULT_STORAGE_BUNDLE_LIMITS,
  validateBundle,
  type StorageBundleLimits,
  type StorageExportBundle,
} from './bundle.js'
import { assertPinnedDirectory, pinnedChildPath, pinParent } from './safe-path.js'

export const IMPORT_MAX_BYTES_DEFAULT = 512 * 1024 * 1024

export interface StorageImportLimits extends StorageBundleLimits {
  maxBytes: number
}

export const DEFAULT_STORAGE_IMPORT_LIMITS: Readonly<StorageImportLimits> = Object.freeze({
  ...DEFAULT_STORAGE_BUNDLE_LIMITS,
  maxBytes: IMPORT_MAX_BYTES_DEFAULT,
})

export interface VerifiedStorageBundle {
  readonly bundle: StorageExportBundle
  readonly inputSha256: string
  readonly bytes: number
  readonly file: string
}

/**
 * Read an import through one descriptor. Size and syntactic nesting are
 * enforced while bytes arrive, before JSON.parse can allocate an attacker-
 * controlled object graph. The strict bundle schema and semantic quotas run
 * before the caller is allowed to connect to or mutate PostgreSQL.
 */
export async function readStorageBundleFile(
  path: string,
  limits: Readonly<StorageImportLimits> = DEFAULT_STORAGE_IMPORT_LIMITS,
): Promise<StorageExportBundle> {
  return (await readBundleSnapshot(path, limits)).bundle
}

/**
 * Verification and parsing share one descriptor. The pathname is never opened
 * once for the digest and again for the restore, so a replacement cannot turn
 * a verified backup into a different, still-valid bundle.
 */
export async function readVerifiedStorageBundleFile(
  path: string,
  limits: Readonly<StorageImportLimits> = DEFAULT_STORAGE_IMPORT_LIMITS,
  signal?: AbortSignal,
): Promise<VerifiedStorageBundle> {
  return { ...(await readBundleSnapshot(path, limits, signal, true)), file: path }
}

async function readBundleSnapshot(
  path: string,
  limits: Readonly<StorageImportLimits>,
  signal?: AbortSignal,
  verifySidecar = false,
): Promise<Omit<VerifiedStorageBundle, 'file'>> {
  assertImportLimits(limits)
  const parent = await pinParent(path)
  const noFollow = constants.O_NOFOLLOW ?? 0
  let file: FileHandle
  let inspected: BigIntStats
  try {
    const target = pinnedChildPath(parent.directory, parent.name)
    inspected = await lstat(target, { bigint: true })
    if (inspected.isSymbolicLink() || !inspected.isFile()) throw new Error('storage import input is not a regular file')
    file = await open(target, constants.O_RDONLY | noFollow)
  } catch (error) {
    await parent.directory.handle.close().catch(() => undefined)
    throw error
  }
  try {
    const stats = await file.stat({ bigint: true })
    if (!stats.isFile() || stats.nlink !== 1n || stats.dev !== inspected.dev || stats.ino !== inspected.ino) {
      throw new Error('storage import input is not the private regular file that was inspected')
    }
    if (stats.size > BigInt(limits.maxBytes)) throw new Error(`storage import exceeds the ${String(limits.maxBytes)} byte limit`)
    await assertPinnedDirectory(parent.directory)

    const chunks: Buffer[] = []
    const block = Buffer.allocUnsafe(1024 * 1024)
    const scanner = new JsonDepthScanner(limits.maxDepth)
    const hash = createHash('sha256')
    let bytes = 0
    for (;;) {
      throwIfAborted(signal)
      const read = await file.read(block, 0, block.byteLength, null)
      if (read.bytesRead === 0) break
      bytes += read.bytesRead
      if (bytes > limits.maxBytes) throw new Error(`storage import exceeds the ${String(limits.maxBytes)} byte limit`)
      const chunk = Buffer.from(block.subarray(0, read.bytesRead))
      hash.update(chunk)
      scanner.write(chunk)
      chunks.push(chunk)
    }
    scanner.end()
    const after = await file.stat({ bigint: true })
    if (after.dev !== stats.dev || after.ino !== stats.ino || after.size !== stats.size || after.mtimeNs !== stats.mtimeNs) {
      throw new Error('storage import input changed while it was being verified')
    }
    await assertPinnedDirectory(parent.directory)
    const parsed: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
    validateBundle(parsed, limits)
    throwIfAborted(signal)
    const inputSha256 = hash.digest('hex')
    if (verifySidecar) {
      const sidecarPath = pinnedChildPath(parent.directory, `${parent.name}.sha256`)
      const inspectedSidecar = await lstat(sidecarPath, { bigint: true })
      if (inspectedSidecar.isSymbolicLink() || !inspectedSidecar.isFile() || inspectedSidecar.nlink !== 1n) {
        throw new Error('storage import sidecar is invalid')
      }
      const sidecar = await open(sidecarPath, constants.O_RDONLY | noFollow)
      try {
        const sidecarStats = await sidecar.stat({ bigint: true })
        if (!sidecarStats.isFile() || sidecarStats.nlink !== 1n || sidecarStats.dev !== inspectedSidecar.dev || sidecarStats.ino !== inspectedSidecar.ino || sidecarStats.size > 1024n) {
          throw new Error('storage import sidecar is invalid')
        }
        const contents = await sidecar.readFile('utf8')
        const sidecarAfter = await sidecar.stat({ bigint: true })
        if (sidecarAfter.dev !== sidecarStats.dev || sidecarAfter.ino !== sidecarStats.ino || sidecarAfter.size !== sidecarStats.size || sidecarAfter.mtimeNs !== sidecarStats.mtimeNs) {
          throw new Error('storage import sidecar changed while it was being verified')
        }
        const expected = contents.trim().split(/\s+/u)[0]
        if (expected !== inputSha256) throw new Error('A cópia não corresponde ao arquivo de verificação.')
      } finally {
        await sidecar.close().catch(() => undefined)
      }
      await assertPinnedDirectory(parent.directory)
      throwIfAborted(signal)
    }
    return { bundle: parsed, bytes, inputSha256 }
  } finally {
    await file.close().catch(() => undefined)
    await parent.directory.handle.close().catch(() => undefined)
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason instanceof Error ? signal.reason : new Error('Operação cancelada.')
}

class JsonDepthScanner {
  private readonly decoder = new StringDecoder('utf8')
  private depth = 0
  private inString = false
  private escaped = false

  constructor(private readonly maxDepth: number) {}

  write(chunk: Buffer): void { this.scan(this.decoder.write(chunk)) }

  end(): void {
    this.scan(this.decoder.end())
    if (this.depth !== 0 || this.inString) throw new Error('storage import contains incomplete JSON')
  }

  private scan(text: string): void {
    for (const character of text) {
      if (this.inString) {
        if (this.escaped) this.escaped = false
        else if (character === '\\') this.escaped = true
        else if (character === '"') this.inString = false
        continue
      }
      if (character === '"') { this.inString = true; continue }
      if (character === '{' || character === '[') {
        this.depth += 1
        if (this.depth > this.maxDepth) throw new Error(`storage import exceeds the ${String(this.maxDepth)} nesting-depth limit`)
      } else if (character === '}' || character === ']') {
        this.depth -= 1
        if (this.depth < 0) throw new Error('storage import contains invalid JSON nesting')
      }
    }
  }
}

function assertImportLimits(limits: Readonly<StorageImportLimits>): void {
  for (const [name, limit] of Object.entries(limits)) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`storage import ${name} must be a positive safe integer`)
  }
}
