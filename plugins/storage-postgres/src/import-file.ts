import { constants } from 'node:fs'
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
  assertImportLimits(limits)
  const parent = await pinParent(path)
  const noFollow = constants.O_NOFOLLOW ?? 0
  let file: FileHandle
  try {
    const target = pinnedChildPath(parent.directory, parent.name)
    const before = await lstat(target)
    if (before.isSymbolicLink() || !before.isFile()) throw new Error('storage import input is not a regular file')
    file = await open(target, constants.O_RDONLY | noFollow)
  } catch (error) {
    await parent.directory.handle.close().catch(() => undefined)
    throw error
  }
  try {
    const stats = await file.stat({ bigint: true })
    if (!stats.isFile()) throw new Error('storage import input is not a regular file')
    if (stats.size > BigInt(limits.maxBytes)) throw new Error(`storage import exceeds the ${String(limits.maxBytes)} byte limit`)
    await assertPinnedDirectory(parent.directory)

    const chunks: Buffer[] = []
    const block = Buffer.allocUnsafe(1024 * 1024)
    const scanner = new JsonDepthScanner(limits.maxDepth)
    let bytes = 0
    for (;;) {
      const read = await file.read(block, 0, block.byteLength, null)
      if (read.bytesRead === 0) break
      bytes += read.bytesRead
      if (bytes > limits.maxBytes) throw new Error(`storage import exceeds the ${String(limits.maxBytes)} byte limit`)
      const chunk = Buffer.from(block.subarray(0, read.bytesRead))
      scanner.write(chunk)
      chunks.push(chunk)
    }
    scanner.end()
    await assertPinnedDirectory(parent.directory)
    const parsed: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
    validateBundle(parsed, limits)
    return parsed
  } finally {
    await file.close().catch(() => undefined)
    await parent.directory.handle.close().catch(() => undefined)
  }
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
