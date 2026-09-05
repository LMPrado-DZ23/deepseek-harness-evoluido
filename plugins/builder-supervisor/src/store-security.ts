import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import { posix } from 'node:path'

export const TEMPLATE_MANIFEST_MAX_BYTES = 2 * 1024 * 1024
export const TEMPLATE_ENTRY_MAX_BYTES = 64 * 1024 * 1024
export const TEMPLATE_STORE_MAX_BYTES = 512 * 1024 * 1024
export const TEMPLATE_STORE_MAX_ENTRIES = 10_000

export type TemplateManifestEntry =
  | { readonly path: string; readonly type: 'directory' }
  | { readonly path: string; readonly type: 'file'; readonly bytes: number; readonly sha256: string }

export interface TemplateStoreManifest {
  readonly version: 1
  readonly template_store_version: string
  readonly tree_sha256: string
  readonly entries: readonly TemplateManifestEntry[]
}

export function parseTemplateStoreManifest(value: unknown): TemplateStoreManifest {
  const record = exactRecord(value, ['version', 'template_store_version', 'tree_sha256', 'entries'])
  if (record.version !== 1 || !isVersion(record.template_store_version) || !isSha256(record.tree_sha256) || !Array.isArray(record.entries)) invalid()
  if (record.entries.length < 1 || record.entries.length > TEMPLATE_STORE_MAX_ENTRIES) invalid()
  const entries = record.entries.map(parseEntry).sort(compareEntries)
  if (new Set(entries.map(entry => entry.path)).size !== entries.length) invalid()
  if (new Set(entries.map(entry => entry.path.toLowerCase())).size !== entries.length) invalid()
  const directories = new Set(entries.filter(entry => entry.type === 'directory').map(entry => entry.path))
  let bytes = 0
  for (const entry of entries) {
    if (entry.type === 'file') {
      bytes = checkedTemplateStoreByteTotal(bytes, entry.bytes)
    }
    assertParentsDeclared(entry, directories)
  }
  const manifest = { version: 1 as const, template_store_version: record.template_store_version, tree_sha256: record.tree_sha256, entries }
  if (computeTemplateTreeSha256(manifest.template_store_version, entries) !== manifest.tree_sha256) invalid()
  return manifest
}

export function checkedTemplateStoreByteTotal(current: number, added: number): number {
  const result = current + added
  if (!Number.isSafeInteger(result) || result > TEMPLATE_STORE_MAX_BYTES) invalid()
  return result
}

export function checkedTemplateStoreEntryCount(count: number): number {
  if (!Number.isSafeInteger(count) || count < 0 || count > TEMPLATE_STORE_MAX_ENTRIES) invalid()
  return count
}

export function computeTemplateTreeSha256(version: string, entries: readonly TemplateManifestEntry[]): string {
  if (!isVersion(version)) invalid()
  const sorted = [...entries].sort(compareEntries)
  const hash = createHash('sha256')
  hash.update('dz23-template-store\0v1\0', 'utf8')
  hash.update(version, 'utf8')
  hash.update('\0', 'utf8')
  for (const entry of sorted) {
    hash.update(entry.type, 'utf8')
    hash.update('\0', 'utf8')
    hash.update(entry.path, 'utf8')
    hash.update('\0', 'utf8')
    if (entry.type === 'file') {
      hash.update(String(entry.bytes), 'utf8')
      hash.update('\0', 'utf8')
      hash.update(entry.sha256, 'utf8')
      hash.update('\0', 'utf8')
    }
  }
  return hash.digest('hex')
}

export function canonicalSourceRoot(value: string): string {
  if (typeof value !== 'string' || !posix.isAbsolute(value) || posix.normalize(value) !== value || value === '/' || value.endsWith('/') || value.includes('\\') || value.includes('\0') || value.includes('://')) invalid()
  return value
}

export function manifestReferencePath(value: string): string {
  if (typeof value !== 'string' || !value.startsWith('file:')) invalid()
  return canonicalSourceRoot(value.slice(5))
}

export function provisionIdentifier(value: string): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value)) invalid()
  return value
}

export function templateVersion(value: string): string {
  if (!isVersion(value)) invalid()
  return value
}

export function sha256Value(value: string): string {
  if (!isSha256(value)) invalid()
  return value
}

export function imageDigestValue(value: string): `sha256:${string}` {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) invalid()
  return value as `sha256:${string}`
}

export function assertSafeStoreStat(stat: Stats, expected: 'directory' | 'file', sealed: boolean): void {
  if (stat.isSymbolicLink() || (expected === 'directory' ? !stat.isDirectory() : !stat.isFile())) invalid()
  if (expected === 'file' && stat.nlink !== 1) invalid()
  const mode = stat.mode & 0o7777
  if (sealed && mode !== (expected === 'directory' ? 0o555 : 0o444)) invalid()
}

export function assertSourceIdentity(opened: Stats, linked: Stats, expected: 'directory' | 'file'): void {
  assertSafeStoreStat(opened, expected, false)
  assertSafeStoreStat(linked, expected, false)
  if (opened.dev !== linked.dev || opened.ino !== linked.ino) invalid()
}

export function assertUnchangedStoreStat(left: Stats, right: Stats, expected: 'directory' | 'file'): void {
  const common = left.dev === right.dev && left.ino === right.ino && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && (left.mode & 0o7777) === (right.mode & 0o7777)
  const fileFields = expected === 'directory' || (left.size === right.size && left.nlink === right.nlink)
  if (!common || !fileFields) invalid()
}

export function isSafeStagingName(value: string): boolean {
  return /^\.staging-[a-f0-9]{32}$/u.test(value) || /^\.orphan-[a-f0-9]{32}$/u.test(value)
}

function parseEntry(value: unknown): TemplateManifestEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid()
  const record = value as Record<string, unknown>
  if (record.type === 'directory') {
    exactKeys(record, ['path', 'type'])
    return { path: templateEntryPath(record.path), type: 'directory' }
  }
  exactKeys(record, ['bytes', 'path', 'sha256', 'type'])
  if (record.type !== 'file' || !Number.isSafeInteger(record.bytes) || (record.bytes as number) < 0 || (record.bytes as number) > TEMPLATE_ENTRY_MAX_BYTES || !isSha256(record.sha256)) invalid()
  return { path: templateEntryPath(record.path), type: 'file', bytes: record.bytes as number, sha256: record.sha256 }
}

export function templateEntryPath(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || Buffer.byteLength(value, 'utf8') > 512 || value.includes('\\') || value.includes('\0') || posix.isAbsolute(value) || posix.normalize(value) !== value || value === '.' || value.endsWith('/') || !/^[A-Za-z0-9_@+().\[\]-]+(?:\/[A-Za-z0-9_@+().\[\]-]+)*$/u.test(value)) invalid()
  if (value.split('/').some(segment => segment === '.' || segment === '..')) invalid()
  return value
}

function assertParentsDeclared(entry: TemplateManifestEntry, directories: ReadonlySet<string>): void {
  let parent = posix.dirname(entry.path)
  while (parent !== '.') {
    if (!directories.has(parent)) invalid()
    parent = posix.dirname(parent)
  }
}

function compareEntries(left: TemplateManifestEntry, right: TemplateManifestEntry): number {
  return Buffer.from(left.path).compare(Buffer.from(right.path))
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid()
  const record = value as Record<string, unknown>
  exactKeys(record, keys)
  return record
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) invalid()
}

function isVersion(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_.@-]{0,63}$/u.test(value)
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

function invalid(): never { throw new Error('INVALID_TEMPLATE_STORE') }
